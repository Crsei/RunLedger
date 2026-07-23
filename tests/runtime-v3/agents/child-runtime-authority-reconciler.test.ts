import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	MemoryChildRuntimeAuthorityStore,
	createQuarantinedChildRuntimeAuthorityRecord,
	type ChildRuntimeAuthorityRecord,
	type ChildRuntimeAuthorityState,
	type ChildRuntimeAuthorityStorePort,
} from "../../../src/runtime/agents/child-runtime-authority.ts";
import { InMemoryAgentGraphStore } from "../../../src/runtime/agents/graph-store.ts";
import {
	GatewayBoundCapabilitySubsetEvaluator,
	ProductionAgentWorkspaceAdapter,
	ProductionChildSessionLauncher,
	createProductionCapabilityGrantPolicy,
} from "../../../src/runtime/agents/integration/index.ts";
import type {
	ProductionChildSessionLauncherOptions,
} from "../../../src/runtime/agents/integration/child-session-launcher.ts";
import type {
	ValidatedAgentWorkspaceContext,
} from "../../../src/runtime/agents/integration/worktree-workspace.ts";
import { AgentSupervisor } from "../../../src/runtime/agents/supervisor.ts";
import type {
	AgentGraphCommitOutcome,
	AgentGraphSemanticCommand,
	AgentGraphStoreHead,
	AgentResult,
	AgentRuntimeReleaseRequest,
	AgentWorkspaceReceiptRef,
	DurableAgentGraphStorePort,
	ParentCapabilityGrantRef,
	RegisterRootAgentRequest,
	SpawnAgentRequest,
} from "../../../src/runtime/agents/types.ts";
import type { RuntimeIdentityContext } from "../../../src/runtime/identity/types.ts";
import type {
	SessionMutationAdmissionGatePort,
	SessionMutationAdmissionReceipt,
} from "../../../src/runtime/lifecycle/mutation-gate.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createIdempotencyKey } from "../../../src/runtime/protocol/v3/coordination.ts";
import { createSessionEventStreamRef } from "../../../src/runtime/protocol/v3/events.ts";
import { createWorktreeId } from "../../../src/runtime/protocol/v3/workspace.ts";
import {
	createRuntimeId,
	type AgentId,
	type CommandId,
	type SessionId,
} from "../../../src/runtime/protocol/v3/ids.ts";
import { DEFAULT_RUNTIME_FEATURES } from "../../../src/runtime/runtime-features.ts";
import { V3SessionManager } from "../../../src/storage/v3-session-manager.ts";
import type { WorktreeManager } from "../../../src/worktree/manager.ts";
import {
	FakeBudgetPort,
	FakeDeniedAgents,
	FakeMergePort,
	FakeWorkspacePort,
	zeroUsage,
} from "./helpers.ts";

const NOW = "2026-07-23T00:00:00.000Z";
const IDENTITY: RuntimeIdentityContext = {
	authorityId: createRuntimeId("authority", "authority-reconciler"),
	tenantId: createRuntimeId("tenant", "authority-reconciler"),
	principalId: createRuntimeId("principal", "authority-reconciler"),
	source: "managed",
	issuedAt: NOW,
};
const ROOT_AGENT_ID = createRuntimeId("agent", "authority-reconciler-root");
const ROOT_SESSION_ID = createRuntimeId("session", "authority-reconciler-root");
const ROOT_RUNTIME_ID = createRuntimeId("runtime", "authority-reconciler-root");
const CHILD_RUNTIME_ID = createRuntimeId("runtime", "authority-reconciler-child");
const ROOT_GOAL_ID = createRuntimeId("goal", "authority-reconciler-root");
const DIGEST = canonicalDigest("child runtime authority reconciler fixture");
const roots: string[] = [];
const launchers: ProductionChildSessionLauncher[] = [];

type ParentCommitFailure = "append" | "flush";

class FailureInjectingGraphStore implements DurableAgentGraphStorePort {
	public readonly committedCommands: AgentGraphSemanticCommand[] = [];
	#failure: ParentCommitFailure | undefined;
	readonly #delegate: InMemoryAgentGraphStore;

	public constructor(delegate = new InMemoryAgentGraphStore()) {
		this.#delegate = delegate;
	}

	public failNextRuntimeRelease(mode: ParentCommitFailure): void {
		this.#failure = mode;
	}

	public load(rootAgentId: AgentId): Promise<AgentResult<AgentGraphStoreHead>> {
		return this.#delegate.load(rootAgentId);
	}

