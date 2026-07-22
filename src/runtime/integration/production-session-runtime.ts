/**
 * Governed v3 session 的生产服务组合根。
 *
 * 本模块只接受已经由 Worktree 专项签发并持久化的 binding，以及已经完成
 * production probe 的 Verification/LoopBreaker 端口；不会用 process-memory fake
 * 补齐缺失能力。
 */

import { join } from "node:path";
import type { ArtifactRepository } from "../artifacts/cas-store.ts";
import type { ArtifactRef } from "../protocol/v3/capability.ts";
import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import { createIdempotencyKey } from "../protocol/v3/coordination.ts";
import type { RuntimeEventType } from "../protocol/v3/event-catalog.ts";
import { sameRuntimeEventStream, type ExpectedRevision, type RuntimeEventV3 } from "../protocol/v3/events.ts";
import {
	createRuntimeId,
	type PrincipalId,
	type SessionId,
	type WorkspaceId,
} from "../protocol/v3/ids.ts";
import type { DeclassificationReceiptRef, InputSourceRef } from "../protocol/v3/taint.ts";
import type { RuntimeEventDraft } from "../session/types.ts";
import { readAllRuntimeEvents } from "../session/snapshot.ts";
import type { EventWriter } from "../session/event-writer.ts";
import {
	createInactivePlanModeState,
	PlanModeService,
	type PlanRuntimeEvent,
	type PlanRuntimeEventSink,
} from "../modes/plan/service.ts";
import type { PlanModeState } from "../modes/plan/types.ts";
import {
	MemoryService,
	type MemoryEventSink,
	type MemoryRuntimeEvent,
} from "../context/memory/service.ts";
import type { MemoryScopeRef } from "../context/memory/types.ts";
import {
	CompactionService,
	type CompactionArtifactPort,
	type CompactionEventSink,
	type CompactionRuntimeEvent,
} from "../context/compaction/service.ts";
import type { CompactionSummarySampler } from "../context/compaction/summarizer.ts";
import type { CompactedHistoryProjection } from "../context/compaction/projection.ts";
import {
	BudgetGuard,
	type BudgetLimits,
} from "../orchestrator/budget-guard.ts";
import { BudgetGuardAgentOperationAdapter } from "../orchestrator/agent-loop-budget.ts";
import { CanonicalAgentQueueAdapter } from "../orchestrator/canonical-queue.ts";
import {
	createDurableGoalStateMachine,
	type DurableGoalStateMachine,
} from "../orchestrator/goal-state-machine.ts";
import type { LoopBreaker } from "../orchestrator/loop-breaker.ts";
import {
	openSavePointCoordinator,
	type SavePointCoordinator,
} from "../orchestrator/save-point.ts";
import { SessionDurableOrchestratorJournal } from "../orchestrator/session-journal.ts";
import {
	SessionCanonicalBudgetJournal,
	SessionCanonicalGoalJournal,
} from "../orchestrator/canonical-journals.ts";
import { SessionTaskRepository } from "../orchestrator/task-repository.ts";
import { TurnOrchestrator } from "../orchestrator/turn-orchestrator.ts";
import type {
	CompletionTrustPort,
	OperationBindings,
	SavePointJournalRecord,
} from "../orchestrator/types.ts";
import type { VerificationPipeline } from "../verification/pipeline.ts";
import type { VerificationSessionRuntime } from "../verification/session-runtime.ts";
import type { V3SessionManager } from "../../storage/v3-session-manager.ts";
import { PlanArtifactStore } from "../../storage/plan-artifact-store.ts";
import { MemoryStore } from "../../storage/memory-store.ts";
import { MemoryLexicalIndex } from "../../storage/memory-index.ts";
import { FileCompactionProjectionStore } from "../../storage/compaction-projection-store.ts";
import { FilePlanModeStateStore } from "../../storage/plan-mode-state-store.ts";
import { getAgentDir, getProjectDir } from "../../storage/paths.ts";
import type { PersistedWorkspaceBinding } from "../../worktree/types.ts";

type DomainRuntimeEvent = PlanRuntimeEvent | MemoryRuntimeEvent | CompactionRuntimeEvent;

class DurableDomainEventSink implements PlanRuntimeEventSink, MemoryEventSink, CompactionEventSink {
	readonly #writer: EventWriter;

	public constructor(writer: EventWriter) {
		this.#writer = writer;
	}

	public async append(event: DomainRuntimeEvent): Promise<void> {
		const appended = await this.#writer.append(event as RuntimeEventDraft<RuntimeEventType>);
		if (!appended.ok) throw new Error(`domain event append failed: ${appended.error.code}`);
		const flushed = await this.#writer.flush();
		if (!flushed.ok || !flushed.value || flushed.value.eventHash !== appended.value.cursor.eventHash) {
			throw new Error("domain event durable barrier did not cover the appended cursor");
		}
	}
}

