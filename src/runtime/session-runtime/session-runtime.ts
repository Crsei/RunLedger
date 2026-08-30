/**
 * R5/R6/R7:SessionRuntime(06 §7) —— lifecycle facade 与 collaborator wiring。
 *
 * S5 拆分后本文件保留:公共类型、SessionRuntime 类(装配 + 公开查询 +
 * handleCommand/handleQuery 委托)与 domain listener wiring。实现协作者:
 * - `lifecycle-controller.ts`  start/pause/fenced/orderly shutdown(runtime state owner);
 * - `event-persistence.ts`    normalized event、checkpoint boundary(runTiming/stream 所有者);
 * - `attempt-controller.ts`   begin/settle/recovery assess/decide(barrier 使用方);
 * - `command-handler.ts`      mutation operation router;
 * - `query-handler.ts`        query operation router;
 * - `idle-recap-controller.ts` 对 IdleRecapCoordinator 的 runtime adapter。
 *
 * 协作者只通过窄 port 注入,不反向访问 facade 私有状态。
 */

import type { SessionStore } from "../../storage/session-store/session-store.ts";
import { OwnerStore } from "../../storage/session-store/owner-store.ts";
import type { SessionOwner } from "../session-owner/session-owner.ts";
import type { SessionRuntimeServer } from "../session-server/runtime-server.ts";
import { type SessionCommandRequest, type SessionCommandResult, type SessionController, type SessionControllerEvent, type SessionQueryRequest, type SessionSnapshot } from "../session-server/runtime-server.ts";
import { RecoveryBarrier, type RecoveryDecision } from "./recovery-barrier.ts";
import type { RestoreOutcome } from "./restore.ts";
import type { CheckpointSnapshot } from "./checkpoint.ts";
import type { LateBoundAttemptPort, StableAttemptRequest, AttemptPortBeginResult } from "./attempt-gateway.ts";
import type { RuntimeDigest } from "../protocol/foundation.ts";
import type { AttemptId, SessionId, ConnectionId } from "../protocol/ids.ts";
import type { CommandAttemptOutcome, CommandEffectClass, OwnerFence, SessionCheckpointBoundary } from "../session-owner/types.ts";
import type { AgentEvent, AgentMessage } from "../types.ts";
import type { LedgerEntry } from "../ledger/types.ts";
import type { InteractiveSessionControllerPort, ProviderStatus, RuntimeSelection, SessionTitleChangedEvent } from "../interactive-session-controller.ts";
import { SESSION_CORE_PROTOCOL_MANIFEST, freezeSessionProtocolManifest, type SessionProtocolCapability, type SessionProtocolManifest, type SessionProtocolOperationDescriptor, type SessionStatus } from "../session-server/protocol.ts";
import { SessionDomainRouter } from "./domain-router.ts";
import type { SessionDomainResult } from "./domain-router.ts";
import type { AgentRunSummary, HumanWaitReason, LateBoundAgentRunBudgetUsage } from "./run-timing.ts";
import type { SessionPlanInspection } from "./plan-composition.ts";
import type { LateBoundHumanInputWaitPort } from "./approval-reverse-request.ts";
import type { SessionProductionToolSource } from "../agents/capability-subset.ts";
import type { ChildModelRuntimeFactoryPort } from "../agents/child-model-runtime.ts";
import type { MultiAgentDomainPort } from "../agents/domain.ts";
import { DEFAULT_RECAP_SETTINGS, type EffectiveRecapSettings } from "../../storage/settings-manager.ts";
import { SessionEventPersistence } from "./event-persistence.ts";
import { SessionIdleRecapController } from "./idle-recap-controller.ts";
import { SessionAttemptController } from "./attempt-controller.ts";
import { SessionLifecycleController } from "./lifecycle-controller.ts";
import { SessionCommandHandler } from "./command-handler.ts";
import { SessionQueryHandler } from "./query-handler.ts";

export type SessionRuntimeState = "starting" | "ready" | "recovery_required" | "ready_with_uncertainty" | "stopping" | "fenced";

/**
 * R7:领域执行端口。由 composition 注入真实 InteractiveSessionController
 * (Agent/model/tool/ledger 全在 SessionRuntime 进程内),SessionRuntime 只
 * 负责 authority/barrier/facade。
 */
