/**
 * R5/R6/R7:SessionRuntime(06 §7)。
 *
 * - 一个 SessionRuntime 只装配一个 Session 的 controller 面:restore(authority
 *   replay + checkpoint cache)、RecoveryBarrier、attempt/receipt 生命周期、
 *   heartbeat 与 self-stop;
 * - crash takeover 无条件先进入 RECOVERY_REQUIRED(barrier open),只允许
 *   attach/subscribe/只读 query/recovery decision;side-effect 在 admission 层
 *   被拒(spawnCount 证据);
 * - 本类实现 SessionController,经 RuntimeServer TCP facade 暴露;
 *   领域执行(Agent/model/tool)由注入的 SessionDomainPort 承担(R7 装配真实
 *   InteractiveSessionController),所有 session.* 操作走同一 facade;
 * - 领域事件(AgentEvent)以 owner-fenced durable event 落库并广播,checkpoint
 *   replay 可从权威流重建;
 * - 恢复不迁移 token stream/socket/PTY/MCP client/child handle。
 */

import type { SessionStore } from "../../storage/session-store/session-store.ts";
import { OwnerStore } from "../../storage/session-store/owner-store.ts";
import type { SessionOwner } from "../session-owner/session-owner.ts";
import type { SessionRuntimeServer } from "../session-server/runtime-server.ts";
import { SESSION_MUTATING_COMMAND_KINDS, type SessionCommandRequest, type SessionCommandResult, type SessionController, type SessionControllerEvent, type SessionQueryRequest, type SessionSnapshot } from "../session-server/runtime-server.ts";
import { RecoveryBarrier, type RecoveryDecision } from "./recovery-barrier.ts";
import type { RestoreOutcome } from "./restore.ts";
import { putSessionCheckpoint, type CheckpointSnapshot } from "./checkpoint.ts";
import type { LateBoundAttemptPort, StableAttemptRequest, AttemptPortBeginResult } from "./attempt-gateway.ts";
import { runtimeDigest, type RuntimeDigest } from "../protocol/foundation.ts";
import { createRuntimeId, type AttemptId, type CommandId, type SessionId, type ConnectionId, type PrincipalId } from "../protocol/ids.ts";
import type { CommandAttemptOutcome, CommandEffectClass, OwnerFence, SessionCheckpointBoundary } from "../session-owner/types.ts";
import type { AgentEvent, AgentMessage } from "../types.ts";
import type { LedgerEntry } from "../ledger/types.ts";
import type { AuthType, Credential, AuthInteraction } from "../../auth/types.ts";
import { createReverseRequestAuthInteraction } from "./credential-reverse-request.ts";
import type { Api, Model, ModelThinkingLevel } from "../../types.ts";
import type { InteractiveSessionControllerPort, ProviderStatus, RuntimeSelection } from "../interactive-session-controller.ts";
import { SESSION_CORE_PROTOCOL_MANIFEST, freezeSessionProtocolManifest, type SessionProtocolCapability, type SessionProtocolManifest, type SessionProtocolOperationDescriptor, type SessionStatus } from "../session-server/protocol.ts";
import { SessionDomainRouter } from "./domain-router.ts";
import type { SessionDomainResult } from "./domain-router.ts";
import { AgentRunTimingTracker, projectAgentRunSummaries, type AgentRunSummary, type HumanWaitReason, type LateBoundAgentRunBudgetUsage } from "./run-timing.ts";
import type { SessionPlanInspection } from "./plan-composition.ts";
import type { LateBoundHumanInputWaitPort } from "./approval-reverse-request.ts";
import { SessionStreamEventCoalescer } from "./stream-event-coalescer.ts";
import type { SessionProductionToolSource } from "../agents/capability-subset.ts";
import type { ChildModelRuntimeFactoryPort } from "../agents/child-model-runtime.ts";
import type { MultiAgentDomainPort } from "../agents/domain.ts";
import type { EffectiveRecapSettings } from "../../storage/settings-manager.ts";
import { DEFAULT_RECAP_SETTINGS } from "../../storage/settings-manager.ts";
import {
	IdleRecapCoordinator,
	IDLE_RECAP_PROMPT,
	isIdleRecapEligible,
	type IdleRecapActivity,
	type IdleRecapRequest,
} from "./idle-recap.ts";

export type SessionRuntimeState = "starting" | "ready" | "recovery_required" | "ready_with_uncertainty" | "stopping" | "fenced";

/**
 * R7:领域执行端口。由 composition 注入真实 InteractiveSessionController
 * (Agent/model/tool/ledger 全在 SessionRuntime 进程内),SessionRuntime 只
 * 负责 authority/barrier/facade。
 */
export interface SessionDomainPort {
	readonly controller: InteractiveSessionControllerPort;
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
	private state: SessionRuntimeState;
	private readonly listeners = new Set<(event: SessionControllerEvent) => void>();
	private readonly runTiming = new AgentRunTimingTracker();
	private readonly streamEvents: SessionStreamEventCoalescer;
	private readonly idleRecap: IdleRecapCoordinator;
	private editorEmpty = true;
	private idleRecapEpochReady = false;
	private idleRecapStatusRequestId: string | undefined;
	private idleRecapStatusActivityGeneration: number | undefined;
	private attemptCounter = 0;
	private started = false;
	private shutdownPromise: Promise<void> | undefined;
	private readonly stoppedPromise: Promise<void>;
	private resolveStopped: (() => void) | undefined;

