/**
 * R7:session-scoped interactive controller(R6 §8.3 本地 owner view 也走 TCP
 * facade 的 TUI 侧适配器)。
 *
 * - 实现 InteractiveSessionControllerPort:所有 mutation 经 SessionClientTransport
 *   (localhost TCP)发到 RuntimeServer,不直接驱动 Agent/controller;
 * - 事件:subscribe_request → subscription_event;payload 中的 AgentEvent
 *   (agent.event 类型)解析后转发给 TUI listener;ack_cursor 维持 cursor;
 * - 消息/审计投影:初始来自 snapshot 查询,之后由 AgentEvent 增量更新。
 */

import type { AuthInteraction, AuthType, Credential } from "../auth/types.ts";
import type { Api, Model, ModelThinkingLevel } from "../types.ts";
import type { AgentEvent, AgentEventSink, AgentMessage, UserAgentMessage } from "../runtime/types.ts";
import type { LedgerEntry } from "../runtime/ledger/types.ts";
import type { SessionFrameEnvelope } from "../runtime/session-server/protocol.ts";
import { SESSION_PROTOCOL_BOUNDS, SESSION_PROTOCOL_VERSION } from "../runtime/session-server/protocol.ts";
import type { SessionClientTransport } from "../runtime/session-server/client-transport.ts";
import type { SessionDomainMutationContext, SessionDomainRequestContext, SessionDomainResult } from "../runtime/session-runtime/domain-router.ts";
import type {
	InteractiveSessionControllerPort,
	ProviderStatus,
	RuntimeSelection,
	SessionTitleChangedSink,
	SessionTitleChangedEvent,
	SessionIdleRecapSink,
	SessionIdleRecapEvent,
	SessionRecoveryAssessment,
	SessionRecoveryDecisionResult,
	SessionRecoveryStatus,
} from "../runtime/interactive-session-controller.ts";
import type { OwnedSessionHandle } from "./session-client.ts";
import type { AgentRunSummary } from "../runtime/session-runtime/run-timing.ts";

export interface SessionInteractiveSnapshot {
	readonly sessionId: string;
	readonly messages: readonly AgentMessage[];
	readonly warnings: readonly string[];
	readonly auditEntries: readonly LedgerEntry[];
	readonly selection: RuntimeSelection;
	readonly toolCount: number;
	readonly eventCursor: number;
	readonly driverRevision: number;
	readonly agentRuns?: readonly AgentRunSummary[];
}

/** R7:TUI 的 session-owner 适配器(替代 legacy RemoteInteractiveSessionController)。 */
export class SessionInteractiveController implements InteractiveSessionControllerPort {
	private readonly transport: SessionClientTransport;
	private readonly supportsOperation: (operation: string) => boolean;
	private readonly listeners = new Set<AgentEventSink>();
	private readonly titleListeners = new Set<SessionTitleChangedSink>();
	private readonly idleRecapListeners = new Set<SessionIdleRecapSink>();
	private readonly pendingTitleEvents: SessionTitleChangedEvent[] = [];
	private readonly session: string;
	private readonly sessionGeneration: number;
	private connectionRole: "driver" | "observer" = "observer";
	private readonly messageState: AgentMessage[];
	private readonly warningState: string[];
	private readonly auditState: LedgerEntry[];
	private toolCountValue: number;
	private selectionValue: RuntimeSelection;
	private inFlightValue = false;
	private eventCursor: number;
	private driverRevision: number;
	private sequence = 0;
	private disposed = false;
	private idleWaiters: Array<() => void> = [];
	private readonly removeTransportListener: () => void;
	private readonly runSummaryState: readonly AgentRunSummary[];
	private readonly pendingListenerEvents: AgentEvent[] = [];
	private eventBufferOverflow = false;