interface ArtifactCompactionScope {
	authorityId: ReturnType<V3SessionManager["identity"]>["authorityId"];
	tenantId: ReturnType<V3SessionManager["identity"]>["tenantId"];
	principalId: PrincipalId;
	sessionId: SessionId;
	workspaceId: WorkspaceId;
}

class ArtifactCompactionPort implements CompactionArtifactPort {
	readonly #repository: ArtifactRepository;
	readonly #scope: ArtifactCompactionScope;

	public constructor(repository: ArtifactRepository, scope: ArtifactCompactionScope) {
		this.#repository = repository;
		this.#scope = scope;
	}

	public async put(input: {
		kind: "log" | "session_report";
		mediaType: "application/json" | "text/markdown";
		body: string;
		inputSources: readonly InputSourceRef[];
		declassificationReceipts: readonly DeclassificationReceiptRef[];
	}): Promise<ArtifactRef> {
		const contentDigest = canonicalDigest(input.body);
		const artifactId = createRuntimeId("artifact", `compaction-${input.kind}-${contentDigest.slice(0, 40)}`);
		const intentId = createRuntimeId("command", `compaction-${canonicalDigest({
			artifactId,
			sessionId: this.#scope.sessionId,
			workspaceId: this.#scope.workspaceId,
		}).slice(0, 48)}`);
		const written = await this.#repository.write({
			authorityId: this.#scope.authorityId,
			tenantId: this.#scope.tenantId,
			artifactId,
			intentId,
			principalId: this.#scope.principalId,
			source: {
				sessionId: this.#scope.sessionId,
				workspaceId: this.#scope.workspaceId,
				producerId: this.#scope.principalId,
			},
			kind: input.kind,
			mediaType: input.mediaType,
			content: input.body,
			redaction: "default",
			lineage: {
				origin: "model_derived",
				inputSources: input.inputSources,
				declassificationReceipts: input.declassificationReceipts,
			},
		});
		if (!written.ok) throw new Error(`compaction Artifact commit failed: ${written.error.code}`);
		if (written.value.state !== "committed" || !written.value.reference) {
			throw new Error("compaction Artifact did not reach a durable committed state");
		}
		return written.value.reference;
	}
}

export interface ProductionVerificationServices {
	implementation: "production";
	authorityId: ReturnType<V3SessionManager["identity"]>["authorityId"];
	tenantId: ReturnType<V3SessionManager["identity"]>["tenantId"];
	sessionId: SessionId;
	evidenceDigest: string;
	pipeline: VerificationPipeline;
	sessionRuntime: VerificationSessionRuntime;
	completionTrust: CompletionTrustPort;
}

export interface ProductionSessionRuntimeOptions {
	manager: V3SessionManager;
	workspace: PersistedWorkspaceBinding;
	verification: ProductionVerificationServices;
	compaction: {
		sampler: CompactionSummarySampler;
	};
	orchestrator: {
		budgetLimits: BudgetLimits;
		initialBindings: OperationBindings;
		/** 必须由 production composition 提供其 replay 状态，不能在这里创建空内存替身。 */
		loopBreaker: LoopBreaker;
	};
	memoryRoots?: {
		userRoot?: string;
		projectRoot?: string;
	};
	clock?: () => Date;
}

export interface ProductionSessionRuntime {
	workspace: PersistedWorkspaceBinding;
	planStore: PlanArtifactStore;
	plan: PlanModeService;
	memoryStore: MemoryStore;
	memoryIndex: MemoryLexicalIndex;
	memory: MemoryService;
	memoryScopes: readonly MemoryScopeRef[];
	compactionProjection: FileCompactionProjectionStore;
	compaction: CompactionService;
	goal: DurableGoalStateMachine;
	tasks: SessionTaskRepository;
	budget: BudgetGuard;
	operationBudget: BudgetGuardAgentOperationAdapter;
	savePoints: SavePointCoordinator;
	queue: CanonicalAgentQueueAdapter;
	turns: TurnOrchestrator;
	verification: ProductionVerificationServices;
}

function persistedBindingDigest(binding: PersistedWorkspaceBinding): string {
	const { bindingDigest: _bindingDigest, ...body } = binding;
	return canonicalDigest(body);
}