	public constructor(options: SessionRuntimeOptions) {
		this.sessionId = options.sessionId;
		this.store = options.store;
		this.ownerStore = options.ownerStore;
		this.owner = options.owner;
		this.server = options.server;
		this.fence = options.fence;
		this.domainRouter = new SessionDomainRouter(options.sessionId, options.fence.generation, options.store, this, {
			...(options.domain?.securityInspection === undefined ? {} : { securityInspection: options.domain.securityInspection }),
			...(options.domain?.planInspection === undefined ? {} : { planInspection: options.domain.planInspection }),
			...(options.domain?.multiAgent === undefined ? {} : { additionalOperations: options.domain.multiAgent.operationManifest }),
		});
		this.lifecycleCleanup = options.lifecycleCleanup;
		this.restored = options.restored;
		this.state = options.crashTakeover ? "recovery_required" : "ready";
		this.barrier = new RecoveryBarrier({ store: options.store, fence: options.fence }, options.crashTakeover ? "open" : "closed");
		this.domain = options.domain;
		this.streamEvents = new SessionStreamEventCoalescer({ emit: (event) => this.persistDomainAgentEvent(event) });
		this.idleRecap = new IdleRecapCoordinator({
			settings: options.recapSettings ?? DEFAULT_RECAP_SETTINGS,
			onFire: (request) => this.fireIdleRecap(request),
			onStatus: (replyText, request) => this.publishIdleRecap(replyText, request),
		});
		this.stoppedPromise = new Promise<void>((resolve) => {
			this.resolveStopped = resolve;
		});
		// P0-2:gateway 在构造时绑定(工具执行必然发生在构造之后)。
		options.attemptPortRef?.bind(this);
		options.humanInputWaitPortRef?.bind(this);
		options.runBudgetUsageRef?.bind(this);
		if (this.domain !== undefined) {
			// R7:领域 AgentEvent 以 owner-fenced durable event 落库并广播,
			// 恢复时从权威流重建(checkpoint 可删)。
			this.domainListener = this.domain.controller.subscribe((event) => {
				this.streamEvents.accept(event);
				this.handleDomainAgentEvent(event);
			});
		}
	}

	private persistDomainAgentEvent(event: AgentEvent): void {
		this.persistAgentEvent(event);
		const boundary = checkpointBoundaryForAgentEvent(event);
		if (boundary !== undefined) this.putCheckpoint(boundary, this.checkpointState(event.type, event.timestamp, false));
	}

	private checkpointState(eventType: string, eventTimestamp: number, replayReady: boolean): Record<string, unknown> {
		const snapshot = this.domain?.snapshot();
		return {
			replayReady,
			eventType,
			eventTimestamp,
			...(snapshot === undefined ? {} : {
				messages: snapshot.messages,
				warnings: snapshot.warnings,
				auditEntries: snapshot.auditEntries,
				selection: snapshot.selection,
				steeringQueue: typeof this.domain?.controller.getSteeringMessages === "function" ? this.domain.controller.getSteeringMessages() : [],
				followUpQueue: typeof this.domain?.controller.getFollowUpMessages === "function" ? this.domain.controller.getFollowUpMessages() : [],
			}),
		};
	}

	/** AgentEvent → durable `agent.event`(owner-fenced)+ emit 广播。 */
	private persistAgentEvent(event: AgentEvent): void {
		const normalized = this.runTiming.accept(event, this.domain?.snapshot().messages.length ?? 0);
		this.persistNormalizedAgentEvent(normalized);
	}

	private persistNormalizedAgentEvent(event: AgentEvent): void {
		let sequence: number | undefined;
		try {
			const tail = this.store.replaySessionEvents(this.sessionId).at(-1);
			const appended = this.store.appendEvent(this.fence, {
				eventId: createRuntimeId("event", `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`),
				ownerGeneration: this.fence.generation,
				eventType: "agent.event",
				payloadJson: JSON.stringify(event),
				createdAtMs: event.timestamp,
				expectedPreviousEventHash: tail?.currentEventHash ?? null,
			});
			sequence = appended.sequence;
		} catch {
			// 事件落库失败不阻断领域执行;fence 失效由 heartbeat/write fence 自停。
		}
		this.emit({ eventType: "agent_event", payload: { event: event as unknown as Record<string, unknown> }, sequence });
	}

	/** 现有/未来 reverse-request 的统一人工等待边界，finally 保证最后一个 wait 闭合。 */
	public async withHumanInputWait<T>(waitId: string, reason: HumanWaitReason, operation: () => Promise<T>): Promise<T> {
		const pause = this.runTiming.pause(waitId, reason, Date.now());
		if (pause !== undefined) this.persistNormalizedAgentEvent(pause);
		try {
			return await operation();
		} finally {
			const resume = this.runTiming.resume(waitId, Date.now());
			if (resume !== undefined) this.persistNormalizedAgentEvent(resume);
		}
	}

	public get runtimeState(): SessionRuntimeState {
		return this.state;
	}

	public get isRecoveryRequired(): boolean {
		return this.state === "recovery_required";
	}

	public get barrierState(): "closed" | "open" {
		return this.barrier.currentState;
	}

	public get sideEffectSpawnCount(): number {
		return this.barrier.sideEffectSpawnCount;
	}

	public activeDurationMs(): number {
		return this.runTiming.activeRun?.activeDurationMs ?? 0;
	}