	public constructor(handle: OwnedSessionHandle, snapshot: SessionInteractiveSnapshot) {
		this.transport = handle.transport;
		this.supportsOperation = typeof handle.supports === "function" ? (operation) => handle.supports(operation) : () => false;
		this.session = snapshot.sessionId;
		this.sessionGeneration = handle.generation;
		this.messageState = [...snapshot.messages];
		this.warningState = [...snapshot.warnings];
		this.auditState = [...snapshot.auditEntries];
		this.selectionValue = { ...snapshot.selection };
		this.toolCountValue = snapshot.toolCount;
		this.eventCursor = snapshot.eventCursor;
		this.driverRevision = snapshot.driverRevision;
		this.runSummaryState = snapshot.agentRuns ?? [];
		this.removeTransportListener = handle.transport.onEvent((frame) => this.receive(frame));
	}

	public driverFence(): { readonly expectedDriverRevision: number } {
		return { expectedDriverRevision: this.driverRevision };
	}

	public supports(operation: string): boolean {
		return this.supportsOperation(operation);
	}

	public setConnectionRole(role: "driver" | "observer"): void {
		this.connectionRole = role;
	}

	public recoveryCursor(): number {
		return this.eventCursor;
	}

	public subscribe(listener: AgentEventSink): () => void {
		this.listeners.add(listener);
		if (this.listeners.size === 1 && this.pendingListenerEvents.length > 0) {
			for (const event of this.pendingListenerEvents.splice(0)) void listener(event);
		}
		return () => this.listeners.delete(listener);
	}

	public subscribeSessionTitleChanged(listener: SessionTitleChangedSink): () => void {
		this.titleListeners.add(listener);
		if (this.titleListeners.size === 1 && this.pendingTitleEvents.length > 0) {
			for (const event of this.pendingTitleEvents.splice(0)) void listener(event);
		}
		return () => this.titleListeners.delete(listener);
	}

	public subscribeIdleRecap(listener: SessionIdleRecapSink): () => void {
		this.idleRecapListeners.add(listener);
		return () => this.idleRecapListeners.delete(listener);
	}

	public get agentRuns(): readonly AgentRunSummary[] {
		return this.runSummaryState;
	}

	public get sessionId(): string {
		return this.session;
	}

	public get authorityGeneration(): number {
		return this.sessionGeneration;
	}

	public get inFlight(): boolean {
		return this.inFlightValue;
	}

	public get currentSelection(): RuntimeSelection {
		return { ...this.selectionValue };
	}

	public get messages(): readonly AgentMessage[] {
		return this.messageState;
	}

	public get warnings(): readonly string[] {
		return this.warningState;
	}

	public get auditEntries(): readonly LedgerEntry[] {
		return this.auditState;
	}

	public get ledger(): undefined {
		return undefined;
	}

	public get toolCount(): number {
		return this.toolCountValue;
	}

	public getSteeringMessages(): readonly UserAgentMessage[] {
		return [];
	}

	public getFollowUpMessages(): readonly UserAgentMessage[] {
		return [];
	}

	public async resumeEvents(): Promise<"subscribed" | "resync_required"> {
		const response = await this.transport.request(this.frame("subscribe_request", { cursor: this.eventCursor }));
		if (this.eventBufferOverflow) return "resync_required";
		if (response.kind !== "command_result" || response.body.ok !== true) {
			return "resync_required";
		}
		const cursor = numberValue(response.body.cursor);
		if (cursor !== undefined) this.eventCursor = Math.max(this.eventCursor, cursor);
		return "subscribed";
	}

	public async getProviderStatuses(): Promise<ProviderStatus[]> {
		const response = await this.command("provider_status", {});
		return Array.isArray(response.providers) ? (response.providers as ProviderStatus[]) : [];
	}

	public getProvider(_id: string): undefined {
		return undefined;
	}

	public async getAvailableModels(provider?: string): Promise<readonly Model<Api>[]> {
		const response = await this.command("models", provider === undefined ? {} : { provider });
		return Array.isArray(response.models) ? (response.models as Model<Api>[]) : [];
	}

