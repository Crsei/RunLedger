import { describe, expect, it, vi } from "vitest";
import { AgentSupervisor } from "../../../src/runtime/agents/supervisor.ts";
import type {
	AgentGraphStoreHead,
	AgentResult,
	AgentRuntimeActivationHandle,
	AgentRuntimeActivationPort,
	AgentRuntimeActivationReceiptRef,
	AgentRuntimeActivationRequest,
	AgentRuntimeCompletion,
} from "../../../src/runtime/agents/types.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import type { EventCursor } from "../../../src/runtime/protocol/v3/events.ts";
import {
	createRuntimeId,
	type SessionId,
} from "../../../src/runtime/protocol/v3/ids.ts";
import {
	rootRegistration,
	runtimeFakes,
	spawnRequest,
	type RuntimeFakes,
	zeroUsage,
} from "./helpers.ts";

const NOW = "2026-07-22T00:00:00.000Z";

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
	let settle: ((value: T) => void) | undefined;
	const promise = new Promise<T>((resolve) => {
		settle = resolve;
	});
	return {
		promise,
		resolve(value) {
			const current = settle;
			if (!current) throw new Error("deferred result already settled");
			settle = undefined;
			current(value);
		},
	};
}

function graphCursor(sessionId: SessionId, revision: number): EventCursor {
	return {
		stream: {
			scope: "session",
			streamId: createRuntimeId("eventStream", "activation-parent-graph"),
			sessionId,
		},
		sequence: revision,
		eventId: createRuntimeId("event", `activation-parent-graph-${revision}`),
		eventHash: canonicalDigest({ kind: "activation_parent_graph", revision }),
	};
}

function childCursor(
	sessionId: SessionId,
	agentId: AgentRuntimeActivationRequest["agentId"],
): EventCursor {
	return {
		stream: {
			scope: "session",
			// FakeLauncher.release() advances this same stream from sequence 0 to 1.
			streamId: createRuntimeId(
				"eventStream",
				`runtime-release-${sessionId}`,
			),
			sessionId,
		},
		sequence: 0,
		eventId: createRuntimeId("event", `activation-child-${agentId}`),
		eventHash: canonicalDigest({ kind: "activation_child_completion", agentId }),
	};
}

function withCursor(
	head: AgentGraphStoreHead,
	sessionId: SessionId,
): AgentGraphStoreHead {
	return {
		...head,
		cursor: graphCursor(sessionId, head.revision),
	};
}

function installDurableGraphCursor(
	runtime: RuntimeFakes,
	sessionId: SessionId,
): void {
	const load = runtime.store.load.bind(runtime.store);
	runtime.store.load = async (rootAgentId) => {
		const loaded = await load(rootAgentId);
		return loaded.ok
			? { ok: true, value: withCursor(loaded.value, sessionId) }
			: loaded;
	};
	const commit = runtime.store.commit.bind(runtime.store);
	runtime.store.commit = async (...args) => {
		const committed = await commit(...args);
		if (!committed.ok || committed.value.status === "conflict") {
			return committed;
		}
		return {
			ok: true,
			value: {
				...committed.value,
				head: withCursor(committed.value.head, sessionId),
			},
		};
	};
}

class DeferredRuntimeActivation implements AgentRuntimeActivationPort {
	public readonly requests: AgentRuntimeActivationRequest[] = [];
	readonly #completion = deferred<AgentResult<AgentRuntimeCompletion>>();
	readonly #onActivate: (() => void) | undefined;
	#failuresRemaining = 0;

	public constructor(onActivate?: () => void) {
		this.#onActivate = onActivate;
	}

	public activate(
		request: AgentRuntimeActivationRequest,
	): Promise<AgentResult<AgentRuntimeActivationHandle>> {
		this.requests.push(structuredClone(request));
		this.#onActivate?.();
		if (this.#failuresRemaining > 0) {
			this.#failuresRemaining -= 1;
			return Promise.resolve({
				ok: false,
				error: {
					code: "reference_unavailable",
					message: "injected transient activation failure",
					retryable: true,
				},
			});
		}
		const receiptBody: Omit<
			AgentRuntimeActivationReceiptRef,
			"receiptDigest"
		> = {
			receiptId: createRuntimeId(
				"receipt",
				`activation-${canonicalDigest(request).slice(0, 40)}`,
			),
			requestId: request.requestId,
			requestDigest: request.requestDigest,
			agentId: request.agentId,
			sessionId: request.sessionId,
			launchReceiptId: request.launchReceipt.receiptId,
			launchRevision: request.launchReceipt.launchRevision,
			residencyReceiptId: request.residencyReceipt.receiptId,
			parentGraphRevision: request.parentGraphRevision,
			parentGraphCursor: structuredClone(request.parentGraphCursor),
			childNodeDigest: request.childNodeDigest,
			activatedAt: NOW,
		};
		return Promise.resolve({
			ok: true,
			value: {
				receipt: {
					...receiptBody,
					receiptDigest: canonicalDigest(receiptBody),
				},
				completion: this.#completion.promise,
			},
		});
	}

	public failNextActivation(): void {
		this.#failuresRemaining += 1;
	}