	public get restoredCheckpoint(): { readonly checkpoint: { readonly descriptor: { readonly checkpointId: string }; readonly snapshot: CheckpointSnapshot }; readonly usedCheckpoint: boolean } | undefined {
		return this.restored.checkpoint === undefined ? undefined : { checkpoint: this.restored.checkpoint, usedCheckpoint: true };
	}

	/**
	 * §5.1:restore 完成后 CAS publish owner state + activate server + heartbeat。
	 * crash takeover publish recovery_required;clean publish running。
	 */
	public start(): void {
		if (this.started) return;
		this.started = true;
		const ownerState = this.state === "recovery_required" ? "recovery_required" : "running";
		this.owner.publish(ownerState);
		this.server.activate(this.fence, this.owner.currentAuthToken, ownerState);
		this.owner.startHeartbeat();
	}

	/** §5.4 owner 被 fence:关 server、断开连接、不再 heartbeat、不写回 durable truth。 */
	public selfStopFenced(): void {
		if (this.state === "fenced" || this.state === "stopping") return;
		this.state = "fenced";
		this.invalidateIdleRecap();
		this.owner.selfStopFenced();
		// P0-4:生产 onFenced 必须中断领域 Runtime(中断 in-flight turn),再关 server。
		this.emit({ eventType: "runtime.fenced", payload: { sessionId: this.sessionId, generation: this.fence.generation } });
		void this.finishFencedStop();
	}

	/** §8.3 兼容入口；真实 shutdown 由 async 方法完成。 */
	public pause(reason: "paused" | "detached" | "error" = "paused"): void {
		void this.shutdownAfterLastAttachment(reason);
	}

	/**
	 * attachment 归零后的唯一有序 shutdown：先停止 admission，再中断并 bounded
	 * 等待领域执行，最后 checkpoint/release/server/domain 收口。
	 */
	public shutdownAfterLastAttachment(reason: "paused" | "detached" | "error" = "paused"): Promise<void> {
		if (this.shutdownPromise !== undefined) return this.shutdownPromise;
		if (this.state === "fenced") return this.stoppedPromise;
		this.state = "stopping";
		this.owner.stopHeartbeat();
		this.shutdownPromise = this.performOrderlyShutdown(reason);
		return this.shutdownPromise;
	}

	public waitForStopped(): Promise<void> {
		return this.stoppedPromise;
	}

	private async performOrderlyShutdown(reason: "paused" | "detached" | "error"): Promise<void> {
		try {
			this.idleRecap.dispose();
			this.clearIdleRecapStatus();
			try {
				this.domain?.controller.interrupt();
			} catch {
				// interrupt 是 best-effort；后续 bounded wait 保证 shutdown 可收口。
			}
			if (this.domain !== undefined && typeof this.domain.controller.waitForIdle === "function") {
				await boundedWait(this.domain.controller.waitForIdle(), 3_000);
			}
			this.streamEvents.flush();
			this.persistAbortedRunIfNeeded();
			await this.lifecycleCleanup?.(reason).catch(() => undefined);
			this.putCheckpoint("paused", { reason, ...this.checkpointState("paused", Date.now(), true) });
			this.owner.release(reason);
			await this.server.close();
			this.domainListener?.();
			this.streamEvents.dispose();
			if (this.domain !== undefined && typeof this.domain.controller.dispose === "function") this.domain.controller.dispose();
		} finally {
			this.resolveStopped?.();
			this.resolveStopped = undefined;
		}
	}

	private async finishFencedStop(): Promise<void> {
		try {
			this.idleRecap.dispose();
			this.clearIdleRecapStatus();
			try {
				this.domain?.controller.interrupt();
			} catch {
				// fence 收口不依赖领域中断成功。
			}
			if (this.domain !== undefined && typeof this.domain.controller.waitForIdle === "function") {
				await boundedWait(this.domain.controller.waitForIdle(), 3_000);
			}
			this.streamEvents.flush();
			this.persistAbortedRunIfNeeded();
			await this.lifecycleCleanup?.("fenced").catch(() => undefined);
			await this.server.close();
			this.domainListener?.();
			this.streamEvents.dispose();
			if (this.domain !== undefined && typeof this.domain.controller.dispose === "function") this.domain.controller.dispose();
		} finally {
			this.resolveStopped?.();
			this.resolveStopped = undefined;
		}
	}

	public unresolvedAttemptsCount(): number {
		return this.barrier.unresolvedAttempts().length;
	}

	public listUnresolvedAttempts(): ReturnType<RecoveryBarrier["unresolvedAttempts"]> {
		return this.barrier.unresolvedAttempts();
	}

	// ── attempt / receipt 生命周期(领域执行由 R6 composition 注入)──────────