export interface SessionDomainPort {
	readonly controller: InteractiveSessionControllerPort;
	/** Internal bridge for auto-title commits; the Runtime publishes the canonical event to clients. */
	readonly subscribeTitleChanged?: (listener: (event: SessionTitleChangedEvent) => void) => () => void;
	/** Session-owned child runtime inputs; absent only on non-production test domains. */
	readonly childRuntime?: SessionChildRuntimePort;
	/** Async Session-owned root delegation domain; absent when any gate is closed. */
	readonly multiAgent?: MultiAgentDomainPort;
	readonly protocolCapabilities?: readonly SessionProtocolCapability[];
	readonly securityInspection?: () => Record<string, unknown>;
	readonly planInspection?: () => SessionPlanInspection;
	readonly process?: SessionProcessDomainPort;
	readonly resources?: SessionResourceDomainPort;
	/** 外部资源只可在 attempt port 绑定后、server activate 前启动。 */
	start?(): Promise<void>;
	/** SessionRuntime 退出时关闭本 Session 私有的外部资源。 */
	shutdown?(reason: "paused" | "detached" | "error" | "fenced"): Promise<void>;
	snapshot(): SessionDomainSnapshot;
}

export interface SessionChildRuntimePort {
	readonly productionToolSource: SessionProductionToolSource;
	readonly modelRuntimeFactory: ChildModelRuntimeFactoryPort;
}

/** Session-scoped Extension/MCP/Hook/Skill/Plugin read/mutation surface。 */
export interface SessionResourceDomainPort {
	readonly operationManifest: readonly SessionProtocolOperationDescriptor[];
	query(
		operation: string,
		payload: Record<string, unknown>,
		context: { readonly correlationId: string; readonly effectId: string },
	): Promise<SessionDomainResult>;
	mutate?(
		operation: string,
		payload: Record<string, unknown>,
		context: { readonly correlationId: string; readonly effectId: string; readonly expectedRevision: number },
	): Promise<SessionDomainResult>;
}

export interface SessionProcessDomainPort {
	readonly operationManifest: readonly SessionProtocolOperationDescriptor[];
	query(
		operation: string,
		payload: Record<string, unknown>,
		context: { readonly correlationId: string; readonly effectId: string },
	): Promise<SessionDomainResult>;
	mutate(
		operation: string,
		payload: Record<string, unknown>,
		context: { readonly correlationId: string; readonly effectId: string; readonly expectedRevision: number },
	): Promise<SessionDomainResult>;
	recoverUnattached?(): Promise<readonly unknown[]>;
	hasRecoveryUncertainty?(): boolean;
	shutdown?(reason: "paused" | "detached" | "error" | "fenced"): Promise<void>;
}

export interface SessionDomainSnapshot {
	readonly messages: readonly AgentMessage[];
	readonly warnings: readonly string[];
	readonly auditEntries: readonly LedgerEntry[];
	readonly selection: RuntimeSelection;
	readonly toolCount: number;
	readonly inFlight: boolean;
	readonly providerStatuses: readonly ProviderStatus[];
}

export interface SessionRuntimeOptions {
	readonly sessionId: SessionId;
	readonly store: SessionStore;
	readonly ownerStore: OwnerStore;
	readonly owner: SessionOwner;
	readonly server: SessionRuntimeServer;
	readonly fence: OwnerFence;
	/** crash takeover 进入 RECOVERY_REQUIRED;clean create/release resume 直接 READY。 */
	readonly crashTakeover: boolean;
	readonly restored: Extract<RestoreOutcome, { readonly ok: true }>;
	/** R7:真实领域执行端口;缺省时 prompt 只记录 intent/receipt(测试/恢复模式)。 */
	readonly domain?: SessionDomainPort;
	/** P0-2:attempt gateway 的延迟绑定引用(domain 装配早于本对象构造)。 */
	readonly attemptPortRef?: LateBoundAttemptPort;
	/** Approval ports 早于 Runtime 装配；构造时统一绑定人工等待计时 authority。 */
	readonly humanInputWaitPortRef?: LateBoundHumanInputWaitPort;
	/** Agent loop 早于 Runtime 装配时持有的 active-time 只读引用。 */
	readonly runBudgetUsageRef?: LateBoundAgentRunBudgetUsage;
	/** Session-scoped external lifecycles(worktree lease, later MCP/process)有序收口。 */
	readonly lifecycleCleanup?: (reason: "paused" | "detached" | "error" | "fenced") => Promise<void>;
	/** Canonical user recap settings; absent in low-level runtime fixtures uses defaults. */
	readonly recapSettings?: EffectiveRecapSettings;
}

