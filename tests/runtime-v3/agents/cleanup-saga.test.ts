import { describe, expect, it } from "vitest";
import { agentCleanupRequestDigest } from "../../../src/runtime/agents/graph-store.ts";
import { AgentSupervisor } from "../../../src/runtime/agents/supervisor.ts";
import { createAgentResidencyReceipt } from "../../../src/runtime/agents/residency.ts";
import type {
	AgentGraphCommitOutcome,
	AgentGraphSemanticCommand,
	AgentGraphStoreHead,
	AgentResult,
	AgentRuntimeReleaseReceiptRef,
	DurableAgentGraphStorePort,
} from "../../../src/runtime/agents/types.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId, type AgentId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	digest,
	key,
	rootRegistration,
	runtimeFakes,
	spawnRequest,
	zeroUsage,
} from "./helpers.ts";

class RecordingGraphStore implements DurableAgentGraphStorePort {
	public readonly commands: AgentGraphSemanticCommand[] = [];
	public failOnce: AgentGraphSemanticCommand["type"] | undefined;
	public loseAcknowledgementOnce: AgentGraphSemanticCommand["type"] | undefined;
	readonly #delegate: DurableAgentGraphStorePort;

	public constructor(delegate: DurableAgentGraphStorePort) {
		this.#delegate = delegate;
	}

	public load(rootAgentId: AgentId): Promise<AgentResult<AgentGraphStoreHead>> {
		return this.#delegate.load(rootAgentId);
	}

	public async commit(
		rootAgentId: AgentId,
		expectedRevision: number,
		command: AgentGraphSemanticCommand,
	): Promise<AgentResult<AgentGraphCommitOutcome>> {
		this.commands.push(command);
		if (this.failOnce === command.type) {
			this.failOnce = undefined;
			return Promise.resolve({
				ok: false,
				error: {
					code: "store_unavailable",
					message: `injected ${command.type} append failure`,
					retryable: true,
				},
			});
		}
		const committed = await this.#delegate.commit(rootAgentId, expectedRevision, command);
		if (this.loseAcknowledgementOnce === command.type) {
			this.loseAcknowledgementOnce = undefined;
			return {
				ok: false,
				error: {
					code: "store_unavailable",
					message: `injected ${command.type} flush acknowledgement loss`,
					retryable: true,
				},
			};
		}
		return committed;
	}
}

async function spawnedRuntime() {
	const runtime = runtimeFakes();
	const root = rootRegistration();
	const store = new RecordingGraphStore(runtime.store);
	const supervisor = new AgentSupervisor({
		rootAgentId: root.agentId,
		ports: { ...runtime.ports, graphStore: store },
		clock: () => new Date("2026-07-22T02:00:00.000Z"),
	});
	expect((await supervisor.registerRoot(root)).ok).toBe(true);
	const spawned = await supervisor.spawn(spawnRequest(root.capabilityGrant));
	if (!spawned.ok) throw new Error(spawned.error.message);
	return { ...runtime, root, store, supervisor, child: spawned.value.node };
}

async function launchRejectedRuntime() {
	const runtime = runtimeFakes();
	const root = rootRegistration();
	const store = new RecordingGraphStore(runtime.store);
	const ports = { ...runtime.ports, graphStore: store };
	const supervisor = new AgentSupervisor({
		rootAgentId: root.agentId,
		ports,
		clock: () => new Date("2026-07-22T02:00:00.000Z"),
	});
	expect((await supervisor.registerRoot(root)).ok).toBe(true);
	store.commands.length = 0;
	runtime.launcher.reject = true;
	return {
		...runtime,
		root,
		store,
		ports,
		supervisor,
		request: spawnRequest(root.capabilityGrant),
	};
}

function terminalRequest(agentId: AgentId, suffix = "") {
	const seed = suffix ? `cleanup-saga-terminal-${suffix}` : "cleanup-saga-terminal";
	return {
		requestId: createRuntimeId("command", seed),
		idempotencyKey: key(seed),
		agentId,
		outcome: "failed" as const,
		reason: "crash" as const,
		usage: zeroUsage(),
	};
}