	public async login(providerId: string, type: AuthType, _interaction: AuthInteraction): Promise<Credential> {
		// §6.3 credential onboarding 走 driver 连接的 reverse-request 通道:
		// 本地 interaction 不再直接使用,server 侧 domain 经 reverse_request
		// 把 secret/select 提示投递给本连接,TUI 的 reverseRequestHandler 渲染。
		await this.command("login", { providerId, authType: type });
		// 命令成功即认证完成;secret/token 留在 server 侧 auth.json,客户端不持有。
		// 返回 status 标记而非伪造 token(调用方随后读 provider_status)。
		return { type: "api_key" } as Credential;
	}

	public async logout(providerId: string): Promise<void> {
		await this.command("logout", { providerId });
	}

	public async selectModel(model: Model<Api>): Promise<void> {
		const response = await this.command("select_model", { provider: model.provider, model: model.id });
		this.updateSelection(response.selection);
	}

	public async setThinkingLevel(level: ModelThinkingLevel): Promise<ModelThinkingLevel> {
		const response = await this.command("set_thinking", { level });
		return this.updateSelection(response.selection).thinkingLevel;
	}

	public async prompt(text: string, behavior?: "steer" | "followUp"): Promise<void> {
		const kind = this.inFlightValue ? (behavior === "followUp" ? "follow_up" : "steer") : "prompt";
		await this.command(kind, behavior === undefined ? { promptText: text } : { text });
	}

	public notifyEditorActivity(editorEmpty: boolean): void {
		void this.command("editor_activity", { empty: editorEmpty }).catch(() => undefined);
	}

	public interrupt(): void {
		void this.command("interrupt", {}).catch(() => undefined);
	}

	public clearAllQueues(): { steering: UserAgentMessage[]; followUp: UserAgentMessage[] } {
		void this.command("clear_queues", {}).catch(() => undefined);
		return { steering: [], followUp: [] };
	}

	public waitForIdle(): Promise<void> {
		if (!this.inFlightValue) return Promise.resolve();
		return new Promise<void>((resolve) => this.idleWaiters.push(resolve));
	}

	public async querySessionDomain(operation: string, payload: Record<string, unknown>, context: SessionDomainRequestContext): Promise<SessionDomainResult> {
		if (!this.supports(operation)) return { ok: false, status: "unavailable", code: "operation_unavailable", operation };
		if (!validDomainContext(context)) return { ok: false, status: "failed", code: "invalid_domain_context", operation };
		const response = await this.transport.request(this.frame("query_request", {
			kind: "domain_query",
			body: {
				sessionId: this.session,
				generation: this.sessionGeneration,
				correlationId: context.correlationId,
				effectId: context.effectId,
				operation,
				payload,
			},
		}));
		if (response.kind !== "query_result") {
			return { ok: false, status: "failed", code: "session_domain_query_rejected", operation };
		}
		return response.body as SessionDomainResult;
	}

	public async commandSessionDomain(operation: string, payload: Record<string, unknown>, context: SessionDomainMutationContext): Promise<SessionDomainResult> {
		if (!this.supports(operation)) return { ok: false, status: "unavailable", code: "operation_unavailable", operation };
		if (this.connectionRole !== "driver") return { ok: false, status: "denied", code: "driver_required", operation };
		if (!validDomainContext(context)) return { ok: false, status: "failed", code: "invalid_domain_context", operation };
		if (!Number.isSafeInteger(context.expectedRevision) || context.expectedRevision < 0) {
			return { ok: false, status: "failed", code: "invalid_expected_revision", operation };
		}
		const response = await this.command("domain_command", {
			sessionId: this.session,
			generation: this.sessionGeneration,
			correlationId: context.correlationId,
			effectId: context.effectId,
			operation,
			expectedRevision: context.expectedRevision,
			payload,
		});
		return response as SessionDomainResult;
	}

	public async recoveryStatus(): Promise<SessionRecoveryStatus> {
		const response = await this.transport.request(this.frame("query_request", { kind: "recovery_status", body: {} }));
		if (response.kind !== "query_result" || response.body.ok !== true) {
			throw new Error(stringValue(response.body.code) ?? "recovery status rejected");
		}
		return {
			state: String(response.body.state ?? "unknown"),
			barrierState: response.body.barrierState === "open" ? "open" : "closed",
			unresolvedAttempts: numberValue(response.body.unresolvedAttempts) ?? 0,
			sideEffectSpawnCount: numberValue(response.body.sideEffectSpawnCount) ?? 0,
		};
	}

