import { describe, expect, it } from "vitest";
import { AgentSupervisor } from "../../../src/runtime/agents/supervisor.ts";
import { createAgentResidencyReceipt } from "../../../src/runtime/agents/residency.ts";
import {
	InMemoryAgentGraphStore,
} from "../../../src/runtime/agents/graph-store.ts";
import type {
	AgentGraphCommitOutcome,
	AgentGraphSemanticCommand,
	AgentGraphStoreHead,
	AgentResult,
	DurableAgentGraphStorePort,
} from "../../../src/runtime/agents/types.ts";
import { spawnAgentRequestDigest } from "../../../src/runtime/agents/delegation.ts";
import {
	artifact,
	digest,
	key,
	rootRegistration,
	runtimeFakes,
	spawnRequest,
	zeroUsage,
} from "../agents/helpers.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createSessionEventStreamRef } from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId, type AgentId } from "../../../src/runtime/protocol/v3/ids.ts";
import { InMemoryCommandIdempotencyRepository } from "../../../src/runtime/control-plane/idempotency.ts";
import {
	SupervisorMultiAgentControlPlaneAdapter,
	type ResolvedAgentSpawnSpec,
} from "../../../src/runtime/control-plane/supervisor-control-plane.ts";
import type {
	AgentSpawnCommandV2,
} from "../../../src/runtime/control-plane/multi-agent-contracts.ts";
import type { ControlPlaneRequestContext } from "../../../src/runtime/control-plane/types.ts";

const DIGEST = "a".repeat(64);
const ROOT_AGENT_ID = createRuntimeId("agent", "root");

class CursorGraphStore implements DurableAgentGraphStorePort {
	readonly #inner = new InMemoryAgentGraphStore();
	readonly #authorityId: ReturnType<typeof createRuntimeId<"authority">>;
	readonly #tenantId: ReturnType<typeof createRuntimeId<"tenant">>;
	readonly #sessionId: ReturnType<typeof createRuntimeId<"session">>;

	public constructor(
		authorityId: ReturnType<typeof createRuntimeId<"authority">>,
		tenantId: ReturnType<typeof createRuntimeId<"tenant">>,
		sessionId: ReturnType<typeof createRuntimeId<"session">>,
	) {
		this.#authorityId = authorityId;
		this.#tenantId = tenantId;
		this.#sessionId = sessionId;
	}

	#withCursor(head: AgentGraphStoreHead): AgentGraphStoreHead {
		if (head.revision === 0) return head;
		return {
			...head,
			cursor: {
				stream: createSessionEventStreamRef(
					{ authorityId: this.#authorityId, tenantId: this.#tenantId },
					this.#sessionId,
				),
				sequence: head.revision - 1,
				eventId: createRuntimeId("event", `agent-graph-${head.revision}`),
				eventHash: canonicalDigest({ graphRevision: head.revision }),
			},
		};
	}