export class SessionRuntime implements SessionController {
	public readonly sessionId: SessionId;
	private readonly store: SessionStore;
	private readonly ownerStore: OwnerStore;
	private readonly owner: SessionOwner;
	private readonly server: SessionRuntimeServer;
	private readonly fence: OwnerFence;
	private readonly barrier: RecoveryBarrier;
	private readonly restored: Extract<RestoreOutcome, { readonly ok: true }>;
	private readonly domain: SessionDomainPort | undefined;
	private readonly domainRouter: SessionDomainRouter;
	private readonly lifecycleCleanup: SessionRuntimeOptions["lifecycleCleanup"];
	private readonly domainListener: (() => void) | undefined;
	private readonly domainTitleListener: (() => void) | undefined;
	private readonly listeners = new Set<(event: SessionControllerEvent) => void>();
	private readonly persistence: SessionEventPersistence;
	private readonly idleRecap: SessionIdleRecapController;
	private readonly attempts: SessionAttemptController;
	private readonly lifecycle: SessionLifecycleController;
	private readonly commandHandler: SessionCommandHandler;
	private readonly queryHandler: SessionQueryHandler;

	public constructor(options: SessionRuntimeOptions) {
		this.sessionId = options.sessionId;
		this.store = options.store;
		this.ownerStore = options.ownerStore;
		this.owner = options.owner;
		this.server = options.server;
		this.fence = options.fence;
		this.domainRouter = new SessionDomainRouter(options.sessionId, options.fence.generation, options.store, this, {
			ownerFence: options.fence,
			...(options.domain?.securityInspection === undefined ? {} : { securityInspection: options.domain.securityInspection }),
			...(options.domain?.planInspection === undefined ? {} : { planInspection: options.domain.planInspection }),
			...(options.domain?.multiAgent === undefined ? {} : { additionalOperations: options.domain.multiAgent.operationManifest }),
		});
		this.lifecycleCleanup = options.lifecycleCleanup;
		this.restored = options.restored;
		this.domain = options.domain;
		this.barrier = new RecoveryBarrier({ store: options.store, fence: options.fence }, options.crashTakeover ? "open" : "closed");
		this.persistence = new SessionEventPersistence({
			store: options.store,
			fence: options.fence,
			sessionId: options.sessionId,
			restored: options.restored,
			domain: this.domain,
			emit: (event) => this.emit(event),
		});
		this.idleRecap = new SessionIdleRecapController({
			domain: this.domain,
			sessionId: options.sessionId,
			fence: options.fence,
			barrier: this.barrier,
			server: this.server,
			state: () => this.lifecycle.currentState,
			emit: (event) => this.emit(event),
			settings: options.recapSettings ?? DEFAULT_RECAP_SETTINGS,
		});
		this.lifecycle = new SessionLifecycleController(options.crashTakeover ? "recovery_required" : "ready", {
			owner: this.owner,
			server: this.server,
			domain: this.domain,
			fence: options.fence,
			sessionId: options.sessionId,
			lifecycleCleanup: options.lifecycleCleanup,
			emit: (event) => this.emit(event),
			persistence: this.persistence,
			idleRecap: this.idleRecap,
			onDomainListenersDisposed: () => {
				this.domainListener?.();
				this.domainTitleListener?.();
			},
		});
		this.attempts = new SessionAttemptController({
			store: options.store,
			fence: options.fence,
			sessionId: options.sessionId,
			domain: this.domain,
			barrier: this.barrier,
			onFenced: () => this.selfStopFenced(),
			currentState: () => this.lifecycle.currentState,
			setState: (state) => this.lifecycle.setState(state),
			invalidateIdleRecap: () => this.idleRecap.invalidateIdleRecap(),
			emit: (event) => this.emit(event),
			ownerPublishRunning: () => this.owner.publish("running"),
		});
		this.commandHandler = new SessionCommandHandler({
			store: options.store,
			domain: this.domain,
			domainRouter: this.domainRouter,
			fence: options.fence,
			sessionId: options.sessionId,
			server: this.server,
			barrier: this.barrier,
			state: () => this.lifecycle.currentState,
			emit: (event) => this.emit(event),
			withHumanInputWait: (waitId, reason, operation) => this.persistence.withHumanInputWait(waitId, reason, operation),
			invalidateIdleRecap: () => this.idleRecap.invalidateIdleRecap(),
			handleEditorActivity: (empty) => this.idleRecap.handleEditorActivity(empty),
			recoveryAssess: () => this.attempts.recoveryAssess(),
			recoveryDecide: (decision) => this.attempts.recoveryDecide(decision),
			unresolvedAttemptsCount: () => this.attempts.unresolvedAttemptsCount(),
		});
		this.queryHandler = new SessionQueryHandler({
			store: options.store,
			sessionId: options.sessionId,
			domain: this.domain,
			domainRouter: this.domainRouter,
			barrier: this.barrier,
			state: () => this.lifecycle.currentState,
			unresolvedAttemptsCount: () => this.attempts.unresolvedAttemptsCount(),
			domainSnapshot: () => this.domainSnapshot(),
		});
		// P0-2:gateway 在构造时绑定(工具执行必然发生在构造之后)。
		options.attemptPortRef?.bind(this);
		options.humanInputWaitPortRef?.bind(this);
		options.runBudgetUsageRef?.bind(this);
		if (this.domain !== undefined) {
			// R7:领域 AgentEvent 以 owner-fenced durable event 落库并广播,
			// 恢复时从权威流重建(checkpoint 可删)。
			this.domainListener = this.domain.controller.subscribe((event) => {
				this.persistence.acceptDomainEvent(event);
				this.idleRecap.handleDomainAgentEvent(event);
				});
			this.domainTitleListener = this.domain.subscribeTitleChanged?.((event) => {
				this.emit({
					eventType: "session.title_changed",
					payload: { sessionId: event.sessionId, title: event.title, source: event.source },
					sequence: event.sequence,
				});
			});
		}
	}