	public async commit(
		rootAgentId: AgentId,
		expectedRevision: number,
		command: AgentGraphSemanticCommand,
	): Promise<AgentResult<AgentGraphCommitOutcome>> {
		if (command.type === "agent.runtime_released" && this.#failure === "append") {
			this.#failure = undefined;
			return {
				ok: false,
				error: {
					code: "store_unavailable",
					message: "injected parent runtime-released append failure",
					retryable: true,
				},
			};
		}
		const committed = await this.#delegate.commit(rootAgentId, expectedRevision, command);
		if (committed.ok && committed.value.status === "committed") {
			this.committedCommands.push(structuredClone(command));
		}
		if (command.type === "agent.runtime_released" && this.#failure === "flush") {
			this.#failure = undefined;
			return {
				ok: false,
				error: {
					code: "store_unavailable",
					message: "injected parent runtime-released flush acknowledgement loss",
					retryable: true,
				},
			};
		}
		return committed;
	}
}

class RecordingAuthorityStore implements ChildRuntimeAuthorityStorePort {
	public readonly history: ChildRuntimeAuthorityRecord[] = [];
	readonly #delegate = new MemoryChildRuntimeAuthorityStore();

	public read(agentId: AgentId): Promise<ChildRuntimeAuthorityRecord | undefined> {
		return this.#delegate.read(agentId);
	}

	public withExclusiveRootAudit<T>(
		audit: (
			records: readonly ChildRuntimeAuthorityRecord[],
		) => T | Promise<T>,
	): Promise<T> {
		return this.#delegate.withExclusiveRootAudit(audit);
	}

	public list(): Promise<readonly ChildRuntimeAuthorityRecord[]> {
		return this.#delegate.list();
	}

	public async begin(
		record: ChildRuntimeAuthorityRecord,
	): Promise<"applied" | "replay" | "conflict"> {
		const result = await this.#delegate.begin(record);
		if (result === "applied") this.history.push(structuredClone(record));
		return result;
	}

	public async compareAndSwap(
		agentId: AgentId,
		expectedRevision: number,
		expectedRecordDigest: string,
		next: ChildRuntimeAuthorityRecord,
	): Promise<"applied" | "replay" | "conflict"> {
		const result = await this.#delegate.compareAndSwap(
			agentId,
			expectedRevision,
			expectedRecordDigest,
			next,
		);
		if (result === "applied") this.history.push(structuredClone(next));
		return result;
	}
}

class TestWorkspaceAdapter extends ProductionAgentWorkspaceAdapter {
	readonly #rootPath: string;

	public constructor(rootPath: string) {
		super({
			manager: {} as WorktreeManager,
			authorityId: IDENTITY.authorityId,
			tenantId: IDENTITY.tenantId,
			principalId: IDENTITY.principalId,
			repositoryId: createRuntimeId("repository", "authority-reconciler"),
			sourceRepo: rootPath,
			sourceCwd: rootPath,
			rootAgentId: ROOT_AGENT_ID,
			rootOwnerRuntimeId: ROOT_RUNTIME_ID,
		});
		this.#rootPath = rootPath;
	}

	public override withValidatedWorkspace<T>(
		input: {
			requestId: CommandId;
			agentId: AgentId;
			sessionId: SessionId;
			receipt: AgentWorkspaceReceiptRef;
		},
		operation: (context: ValidatedAgentWorkspaceContext) => Promise<AgentResult<T>>,
	): Promise<AgentResult<T>> {
		return operation({
			authorityId: IDENTITY.authorityId,
			tenantId: IDENTITY.tenantId,
			principalId: IDENTITY.principalId,
			repositoryId: input.receipt.repositoryId,
			agentId: input.agentId,
			sessionId: input.sessionId,
			workspaceReceipt: input.receipt,
			runtimeBinding: {
				authorityId: IDENTITY.authorityId,
				tenantId: IDENTITY.tenantId,
				workspaceId: input.receipt.workspaceId,
				repositoryId: input.receipt.repositoryId,
				bindingKind: "managed_worktree",
				canonicalCwd: this.#rootPath,
				effectiveCwd: this.#rootPath,
				branch: "worktree/authority-reconciler",
				baseCommit: DIGEST,
				headCommit: DIGEST,
				worktreeId: createWorktreeId(
					"authority-reconciler",
				),
			},
			envelope: {
				authorityId: IDENTITY.authorityId,
				tenantId: IDENTITY.tenantId,
				principalId: IDENTITY.principalId,
				sessionId: input.sessionId,
				workspaceId: input.receipt.workspaceId,
				repositoryId: input.receipt.repositoryId,
				worktreePath: this.#rootPath,
				branch: "worktree/authority-reconciler",
				baseCommit: DIGEST,
				agentId: input.agentId,
				toolCallId: createRuntimeId("toolCall", "authority-reconciler"),
				traceId: createRuntimeId("trace", "authority-reconciler"),
				cwd: this.#rootPath,
				ownerRuntimeId: CHILD_RUNTIME_ID,
				leaseRevision: input.receipt.leaseRevision ?? 1,
				fencingToken: "test-only-authority-reconciler-fencing-token",
			},
		});
	}
}