function assertProductionInputs(options: ProductionSessionRuntimeOptions): void {
	const identity = options.manager.identity();
	const binding = options.workspace;
	if (options.manager.isClosed() || binding.bindingDigest !== persistedBindingDigest(binding) ||
		binding.authorityId !== identity.authorityId || binding.tenantId !== identity.tenantId ||
		binding.principalId !== identity.principalId || binding.sessionId !== options.manager.sessionId() ||
		binding.ownerRuntimeId !== options.manager.runtimeId() || binding.leaseRevision < 1) {
		throw new Error("production session requires an exact active durable workspace binding");
	}
	const verification = options.verification;
	if (verification.implementation !== "production" || verification.authorityId !== identity.authorityId ||
		verification.tenantId !== identity.tenantId || verification.sessionId !== options.manager.sessionId() ||
		!/^[a-f0-9]{64}$/u.test(verification.evidenceDigest) || new Set(verification.evidenceDigest).size < 4) {
		throw new Error("production verification services are absent or not correlated to the session");
	}
	const workspace = options.orchestrator.initialBindings.workspace;
	if (!workspace || workspace.workspaceId !== binding.workspaceId ||
		workspace.bindingRevision !== binding.leaseRevision || workspace.bindingDigest !== binding.bindingDigest) {
		throw new Error("orchestrator save-point bindings do not pin the active workspace binding");
	}
}

function eventRevision(event: RuntimeEventV3): ExpectedRevision {
	return { stream: event.stream, sequence: event.sequence, eventHash: event.currentEventHash };
}

async function planStateFor(
	manager: V3SessionManager,
	workspaceId: WorkspaceId,
	events: readonly RuntimeEventV3[],
	clock: () => Date,
): Promise<{ state: PlanModeState; store: FilePlanModeStateStore }> {
	const identity = manager.identity();
	const store = new FilePlanModeStateStore({
		path: join(manager.stateDirectory(), "context", "plan-mode-state.json"),
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		sessionId: manager.sessionId(),
		workspaceId,
		currentRevision: () => {
			const head = manager.writer().currentHead();
			return head ? { stream: head.stream, sequence: head.sequence, eventHash: head.eventHash } : undefined;
		},
	});
	const loaded = await store.load();
	const latest = [...events].reverse().find((event) => event.type === "mode.transitioned");
	if (!latest) {
		if (loaded && (loaded.state.kind !== "inactive" || loaded.state.modeRevision !== 0)) {
			throw new Error("plan mode projection exists without a canonical mode transition");
		}
		return {
			state: loaded?.state ?? createInactivePlanModeState({
				authorityId: identity.authorityId,
				tenantId: identity.tenantId,
				principalId: identity.principalId,
				sessionId: manager.sessionId(),
				workspaceId,
			}, events[0]?.timestamp ?? clock().toISOString()),
			store,
		};
	}
	if (!loaded || !sameRuntimeEventStream(loaded.eventRevision.stream, latest.stream) ||
		loaded.eventRevision.sequence !== latest.sequence || loaded.eventRevision.eventHash !== latest.currentEventHash ||
		loaded.state.modeRevision !== latest.payload.modeRevision || loaded.state.kind !== latest.payload.toState ||
		loaded.state.mode !== latest.payload.to) {
		throw new Error("plan mode projection is missing or stale relative to canonical events");
	}
	return { state: loaded.state, store };
}

function latestCompletedCompaction(events: readonly RuntimeEventV3[]) {
	return [...events].reverse().find((event) => event.type === "compaction.completed");
}

function assertCompactionProjection(
	events: readonly RuntimeEventV3[],
	projection: CompactedHistoryProjection | undefined,
): void {
	const completed = latestCompletedCompaction(events);
	if (!completed && projection) throw new Error("compaction projection has no canonical completed event");
	if (completed && (!projection || projection.checkpoint.checkpointId !== completed.payload.checkpointId ||
		projection.checkpoint.compactionId !== completed.payload.compactionId ||
		projection.checkpoint.summaryDigest !== completed.payload.summaryDigest ||
		projection.checkpoint.invariantDigest !== completed.payload.invariantDigest)) {
		throw new Error("compaction projection recovery is required before the session can resume");
	}
}