	/** 现有/未来 reverse-request 的统一人工等待边界，finally 保证最后一个 wait 闭合。 */
	public async withHumanInputWait<T>(waitId: string, reason: HumanWaitReason, operation: () => Promise<T>): Promise<T> {
		return this.persistence.withHumanInputWait(waitId, reason, operation);
	}

	public get runtimeState(): SessionRuntimeState {
		return this.lifecycle.currentState;
	}

	public get isRecoveryRequired(): boolean {
		return this.lifecycle.currentState === "recovery_required";
	}

	public get barrierState(): "closed" | "open" {
		return this.barrier.currentState;
	}

	public get sideEffectSpawnCount(): number {
		return this.barrier.sideEffectSpawnCount;
	}

	public activeDurationMs(): number {
		return this.persistence.activeDurationMs();
	}

	public get restoredCheckpoint(): { readonly checkpoint: { readonly descriptor: { readonly checkpointId: string }; readonly snapshot: CheckpointSnapshot }; readonly usedCheckpoint: boolean } | undefined {
		return this.restored.checkpoint === undefined ? undefined : { checkpoint: this.restored.checkpoint, usedCheckpoint: true };
	}

	public start(): void {
		this.lifecycle.start();
	}

	public selfStopFenced(): void {
		this.lifecycle.selfStopFenced();
	}

	public pause(reason: "paused" | "detached" | "error" = "paused"): void {
		this.lifecycle.pause(reason);
	}

	public shutdownAfterLastAttachment(reason: "paused" | "detached" | "error" = "paused"): Promise<void> {
		return this.lifecycle.shutdownAfterLastAttachment(reason);
	}

	public waitForStopped(): Promise<void> {
		return this.lifecycle.waitForStopped();
	}

	public unresolvedAttemptsCount(): number {
		return this.attempts.unresolvedAttemptsCount();
	}

	public listUnresolvedAttempts(): ReturnType<RecoveryBarrier["unresolvedAttempts"]> {
		return this.attempts.listUnresolvedAttempts();
	}

	public beginAttempt(
		effectClassOrRequest: CommandEffectClass | StableAttemptRequest,
		requestDigest?: RuntimeDigest,
	): AttemptPortBeginResult {
		return this.attempts.beginAttempt(effectClassOrRequest, requestDigest);
	}

