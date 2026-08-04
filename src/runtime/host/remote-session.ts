/** Host-owned interactive-session facade used by the standard client TUI. */

import type { AuthInteraction, AuthType, Credential } from "../../auth/types.ts";
import type { Api, Model, ModelThinkingLevel } from "../../types.ts";
import type {
	AgentEvent,
	AgentEventSink,
	AgentMessage,
	UserAgentMessage,
} from "../types.ts";
import type { LedgerEntry } from "../ledger/types.ts";
import type { HostFrameEnvelope } from "./types.ts";
import type {
	InteractiveSessionControllerPort,
	ProviderStatus,
	RuntimeSelection,
} from "../interactive-session-controller.ts";

export interface HostRequestTransport {
	request(frame: HostFrameEnvelope): Promise<HostFrameEnvelope>;
	onEvent(listener: (frame: HostFrameEnvelope) => void): () => void;
}

export interface RemoteSessionSnapshot {
	readonly sessionId: string;
	readonly selection: RuntimeSelection;
	readonly messages: readonly AgentMessage[];
	readonly warnings: readonly string[];
	readonly auditEntries: readonly LedgerEntry[];
	readonly toolCount: number;
}

export class RemoteInteractiveSessionController implements InteractiveSessionControllerPort {
	private readonly transport: HostRequestTransport;
	private readonly listeners = new Set<AgentEventSink>();
	private readonly seenEventIds = new Set<string>();
	private readonly removeTransportListener: () => void;
	private readonly session: string;
	private readonly messageState: AgentMessage[];
	private readonly warningState: string[];
	private readonly auditState: LedgerEntry[];
	private readonly toolCountValue: number;
	private selectionValue: RuntimeSelection;
	private inFlightValue = false;
	private sequence = 0;
	private disposed = false;
	private idleWaiters: Array<() => void> = [];

	public constructor(transport: HostRequestTransport, snapshot: RemoteSessionSnapshot) {
		this.transport = transport;
		this.session = snapshot.sessionId;
		this.selectionValue = { ...snapshot.selection };
		this.messageState = [...snapshot.messages];
		this.warningState = [...snapshot.warnings];
		this.auditState = [...snapshot.auditEntries];
		this.toolCountValue = snapshot.toolCount;
		this.removeTransportListener = transport.onEvent((frame) => this.receive(frame));
	}

	public subscribe(listener: AgentEventSink): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	public get sessionId(): string { return this.session; }
	public get inFlight(): boolean { return this.inFlightValue; }
	public get currentSelection(): RuntimeSelection { return { ...this.selectionValue }; }
	public get messages(): readonly AgentMessage[] { return this.messageState; }
	public get warnings(): readonly string[] { return this.warningState; }
	public get auditEntries(): readonly LedgerEntry[] { return this.auditState; }
	public get ledger(): undefined { return undefined; }
	public get toolCount(): number { return this.toolCountValue; }

	public getSteeringMessages(): readonly UserAgentMessage[] { return []; }
	public getFollowUpMessages(): readonly UserAgentMessage[] { return []; }

	public async getProviderStatuses(): Promise<ProviderStatus[]> {
		const response = await this.command("session.provider_status", {});
		return isArray(response.body.providers) ? response.body.providers as ProviderStatus[] : [];
	}

	public getProvider(_id: string): undefined { return undefined; }

	public async getAvailableModels(provider?: string): Promise<readonly Model<Api>[]> {
		const response = await this.command("session.models", provider === undefined ? {} : { provider });
		return isArray(response.body.models) ? response.body.models as Model<Api>[] : [];
	}

	public async login(_providerId: string, _type: AuthType, _interaction: AuthInteraction): Promise<Credential> {
		throw new Error("remote provider login requires an interactive Host auth channel");
	}

	public async logout(providerId: string): Promise<void> {
		await this.command("session.logout", { providerId });
	}

	public async selectModel(model: Model<Api>): Promise<void> {
		const response = await this.command("session.select_model", { provider: model.provider, model: model.id });
		this.updateSelection(response.body.selection);
	}

	public async setThinkingLevel(level: ModelThinkingLevel): Promise<ModelThinkingLevel> {
		const response = await this.command("session.set_thinking", { level });
		const selection = this.updateSelection(response.body.selection);
		return selection.thinkingLevel;
	}

	public async prompt(text: string, behavior?: "steer" | "followUp"): Promise<void> {
		const operation = this.inFlightValue
			? behavior === "followUp" ? "session.follow_up" : "session.steer"
			: "session.prompt";
		await this.command(operation, { text });
	}

	public interrupt(): void {
		void this.command("session.interrupt", {}).catch(() => undefined);
	}

	public clearAllQueues(): { steering: UserAgentMessage[]; followUp: UserAgentMessage[] } {
		void this.command("session.clear_queues", {}).catch(() => undefined);
		return { steering: [], followUp: [] };
	}

	public waitForIdle(): Promise<void> {
		if (!this.inFlightValue) return Promise.resolve();
		return new Promise<void>((resolve) => this.idleWaiters.push(resolve));
	}

	public dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.removeTransportListener();
		this.listeners.clear();
		for (const resolve of this.idleWaiters.splice(0)) resolve();
	}

	private async command(operation: string, body: Record<string, unknown>): Promise<HostFrameEnvelope> {
		if (this.disposed) throw new Error("remote session controller is disposed");
		const frameId = `remote_${++this.sequence}_${Date.now()}`;
		const response = await this.transport.request({
			frameId,
			kind: "command_request",
			protocolVersion: 1,
			body: { operation, commandId: frameId, sessionId: this.session, ...body },
		});
		if (response.body.ok === false) {
			throw new Error(typeof response.body.code === "string" ? response.body.code : "Host request rejected");
		}
		return response;
	}

	private receive(frame: HostFrameEnvelope): void {
		if (this.disposed || frame.kind !== "subscription_event") return;
		if (frame.body.sessionId !== this.session || typeof frame.body.eventId !== "string") return;
		if (this.seenEventIds.has(frame.body.eventId)) return;
		this.seenEventIds.add(frame.body.eventId);
		const event = frame.body.event;
		if (!isAgentEvent(event)) return;
		this.inFlightValue = event.type !== "agent_end";
		if (event.type === "agent_end") {
			for (const resolve of this.idleWaiters.splice(0)) resolve();
		}
		for (const listener of this.listeners) void listener(event);
	}

	private updateSelection(value: unknown): RuntimeSelection {
		if (isRecord(value) && (value.model === undefined || isRecord(value.model)) && typeof value.thinkingLevel === "string") {
			this.selectionValue = value as unknown as RuntimeSelection;
		}
		return this.selectionValue;
	}
}

function isArray(value: unknown): value is readonly unknown[] { return Array.isArray(value); }

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAgentEvent(value: unknown): value is AgentEvent {
	return isRecord(value) && typeof value.type === "string" && typeof value.timestamp === "number";
}