function rootWorkspaceReceipt(): AgentWorkspaceReceiptRef {
	const body: Omit<AgentWorkspaceReceiptRef, "receiptDigest"> = {
		receiptId: createRuntimeId("receipt", "authority-reconciler-root-workspace"),
		strategy: {
			strategyId: createRuntimeId("resource", "authority-reconciler-root-workspace"),
			kind: "isolated_lease",
			strategyDigest: canonicalDigest("authority reconciler root workspace strategy"),
		},
		sessionId: ROOT_SESSION_ID,
		workspaceId: createRuntimeId("workspace", "authority-reconciler-root"),
		repositoryId: createRuntimeId("repository", "test"),
		bindingRevision: 1,
		bindingDigest: canonicalDigest("authority reconciler root workspace binding"),
		leaseId: createRuntimeId("lease", "authority-reconciler-root"),
		leaseRevision: 1,
		status: "active",
		issuedAt: NOW,
	};
	return { ...body, receiptDigest: canonicalDigest(body) };
}

function parentGrant(): ParentCapabilityGrantRef {
	return {
		receiptId: createRuntimeId("receipt", "authority-reconciler-parent-grant"),
		receiptDigest: canonicalDigest("authority reconciler parent grant"),
		decisionRevision: 1,
		expiresAt: "2026-07-24T00:00:00.000Z",
	};
}

function rootRegistration(grant: ParentCapabilityGrantRef): RegisterRootAgentRequest {
	return {
		requestId: createRuntimeId("command", "authority-reconciler-register-root"),
		idempotencyKey: createIdempotencyKey("authority-reconciler-register-root"),
		agentId: ROOT_AGENT_ID,
		sessionId: ROOT_SESSION_ID,
		goalId: ROOT_GOAL_ID,
		role: "build",
		workspaceReceipt: rootWorkspaceReceipt(),
		capabilityGrant: grant,
		inputSources: [],
		declassificationReceipts: [],
		registeredAt: NOW,
	};
}

function spawnRequest(grant: ParentCapabilityGrantRef): SpawnAgentRequest {
	return {
		requestId: createRuntimeId("command", "authority-reconciler-spawn"),
		idempotencyKey: createIdempotencyKey("authority-reconciler-spawn-child"),
		parentAgentId: ROOT_AGENT_ID,
		childAgentId: createRuntimeId("agent", "authority-reconciler-child"),
		childSessionId: createRuntimeId("session", "authority-reconciler-child"),
		role: "build",
		objective: "Exercise cold child runtime cleanup reconciliation.",
		expectedArtifacts: [
			{ kind: "diff", mediaType: "text/x-diff", logicalName: "patch" },
		],
		allowPartial: false,
		depth: 1,
		budget: {
			maxTurns: 2,
			maxInputTokens: 1_000,
			maxOutputTokens: 1_000,
			maxUsdMicros: 10_000,
			maxWallTimeMs: 60_000,
			maxToolCalls: 2,
			maxNetworkBytes: 0,
			maxStorageBytes: 10_000,
		},
		parentGrant: grant,
		requestedCapabilities: [],
		workspaceStrategy: {
			strategyId: createRuntimeId("resource", "authority-reconciler-child"),
			kind: "managed_worktree",
			strategyDigest: canonicalDigest("authority reconciler child workspace strategy"),
		},
		inputSources: [],
		declassificationReceipts: [],
	};
}

