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
import { RUNTIME_HOST_BOUNDS } from "./types.ts";
import type {
	InteractiveSessionControllerPort,
	ProviderStatus,
	RuntimeSelection,
} from "../interactive-session-controller.ts";

export interface HostRequestTransport {
	request(frame: HostFrameEnvelope): Promise<HostFrameEnvelope>;
	onEvent(listener: (frame: HostFrameEnvelope) => void): () => void;
	notify?(frame: HostFrameEnvelope): void | Promise<void>;
}

/** Client-only view of Host domain ports; it owns no reducer, store, or writer. */
export interface HostDomainClient {
	queryHostDomain(operation: string, body?: Record<string, unknown>): Promise<Record<string, unknown>>;
	commandHostDomain(operation: string, body?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface RemoteSessionSnapshot {
	readonly sessionId: string;
	readonly selection: RuntimeSelection;
	readonly messages: readonly AgentMessage[];
	readonly warnings: readonly string[];
	readonly auditEntries: readonly LedgerEntry[];
	readonly toolCount: number;
	readonly hostGeneration: number;
	readonly sessionGeneration: number;
	readonly driverRevision: number;
	readonly eventCursor?: number;
}

export class RemoteInteractiveSessionController implements InteractiveSessionControllerPort, HostDomainClient {
	private readonly transport: HostRequestTransport;
	private readonly listeners = new Set<AgentEventSink>();
	private readonly seenEventIds = new Set<string>();
	private readonly seenEventOrder: string[] = [];
	private readonly pendingEvents = new Map<number, HostFrameEnvelope>();
	private readonly removeTransportListener: () => void;
	private readonly session: string;
	private readonly messageState: AgentMessage[];
	private readonly warningState: string[];
	private readonly auditState: LedgerEntry[];
	private readonly toolCountValue: number;
	private selectionValue: RuntimeSelection;
	private inFlightValue = false;
	private sequence = 0;
	private hostGeneration: number;
	private sessionGeneration: number;
	private driverRevision: number;
	private eventCursor: number;
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
		this.hostGeneration = snapshot.hostGeneration;
		this.sessionGeneration = snapshot.sessionGeneration;
		this.driverRevision = snapshot.driverRevision;
		this.eventCursor = snapshot.eventCursor ?? 0;
		this.removeTransportListener = transport.onEvent((frame) => this.receive(frame));
	}

	public driverFence(): { readonly expectedHostGeneration: number; readonly expectedSessionGeneration: number; readonly expectedDriverRevision: number } {
		return {
			expectedHostGeneration: this.hostGeneration,
			expectedSessionGeneration: this.sessionGeneration,
			expectedDriverRevision: this.driverRevision,
		};
	}

	public updateDriverFence(value: { readonly hostGeneration?: number; readonly sessionGeneration?: number; readonly driverRevision?: number }): void {
		if (value.hostGeneration !== undefined) this.hostGeneration = value.hostGeneration;
		if (value.sessionGeneration !== undefined) this.sessionGeneration = value.sessionGeneration;
		if (value.driverRevision !== undefined) this.driverRevision = value.driverRevision;
	}

	public async resumeEvents(): Promise<"subscribed" | "resync_required"> {
		const response = await this.command("session.subscribe", { cursor: this.eventCursor }, true);
		if (response.body.ok === false) {
			if (response.body.code === "resync_required" && typeof response.body.safeCursor === "number") {
				this.eventCursor = response.body.safeCursor;
				this.pendingEvents.clear();
				return "resync_required";
			}
			throw new Error(typeof response.body.code === "string" ? response.body.code : "Host subscription rejected");
		}
		if (Array.isArray(response.body.events)) {
			for (const body of response.body.events) {
				if (isRecord(body)) this.acceptEventBody(body);
			}
		}
		return "subscribed";
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

	public async queryHostDomain(operation: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
		if (this.disposed) throw new Error("remote session controller is disposed");
		const frameId = `remote_query_${++this.sequence}_${Date.now()}`;
		const response = await this.transport.request({
			frameId,
			kind: "query_request",
			protocolVersion: 1,
			body: { operation, sessionId: this.session, ...body },
		});
		if (response.body.ok !== true) throw new Error(typeof response.body.code === "string" ? response.body.code : "Host domain query rejected");
		return response.body;
	}

	public async commandHostDomain(operation: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
		const response = await this.command(operation, body);
		return response.body;
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

	private async command(operation: string, body: Record<string, unknown>, allowFailure = false): Promise<HostFrameEnvelope> {
		if (this.disposed) throw new Error("remote session controller is disposed");
		const frameId = `remote_${++this.sequence}_${Date.now()}`;
		const response = await this.transport.request({
			frameId,
			kind: "command_request",
			protocolVersion: 1,
			body: { operation, commandId: frameId, sessionId: this.session, ...this.driverFence(), ...body },
		});
		this.updateDriverFence({
			hostGeneration: integer(response.body.hostGeneration),
			sessionGeneration: integer(response.body.sessionGeneration),
			driverRevision: integer(response.body.driverRevision),
		});
		if (!allowFailure && response.body.ok === false) {
			throw new Error(typeof response.body.code === "string" ? response.body.code : "Host request rejected");
		}
		return response;
	}

	private receive(frame: HostFrameEnvelope): void {
		if (this.disposed) return;
		if (frame.kind === "resync_required") {
			const safeCursor = integer(frame.body.safeCursor);
			if (safeCursor !== undefined) {
				this.eventCursor = safeCursor;
				this.pendingEvents.clear();
			}
			return;
		}
		if (frame.kind !== "subscription_event" || frame.body.sessionId !== this.session) return;
		this.acceptEventBody(frame.body, frame);
	}

	private acceptEventBody(body: Record<string, unknown>, sourceFrame?: HostFrameEnvelope): void {
		const eventId = typeof body.eventId === "string" ? body.eventId : undefined;
		const eventSequence = integer(body.sequence);
		if (eventId === undefined || eventSequence === undefined || eventSequence < 1 || eventSequence <= this.eventCursor || this.seenEventIds.has(eventId)) return;
		if (eventSequence > this.eventCursor + 1) {
			if (this.pendingEvents.size >= RUNTIME_HOST_BOUNDS.maxAckWindow) {
				this.pendingEvents.clear();
				return;
			}
			this.pendingEvents.set(eventSequence, sourceFrame ?? { frameId: eventId, kind: "subscription_event", protocolVersion: 1, body });
			return;
		}
		const event = body.event;
		if (!isAgentEvent(event)) return;
		this.rememberEvent(eventId);
		this.eventCursor = eventSequence;
		this.inFlightValue = event.type !== "agent_end";
		if (event.type === "agent_end") {
			for (const resolve of this.idleWaiters.splice(0)) resolve();
		}
		for (const listener of this.listeners) void listener(event);
		this.ackCursor();
		while (true) {
			const next = this.pendingEvents.get(this.eventCursor + 1);
			if (!next) break;
			this.pendingEvents.delete(this.eventCursor + 1);
			this.acceptEventBody(next.body, next);
		}
	}

	private rememberEvent(eventId: string): void {
		this.seenEventIds.add(eventId);
		this.seenEventOrder.push(eventId);
		while (this.seenEventOrder.length > RUNTIME_HOST_BOUNDS.maxAckWindow) {
			const oldest = this.seenEventOrder.shift();
			if (oldest !== undefined) this.seenEventIds.delete(oldest);
		}
	}

	private ackCursor(): void {
		void this.transport.notify?.({
			frameId: `ack_${this.session}_${this.eventCursor}`,
			kind: "ack_cursor",
			protocolVersion: 1,
			body: { sessionId: this.session, cursor: this.eventCursor },
		});
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

function integer(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