	public settleAttempt(attemptId: AttemptId, outcome: CommandAttemptOutcome, resultDigest?: RuntimeDigest, evidenceDigest?: RuntimeDigest): { readonly ok: true } | { readonly ok: false; readonly code: string } {
		return this.attempts.settleAttempt(attemptId, outcome, resultDigest, evidenceDigest);
	}

	public putCheckpoint(boundary: SessionCheckpointBoundary, state: Record<string, unknown>): void {
		this.persistence.putCheckpoint(boundary, state);
	}

	public currentHeadSequence(): number {
		return this.persistence.currentHeadSequence();
	}

	public recoveryAssess(): { readonly ok: true; readonly barrierState: "closed" | "open"; readonly unresolvedRemaining: number } {
		return this.attempts.recoveryAssess();
	}

	public recoveryDecide(decision: RecoveryDecision): { readonly ok: boolean; readonly code?: string; readonly state: SessionRuntimeState } {
		return this.attempts.recoveryDecide(decision);
	}

	public protocolManifest(): SessionProtocolManifest {
		const processManifest = this.domain?.process?.operationManifest ?? [];
		const resourceManifest = this.domain?.resources?.operationManifest ?? [];
		const multiAgentManifest = this.domain?.multiAgent?.operationManifest ?? [];
		return freezeSessionProtocolManifest({
			protocolCapabilities: [
				...SESSION_CORE_PROTOCOL_MANIFEST.protocolCapabilities,
				"session.catalog",
				...(processManifest.length === 0 ? [] : ["session.process" as const]),
				...resourceManifest.map((entry) => entry.capability),
				...(multiAgentManifest.length === 0 ? [] : ["session.multi-agent" as const]),
				...(this.domain?.protocolCapabilities ?? []),
			],
			operationManifest: [...SESSION_CORE_PROTOCOL_MANIFEST.operationManifest, ...this.domainRouter.operationManifest, ...processManifest, ...resourceManifest],
		});
	}

	public snapshot(): SessionSnapshot {
		const events = this.store.replaySessionEvents(this.sessionId);
		const messageCount = this.domain?.snapshot().messages.length ?? 0;
		return {
			sessionId: this.sessionId,
			headSequence: this.currentHeadSequence(),
			sessionStatus: this.wireSessionStatus(),
			runtimeState: this.lifecycle.currentState,
			agentRuns: this.persistence.runSummaries(events, messageCount),
		};
	}

	private wireSessionStatus(): SessionStatus {
		switch (this.lifecycle.currentState) {
			case "recovery_required": return "recovery_required";
			case "fenced": return "failed";
			case "stopping": return "paused";
			case "starting":
			case "ready":
			case "ready_with_uncertainty":
				return "active";
		}
	}

	/** R7:领域投影(消息/审计/选择)经同一 facade 供 client 重建 TUI 状态。 */
	public domainSnapshot(): Record<string, unknown> {
		const domain = this.domain?.snapshot();
		const projection = domain === undefined
			? { messages: [], warnings: [], auditEntries: [], toolCount: 0, inFlight: false, selection: { thinkingLevel: "off" } }
			: {
				messages: domain.messages,
				warnings: domain.warnings,
				auditEntries: domain.auditEntries,
				selection: domain.selection,
				toolCount: domain.toolCount,
				inFlight: domain.inFlight,
				providerStatuses: domain.providerStatuses,
			};
		return {
			ok: true,
			kind: "snapshot",
			...this.snapshot(),
			...projection,
		};
	}

	public handleDriverStateChange(): void {
		this.idleRecap.handleDriverStateChange();
	}

	public isMutatingKind(kind: string): boolean {
		return this.commandHandler.isMutatingKind(kind);
	}

	public async handleCommand(request: SessionCommandRequest, meta: { readonly connectionId: ConnectionId; readonly clientId: string; readonly isDriver: boolean }): Promise<SessionCommandResult> {
		return this.commandHandler.handleCommand(request, meta);
	}

	public async handleQuery(request: SessionQueryRequest): Promise<Record<string, unknown>> {
		return this.queryHandler.handleQuery(request);
	}

	public onEvent(listener: (event: SessionControllerEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(event: SessionControllerEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				// observer 隔离。
			}
		}
	}
}