function parentWriterFence() {
	const body = {
		authorityId: IDENTITY.authorityId,
		tenantId: IDENTITY.tenantId,
		sessionId: ROOT_SESSION_ID,
		runtimeId: ROOT_RUNTIME_ID,
		stream: createSessionEventStreamRef(IDENTITY, ROOT_SESSION_ID),
		leaseId: createRuntimeId("lease", "authority-reconciler-parent"),
		writerEpoch: 1,
		fencingTokenDigest: canonicalDigest("authority reconciler parent fence"),
		acquiredAt: NOW,
		expiresAt: "2026-07-24T00:00:00.000Z",
	};
	const receiptDigest = canonicalDigest(body);
	return {
		...body,
		receiptId: createRuntimeId("receipt", `writer-fence-${receiptDigest.slice(0, 48)}`),
		receiptDigest,
	};
}

function parentAdmissionGate(): SessionMutationAdmissionGatePort {
	return {
		revalidate: async (request) => {
			const body: Omit<SessionMutationAdmissionReceipt, "receiptDigest"> = {
				schemaVersion: 1,
				authorityId: IDENTITY.authorityId,
				tenantId: IDENTITY.tenantId,
				sessionId: ROOT_SESSION_ID,
				kind: request.kind,
				correlationId: request.correlationId,
				eventHead: {
					stream: createSessionEventStreamRef(IDENTITY, ROOT_SESSION_ID),
					sequence: 1,
					eventId: createRuntimeId("event", "authority-reconciler-parent-head"),
					eventHash: DIGEST,
				},
				checkedAt: NOW,
				auditReceipts: [],
			};
			return { ok: true, value: { ...body, receiptDigest: canonicalDigest(body) } };
		},
	};
}

function createCapabilitySubset(grant: ParentCapabilityGrantRef) {
	return new GatewayBoundCapabilitySubsetEvaluator([
		createProductionCapabilityGrantPolicy({
			policyReceiptId: createRuntimeId("receipt", "authority-reconciler-policy"),
			parentGrant: grant,
			allowedRequests: [],
			delegableToolKinds: [],
			childSpawnAllowed: true,
			decisionRevision: 2,
			evaluatorId: IDENTITY.principalId,
			issuedAt: NOW,
			expiresAt: "2026-07-24T00:00:00.000Z",
		}),
	], () => new Date(NOW));
}

interface ColdFailureFixture {
	authorityStore: RecordingAuthorityStore;
	graphStore: FailureInjectingGraphStore;
	launcherOptions: ProductionChildSessionLauncherOptions;
	workspace: FakeWorkspacePort;
	budget: FakeBudgetPort;
	childAgentId: AgentId;
}

async function coldFailureFixture(mode: ParentCommitFailure): Promise<ColdFailureFixture> {
	const rootPath = await mkdtemp(join(tmpdir(), "runledger-authority-reconciler-"));
	roots.push(rootPath);
	const grant = parentGrant();
	const capabilitySubset = createCapabilitySubset(grant);
	const authorityStore = new RecordingAuthorityStore();
	const launcherOptions: ProductionChildSessionLauncherOptions = {
		workspace: new TestWorkspaceAdapter(rootPath),
		capabilitySubset,
		parentMutationGate: parentAdmissionGate(),
		sessionDir: join(rootPath, "child-sessions"),
		features: { ...DEFAULT_RUNTIME_FEATURES, sessionV3: true },
		identity: IDENTITY,
		maxActiveChildren: 1,
		authorityStore,
		parentAuthority: {
			parentSessionId: ROOT_SESSION_ID,
			resolve: async () => ({
				ok: true,
				value: {
					parentSessionId: ROOT_SESSION_ID,
					ownerParentRuntimeId: ROOT_RUNTIME_ID,
					parentGraphRevision: 1,
					parentGraphCursor: {
						stream: createSessionEventStreamRef(IDENTITY, ROOT_SESSION_ID),
						sequence: 1,
						eventId: createRuntimeId("event", "authority-reconciler-parent-head"),
						eventHash: DIGEST,
					},
					parentNodeDigest: canonicalDigest("authority reconciler parent node"),
					ownerParentWriterFence: parentWriterFence(),
				},
			}),
		},
		clock: () => new Date(NOW),
	};
	const launcher = new ProductionChildSessionLauncher(launcherOptions);
	launchers.push(launcher);
	const graphStore = new FailureInjectingGraphStore();
	const workspace = new FakeWorkspacePort();
	const budget = new FakeBudgetPort();
	const supervisor = new AgentSupervisor({
		rootAgentId: ROOT_AGENT_ID,
		ports: {
			graphStore,
			capabilitySubset,
			workspace,
			budget,
			launcher,
			deniedAgents: new FakeDeniedAgents(),
			merge: new FakeMergePort(),
		},
		clock: () => new Date(NOW),
	});
	const registered = await supervisor.registerRoot(rootRegistration(grant));
	if (!registered.ok) throw new Error(registered.error.message);
	const spawned = await supervisor.spawn(spawnRequest(grant));
	if (!spawned.ok) throw new Error(spawned.error.message);
	graphStore.failNextRuntimeRelease(mode);
	const finished = await supervisor.finish({
		requestId: createRuntimeId("command", "authority-reconciler-finish"),
		idempotencyKey: createIdempotencyKey("authority-reconciler-finish-child"),
		agentId: spawned.value.node.agentId,
		outcome: "failed",
		reason: "crash",
		usage: zeroUsage(),
	});
	expect(finished).toMatchObject({
		ok: false,
		error: { code: "store_unavailable", retryable: true },
	});
	return {
		authorityStore,
		graphStore,
		launcherOptions,
		workspace,
		budget,
		childAgentId: spawned.value.node.agentId,
	};
}