describe("Agent child cleanup saga", () => {
	it("durably cleans a launch-rejected child without invoking runtime release", async () => {
		const runtime = await launchRejectedRuntime();
		const order: string[] = [];
		const originalCommit = runtime.store.commit.bind(runtime.store);
		runtime.store.commit = async (...args) => {
			order.push(`graph:${args[2].type}`);
			return originalCommit(...args);
		};
		const originalRuntimeRelease = runtime.launcher.release.bind(runtime.launcher);
		runtime.launcher.release = async (...args) => {
			order.push("external:runtime");
			return originalRuntimeRelease(...args);
		};
		const originalWorkspaceRelease = runtime.workspace.release.bind(runtime.workspace);
		runtime.workspace.release = async (...args) => {
			order.push("external:workspace");
			return originalWorkspaceRelease(...args);
		};
		const originalBudgetSettle = runtime.budget.settle.bind(runtime.budget);
		runtime.budget.settle = async (...args) => {
			order.push("external:budget");
			return originalBudgetSettle(...args);
		};

		expect(await runtime.supervisor.spawn(runtime.request)).toMatchObject({
			ok: false,
			error: { code: "launch_failed" },
		});
		const terminalIndex = order.indexOf("graph:agent.failed");
		expect(terminalIndex).toBeGreaterThanOrEqual(0);
		expect(order.slice(terminalIndex)).toEqual([
			"graph:agent.failed",
			"graph:agent.cleanup_requested",
			"external:workspace",
			"graph:agent.workspace_released",
			"external:budget",
			"graph:agent.budget_settled",
			"graph:agent.cleanup_completed",
		]);

		const graph = await runtime.supervisor.graph();
		const child = graph.ok ? graph.value.nodes.get(runtime.request.childAgentId) : undefined;
		const cleanup = graph.ok ? graph.value.cleanups.get(runtime.request.childAgentId) : undefined;
		expect(child).toMatchObject({
			state: "failed",
			stateReason: "launch_rejected",
			workspaceReceipt: { status: "released" },
		});
		expect(child?.launchReceipt).toBeUndefined();
		expect(child?.residency).toBeUndefined();
		expect(cleanup).toMatchObject({
			kind: "not_started",
			workspaceRelease: { receipt: { releasedWorkspaceReceipt: { status: "released" } } },
			budgetSettlement: { receipt: { outcome: "not_started" } },
			completionReceipt: {
				schemaVersion: 1,
				kind: "not_started",
				terminalDigest: child?.terminal?.terminalDigest,
			},
		});
		expect(cleanup && "runtimeRelease" in cleanup).toBe(false);
		expect(cleanup?.completionReceipt && "runtimeReleaseReceiptId" in cleanup.completionReceipt).toBe(false);
		expect(runtime.launcher.releases).toHaveLength(0);
		expect(runtime.workspace.releases[0]?.reason).toBe("spawn_aborted");
		expect(runtime.workspace.releaseExecutions).toBe(1);
		expect(runtime.budget.settlementExecutions).toBe(1);
	});

	it("restarts and reconciles a launch-rejected cleanup only after Workspace release succeeds", async () => {
		const runtime = await launchRejectedRuntime();
		runtime.workspace.releaseError = {
			code: "workspace_invalid",
			message: "injected launch-rejected Workspace release uncertainty",
			retryable: true,
		};

		expect(await runtime.supervisor.spawn(runtime.request)).toMatchObject({
			ok: false,
			error: { code: "workspace_invalid" },
		});
		const pending = await runtime.supervisor.graph();
		expect(pending.ok && pending.value.cleanups.get(runtime.request.childAgentId)).toMatchObject({
			reconciliationRequired: { stage: "workspace_release" },
		});
		expect(runtime.launcher.releases).toHaveLength(0);
		expect(runtime.workspace.releases).toHaveLength(1);
		expect(runtime.budget.settlements).toHaveLength(0);

		runtime.workspace.releaseError = undefined;
		const restarted = new AgentSupervisor({
			rootAgentId: runtime.root.agentId,
			ports: runtime.ports,
			clock: () => new Date("2026-07-22T02:00:00.000Z"),
		});
		const reconciled = await restarted.reconcilePendingCleanups();
		expect(reconciled.ok && reconciled.value.cleanups.get(runtime.request.childAgentId)).toMatchObject({
			kind: "not_started",
			workspaceRelease: { receipt: { releasedWorkspaceReceipt: { status: "released" } } },
			budgetSettlement: { receipt: { outcome: "not_started" } },
			completionReceipt: { schemaVersion: 1, kind: "not_started" },
		});
		const reconciledCleanup = reconciled.ok
			? reconciled.value.cleanups.get(runtime.request.childAgentId)
			: undefined;
		expect(reconciledCleanup && "runtimeRelease" in reconciledCleanup).toBe(false);
		expect(runtime.launcher.releases).toHaveLength(0);
		expect(runtime.workspace.releaseExecutions).toBe(1);
		expect(runtime.budget.settlementExecutions).toBe(1);
	});

	it("keeps a launch-rejected cleanup incomplete when Budget settlement is uncertain", async () => {
		const runtime = await launchRejectedRuntime();
		runtime.budget.settlementError = {
			code: "store_unavailable",
			message: "injected launch-rejected Budget uncertainty",
			retryable: true,
		};

		expect(await runtime.supervisor.spawn(runtime.request)).toMatchObject({
			ok: false,
			error: { code: "store_unavailable" },
		});
		const pending = await runtime.supervisor.graph();
		const pendingCleanup = pending.ok
			? pending.value.cleanups.get(runtime.request.childAgentId)
			: undefined;
		expect(pendingCleanup).toMatchObject({
			kind: "not_started",
			workspaceRelease: expect.any(Object),
			reconciliationRequired: { stage: "budget_settlement" },
		});
		expect(pendingCleanup?.completionReceipt).toBeUndefined();
		expect(runtime.launcher.releases).toHaveLength(0);
		expect(runtime.workspace.releaseExecutions).toBe(1);
		expect(runtime.budget.settlementExecutions).toBe(0);
		expect(runtime.budget.settlements.at(-1)).toMatchObject({
			outcome: "not_started",
			partialResults: [],
		});
		expect(runtime.budget.settlements.at(-1)).not.toHaveProperty("usage");

		runtime.budget.settlementError = undefined;
		const reconciled = await runtime.supervisor.reconcilePendingCleanups();
		expect(reconciled.ok && reconciled.value.cleanups.get(runtime.request.childAgentId)).toMatchObject({
			kind: "not_started",
			completionReceipt: { schemaVersion: 1, kind: "not_started" },
		});
		expect(runtime.workspace.releaseExecutions).toBe(1);
		expect(runtime.budget.settlementExecutions).toBe(1);
		expect(runtime.budget.settlements.at(-1)).not.toHaveProperty("usage");
	});

	it("rejects a wrong cleanup kind and every runtime-release stage for a not-started child", async () => {
		const runtime = await launchRejectedRuntime();
		runtime.store.failOnce = "agent.cleanup_requested";
		expect(await runtime.supervisor.spawn(runtime.request)).toMatchObject({
			ok: false,
			error: { code: "store_unavailable" },
		});
		const failedRequest = runtime.store.commands.find(
			(command) => command.type === "agent.cleanup_requested",
		);
		if (!failedRequest || failedRequest.type !== "agent.cleanup_requested") {
			throw new Error("launch-rejected cleanup request was not attempted");
		}
		let loaded = await runtime.store.load(runtime.root.agentId);
		if (!loaded.ok) throw new Error(loaded.error.message);
		expect(await runtime.store.commit(runtime.root.agentId, loaded.value.revision, {
			...failedRequest,
			kind: "started",
			requestDigest: agentCleanupRequestDigest({
				requestId: failedRequest.requestId,
				agentId: runtime.request.childAgentId,
				sessionId: runtime.request.childSessionId,
				kind: "started",
				terminalDigest: failedRequest.terminalDigest,
			}),
		})).toMatchObject({ ok: false, error: { code: "cleanup_invalid" } });

		runtime.workspace.releaseError = {
			code: "workspace_invalid",
			message: "hold not-started cleanup at Workspace release",
			retryable: true,
		};
		expect(await runtime.supervisor.reconcilePendingCleanups()).toMatchObject({
			ok: false,
			error: { code: "workspace_invalid" },
		});
		loaded = await runtime.store.load(runtime.root.agentId);
		if (!loaded.ok) throw new Error(loaded.error.message);
		const cleanup = loaded.value.projection.cleanups.get(runtime.request.childAgentId);
		if (!cleanup) throw new Error("not-started cleanup intent was not durably recorded");
		const runtimeInstanceId = createRuntimeId("runtime", "not-started-forbidden-runtime");
		const releasedAt = "2026-07-22T02:00:00.000Z";
		const forbiddenRuntimeReceipt: AgentRuntimeReleaseReceiptRef = {
			receiptId: createRuntimeId("receipt", "not-started-forbidden-runtime"),
			requestId: createRuntimeId("command", "not-started-forbidden-runtime"),
			requestDigest: digest("1"),
			agentId: runtime.request.childAgentId,
			sessionId: runtime.request.childSessionId,
			runtimeInstanceId,
			launchReceiptId: createRuntimeId("receipt", "not-started-missing-launch"),
			launchRevision: 1,
			writerFenceReceiptId: createRuntimeId("receipt", "not-started-forbidden-fence"),
			writerFenceReceiptDigest: digest("2"),
			finalCursor: {
				stream: {
					scope: "session",
					streamId: createRuntimeId("eventStream", "not-started-forbidden-runtime"),
					sessionId: runtime.request.childSessionId,
				},
				sequence: 0,
				eventId: createRuntimeId("event", "not-started-forbidden-runtime"),
				eventHash: digest("3"),
			},
			residencyReceipt: {
				receiptId: createRuntimeId("receipt", "not-started-forbidden-residency"),
				agentId: runtime.request.childAgentId,
				sessionId: runtime.request.childSessionId,
				runtimeInstanceId,
				state: "nonresident",
				revision: 1,
				observedAt: releasedAt,
				receiptDigest: digest("4"),
			},
			releasedAt,
			receiptDigest: digest("5"),
		};
		expect(await runtime.store.commit(runtime.root.agentId, loaded.value.revision, {
			type: "agent.runtime_released",
			requestId: forbiddenRuntimeReceipt.requestId,
			idempotencyKey: key("not-started-forbidden-runtime"),
			occurredAt: releasedAt,
			agentId: runtime.request.childAgentId,
			cleanupRequestId: cleanup.requestId,
			receipt: forbiddenRuntimeReceipt,
		})).toMatchObject({ ok: false, error: { code: "cleanup_invalid" } });
		expect(loaded.value.projection.cleanups.get(runtime.request.childAgentId)).not.toHaveProperty("runtimeRelease");
	});

	it.each([
		["append", "agent.cleanup_requested", 0, 0],
		["flush", "agent.cleanup_requested", 0, 0],
		["append", "agent.workspace_released", 1, 0],
		["flush", "agent.workspace_released", 1, 0],
		["append", "agent.budget_settled", 1, 1],
		["flush", "agent.budget_settled", 1, 1],
		["append", "agent.cleanup_completed", 1, 1],
		["flush", "agent.cleanup_completed", 1, 1],
	] as const)(
		"exactly retries a launch-rejected cleanup after a one-shot %s failure at %s",
		async (failureMode, failedType, workspaceExecutions, budgetExecutions) => {
			const runtime = await launchRejectedRuntime();
			if (failureMode === "append") runtime.store.failOnce = failedType;
			else runtime.store.loseAcknowledgementOnce = failedType;

			expect(await runtime.supervisor.spawn(runtime.request)).toMatchObject({
				ok: false,
				error: { code: "store_unavailable" },
			});
			expect(runtime.launcher.releases).toHaveLength(0);
			expect(runtime.workspace.releaseExecutions).toBe(workspaceExecutions);
			expect(runtime.budget.settlementExecutions).toBe(budgetExecutions);

			const reconciled = await runtime.supervisor.reconcilePendingCleanups();
			expect(reconciled.ok && reconciled.value.cleanups.get(runtime.request.childAgentId)).toMatchObject({
				kind: "not_started",
				workspaceRelease: expect.any(Object),
				budgetSettlement: { receipt: { outcome: "not_started" } },
				completionReceipt: { schemaVersion: 1, kind: "not_started" },
			});
			const reconciledCleanup = reconciled.ok
				? reconciled.value.cleanups.get(runtime.request.childAgentId)
				: undefined;
			expect(reconciledCleanup && "runtimeRelease" in reconciledCleanup).toBe(false);
			expect(runtime.launcher.releases).toHaveLength(0);
			expect(runtime.workspace.releaseExecutions).toBe(1);
			expect(runtime.budget.settlementExecutions).toBe(1);
		},
	);

	it("replays a completed launch-rejected cleanup aggregate after restart", async () => {
		const runtime = await launchRejectedRuntime();
		expect(await runtime.supervisor.spawn(runtime.request)).toMatchObject({
			ok: false,
			error: { code: "launch_failed" },
		});
		const beforeRestart = await runtime.supervisor.graph();
		const beforeCleanup = beforeRestart.ok
			? beforeRestart.value.cleanups.get(runtime.request.childAgentId)
			: undefined;
		expect(beforeCleanup?.completionReceipt).toBeDefined();

		const restarted = new AgentSupervisor({
			rootAgentId: runtime.root.agentId,
			ports: runtime.ports,
			clock: () => new Date("2026-07-22T02:00:00.000Z"),
		});
		const replayed = await restarted.reconcilePendingCleanups();
		expect(replayed.ok && replayed.value.cleanups.get(runtime.request.childAgentId)).toEqual(beforeCleanup);
		expect(runtime.launcher.releases).toHaveLength(0);
		expect(runtime.workspace.releaseExecutions).toBe(1);
		expect(runtime.budget.settlementExecutions).toBe(1);
	});

	it("rejects a terminal child without exact usage before semantic state mutation", async () => {
		const runtime = await spawnedRuntime();
		const request = {
			requestId: createRuntimeId("command", "cleanup-saga-missing-usage"),
			idempotencyKey: key("cleanup-saga-missing-usage"),
			agentId: runtime.child.agentId,
			outcome: "failed" as const,
			reason: "crash" as const,
		};

		expect(await runtime.supervisor.finish(request)).toMatchObject({
			ok: false,
			error: { code: "invalid_request" },
		});
		const graph = await runtime.supervisor.graph();
		expect(graph.ok && graph.value.nodes.get(runtime.child.agentId)).toMatchObject({
			state: "running",
			residency: { state: "resident" },
		});
		expect(graph.ok && graph.value.nodes.get(runtime.child.agentId)?.terminal).toBeUndefined();
		expect(graph.ok && graph.value.cleanups.has(runtime.child.agentId)).toBe(false);
		expect(runtime.launcher.releases).toHaveLength(0);
		expect(runtime.workspace.releases).toHaveLength(0);
		expect(runtime.budget.settlements).toHaveLength(0);
	});

	it.each([
		["completed", "crash"],
		["stopped", "crash"],
		["failed", "cancelled"],
	] as const)("rejects contradictory terminal outcome %s and reason %s", async (outcome, reason) => {
		const runtime = await spawnedRuntime();
		expect(await runtime.supervisor.finish({
			requestId: createRuntimeId("command", `cleanup-saga-invalid-${outcome}-${reason}`),
			idempotencyKey: key(`cleanup-saga-invalid-${outcome}-${reason}`),
			agentId: runtime.child.agentId,
			outcome,
			reason,
			usage: zeroUsage(),
		})).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		const graph = await runtime.supervisor.graph();
		expect(graph.ok && graph.value.nodes.get(runtime.child.agentId)?.state).toBe("running");
		expect(graph.ok && graph.value.cleanups.has(runtime.child.agentId)).toBe(false);
	});

	it("rejects an interrupted child without exact usage before residency mutation", async () => {
		const runtime = await spawnedRuntime();
		if (!runtime.child.residency) throw new Error("spawned child lacks residency");
		const unavailable = createAgentResidencyReceipt({
			agentId: runtime.child.agentId,
			sessionId: runtime.child.sessionId,
			runtimeInstanceId: runtime.child.residency.runtimeInstanceId,
			state: "unavailable",
			revision: runtime.child.residency.revision + 1,
			observedAt: "2026-07-22T01:59:59.000Z",
			reasonDigest: digest("6"),
		});
		if (!unavailable.ok) throw new Error(unavailable.error.message);

		expect(await runtime.supervisor.interrupt(
			runtime.child.agentId,
			"timeout",
			unavailable.value,
			key("cleanup-saga-missing-usage"),
		)).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		const graph = await runtime.supervisor.graph();
		expect(graph.ok && graph.value.nodes.get(runtime.child.agentId)).toMatchObject({
			state: "running",
			residency: runtime.child.residency,
		});
		expect(runtime.launcher.releases).toHaveLength(0);
		expect(runtime.workspace.releases).toHaveLength(0);
		expect(runtime.budget.settlements).toHaveLength(0);
	});

	it("durably orders semantic terminal, runtime release, Workspace release, budget settlement, and completion", async () => {
		const runtime = await spawnedRuntime();
		const order: string[] = [];
		const originalCommit = runtime.store.commit.bind(runtime.store);
		runtime.store.commit = async (...args) => {
			order.push(`graph:${args[2].type}`);
			return originalCommit(...args);
		};
		const originalRuntimeRelease = runtime.launcher.release.bind(runtime.launcher);
		runtime.launcher.release = async (...args) => {
			order.push("external:runtime");
			return originalRuntimeRelease(...args);
		};
		const originalWorkspaceRelease = runtime.workspace.release.bind(runtime.workspace);
		runtime.workspace.release = async (...args) => {
			order.push("external:workspace");
			return originalWorkspaceRelease(...args);
		};
		const originalBudgetSettle = runtime.budget.settle.bind(runtime.budget);
		runtime.budget.settle = async (...args) => {
			order.push("external:budget");
			return originalBudgetSettle(...args);
		};

		const request = terminalRequest(runtime.child.agentId);
		const finished = await runtime.supervisor.finish(request);
		expect(finished.ok).toBe(true);
		if (!finished.ok) return;
		expect(order).toEqual([
			"graph:agent.failed",
			"graph:agent.cleanup_requested",
			"external:runtime",
			"graph:agent.runtime_released",
			"external:workspace",
			"graph:agent.workspace_released",
			"external:budget",
			"graph:agent.budget_settled",
			"graph:agent.cleanup_completed",
		]);
		expect(finished.value.nodes.get(runtime.child.agentId)).toMatchObject({
			state: "failed",
			residency: { state: "nonresident" },
			workspaceReceipt: { status: "released" },
		});
			expect(finished.value.cleanups.get(runtime.child.agentId)).toMatchObject({
				runtimeRelease: { receipt: { receiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) } },
				workspaceRelease: { receipt: { releasedWorkspaceReceipt: { status: "released" } } },
			budgetSettlement: { receipt: { outcome: "failed" } },
			completionReceipt: { receiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) },
		});

		expect((await runtime.supervisor.finish(request)).ok).toBe(true);
		expect(runtime.launcher.releaseExecutions).toBe(1);
		expect(runtime.workspace.releaseExecutions).toBe(1);
		expect(runtime.budget.settlementExecutions).toBe(1);
		expect(await runtime.supervisor.finish({
			...request,
			idempotencyKey: "short" as typeof request.idempotencyKey,
		})).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		expect(await runtime.supervisor.finish({
			...request,
			idempotencyKey: key("cleanup-saga-terminal-drift"),
		})).toMatchObject({ ok: false, error: { code: "invalid_transition" } });
	});

	it("stops before Workspace and budget when runtime release is uncertain, then resumes the exact missing stage", async () => {
		const runtime = await spawnedRuntime();
		runtime.launcher.releaseError = {
			code: "reference_unavailable",
			message: "injected runtime release uncertainty",
			retryable: true,
		};
		const request = terminalRequest(runtime.child.agentId);
		expect(await runtime.supervisor.finish(request)).toMatchObject({
			ok: false,
			error: { code: "reference_unavailable" },
		});
		const pending = await runtime.supervisor.graph();
		expect(pending.ok && pending.value.nodes.get(runtime.child.agentId)?.state).toBe("failed");
		expect(pending.ok && pending.value.nodes.get(runtime.child.agentId)?.residency?.state).toBe("resident");
		expect(pending.ok && pending.value.cleanups.get(runtime.child.agentId)?.reconciliationRequired).toMatchObject({
			stage: "runtime_release",
			error: { outcomeCertain: false, effect: "uncertain" },
		});
		expect(runtime.workspace.releases).toHaveLength(0);
		expect(runtime.budget.settlements).toHaveLength(0);

		runtime.launcher.releaseError = undefined;
		const reconciled = await runtime.supervisor.reconcilePendingCleanups();
		expect(reconciled.ok && reconciled.value.cleanups.get(runtime.child.agentId)?.completionReceipt).toBeDefined();
	});

	it("continues reconciling independent terminal children after an earlier runtime release failure", async () => {
		const runtime = runtimeFakes();
		const root = rootRegistration();
		expect((await runtime.supervisor.registerRoot(root)).ok).toBe(true);
		const first = await runtime.supervisor.spawn(spawnRequest(root.capabilityGrant));
		const second = await runtime.supervisor.spawn(spawnRequest(root.capabilityGrant));
		if (!first.ok) throw new Error(first.error.message);
		if (!second.ok) throw new Error(second.error.message);

		const originalRelease = runtime.launcher.release.bind(runtime.launcher);
		let failEveryRelease = true;
		runtime.launcher.release = (request) => {
			if (failEveryRelease || request.agentId === first.value.node.agentId) {
				return Promise.resolve({
					ok: false,
					error: {
						code: "reference_unavailable",
						message: "injected first-child runtime release failure",
						retryable: true,
					},
				});
			}
			return originalRelease(request);
		};

		expect(await runtime.supervisor.finish(
			terminalRequest(first.value.node.agentId, "first"),
		)).toMatchObject({ ok: false, error: { code: "reference_unavailable" } });
		expect(await runtime.supervisor.finish(
			terminalRequest(second.value.node.agentId, "second"),
		)).toMatchObject({ ok: false, error: { code: "reference_unavailable" } });

		failEveryRelease = false;
		expect(await runtime.supervisor.reconcilePendingCleanups()).toMatchObject({
			ok: false,
			error: { code: "reference_unavailable" },
		});
		const graph = await runtime.supervisor.graph();
		expect(graph.ok && graph.value.cleanups.get(first.value.node.agentId)?.completionReceipt).toBeUndefined();
		expect(graph.ok && graph.value.cleanups.get(second.value.node.agentId)?.completionReceipt).toBeDefined();
		expect(runtime.launcher.releaseExecutions).toBe(1);
	});

	it("stops before budget when Workspace release is uncertain", async () => {
		const runtime = await spawnedRuntime();
		runtime.workspace.releaseError = {
			code: "workspace_invalid",
			message: "injected Workspace release uncertainty",
			retryable: true,
		};
		expect(await runtime.supervisor.finish(terminalRequest(runtime.child.agentId))).toMatchObject({ ok: false });
		const pending = await runtime.supervisor.graph();
		expect(pending.ok && pending.value.nodes.get(runtime.child.agentId)?.residency?.state).toBe("nonresident");
		expect(pending.ok && pending.value.nodes.get(runtime.child.agentId)?.workspaceReceipt.status).toBe("active");
		expect(pending.ok && pending.value.cleanups.get(runtime.child.agentId)?.reconciliationRequired?.stage).toBe("workspace_release");
		expect(runtime.budget.settlements).toHaveLength(0);
	});

	it("keeps cleanup incomplete when budget settlement is uncertain", async () => {
		const runtime = await spawnedRuntime();
		runtime.budget.settlementError = {
			code: "store_unavailable",
			message: "injected budget settlement uncertainty",
			retryable: true,
		};
		expect(await runtime.supervisor.finish(terminalRequest(runtime.child.agentId))).toMatchObject({ ok: false });
		const pending = await runtime.supervisor.graph();
		expect(pending.ok && pending.value.cleanups.get(runtime.child.agentId)).toMatchObject({
			runtimeRelease: expect.any(Object),
			workspaceRelease: expect.any(Object),
			reconciliationRequired: { stage: "budget_settlement" },
		});
		expect(pending.ok && pending.value.cleanups.get(runtime.child.agentId)?.completionReceipt).toBeUndefined();
	});

	it("routes parent cancellation through semantic stopped and the same typed release saga", async () => {
		const runtime = await spawnedRuntime();
		const request = {
			requestId: createRuntimeId("command", "cleanup-saga-cancel"),
			idempotencyKey: key("cleanup-saga-cancel"),
			agentId: runtime.child.agentId,
		};
		const reasonEvidenceDigest = digest("9");
		const cancelled = await runtime.supervisor.cancel(
			request,
			reasonEvidenceDigest,
			zeroUsage(),
		);
		expect(cancelled.ok && cancelled.value.nodes.get(runtime.child.agentId)).toMatchObject({
			state: "stopped",
			residency: { state: "nonresident" },
			workspaceReceipt: { status: "released" },
		});
		expect(cancelled.ok && cancelled.value.cleanups.get(runtime.child.agentId)?.completionReceipt).toBeDefined();
		expect(runtime.launcher.cancelCalls).toBe(0);
		expect(runtime.launcher.releaseExecutions).toBe(1);
	});

	it("binds cancellation reason evidence into the semantic terminal and cleanup identity", async () => {
		const runtime = await spawnedRuntime();
		const request = {
			requestId: createRuntimeId("command", "cleanup-saga-cancel-evidence"),
			idempotencyKey: key("cleanup-saga-cancel-evidence"),
			agentId: runtime.child.agentId,
		};
		const reasonEvidenceDigest = digest("8");
		const usage = zeroUsage();
		const cancelled = await runtime.supervisor.cancel(request, reasonEvidenceDigest, usage);
		expect(cancelled.ok).toBe(true);
		if (!cancelled.ok) return;

		const expectedRequestDigest = canonicalDigest({
			...request,
			outcome: "stopped",
			reason: "cancelled",
			reasonEvidenceDigest,
			usage,
			partialResults: [],
		});
		const expectedTerminalDigest = canonicalDigest({
			requestId: request.requestId,
			requestDigest: expectedRequestDigest,
			outcome: "stopped",
			reason: "cancelled",
			reasonEvidenceDigest,
			usage,
			partialResults: [],
		});
		const node = cancelled.value.nodes.get(runtime.child.agentId);
		const cleanup = cancelled.value.cleanups.get(runtime.child.agentId);
		expect(node?.terminal).toMatchObject({
			reasonEvidenceDigest,
			requestDigest: expectedRequestDigest,
			terminalDigest: expectedTerminalDigest,
		});
		expect(cleanup).toMatchObject({
			terminalDigest: expectedTerminalDigest,
			completionReceipt: { terminalDigest: expectedTerminalDigest },
		});
	});

	it("rejects an exact cancellation retry when its reason evidence digest drifts", async () => {
		const runtime = await spawnedRuntime();
		const request = {
			requestId: createRuntimeId("command", "cleanup-saga-cancel-reason-drift"),
			idempotencyKey: key("cleanup-saga-cancel-reason-drift"),
			agentId: runtime.child.agentId,
		};
		const usage = zeroUsage();
		expect(await runtime.supervisor.cancel(request, digest("7"), usage)).toMatchObject({ ok: true });
		expect(await runtime.supervisor.cancel(request, digest("7"), usage)).toMatchObject({ ok: true });
		expect(await runtime.supervisor.cancel(request, digest("6"), usage)).toMatchObject({
			ok: false,
			error: { code: "idempotency_conflict" },
		});
	});

	it("routes a terminal interruption through cleanup after durably recording unavailable residency", async () => {
		const runtime = await spawnedRuntime();
		if (!runtime.child.residency) throw new Error("spawned child lacks residency");
		const unavailable = createAgentResidencyReceipt({
			agentId: runtime.child.agentId,
			sessionId: runtime.child.sessionId,
			runtimeInstanceId: runtime.child.residency.runtimeInstanceId,
			state: "unavailable",
			revision: runtime.child.residency.revision + 1,
			observedAt: "2026-07-22T01:59:59.000Z",
			reasonDigest: digest("7"),
		});
		if (!unavailable.ok) throw new Error(unavailable.error.message);
		const interrupted = await runtime.supervisor.interrupt(
			runtime.child.agentId,
			"timeout",
			unavailable.value,
			key("cleanup-saga-timeout"),
			zeroUsage(),
		);
		expect(interrupted.ok && interrupted.value.nodes.get(runtime.child.agentId)).toMatchObject({
			state: "failed",
			residency: { state: "nonresident", revision: unavailable.value.revision + 1 },
		});
		expect(interrupted.ok && interrupted.value.cleanups.get(runtime.child.agentId)?.completionReceipt).toBeDefined();
		expect(runtime.launcher.releases[0]?.previousResidencyReceipt).toEqual(unavailable.value);
	});

	it.each([
		["timeout", "agent.failed", "failed"],
		["cancelled", "agent.stopped", "stopped"],
	] as const)(
		"retries an exact %s interruption after the residency commit wins but terminal append fails",
		async (cause, terminalType, terminalState) => {
			const runtime = await spawnedRuntime();
			if (!runtime.child.residency) throw new Error("spawned child lacks residency");
			const unavailable = createAgentResidencyReceipt({
				agentId: runtime.child.agentId,
				sessionId: runtime.child.sessionId,
				runtimeInstanceId: runtime.child.residency.runtimeInstanceId,
				state: "unavailable",
				revision: runtime.child.residency.revision + 1,
				observedAt: "2026-07-22T01:59:59.000Z",
				reasonDigest: digest(cause === "timeout" ? "4" : "5"),
			});
			if (!unavailable.ok) throw new Error(unavailable.error.message);
			const interruptionKey = key(`cleanup-saga-${cause}-append-retry`);
			runtime.store.failOnce = terminalType;

			expect(await runtime.supervisor.interrupt(
				runtime.child.agentId,
				cause,
				unavailable.value,
				interruptionKey,
				zeroUsage(),
			)).toMatchObject({ ok: false, error: { code: "store_unavailable" } });
			const halfCommitted = await runtime.supervisor.graph();
			expect(halfCommitted.ok && halfCommitted.value.nodes.get(runtime.child.agentId)).toMatchObject({
				state: "running",
				residency: unavailable.value,
			});

			const retried = await runtime.supervisor.interrupt(
				runtime.child.agentId,
				cause,
				unavailable.value,
				interruptionKey,
				zeroUsage(),
			);
			expect(retried.ok && retried.value.nodes.get(runtime.child.agentId)?.state).toBe(terminalState);
			expect(retried.ok && retried.value.cleanups.get(runtime.child.agentId)?.completionReceipt).toBeDefined();

			expect((await runtime.supervisor.interrupt(
				runtime.child.agentId,
				cause,
				unavailable.value,
				interruptionKey,
				zeroUsage(),
			)).ok).toBe(true);
			expect(runtime.store.commands.filter((command) => command.type === "agent.residency_changed")).toHaveLength(1);
			expect(runtime.launcher.releaseExecutions).toBe(1);
			expect(runtime.workspace.releaseExecutions).toBe(1);
			expect(runtime.budget.settlementExecutions).toBe(1);
		},
	);

	it.each([
		["agent.cleanup_requested", 0, 0, 0],
		["agent.runtime_released", 1, 0, 0],
		["agent.workspace_released", 1, 1, 0],
		["agent.budget_settled", 1, 1, 1],
	] as const)(
		"replays exact external receipts after a one-shot %s append failure",
		async (failedType, runtimeExecutions, workspaceExecutions, budgetExecutions) => {
			const runtime = await spawnedRuntime();
			runtime.store.failOnce = failedType;
			const request = terminalRequest(runtime.child.agentId);
			expect(await runtime.supervisor.finish(request)).toMatchObject({
				ok: false,
				error: { code: "store_unavailable" },
			});
			expect(runtime.launcher.releaseExecutions).toBe(runtimeExecutions);
			expect(runtime.workspace.releaseExecutions).toBe(workspaceExecutions);
			expect(runtime.budget.settlementExecutions).toBe(budgetExecutions);

			const retried = await runtime.supervisor.finish(request);
			expect(retried.ok && retried.value.cleanups.get(runtime.child.agentId)?.completionReceipt).toBeDefined();
			expect(runtime.launcher.releaseExecutions).toBe(1);
			expect(runtime.workspace.releaseExecutions).toBe(1);
			expect(runtime.budget.settlementExecutions).toBe(1);
		},
	);
});