	/**
	 * §7.3 开始一次 attempt:先经 barrier admission(只读放行、side-effect 需
	 * barrier closed),再 owner-fenced 记录 command intent + started receipt。
	 */
	public beginAttempt(
		effectClassOrRequest: CommandEffectClass | StableAttemptRequest,
		requestDigest?: RuntimeDigest,
	): AttemptPortBeginResult {
		const stableRequest = typeof effectClassOrRequest === "string" ? undefined : effectClassOrRequest;
		const effectClass: CommandEffectClass = typeof effectClassOrRequest === "string" ? effectClassOrRequest : effectClassOrRequest.effectClass;
		const admission = this.barrier.admitMutation(effectClass);
		if (!admission.ok) return { error: admission.code };
		const attemptId = stableRequest?.attemptId ?? createRuntimeId("attempt", `a${++this.attemptCounter}-${Date.now().toString(36)}`);
		const commandId = stableRequest?.commandId ?? createRuntimeId("command", `c${this.attemptCounter}-${Date.now().toString(36)}`);
		try {
			const result = this.store.beginCommandAttempt(this.fence, {
				sessionId: this.sessionId,
				commandId,
				attemptId,
				effectClass,
				requestDigest: stableRequest?.requestDigest ?? requestDigest ?? runtimeDigest({ effectClass, operation: "unspecified" }),
				originGeneration: this.fence.generation,
				createdAtMs: Date.now(),
			});
			if (stableRequest !== undefined) return result;
			if (result.status === "started") return { attemptId, commandId };
			return result;
		} catch {
			this.selfStopFenced();
			return { error: "owner_fenced" };
		}
		return { attemptId, commandId };
	}

	/**
	 * §7.3 收口 attempt:只 append,不猜 outcome。
	 * interrupted/uncertain 保留 unresolved(barrier 评估可见)。
	 */
	public settleAttempt(attemptId: AttemptId, outcome: CommandAttemptOutcome, resultDigest?: RuntimeDigest, evidenceDigest?: RuntimeDigest): { readonly ok: true } | { readonly ok: false; readonly code: string } {
		const receipt = this.store.listAllAttemptReceipts(this.sessionId).find((candidate) => candidate.attemptId === attemptId);
		if (receipt === undefined) return { ok: false, code: "attempt_not_found" };
		try {
			this.store.appendAttemptReceipt(this.fence, {
				receiptId: createRuntimeId("receipt", `settle-${attemptId.slice(-20)}-${Date.now().toString(36)}`),
				sessionId: this.sessionId,
				commandId: receipt.commandId,
				attemptId,
				originGeneration: receipt.originGeneration,
				settledGeneration: isTerminalAttemptOutcome(outcome) ? this.fence.generation : undefined,
				effectClass: receipt.effectClass,
				outcome,
				resultDigest,
				evidenceDigest,
				createdAtMs: Date.now(),
			});
		} catch {
			this.selfStopFenced();
			return { ok: false, code: "owner_fenced" };
		}
		return { ok: true };
	}

	/** §7.2 六个 safe checkpoint boundary。sourceSequence 取当前 live head(不是
	 *  启动时冻结的 restored.headSequence),运行中新事件持续推进 checkpoint。 */
	public putCheckpoint(boundary: SessionCheckpointBoundary, state: Record<string, unknown>): void {
		try {
			const descriptor = putSessionCheckpoint(this.store, this.fence, boundary, this.currentHeadSequence(), state);
			this.emit({ eventType: "session.checkpoint", payload: { checkpointId: descriptor.checkpointId, boundary, sourceSequence: descriptor.sourceSequence } });
		} catch {
			// checkpoint 是 cache:写入失败不改变 authority。
		}
	}

	/** 当前权威 event head(sessions.head_sequence 是唯一真源)。 */
	public currentHeadSequence(): number {
		try {
			const row = this.store.database().querySingle("SELECT head_sequence FROM sessions WHERE session_id = ?", [this.sessionId]);
			return Number(row?.head_sequence ?? this.restored.headSequence);
		} catch {
			return this.restored.headSequence;
		}
	}

	// ── recovery decision(§7.3)───────────────────────────────────────────

	public recoveryAssess(): { readonly ok: true; readonly barrierState: "closed" | "open"; readonly unresolvedRemaining: number } {
		if (this.domain?.process?.hasRecoveryUncertainty?.() === true) {
			this.state = "recovery_required";
			this.invalidateIdleRecap();
			return { ok: true, barrierState: "open", unresolvedRemaining: this.unresolvedAttemptsCount() };
		}
		const result = this.barrier.assess();
		if (result.ok && result.state === "closed") {
			this.state = "ready";
			this.invalidateIdleRecap();
			this.owner.publish("running");
			this.emit({ eventType: "recovery.assessed_clean", payload: { barrierState: "closed" } });
		}
		return { ok: true, barrierState: result.ok ? result.state : "open", unresolvedRemaining: result.ok ? result.unresolvedRemaining : this.unresolvedAttemptsCount() };
	}

	public recoveryDecide(decision: RecoveryDecision): { readonly ok: boolean; readonly code?: string; readonly state: SessionRuntimeState } {
		const result = this.barrier.decide(decision);
		if (!result.ok) return { ok: false, code: result.code, state: this.state };
		if (decision.kind === "resume_despite_uncertainty") {
			this.state = "ready_with_uncertainty";
			this.invalidateIdleRecap();
		} else if (result.state === "closed") {
			this.state = "ready";
			this.invalidateIdleRecap();
		}
		if (result.state === "closed") this.owner.publish("running");
		return { ok: true, state: this.state };
	}