function recordInState<S extends ChildRuntimeAuthorityState>(
	history: readonly ChildRuntimeAuthorityRecord[],
	state: S,
): Extract<ChildRuntimeAuthorityRecord, { state: S }> {
	const record = history.find((candidate) => candidate.state === state);
	if (!record) throw new Error(`authority history lacks ${state}`);
	return record as Extract<ChildRuntimeAuthorityRecord, { state: S }>;
}

async function storeAtState(
	history: readonly ChildRuntimeAuthorityRecord[],
	state: Exclude<ChildRuntimeAuthorityState, "released">,
): Promise<MemoryChildRuntimeAuthorityStore> {
	const claimed = recordInState(history, "claimed");
	const store = new MemoryChildRuntimeAuthorityStore();
	expect(await store.begin(claimed)).toBe("applied");
	if (state === "claimed") return store;
	if (state === "quarantined") {
		const quarantined = createQuarantinedChildRuntimeAuthorityRecord({
			previous: claimed,
			reason: "cold_recovery_unsupported",
			evidenceDigest: canonicalDigest({
				agentId: claimed.agentId,
				recordDigest: claimed.recordDigest,
				reason: "cold_recovery_unsupported",
			}),
			updatedAt: NOW,
		});
		expect(await store.compareAndSwap(
			claimed.agentId,
			claimed.revision,
			claimed.recordDigest,
			quarantined,
		)).toBe("applied");
		return store;
	}
	const creating = recordInState(history, "creating");
	expect(await store.compareAndSwap(
		claimed.agentId,
		claimed.revision,
		claimed.recordDigest,
		creating,
	)).toBe("applied");
	if (state === "creating") return store;
	const provisional = recordInState(history, "provisional");
	expect(await store.compareAndSwap(
		creating.agentId,
		creating.revision,
		creating.recordDigest,
		provisional,
	)).toBe("applied");
	if (state === "provisional") return store;
	const resident = recordInState(history, "resident");
	expect(await store.compareAndSwap(
		provisional.agentId,
		provisional.revision,
		provisional.recordDigest,
		resident,
	)).toBe("applied");
	if (state === "resident") return store;
	const pending = recordInState(history, "release_pending");
	expect(await store.compareAndSwap(
		resident.agentId,
		resident.revision,
		resident.recordDigest,
		pending,
	)).toBe("applied");
	return store;
}

async function cloneGraph(
	commands: readonly AgentGraphSemanticCommand[],
): Promise<InMemoryAgentGraphStore> {
	const store = new InMemoryAgentGraphStore();
	for (const command of commands) {
		const loaded = await store.load(ROOT_AGENT_ID);
		if (!loaded.ok) throw new Error(loaded.error.message);
		const committed = await store.commit(
			ROOT_AGENT_ID,
			loaded.value.revision,
			structuredClone(command),
		);
		if (!committed.ok || committed.value.status !== "committed") {
			throw new Error("could not clone pending parent graph");
		}
	}
	return store;
}

function changedReleaseRequest(
	request: AgentRuntimeReleaseRequest,
): AgentRuntimeReleaseRequest {
	const { requestDigest: _requestDigest, ...body } = request;
	const changedBody = {
		...body,
		requestId: createRuntimeId("command", "authority-reconciler-changed-release"),
	};
	return { ...changedBody, requestDigest: canonicalDigest(changedBody) };
}

