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
import type {
	InteractiveSessionControllerPort,
	ProviderStatus,
	RuntimeSelection,
	SessionRecoveryAssessment,
	SessionRecoveryDecisionResult,
	SessionRecoveryStatus,
} from "../runtime/interactive-session-controller.ts";
import type { OwnedSessionHandle } from "./session-client.ts";

export interface SessionInteractiveSnapshot {
	readonly sessionId: string;
	readonly messages: readonly AgentMessage[];
	readonly warnings: readonly string[];
	readonly auditEntries: readonly LedgerEntry[];
	readonly selection: RuntimeSelection;
	readonly toolCount: number;
	readonly eventCursor: number;
	readonly driverRevision: number;
}

/** R7:TUI 的 session-owner 适配器(替代 legacy RemoteInteractiveSessionController)。 */
export class SessionInteractiveController implements InteractiveSessionControllerPort {
	private readonly transport: SessionClientTransport;
	private readonly listeners = new Set<AgentEventSink>();
	private readonly session: string;
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

	public constructor(handle: OwnedSessionHandle, snapshot: SessionInteractiveSnapshot) {
		this.transport = handle.transport;
		this.session = snapshot.sessionId;
		this.messageState = [...snapshot.messages];
		this.warningState = [...snapshot.warnings];
		this.auditState = [...snapshot.auditEntries];
		this.selectionValue = { ...snapshot.selection };
		this.toolCountValue = snapshot.toolCount;
		this.eventCursor = snapshot.eventCursor;
		this.driverRevision = snapshot.driverRevision;
		this.removeTransportListener = handle.transport.onEvent((frame) => this.receive(frame));
	}

	public driverFence(): { readonly expectedDriverRevision: number } {
		return { expectedDriverRevision: this.driverRevision };
	}

	public recoveryCursor(): number {
		return this.eventCursor;
	}

	public subscribe(listener: AgentEventSink): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	public get sessionId(): string {
		return this.session;
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
		if (response.kind !== "command_result" || response.body.ok !== true) {
			return "resync_required";
		}
		const cursor = numberValue(response.body.cursor);
		if (cursor !== undefined) this.eventCursor = cursor;
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

	public async login(_providerId: string, _type: AuthType, _interaction: AuthInteraction): Promise<Credential> {
		// §6.3 reverse request:credential/onboarding 走 UI interaction 通道。
		throw new Error("credential onboarding requires a reverse-request UI channel");
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

	public async queryHostDomain(operation: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
		const response = await this.transport.request(this.frame("query_request", { kind: "domain_query", body: { operation, body } }));
		if (response.kind !== "query_result" || response.body.ok !== true) {
			throw new Error(stringValue(response.body.code) ?? "session domain query rejected");
		}
		return (response.body.result ?? {}) as Record<string, unknown>;
	}

	public async commandHostDomain(operation: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
		const response = await this.command("domain_command", { operation, body });
		return response;
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
			throw new Error(stringValue(response.body.code) ?? "session command rejected");
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
		if (sequence !== undefined) this.eventCursor = Math.max(this.eventCursor, sequence);
		const event = frame.body.payload;
		if (!isAgentEvent(event)) return;
		this.inFlightValue = event.type !== "agent_end";
		if (event.type === "agent_end") {
			for (const resolve of this.idleWaiters.splice(0)) resolve();
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

function isAgentEvent(value: unknown): value is AgentEvent {
	return isRecord(value) && typeof value.type === "string" && typeof value.timestamp === "number";
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}