	public complete(completion: AgentRuntimeCompletion): void {
		this.#completion.resolve({ ok: true, value: completion });
	}

	public makeCompletionUncertain(): void {
		this.#completion.resolve({
			ok: false,
			error: {
				code: "reference_unavailable",
				message: "exact child usage is unavailable",
				retryable: true,
			},
		});
	}
}

function fixture(order?: string[]) {
	const runtime = runtimeFakes();
	const root = rootRegistration();
	installDurableGraphCursor(runtime, root.sessionId);
	const activation = new DeferredRuntimeActivation(
		order ? () => order.push("external:activate") : undefined,
	);
	runtime.ports.runtimeActivation = activation;
	const supervisor = new AgentSupervisor({
		rootAgentId: root.agentId,
		ports: runtime.ports,
		clock: () => new Date(NOW),
	});
	return { ...runtime, supervisor, root, activation };
}

function observeCommits(runtime: RuntimeFakes, order: string[]): void {
	const commit = runtime.store.commit.bind(runtime.store);
	runtime.store.commit = async (...args) => {
		const committed = await commit(...args);
		if (
			committed.ok &&
			committed.value.status !== "conflict"
		) {
			order.push(`graph:${args[2].type}`);
		}
		return committed;
	};
}

async function nextEventLoopTurn(): Promise<void> {
	await new Promise<void>((resolve) => {
		setImmediate(resolve);
	});
}