	// ── SessionController facade(server 路由进本 runtime)──────────────────

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
			runtimeState: this.state,
			agentRuns: this.runSummaries(events, messageCount),
		};
	}

	private runSummaries(events: ReturnType<SessionStore["replaySessionEvents"]>, messageCount: number): readonly AgentRunSummary[] {
		const projected = projectAgentRunSummaries(events, messageCount);
		const active = this.runTiming.activeRun;
		if (active === undefined) return projected;
		return [...projected.filter((summary) => summary.runId !== active.runId), active];
	}

	private persistAbortedRunIfNeeded(): void {
		const aborted = this.runTiming.abort(Date.now(), this.domain?.snapshot().messages.length ?? 0);
		if (aborted !== undefined) this.persistNormalizedAgentEvent(aborted);
	}

	private wireSessionStatus(): SessionStatus {
		switch (this.state) {
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

	private handleDomainAgentEvent(event: AgentEvent): void {
		if (event.type === "agent_start" || event.type === "turn_start" || event.type === "message_start") {
			this.invalidateIdleRecap();
			return;
		}
		if (event.type !== "agent_end") return;
		this.idleRecapEpochReady = true;
		// Agent marks inFlight false in its prompt() finally after agent_end is
		// dispatched. A macrotask lets that lifecycle settle before we snapshot.
		const messageCount = event.messageCountAtEnd;
		const timer = setTimeout(() => {
			if (this.state !== "ready" && this.state !== "ready_with_uncertainty") return;
			const activity = this.currentIdleRecapActivity(messageCount);
			this.idleRecap.arm(activity);
		}, 0);
		timer.unref?.();
	}

	private currentIdleRecapActivity(messageCountOverride?: number): IdleRecapActivity {
		const snapshot = this.domain?.snapshot();
		const selection = snapshot?.selection;
		const model = selection?.model;
		const streaming = snapshot?.inFlight ?? false;
		const maintenance = (this.state === "ready" || this.state === "ready_with_uncertainty") && !streaming ? "idle" : "busy";
		return {
			sessionId: this.sessionId,
			ownerGeneration: this.fence.generation,
			driverRevision: this.server.driverRevision?.() ?? 0,
			driverAttached: this.server.driverConnectionId?.() !== undefined,
			editorEmpty: this.editorEmpty,
			streaming,
			maintenance,
			hasModel: model !== undefined,
			hasHistory: (snapshot?.messages.length ?? 0) > 0 || (messageCountOverride ?? 0) > 0,
			selectionDigest: runtimeDigest({
				provider: selection?.provider ?? null,
				model: model?.id ?? null,
				thinkingLevel: selection?.thinkingLevel ?? "off",
			}).digest,
		};
	}

	private invalidateIdleRecap(): void {
		this.idleRecapEpochReady = false;
		this.idleRecap.notifyActivity(this.currentIdleRecapActivity());
		this.clearIdleRecapStatus();
	}

	private refreshIdleRecapActivity(): void {
		this.idleRecap.notifyActivity(this.currentIdleRecapActivity());
		this.clearIdleRecapStatus();
	}

	public handleDriverStateChange(): void {
		const activity = this.currentIdleRecapActivity();
		if (this.idleRecapEpochReady && activity.driverAttached && activity.editorEmpty && !activity.streaming) this.idleRecap.arm(activity);
		else {
			this.idleRecap.notifyActivity(activity);
			this.clearIdleRecapStatus();
		}
	}

	private async fireIdleRecap(request: IdleRecapRequest): Promise<string | undefined> {
		const activity = this.currentIdleRecapActivity();
		if (
			!isIdleRecapEligible(activity) ||
			activity.ownerGeneration !== request.ownerGeneration ||
			activity.driverRevision !== request.driverRevision ||
			activity.selectionDigest !== request.expectedSelectionDigest
		) return undefined;
		const runEphemeralTurn = this.domain?.controller.runEphemeralTurn;
		if (runEphemeralTurn === undefined) return undefined;
		return runEphemeralTurn({
			kind: "idle-recap",
			requestId: request.requestId,
			ownerGeneration: request.ownerGeneration,
			activityGeneration: request.activityGeneration,
			promptText: IDLE_RECAP_PROMPT,
			signal: request.signal,
		});
	}

	private publishIdleRecap(replyText: string, request: IdleRecapRequest): void {
		const activity = this.currentIdleRecapActivity();
		if (
			!isIdleRecapEligible(activity) ||
			activity.ownerGeneration !== request.ownerGeneration ||
			activity.driverRevision !== request.driverRevision ||
			activity.selectionDigest !== request.expectedSelectionDigest
		) return;
		this.idleRecapStatusRequestId = request.requestId;
		this.idleRecapStatusActivityGeneration = request.activityGeneration;
		this.emit({
			eventType: "session.idle_recap",
			payload: {
				sessionId: this.sessionId,
				requestId: request.requestId,
				ownerGeneration: request.ownerGeneration,
				activityGeneration: request.activityGeneration,
				driverRevision: request.driverRevision,
				text: replyText,
			},
		});
	}

	private clearIdleRecapStatus(): void {
		const requestId = this.idleRecapStatusRequestId;
		if (requestId === undefined) return;
		const activityGeneration = this.idleRecapStatusActivityGeneration;
		this.idleRecapStatusRequestId = undefined;
		this.idleRecapStatusActivityGeneration = undefined;
		this.emit({
			eventType: "session.idle_recap",
			payload: {
				sessionId: this.sessionId,
				requestId,
				ownerGeneration: this.fence.generation,
				...(activityGeneration === undefined ? {} : { activityGeneration }),
				cleared: true,
			},
		});
	}

	public isMutatingKind(kind: string): boolean {
		return (SESSION_MUTATING_COMMAND_KINDS as readonly string[]).includes(kind) || kind === "prompt" || kind === "steer" || kind === "follow_up" || kind === "clear_queues" || kind === "select_model" || kind === "set_thinking" || kind === "logout" || kind === "login" || kind === "editor_activity" || kind === "domain_command";
	}

	public async handleCommand(request: SessionCommandRequest, meta: { readonly connectionId: ConnectionId; readonly clientId: string; readonly isDriver: boolean }): Promise<SessionCommandResult> {
		if (this.isMutatingKind(request.kind) && !meta.isDriver) {
			// §1.2 mutating client 受 driver/observer fence。
			return { ok: false, code: "observer_mutation_forbidden" };
		}
		switch (request.kind) {
			case "prompt": {
				this.invalidateIdleRecap();
				if (this.state === "recovery_required") {
					return { ok: false, code: "recovery_barrier_active", detail: "session is in RECOVERY_REQUIRED" };
				}
				const admission = this.barrier.admitPrompt();
				if (!admission.ok) return { ok: false, code: "recovery_barrier_active" };
				this.emit({ eventType: "turn.started", payload: { promptText: String(request.body.promptText ?? "").slice(0, 512) } });
				// R7:有 domain 时转发真实领域执行;无 domain 时只记录 intent/receipt。
				if (this.domain !== undefined) {
					const text = String(request.body.promptText ?? "");
					const behavior = request.body.behavior === "followUp" ? ("followUp" as const) : request.body.behavior === "steer" ? ("steer" as const) : undefined;
					try {
						await this.domain.controller.prompt(text, behavior);
					} catch (error) {
						return { ok: false, code: "domain_prompt_failed", detail: error instanceof Error ? error.message.slice(0, 200) : undefined };
					}
				}
				return { ok: true, kind: "prompt", result: { accepted: true } };
			}
			case "steer":
			case "follow_up": {
				this.invalidateIdleRecap();
				if (this.domain === undefined) return { ok: false, code: "domain_unavailable" };
				if (this.state === "recovery_required") return { ok: false, code: "recovery_barrier_active" };
				await this.domain.controller.prompt(String(request.body.text ?? ""), request.kind === "steer" ? "steer" : "followUp");
				return { ok: true, kind: request.kind, result: {} };
			}
			case "clear_queues": {
				this.invalidateIdleRecap();
				if (this.domain === undefined) return { ok: false, code: "domain_unavailable" };
				this.domain.controller.clearAllQueues();
				return { ok: true, kind: "clear_queues", result: {} };
			}
			case "provider_status": {
				if (this.domain === undefined) return { ok: false, code: "domain_unavailable" };
				const providers = await this.domain.controller.getProviderStatuses();
				return { ok: true, kind: "provider_status", result: { providers } };
			}
			case "models": {
				if (this.domain === undefined) return { ok: false, code: "domain_unavailable" };
				const provider = typeof request.body.provider === "string" ? request.body.provider : undefined;
				const models = await this.domain.controller.getAvailableModels(provider);
				return { ok: true, kind: "models", result: { models } };
			}
			case "select_model": {
				this.invalidateIdleRecap();
				if (this.domain === undefined) return { ok: false, code: "domain_unavailable" };
				const body = request.body as Record<string, unknown>;
				if (typeof body.provider !== "string" || typeof body.model !== "string") return { ok: false, code: "invalid_input" };
				await this.domain.controller.selectModel({ provider: body.provider, id: body.model } as Model<Api>);
				return { ok: true, kind: "select_model", result: { selection: this.domain.snapshot().selection } };
			}
			case "set_thinking": {
				this.invalidateIdleRecap();
				if (this.domain === undefined) return { ok: false, code: "domain_unavailable" };
				const level = String(request.body.level ?? "off") as ModelThinkingLevel;
				await this.domain.controller.setThinkingLevel(level);
				return { ok: true, kind: "set_thinking", result: { selection: this.domain.snapshot().selection } };
			}
			case "editor_activity": {
				if (typeof request.body.empty !== "boolean") return { ok: false, code: "invalid_input" };
				this.editorEmpty = request.body.empty;
				if (this.editorEmpty) this.handleDriverStateChange();
				else this.refreshIdleRecapActivity();
				return { ok: true, kind: "editor_activity", result: {} };
			}
			case "logout": {
				if (this.domain === undefined) return { ok: false, code: "domain_unavailable" };
				const providerId = String(request.body.providerId ?? "");
				if (providerId.length === 0) return { ok: false, code: "invalid_input" };
				await this.domain.controller.logout(providerId);
				return { ok: true, kind: "logout", result: {} };
			}
			case "login": {
				if (this.domain === undefined) return { ok: false, code: "domain_unavailable" };
				const loginBody = request.body as Record<string, unknown>;
				const loginProvider = String(loginBody.providerId ?? "");
				if (loginProvider.length === 0) return { ok: false, code: "invalid_input" };
				if (loginBody.authType !== "api_key" && loginBody.authType !== "oauth") return { ok: false, code: "invalid_input" };
				// credential onboarding 经 driver 连接的 reverse-request 投递 UI。
				const interaction = createReverseRequestAuthInteraction({ sender: this.server, connectionId: meta.connectionId });
				try {
					await this.withHumanInputWait(`credential-${request.commandId}`, "credential", () => this.domain!.controller.login(loginProvider, loginBody.authType as AuthType, interaction));
				} catch (error) {
					return { ok: false, code: "login_failed", detail: error instanceof Error ? error.message.slice(0, 200) : undefined };
				}
				const loginProviders = await this.domain.controller.getProviderStatuses();
				return { ok: true, kind: "login", result: { providers: loginProviders } };
			}
			case "domain_query": {
				const multiAgent = this.domain?.multiAgent;
				const multiOperation = typeof request.body.operation === "string" ? request.body.operation : "unknown";
				if (multiAgent !== undefined && multiAgent.operationManifest.some((entry) => entry.operation === multiOperation)) {
					const validated = this.domainRouter.query(request.body);
					if (validated.status !== "unavailable" || validated.code !== "operation_unavailable") {
						return { ok: true, kind: "domain_query", result: validated };
					}
					return {
						ok: true,
						kind: "domain_query",
						result: await multiAgent.query(
							multiOperation,
							objectValue(request.body.payload) ?? {},
							{ correlationId: String(request.body.correlationId), effectId: String(request.body.effectId) },
						),
					};
				}
				return { ok: true, kind: "domain_query", result: this.domainRouter.query(request.body) };
			}
			case "domain_command": {
				const operation = typeof request.body.operation === "string" ? request.body.operation : "unknown";
				const multiAgent = this.domain?.multiAgent;
				if (multiAgent !== undefined && multiAgent.operationManifest.some((entry) => entry.operation === operation)) {
					const validated = this.domainRouter.mutate(request.body, meta.isDriver);
					if (validated.status !== "unavailable" || validated.code !== "operation_unavailable") {
						return { ok: true, kind: "domain_command", result: validated };
					}
					if (this.state === "recovery_required" && operation === "agent.spawn") {
						return {
							ok: true,
							kind: "domain_command",
							result: { ok: false, status: "recovery_required", code: "recovery_barrier_active", operation },
						};
					}
					return {
						ok: true,
						kind: "domain_command",
						result: await multiAgent.mutate(
							operation,
							objectValue(request.body.payload) ?? {},
							{
								correlationId: String(request.body.correlationId),
								effectId: String(request.body.effectId),
								expectedRevision: Number(request.body.expectedRevision),
							},
						),
					};
				}
				const process = this.domain?.process;
				if (process !== undefined && process.operationManifest.some((entry) => entry.operation === operation)) {
					if (this.state === "recovery_required") {
						return {
							ok: true,
							kind: "domain_command",
							result: { ok: false, status: "recovery_required", code: "recovery_barrier_active", operation },
						};
					}
					const validated = this.domainRouter.mutate(request.body, meta.isDriver);
					if (validated.status !== "unavailable" || validated.code !== "operation_unavailable") {
						return { ok: true, kind: "domain_command", result: validated };
					}
					return {
						ok: true,
						kind: "domain_command",
						result: await process.mutate(
							operation,
							objectValue(request.body.payload) ?? {},
							{
								correlationId: String(request.body.correlationId),
								effectId: String(request.body.effectId),
								expectedRevision: Number(request.body.expectedRevision),
							},
						),
					};
				}
				const resources = this.domain?.resources;
				if (resources?.mutate !== undefined && resources.operationManifest.some((entry) => entry.operation === operation && entry.access === "mutate")) {
					if (this.state === "recovery_required") {
						return {
							ok: true,
							kind: "domain_command",
							result: { ok: false, status: "recovery_required", code: "recovery_barrier_active", operation },
						};
					}
					return {
						ok: true,
						kind: "domain_command",
						result: await resources.mutate(
							operation,
							objectValue(request.body.payload) ?? {},
							{
								correlationId: String(request.body.correlationId),
								effectId: String(request.body.effectId),
								expectedRevision: Number(request.body.expectedRevision),
							},
						),
					};
				}
				return { ok: true, kind: "domain_command", result: this.domainRouter.mutate(request.body, meta.isDriver) };
			}
			case "recovery_explain": {
				return {
					ok: true,
					kind: "recovery_explain",
					result: {
						state: this.state,
						barrierState: this.barrier.currentState,
						unresolvedAttempts: this.barrier.unresolvedAttempts().map((receipt) => ({
							attemptId: receipt.attemptId,
							commandId: receipt.commandId,
							effectClass: receipt.effectClass,
							outcome: receipt.outcome,
							originGeneration: receipt.originGeneration,
						})),
						sideEffectSpawnCount: this.barrier.sideEffectSpawnCount,
					},
				};
			}
			case "recovery_assess": {
				this.recoveryAssess();
				return { ok: true, kind: "recovery_assess", result: { state: this.state, unresolvedRemaining: this.unresolvedAttemptsCount() } };
			}
			case "recovery_verify": {
				const decision = request.body as Partial<RecoveryDecision> & { kind: "verify" };
				if (typeof decision.attemptId !== "string") return { ok: false, code: "invalid_input" };
				const result = this.recoveryDecide({
					kind: "verify",
					attemptId: decision.attemptId as AttemptId,
					outcome: decision.outcome === "verified_clean" ? "verified_clean" : "settled",
					evidenceDigest: decision.evidenceDigest,
				});
				if (!result.ok) return { ok: false, code: result.code ?? "recovery_verify_failed" };
				return { ok: true, kind: "recovery_verify", result: { state: result.state } };
			}
			case "recovery_abort": {
				const reasonCode = typeof request.body.reasonCode === "string" ? request.body.reasonCode : "operator-abort";
				this.recoveryDecide({ kind: "abort", reasonCode });
				return { ok: true, kind: "recovery_abort", result: { state: this.state } };
			}
			case "recovery_resume": {
				const body = request.body as Record<string, unknown>;
				const principalId = (typeof body.principalId === "string" ? body.principalId : "principal_operator") as PrincipalId;
				const result = this.recoveryDecide({
					kind: "resume_despite_uncertainty",
					principalId,
					reasonCode: typeof body.reasonCode === "string" ? body.reasonCode : "user-accepted-uncertainty",
					originGeneration: this.fence.generation,
					settledGeneration: this.fence.generation,
					evidenceDigest: runtimeDigest({ resume: String(body.reasonCode ?? "") }),
				});
				if (!result.ok) return { ok: false, code: result.code ?? "recovery_resume_failed" };
				return { ok: true, kind: "recovery_resume", result: { state: result.state } };
			}
			case "interrupt":
				this.invalidateIdleRecap();
				this.domain?.controller.interrupt();
				this.emit({ eventType: "turn.interrupted", payload: {} });
				return { ok: true, kind: "interrupt", result: {} };
			default:
				return { ok: false, code: "unknown_command" };
		}
	}

	public async handleQuery(request: SessionQueryRequest): Promise<Record<string, unknown>> {
		switch (request.kind) {
			case "domain_query": {
					const operation = typeof request.body.operation === "string" ? request.body.operation : "unknown";
					const multiAgent = this.domain?.multiAgent;
					if (multiAgent !== undefined && multiAgent.operationManifest.some((entry) => entry.operation === operation)) {
						const validated = this.domainRouter.query(request.body);
						if (validated.status !== "unavailable" || validated.code !== "operation_unavailable") return validated;
						return multiAgent.query(
							operation,
							objectValue(request.body.payload) ?? {},
							{ correlationId: String(request.body.correlationId), effectId: String(request.body.effectId) },
						);
					}
					const process = this.domain?.process;
				if (process !== undefined && process.operationManifest.some((entry) => entry.operation === operation)) {
					const validated = this.domainRouter.query(request.body);
					if (validated.status !== "unavailable" || validated.code !== "operation_unavailable") return validated;
					return process.query(
						operation,
						objectValue(request.body.payload) ?? {},
						{
							correlationId: String(request.body.correlationId),
							effectId: String(request.body.effectId),
						},
						);
					}
					const resources = this.domain?.resources;
					if (resources !== undefined && resources.operationManifest.some((entry) => entry.operation === operation && entry.access === "read")) {
						const validated = this.domainRouter.query(request.body);
						if (validated.status !== "unavailable" || validated.code !== "operation_unavailable") return validated;
						return resources.query(
							operation,
							objectValue(request.body.payload) ?? {},
							{
								correlationId: String(request.body.correlationId),
								effectId: String(request.body.effectId),
							},
						);
					}
					return this.domainRouter.query(request.body);
			}
			case "snapshot":
				return this.domainSnapshot();
			case "timeline":
				{
					const requestedLimit = Number(request.body.limit ?? 100);
					const limit = Number.isSafeInteger(requestedLimit) ? Math.min(1_000, Math.max(1, requestedLimit)) : 100;
					const events = this.store.replaySessionEvents(this.sessionId);
				return {
					ok: true,
					kind: "timeline",
					events: events.slice(-limit).map((event) => ({
						sequence: event.sequence,
						eventId: event.eventId,
						eventType: event.eventType,
						payload: safeJson(event.payloadJson),
					})),
				};
				}
			case "receipts":
				return {
					ok: true,
					kind: "receipts",
					receipts: this.store.listAllAttemptReceipts(this.sessionId).map((receipt) => ({
						attemptId: receipt.attemptId,
						commandId: receipt.commandId,
						outcome: receipt.outcome,
						effectClass: receipt.effectClass,
						originGeneration: receipt.originGeneration,
						settledGeneration: receipt.settledGeneration,
					})),
				};
			case "recovery_status":
				return {
					ok: true,
					kind: "recovery_status",
					state: this.state,
					barrierState: this.barrier.currentState,
					unresolvedAttempts: this.unresolvedAttemptsCount(),
					sideEffectSpawnCount: this.barrier.sideEffectSpawnCount,
				};
			default:
				return { ok: false, kind: request.kind, code: "unknown_query" };
		}
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

function safeJson(text: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(text) as unknown;
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : { raw: text };
	} catch {
		return { raw: text };
	}
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function isTerminalAttemptOutcome(outcome: CommandAttemptOutcome): boolean {
	return outcome === "committed" || outcome === "rejected" || outcome === "verified";
}

function checkpointBoundaryForAgentEvent(event: AgentEvent): SessionCheckpointBoundary | undefined {
	switch (event.type) {
		case "turn_start": return "before_model";
		case "message_end": return event.role === "assistant" ? "after_model" : undefined;
		case "tool_execution_start": return "before_tool";
		case "tool_execution_end": return "after_tool";
		case "turn_end": return "turn_completed";
		default: return undefined;
	}
}

async function boundedWait(promise: Promise<void>, timeoutMs: number): Promise<void> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			promise.catch(() => undefined),
			new Promise<void>((resolve) => {
				timeout = setTimeout(resolve, timeoutMs);
				timeout.unref?.();
			}),
		]);
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}