afterEach(async () => {
	await Promise.all(
		launchers.splice(0).map((launcher) => launcher.close().catch(() => undefined)),
	);
	vi.restoreAllMocks();
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

describe("child runtime authority cold cleanup reconciliation", () => {
	it.each(["append", "flush"] as const)(
		"replays a durable released sidecar after parent %s failure without repeating stop or close",
		async (failureMode) => {
			const stop = vi.spyOn(V3SessionManager.prototype, "requestStop");
			const close = vi.spyOn(V3SessionManager.prototype, "closeAll");
			const runtime = await coldFailureFixture(failureMode);
			const released = recordInState(runtime.authorityStore.history, "released");

			expect(released.releaseReceipt.requestDigest).toBe(
				released.releaseRequest.requestDigest,
			);
			expect(stop).toHaveBeenCalledTimes(1);
			expect(close).toHaveBeenCalledTimes(1);
			expect(runtime.workspace.releaseExecutions).toBe(0);
			expect(runtime.budget.settlementExecutions).toBe(0);

			const freshLauncher = new ProductionChildSessionLauncher({
				...runtime.launcherOptions,
				authorityStore: runtime.authorityStore,
			});
			launchers.push(freshLauncher);
			expect(await freshLauncher.release(released.releaseRequest)).toEqual({
				ok: true,
				value: released.releaseReceipt,
			});
			expect(await freshLauncher.release(
				changedReleaseRequest(released.releaseRequest),
			)).toMatchObject({
				ok: false,
				error: { code: "idempotency_conflict", retryable: false },
			});
			expect(stop).toHaveBeenCalledTimes(1);
			expect(close).toHaveBeenCalledTimes(1);

			const release = vi.spyOn(freshLauncher, "release");
			const restarted = new AgentSupervisor({
				rootAgentId: ROOT_AGENT_ID,
				ports: {
					graphStore: runtime.graphStore,
					capabilitySubset: runtime.launcherOptions.capabilitySubset,
					workspace: runtime.workspace,
					budget: runtime.budget,
					launcher: freshLauncher,
					deniedAgents: new FakeDeniedAgents(),
					merge: new FakeMergePort(),
				},
				clock: () => new Date(NOW),
			});
			const reconciled = await restarted.reconcilePendingCleanups();
			expect(reconciled.ok).toBe(true);
			if (!reconciled.ok) return;
			expect(
				reconciled.value.cleanups.get(runtime.childAgentId),
			).toMatchObject({
				runtimeRelease: {
					receipt: released.releaseReceipt,
				},
				workspaceRelease: expect.any(Object),
				budgetSettlement: expect.any(Object),
				completionReceipt: expect.any(Object),
			});
			expect(release).toHaveBeenCalledTimes(failureMode === "append" ? 1 : 0);
			expect(stop).toHaveBeenCalledTimes(1);
			expect(close).toHaveBeenCalledTimes(1);
			expect(runtime.workspace.releaseExecutions).toBe(1);
			expect(runtime.budget.settlementExecutions).toBe(1);
		},
	);

	it("keeps every cold partial authority state ahead of Workspace and Budget effects", async () => {
		const runtime = await coldFailureFixture("append");
		const partialStates = [
			"claimed",
			"creating",
			"provisional",
			"resident",
			"release_pending",
			"quarantined",
		] as const;

		for (const state of partialStates) {
			const authorityStore = await storeAtState(
				runtime.authorityStore.history,
				state,
			);
			const launcher = new ProductionChildSessionLauncher({
				...runtime.launcherOptions,
				authorityStore,
			});
			launchers.push(launcher);
			const workspace = new FakeWorkspacePort();
			const budget = new FakeBudgetPort();
			const restarted = new AgentSupervisor({
				rootAgentId: ROOT_AGENT_ID,
				ports: {
					graphStore: await cloneGraph(
						runtime.graphStore.committedCommands,
					),
					capabilitySubset: runtime.launcherOptions.capabilitySubset,
					workspace,
					budget,
					launcher,
					deniedAgents: new FakeDeniedAgents(),
					merge: new FakeMergePort(),
				},
				clock: () => new Date(NOW),
			});

			expect(await restarted.reconcilePendingCleanups()).toMatchObject({
				ok: false,
				error: {
					code: "reference_unavailable",
					retryable: true,
				},
			});
			expect(workspace.releases, state).toHaveLength(0);
			expect(workspace.releaseExecutions, state).toBe(0);
			expect(budget.settlements, state).toHaveLength(0);
			expect(budget.settlementExecutions, state).toBe(0);
			expect(await authorityStore.read(runtime.childAgentId), state).toMatchObject({
				state,
			});
		}
	});
});