	public async recoveryAssess(): Promise<SessionRecoveryAssessment> {
		const result = await this.command("recovery_assess", {});
		return {
			state: String(result.state ?? "unknown"),
			unresolvedRemaining: numberValue(result.unresolvedRemaining) ?? 0,
		};
	}

	public async recoveryVerify(attemptId: string): Promise<SessionRecoveryDecisionResult> {
		const result = await this.command("recovery_verify", { attemptId });
		return { state: String(result.state ?? "unknown") };
	}

	public async recoveryResume(reasonCode: string): Promise<SessionRecoveryDecisionResult> {
		const result = await this.command("recovery_resume", { reasonCode });
		return { state: String(result.state ?? "unknown") };
	}

	public dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.removeTransportListener();
		this.listeners.clear();
		this.titleListeners.clear();
		this.idleRecapListeners.clear();
		this.pendingTitleEvents.splice(0);
		for (const resolve of this.idleWaiters.splice(0)) resolve();
	}

	// ── 私有 ─────────────────────────────────────────────────────────────

	private frame(kind: SessionFrameEnvelope["kind"], body: Record<string, unknown>): SessionFrameEnvelope {
		return {
			frameId: `c${++this.sequence}_${Date.now().toString(36)}`,
			kind,
			protocolVersion: SESSION_PROTOCOL_VERSION,
			body,
		};
	}

	private async command(kind: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
		if (this.disposed) throw new Error("session controller is disposed");
		const response = await this.transport.request(this.frame("command_request", { commandId: `command_${this.sequence}`, kind, body }));
		if (response.kind !== "command_result") throw new Error("session command rejected");
		const result = response.body.result;
		const revision = numberValue(response.body.driverRevision);
		if (revision !== undefined) this.driverRevision = revision;
		if (response.body.ok !== true) {
			const code = stringValue(response.body.code) ?? "session command rejected";
			const detail = stringValue(response.body.detail);
			// 保留 detail(如 "No model selected. Use /provider or /model."),否则 TUI 只显示
			// domain_prompt_failed 这种 code,用户无法知道真正原因。
			throw new Error(detail === undefined ? code : `${code}: ${detail}`);
		}
		return typeof result === "object" && result !== null ? (result as Record<string, unknown>) : {};
	}

	private receive(frame: SessionFrameEnvelope): void {
		if (this.disposed) return;
		if (frame.kind === "resync_required") {
			const cursor = numberValue(frame.body.cursor);
			if (cursor !== undefined) this.eventCursor = cursor;
			return;
		}
		if (frame.kind !== "subscription_event") return;
		const sequence = numberValue(frame.body.sequence);
		if (sequence !== undefined && sequence <= this.eventCursor) return;
		if (sequence !== undefined) this.eventCursor = sequence;
		const event = frame.body.payload;
		if (frame.body.eventType === "session.title_changed") {
			const titleEvent = parseSessionTitleChangedEvent(event, this.session, sequence);
			if (titleEvent !== undefined) {
				if (this.titleListeners.size === 0) {
					if (this.pendingTitleEvents.length >= SESSION_PROTOCOL_BOUNDS.maxPreActivationPending) this.pendingTitleEvents.shift();
					this.pendingTitleEvents.push(titleEvent);
				}
				for (const listener of this.titleListeners) {
					try {
						void listener(titleEvent);
					} catch {
						// title observers are isolated from subscription delivery.
					}
				}
			}
			this.ackCursor();
			return;
		}
		if (frame.body.eventType === "session.idle_recap") {
			const recapEvent = parseSessionIdleRecapEvent(frame.body.payload, this.session);
			if (recapEvent !== undefined) {
				for (const listener of this.idleRecapListeners) {
					try {
						void listener(recapEvent);
					} catch {
						// transient status observers are isolated from wire delivery.
					}
				}
			}
			return;
		}
		if (!isAgentEvent(event)) {
			this.ackCursor();
			return;
		}
		this.applyCanonicalMessageEvent(event);
		this.inFlightValue = event.type !== "agent_end";
		if (event.type === "agent_end") {
			for (const resolve of this.idleWaiters.splice(0)) resolve();
		}
		if (this.listeners.size === 0) {
			if (this.pendingListenerEvents.length >= SESSION_PROTOCOL_BOUNDS.maxPreActivationPending) {
				this.pendingListenerEvents.shift();
				this.eventBufferOverflow = true;
			}
			this.pendingListenerEvents.push(event);
		}
		for (const listener of this.listeners) {
			try {
				void listener(event);
			} catch {
				// 单个 observer 失败不影响其他投递。
			}
		}
		this.ackCursor();
	}

	/**
	 * Live event 是 snapshot 之后的 canonical message 增量。
	 * TUI recovery/reseed 读取同一个 projection，不能只把事件转发给 renderer。
	 */
	private applyCanonicalMessageEvent(event: AgentEvent): void {
		if (event.type === "message_end" && event.message !== undefined) {
			this.messageState.push(event.message);
			return;
		}
		if (event.type === "tool_execution_end") {
			this.messageState.push({ role: "toolResult", content: [event.result] });
		}
	}

	private ackCursor(): void {
		this.transport.notify(this.frame("ack_cursor", { cursor: this.eventCursor }));
	}

	private updateSelection(value: unknown): RuntimeSelection {
		if (isRecord(value) && (value.model === undefined || isRecord(value.model)) && typeof value.thinkingLevel === "string") {
			this.selectionValue = value as unknown as RuntimeSelection;
		}
		return this.selectionValue;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validDomainContext(context: SessionDomainRequestContext): boolean {
	return boundedIdentifier(context.correlationId) && boundedIdentifier(context.effectId);
}

function boundedIdentifier(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function isAgentEvent(value: unknown): value is AgentEvent {
	return isRecord(value) && typeof value.type === "string" && typeof value.timestamp === "number";
}

function parseSessionTitleChangedEvent(value: unknown, sessionId: string, sequence: number | undefined): SessionTitleChangedEvent | undefined {
	if (!isRecord(value) || typeof value.title !== "string" || value.title.length === 0) return undefined;
	if (value.source !== "auto" && value.source !== "user") return undefined;
	return {
		sessionId,
		title: value.title,
		source: value.source,
		...(sequence === undefined ? {} : { sequence }),
	};
}

function parseSessionIdleRecapEvent(value: unknown, sessionId: string): SessionIdleRecapEvent | undefined {
	if (!isRecord(value) || value.sessionId !== sessionId || typeof value.requestId !== "string" || value.requestId.length === 0) return undefined;
	if (typeof value.ownerGeneration !== "number" || !Number.isSafeInteger(value.ownerGeneration) || value.ownerGeneration <= 0) return undefined;
	if (value.activityGeneration !== undefined && (typeof value.activityGeneration !== "number" || !Number.isSafeInteger(value.activityGeneration) || value.activityGeneration <= 0)) return undefined;
	if (value.driverRevision !== undefined && (typeof value.driverRevision !== "number" || !Number.isSafeInteger(value.driverRevision) || value.driverRevision < 0)) return undefined;
	if (value.text !== undefined && typeof value.text !== "string") return undefined;
	if (value.cleared !== undefined && typeof value.cleared !== "boolean") return undefined;
	return {
		sessionId,
		requestId: value.requestId,
		ownerGeneration: value.ownerGeneration,
		...(value.activityGeneration === undefined ? {} : { activityGeneration: value.activityGeneration }),
		...(value.driverRevision === undefined ? {} : { driverRevision: value.driverRevision }),
		...(value.text === undefined ? {} : { text: value.text }),
		...(value.cleared === undefined ? {} : { cleared: value.cleared }),
	};
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}