export async function createProductionSessionRuntime(
	options: ProductionSessionRuntimeOptions,
): Promise<ProductionSessionRuntime> {
	assertProductionInputs(options);
	const eventStore = options.manager.eventStore();
	const verification = await eventStore.verify(eventStore.streamRef());
	if (!verification.ok || verification.value.integrity !== "valid") {
		throw new Error("production session event chain is not valid");
	}
	const replay = await readAllRuntimeEvents(options.manager.eventStore());
	if (!replay.ok) throw new Error(`production session event replay failed: ${replay.error.code}`);
	const events = replay.value;
	const identity = options.manager.identity();
	const clock = options.clock ?? (() => new Date());
	const domainEvents = new DurableDomainEventSink(options.manager.writer());
	const planState = await planStateFor(options.manager, options.workspace.workspaceId, events, clock);
	const contextRoot = join(options.manager.stateDirectory(), "context");
	const planStore = new PlanArtifactStore(contextRoot, {
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		sessionId: options.manager.sessionId(),
		workspaceId: options.workspace.workspaceId,
		principalId: identity.principalId,
	});
	if ("plan" in planState.state && await planStore.inspectWorkingCopy(planState.state.plan) !== "current") {
		throw new Error("plan mode working copy is missing or changed outside its immutable revision");
	}
	const plan = new PlanModeService({
		identity: {
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			principalId: identity.principalId,
			sessionId: options.manager.sessionId(),
			workspaceId: options.workspace.workspaceId,
		},
		state: planState.state,
		store: planStore,
		events: domainEvents,
		projection: planState.store,
		clock,
	});

	const memoryStore = new MemoryStore({
		userRoot: options.memoryRoots?.userRoot ?? getAgentDir(),
		projectRoot: options.memoryRoots?.projectRoot ?? getProjectDir(options.workspace.sourceRepo),
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		principalId: identity.principalId,
		workspaceId: options.workspace.workspaceId,
		sessionId: options.manager.sessionId(),
	});
	const memoryIndex = new MemoryLexicalIndex(join(contextRoot, "memory-index.json"));
	const memory = new MemoryService({
		identity: {
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			principalId: identity.principalId,
			sessionId: options.manager.sessionId(),
			workspaceId: options.workspace.workspaceId,
		},
		store: memoryStore,
		index: memoryIndex,
		events: domainEvents,
		clock,
	});
	const memoryScopes: readonly MemoryScopeRef[] = [
		{ scope: "session", sessionId: options.manager.sessionId() },
		{ scope: "workspace", workspaceId: options.workspace.workspaceId },
		{ scope: "user", ownerPrincipalId: identity.principalId },
	];

	const compactionProjection = new FileCompactionProjectionStore({
		path: join(contextRoot, "compaction-projection.json"),
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		sessionId: options.manager.sessionId(),
	});
	assertCompactionProjection(events, await compactionProjection.load());
	const compaction = new CompactionService({
		identity: {
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			principalId: identity.principalId,
			sessionId: options.manager.sessionId(),
		},
		sampler: options.compaction.sampler,
		artifacts: new ArtifactCompactionPort(options.manager.artifactRepository(), {
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			principalId: identity.principalId,
			sessionId: options.manager.sessionId(),
			workspaceId: options.workspace.workspaceId,
		}),
		events: domainEvents,
		projection: compactionProjection,
		clock,
	});

	const journalBase = {
		writer: options.manager.writer(),
		store: options.manager.eventStore(),
		principalId: identity.principalId,
	} as const;
	const goalJournal = new SessionCanonicalGoalJournal(journalBase);
	const goalId = options.manager.sessionEvents().lineage().goalId;
	const goalResult = await createDurableGoalStateMachine({
		journal: goalJournal,
		completionTrust: options.verification.completionTrust,
		clock,
	}, {
		goalId,
		phase: "planning",
		revision: 0,
		evidence: [],
		partialResults: [],
	}, createIdempotencyKey(`goal-genesis-${canonicalDigest({ sessionId: options.manager.sessionId(), goalId }).slice(0, 48)}`));
	if (!goalResult.ok) throw new Error(`production goal recovery failed: ${goalResult.error.code}`);

	const budget = new BudgetGuard({
		goalId,
		limits: options.orchestrator.budgetLimits,
		journal: new SessionCanonicalBudgetJournal({
			...journalBase,
			goalId,
			limits: options.orchestrator.budgetLimits,
		}),
		clock,
	});
	const tasks = new SessionTaskRepository({ ...journalBase, clock });
	const taskProjection = await tasks.load();
	if (!taskProjection.ok) throw new Error(`production task recovery failed: ${taskProjection.error.code}`);
	if (taskProjection.value.goalId !== null && taskProjection.value.goalId !== goalId) {
		throw new Error("production task projection belongs to another goal");
	}
	const operationBudget = new BudgetGuardAgentOperationAdapter(budget, clock);
	const savePointResult = await openSavePointCoordinator({
		initialBindings: options.orchestrator.initialBindings,
		journal: new SessionDurableOrchestratorJournal<SavePointJournalRecord>({ ...journalBase, journalKind: "save_point" }),
		clock,
	});
	if (!savePointResult.ok) throw new Error(`production save-point recovery failed: ${savePointResult.error.code}`);
	// queue.* canonical projection 是唯一真源；不再创建 opaque Orchestrator queue journal。
	const queue = new CanonicalAgentQueueAdapter(options.manager.sessionEvents());
	const turns = new TurnOrchestrator({
		budget,
		savePoints: savePointResult.value,
		loopBreaker: options.orchestrator.loopBreaker,
	});

	return {
		workspace: structuredClone(options.workspace),
		planStore,
		plan,
		memoryStore,
		memoryIndex,
		memory,
		memoryScopes,
		compactionProjection,
		compaction,
		goal: goalResult.value,
		tasks,
		budget,
		operationBudget,
		savePoints: savePointResult.value,
		queue,
		turns,
		verification: options.verification,
	};
}