	public async load(rootAgentId: AgentId): Promise<AgentResult<AgentGraphStoreHead>> {
		const loaded = await this.#inner.load(rootAgentId);
		return loaded.ok
			? { ok: true, value: this.#withCursor(loaded.value) }
			: loaded;
	}

	public async commit(
		rootAgentId: AgentId,
		expectedRevision: number,
		command: AgentGraphSemanticCommand,
	): Promise<AgentResult<AgentGraphCommitOutcome>> {
		const committed = await this.#inner.commit(rootAgentId, expectedRevision, command);
		if (!committed.ok || committed.value.status === "conflict") return committed;
		return {
			ok: true,
			value: {
				...committed.value,
				head: this.#withCursor(committed.value.head),
			},
		};
	}
}

async function fixture(options: { uncertainLaunch?: boolean } = {}) {
	const authorityId = createRuntimeId("authority", "agent-control-plane");
	const tenantId = createRuntimeId("tenant", "agent-control-plane");
	const principalId = createRuntimeId("principal", "agent-control-plane");
	const root = rootRegistration();
	const base = runtimeFakes();
	const graphStore = new CursorGraphStore(authorityId, tenantId, root.sessionId);
	const supervisor = new AgentSupervisor({
		rootAgentId: ROOT_AGENT_ID,
		ports: { ...base.ports, graphStore },
		clock: () => new Date("2026-07-22T00:00:00.000Z"),
	});
	expect((await supervisor.registerRoot(root)).ok).toBe(true);
	if (options.uncertainLaunch) {
		base.launcher.launch = async () => ({
			ok: false,
			error: {
				code: "reference_unavailable",
				message: "injected unknown launch outcome",
				retryable: true,
			},
		});
	}
	const launchSpecArtifact = {
		...artifact("control-plane-launch"),
		authorityId,
		tenantId,
	};
	const promptArtifact = {
		...artifact("control-plane-prompt"),
		authorityId,
		tenantId,
	};
	const request = spawnRequest(root.capabilityGrant, {
		requestId: createRuntimeId("command", "agent-control-plane-spawn"),
	});
	const head = await graphStore.load(ROOT_AGENT_ID);
	if (!head.ok || !head.value.cursor) throw new Error("root Agent graph did not initialize");
	const command: AgentSpawnCommandV2 = {
		kind: "command",
		type: "agent:spawn",
		commandId: request.requestId,
		idempotencyKey: request.idempotencyKey,
		authorityId,
		tenantId,
		principalId,
		expectedSessionRevision: {
			stream: head.value.cursor.stream,
			sequence: head.value.cursor.sequence,
			eventHash: head.value.cursor.eventHash,
		},
		expectedAgentGraphRevision: head.value.revision,
		sessionHandle: {
			handleId: "handle_0123456789abcdef",
			sessionId: root.sessionId,
			generation: 2,
		},
		payload: {
			sessionId: root.sessionId,
			spec: {
				launchSpecArtifact,
				launchSpecDigest: launchSpecArtifact.storedDigest,
				promptArtifact,
				promptDigest: promptArtifact.storedDigest,
				parentAgentId: request.parentAgentId,
				childAgentId: request.childAgentId,
				childSessionId: request.childSessionId,
				role: request.role,
			},
		},
	};
	const resolved: ResolvedAgentSpawnSpec = {
		request,
		resolutionDigest: canonicalDigest({
			commandId: command.commandId,
			launchSpecArtifact,
			promptArtifact,
			spawnRequestDigest: spawnAgentRequestDigest(request),
		}),
	};
	let resolutions = 0;
	const idempotency = new InMemoryCommandIdempotencyRepository(
		() => new Date("2026-07-24T00:00:00.000Z"),
	);
	const mutationGate = {
		assertMutationOpen: () => ({ ok: true as const, value: undefined }),
	};
	const adapter = new SupervisorMultiAgentControlPlaneAdapter({
		supervisor,
		graphStore,
		rootAgentId: ROOT_AGENT_ID,
		parentSessionId: root.sessionId,
		handles: {
			validate: (handle) => handle.generation === 2
				? { ok: true, value: undefined }
				: {
						ok: false,
						error: {
							code: "stale_session_handle",
							message: "stale test handle",
							retryable: false,
						},
						effect: "none",
					},
		},
		spawns: {
			resolve: async () => {
				resolutions += 1;
				return { ok: true, value: resolved };
			},
		},
		cancellationUsage: {
			resolve: async () => ({ ok: true, value: zeroUsage() }),
		},
		idempotency,
		mutationGate,
		runtimeGeneration: () => 4,
	});
	const context: ControlPlaneRequestContext = {
		peer: {
			transport: "jsonl",
			principalId,
			isLocal: true,
			peerCredentialsVerified: true,
		},
		handshake: {
			kind: "handshake_result",
			requestId: "agent-control-plane-handshake",
			protocol: { major: 1, minor: 1 },
			controlPlaneSchemaVersion: 2,
			runtimeSchemaVersion: 3,
			features: ["session", "multi_agent"],
			serverInstanceId: createRuntimeId("runtime", "agent-control-plane"),
		},
	};
	return {
		adapter,
		base,
		command,
		context,
		graphStore,
		idempotency,
		mutationGate,
		root,
		supervisor,
		get resolutions() {
			return resolutions;
		},
	};
}

async function currentMutationBase(
	test: Awaited<ReturnType<typeof fixture>>,
	seed: string,
) {
	const head = await test.graphStore.load(ROOT_AGENT_ID);
	if (!head.ok || !head.value.cursor) throw new Error("Agent graph cursor is unavailable");
	return {
		kind: "command" as const,
		commandId: createRuntimeId("command", seed),
		idempotencyKey: key(seed),
		authorityId: test.command.authorityId,
		tenantId: test.command.tenantId,
		principalId: test.command.principalId,
		expectedSessionRevision: {
			stream: head.value.cursor.stream,
			sequence: head.value.cursor.sequence,
			eventHash: head.value.cursor.eventHash,
		},
		expectedAgentGraphRevision: head.value.revision,
		sessionHandle: test.command.sessionHandle,
	};
}

describe("Supervisor multi-agent Control Plane adapter", () => {
	it("claims before side effects, reuses the injected Supervisor, and returns a bounded durable effect", async () => {
		const test = await fixture();
		expect(test.adapter.matchesProductionBinding({
			idempotency: test.idempotency,
			mutationGate: test.mutationGate,
			runtimeGeneration: 4,
		})).toBe(true);
		expect(test.adapter.matchesProductionBinding({
			idempotency: new InMemoryCommandIdempotencyRepository(),
			mutationGate: test.mutationGate,
			runtimeGeneration: 4,
		})).toBe(false);
		const executed = await test.adapter.execute(test.command, test.context);
		expect(executed).toMatchObject({
			ok: true,
			value: {
				status: "executed",
				result: {
					type: "agent:spawn",
					sessionId: test.root.sessionId,
					agent: {
						agentId: test.command.payload.spec.childAgentId,
						state: "running",
					},
				},
			},
		});
		if (!executed.ok) return;
		expect(executed.value.result.receiptDigest).toBe(canonicalDigest({
			type: executed.value.result.type,
			sessionId: executed.value.result.sessionId,
			agent: executed.value.result.agent,
			graphRevision: executed.value.result.graphRevision,
			durableCursor: executed.value.result.durableCursor,
		}));
		expect(test.base.launcher.launches).toHaveLength(1);
		expect(test.resolutions).toBe(1);

		const duplicate = await test.adapter.execute(test.command, test.context);
		expect(duplicate).toMatchObject({ ok: true, value: { status: "duplicate" } });
		expect(test.base.launcher.launches).toHaveLength(1);
		expect(test.resolutions).toBe(1);

		const inspected = await test.adapter.inspect({
			kind: "query",
			type: "agent:inspect",
			queryId: "inspect-after-spawn",
			authorityId: test.command.authorityId,
			tenantId: test.command.tenantId,
			principalId: test.command.principalId,
			payload: {
				sessionId: test.root.sessionId,
				sessionHandle: test.command.sessionHandle,
				agentId: test.command.payload.spec.childAgentId,
			},
		}, test.context);
		expect(inspected).toMatchObject({
			ok: true,
			value: {
				result: {
					agents: [{ agentId: test.command.payload.spec.childAgentId }],
				},
			},
		});
	});

	it("rejects a stale graph revision before resolving a launch specification", async () => {
		const test = await fixture();
		const stale = {
			...test.command,
			expectedAgentGraphRevision: test.command.expectedAgentGraphRevision - 1,
		};
		await expect(test.adapter.execute(stale, test.context)).resolves.toMatchObject({
			ok: false,
			error: { code: "expected_revision_conflict" },
		});
		expect(test.base.launcher.launches).toHaveLength(0);
		expect(test.resolutions).toBe(0);
	});

	it("maps cancel and resume through the same durable graph and exact evidence", async () => {
		const cancelled = await fixture();
		expect((await cancelled.adapter.execute(cancelled.command, cancelled.context)).ok).toBe(true);
		const cancelBase = await currentMutationBase(cancelled, "agent-control-plane-cancel");
		await expect(cancelled.adapter.execute({
			...cancelBase,
			type: "agent:cancel",
			payload: {
				sessionId: cancelled.root.sessionId,
				agentId: cancelled.command.payload.spec.childAgentId,
				reasonDigest: digest("c"),
			},
		}, cancelled.context)).resolves.toMatchObject({
			ok: true,
			value: {
				result: {
					type: "agent:cancel",
					agent: { state: "stopped" },
				},
			},
		});

		const resumed = await fixture();
		expect((await resumed.adapter.execute(resumed.command, resumed.context)).ok).toBe(true);
		const running = await resumed.graphStore.load(ROOT_AGENT_ID);
		if (!running.ok) throw new Error(running.error.message);
		const child = running.value.projection.nodes.get(resumed.command.payload.spec.childAgentId);
		if (!child?.residency) throw new Error("spawned child is not resident");
		const evicted = createAgentResidencyReceipt({
			agentId: child.agentId,
			sessionId: child.sessionId,
			runtimeInstanceId: child.residency.runtimeInstanceId,
			state: "evicted",
			revision: child.residency.revision + 1,
			observedAt: "2026-07-22T00:00:01.000Z",
			reasonDigest: digest("e"),
		});
		if (!evicted.ok) throw new Error(evicted.error.message);
		expect((await resumed.supervisor.interrupt(
			child.agentId,
			"residency_evicted",
			evicted.value,
			key("agent-control-plane-pause"),
			zeroUsage(),
		)).ok).toBe(true);
		const paused = await resumed.graphStore.load(ROOT_AGENT_ID);
		if (!paused.ok) throw new Error(paused.error.message);
		const pausedChild = paused.value.projection.nodes.get(child.agentId);
		if (!pausedChild) throw new Error("paused child disappeared");
		const resumeBase = await currentMutationBase(resumed, "agent-control-plane-resume");
		const revalidationDigest = canonicalDigest({
			agentId: pausedChild.agentId,
			parentAgentId: pausedChild.parentAgentId,
			delegationReceiptDigest: pausedChild.delegationReceipt?.receiptDigest ?? null,
			workspaceReceiptDigest: pausedChild.workspaceReceipt.receiptDigest,
			requestedCapabilities: pausedChild.requestedCapabilities,
		});
		await expect(resumed.adapter.execute({
			...resumeBase,
			type: "agent:resume",
			payload: {
				sessionId: resumed.root.sessionId,
				agentId: pausedChild.agentId,
				revalidationDigest,
			},
		}, resumed.context)).resolves.toMatchObject({
			ok: true,
			value: {
				result: {
					type: "agent:resume",
					agent: { state: "running" },
				},
			},
		});
	});

	it("carries an immutable final Artifact through handoff, deterministic merge, cleanup, and replay", async () => {
		const test = await fixture();
		expect((await test.adapter.execute(test.command, test.context)).ok).toBe(true);
		const graph = await test.graphStore.load(ROOT_AGENT_ID);
		if (!graph.ok) throw new Error(graph.error.message);
		const child = graph.value.projection.nodes.get(test.command.payload.spec.childAgentId);
		if (!child) throw new Error("spawned child is absent");
		const resultArtifact = artifact(
			"agent-control-plane-result",
			child.workspaceReceipt.workspaceId,
		);
		expect((await test.supervisor.reportArtifact({
			requestId: createRuntimeId("command", "agent-control-plane-artifact"),
			idempotencyKey: key("agent-control-plane-artifact"),
			report: {
				agentId: child.agentId,
				logicalName: "patch",
				artifact: resultArtifact,
				integrity: "valid",
				verification: "verified",
				inputSources: [],
				declassificationReceipts: [],
				reportedAt: "2026-07-22T00:00:01.000Z",
			},
		})).ok).toBe(true);
		expect((await test.supervisor.finish({
			requestId: createRuntimeId("command", "agent-control-plane-complete"),
			idempotencyKey: key("agent-control-plane-complete"),
			agentId: child.agentId,
			outcome: "completed",
			usage: { ...zeroUsage(), artifactCount: 1, verifications: 1 },
		})).ok).toBe(true);
		const handoffBase = await currentMutationBase(test, "agent-control-plane-handoff");
		const handoffDigest = canonicalDigest({
			parentAgentId: test.root.agentId,
			childAgentId: child.agentId,
			artifactRefs: [resultArtifact],
		});
		const handedOff = await test.adapter.execute({
			...handoffBase,
			type: "agent:handoff",
			payload: {
				sessionId: test.root.sessionId,
				parentAgentId: test.root.agentId,
				childAgentId: child.agentId,
				artifactRefs: [resultArtifact],
				handoffDigest,
			},
		}, test.context);
		expect(handedOff).toMatchObject({
			ok: true,
			value: {
				result: {
					type: "agent:handoff",
					agent: { state: "completed", artifactCount: 1 },
				},
			},
		});
		expect((await test.supervisor.merge({
			requestId: createRuntimeId("command", "agent-control-plane-merge"),
			idempotencyKey: key("agent-control-plane-merge"),
			parentAgentId: test.root.agentId,
			childAgentId: child.agentId,
			handoffId: handoffBase.commandId,
			logicalNames: ["patch"],
		})).ok).toBe(true);
		const replayed = await test.adapter.inspect({
			kind: "query",
			type: "agent:inspect",
			queryId: "agent-control-plane-replay",
			authorityId: test.command.authorityId,
			tenantId: test.command.tenantId,
			principalId: test.command.principalId,
			payload: {
				sessionId: test.root.sessionId,
				sessionHandle: test.command.sessionHandle,
				agentId: child.agentId,
			},
		}, test.context);
		expect(replayed).toMatchObject({
			ok: true,
			value: {
				result: {
					agents: [{ state: "completed", artifactCount: 1 }],
				},
			},
		});
		expect(test.base.workspace.releases).toHaveLength(1);
		expect(test.base.merge.requests).toHaveLength(1);
	});

	it("keeps an unknown provider/runtime outcome in flight and never auto-replays it", async () => {
		const test = await fixture({ uncertainLaunch: true });
		await expect(test.adapter.execute(test.command, test.context)).resolves.toMatchObject({
			ok: false,
			error: { code: "adapter_unavailable" },
			effect: "uncertain",
		});
		expect(test.base.launcher.launches).toHaveLength(0);
		await expect(test.adapter.execute(test.command, test.context)).resolves.toMatchObject({
			ok: false,
			error: { code: "command_in_flight" },
			effect: "uncertain",
		});
		expect(test.resolutions).toBe(1);
	});
});