describe("post-commit governed child activation", () => {
	it("activates only after launch_recorded and running are durable, then deduplicates an exact spawn retry", async () => {
		const order: string[] = [];
		const runtime = fixture(order);
		observeCommits(runtime, order);
		expect((await runtime.supervisor.registerRoot(runtime.root)).ok).toBe(true);
		const request = spawnRequest(runtime.root.capabilityGrant);
		order.length = 0;

		const spawned = await runtime.supervisor.spawn(request);
		expect(spawned.ok).toBe(true);
		if (!spawned.ok) return;
		await vi.waitFor(() => {
			expect(runtime.activation.requests).toHaveLength(1);
		});

		expect(order.indexOf("graph:agent.launch_recorded")).toBeGreaterThanOrEqual(0);
		expect(order.indexOf("graph:agent.transitioned")).toBeGreaterThan(
			order.indexOf("graph:agent.launch_recorded"),
		);
		expect(order.indexOf("external:activate")).toBeGreaterThan(
			order.indexOf("graph:agent.transitioned"),
		);

		const loaded = await runtime.store.load(runtime.root.agentId);
		if (!loaded.ok || !loaded.value.cursor) {
			throw new Error("test graph lacks its durable head cursor");
		}
		const activationRequest = runtime.activation.requests[0]!;
		expect(activationRequest).toMatchObject({
			agentId: spawned.value.node.agentId,
			sessionId: spawned.value.node.sessionId,
			launchReceipt: spawned.value.node.launchReceipt,
			residencyReceipt: spawned.value.node.residency,
			parentGraphRevision: loaded.value.revision,
			parentGraphCursor: loaded.value.cursor,
			childNodeDigest: canonicalDigest(spawned.value.node),
		});
		const {
			requestDigest,
			...activationRequestBody
		} = activationRequest;
		expect(requestDigest).toBe(canonicalDigest(activationRequestBody));

		expect((await runtime.supervisor.spawn(request)).ok).toBe(true);
		expect(runtime.activation.requests).toHaveLength(1);
	});

	it("retries the exact durable activation after a transient adapter failure", async () => {
		const runtime = fixture();
		expect((await runtime.supervisor.registerRoot(runtime.root)).ok).toBe(true);
		const request = spawnRequest(runtime.root.capabilityGrant);
		runtime.activation.failNextActivation();

		expect(await runtime.supervisor.spawn(request)).toMatchObject({
			ok: false,
			error: {
				code: "reference_unavailable",
				retryable: true,
			},
		});
		expect(runtime.activation.requests).toHaveLength(1);

		expect(await runtime.supervisor.spawn(request)).toMatchObject({
			ok: true,
			value: {
				node: {
					agentId: request.childAgentId,
					state: "running",
				},
			},
		});
		expect(runtime.activation.requests).toHaveLength(2);
		expect(runtime.activation.requests[1]).toEqual(
			runtime.activation.requests[0],
		);
	});

	it("does not activate when the durable running transition fails", async () => {
		const runtime = fixture();
		expect((await runtime.supervisor.registerRoot(runtime.root)).ok).toBe(true);
		const request = spawnRequest(runtime.root.capabilityGrant);
		const commit = runtime.store.commit.bind(runtime.store);
		runtime.store.commit = async (...args) => {
			if (
				args[2].type === "agent.transitioned" &&
				args[2].agentId === request.childAgentId &&
				args[2].to === "running"
			) {
				return {
					ok: false,
					error: {
						code: "store_unavailable",
						message: "injected running commit failure",
						retryable: true,
					},
				};
			}
			return commit(...args);
		};

		expect(await runtime.supervisor.spawn(request)).toMatchObject({
			ok: false,
			error: { code: "store_unavailable", retryable: true },
		});
		await nextEventLoopTurn();
		expect(runtime.activation.requests).toHaveLength(0);
		const graph = await runtime.supervisor.graph();
		expect(
			graph.ok && graph.value.nodes.get(request.childAgentId),
		).toMatchObject({
			state: "pending",
			launchReceipt: expect.any(Object),
			residency: { state: "resident" },
		});
	});

	it("records completion turns and cursor before exact finish, then preserves runtime to Workspace to Budget cleanup", async () => {
		const runtime = fixture();
		expect((await runtime.supervisor.registerRoot(runtime.root)).ok).toBe(true);
		const request = spawnRequest(runtime.root.capabilityGrant);
		const spawned = await runtime.supervisor.spawn(request);
		if (!spawned.ok) throw new Error(spawned.error.message);
		await vi.waitFor(() => {
			expect(runtime.activation.requests).toHaveLength(1);
		});

		const order: string[] = [];
		observeCommits(runtime, order);
		const releaseRuntime = runtime.launcher.release.bind(runtime.launcher);
		runtime.launcher.release = async (...args) => {
			order.push("external:runtime");
			return releaseRuntime(...args);
		};
		const releaseWorkspace = runtime.workspace.release.bind(runtime.workspace);
		runtime.workspace.release = async (...args) => {
			order.push("external:workspace");
			return releaseWorkspace(...args);
		};
		const settleBudget = runtime.budget.settle.bind(runtime.budget);
		runtime.budget.settle = async (...args) => {
			order.push("external:budget");
			return settleBudget(...args);
		};

		const turnIds = [
			createRuntimeId("turn", "activation-completion-one"),
			createRuntimeId("turn", "activation-completion-two"),
		] as const;
		const finalCursor = childCursor(
			spawned.value.node.sessionId,
			spawned.value.node.agentId,
		);
		const usage = {
			...zeroUsage(),
			inputTokens: 41,
			outputTokens: 13,
			usdMicros: 7,
			wallTimeMs: 29,
			toolCalls: 1,
			networkBytes: 17,
			storageBytes: 23,
		};
		runtime.activation.complete({
			outcome: "failed",
			reason: "crash",
			usage,
			turnIds,
			finalCursor,
		});

		await vi.waitFor(async () => {
			const graph = await runtime.supervisor.graph();
			expect(
				graph.ok &&
					graph.value.cleanups.get(
						spawned.value.node.agentId,
					)?.completionReceipt,
			).toBeDefined();
		});
		const graph = await runtime.supervisor.graph();
		if (!graph.ok) throw new Error(graph.error.message);
		expect(graph.value.nodes.get(spawned.value.node.agentId)).toMatchObject({
			state: "failed",
			turnsUsed: 2,
			turnIds,
			cursor: finalCursor,
			terminal: {
				outcome: "failed",
				reason: "crash",
				usage,
			},
		});
		expect(runtime.budget.settlements.at(-1)?.usage).toEqual(usage);

		expect(order.slice(0, 4)).toEqual([
			"graph:agent.turn_recorded",
			"graph:agent.turn_recorded",
			"graph:agent.cursor_advanced",
			"graph:agent.failed",
		]);
		expect(order.filter((entry) => entry.startsWith("external:"))).toEqual([
			"external:runtime",
			"external:workspace",
			"external:budget",
		]);
		expect(order.indexOf("external:runtime")).toBeGreaterThan(
			order.indexOf("graph:agent.failed"),
		);
		expect(order.indexOf("external:workspace")).toBeGreaterThan(
			order.indexOf("external:runtime"),
		);
		expect(order.indexOf("external:budget")).toBeGreaterThan(
			order.indexOf("external:workspace"),
		);
	});

	it("leaves the child running and does not finish when completion usage is uncertain", async () => {
		const runtime = fixture();
		expect((await runtime.supervisor.registerRoot(runtime.root)).ok).toBe(true);
		const request = spawnRequest(runtime.root.capabilityGrant);
		const spawned = await runtime.supervisor.spawn(request);
		if (!spawned.ok) throw new Error(spawned.error.message);
		await vi.waitFor(() => {
			expect(runtime.activation.requests).toHaveLength(1);
		});
		const finish = vi.spyOn(runtime.supervisor, "finish");

		runtime.activation.makeCompletionUncertain();
		await nextEventLoopTurn();
		await nextEventLoopTurn();

		expect(finish).not.toHaveBeenCalled();
		const graph = await runtime.supervisor.graph();
		if (!graph.ok) throw new Error(graph.error.message);
		expect(graph.value.nodes.get(spawned.value.node.agentId)).toMatchObject({
			state: "running",
			turnsUsed: 0,
		});
		expect(
			graph.value.nodes.get(spawned.value.node.agentId)?.terminal,
		).toBeUndefined();
		expect(
			graph.value.cleanups.has(spawned.value.node.agentId),
		).toBe(false);
		expect(runtime.launcher.releases).toHaveLength(0);
		expect(runtime.workspace.releases).toHaveLength(0);
		expect(runtime.budget.settlements).toHaveLength(0);
	});
});
