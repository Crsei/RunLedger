/** Stable client transport that recovers disposable Runtime Host connections. */

import type { HostRequestTransport } from "../runtime/host/remote-session.ts";
import type { HostFrameEnvelope } from "../runtime/host/types.ts";
import type { HostEndpointRecord } from "../storage/host/endpoint-store.ts";
import type { HostShutdownIntent } from "../storage/host/shutdown-intent-store.ts";

export type HostBridgeState = "ready" | "reconnecting" | "stopped" | "build_mismatch" | "recovery_required";

export interface ReconnectableHostConnection extends HostRequestTransport {
	readonly endpoint: HostEndpointRecord;
	onClose(listener: (error: Error) => void): () => void;
	close(): Promise<void>;
}

export interface ReconnectingHostBridgeOptions {
	readonly initialConnection: ReconnectableHostConnection;
	readonly reconnect: () => Promise<ReconnectableHostConnection>;
	readonly policy: "tui" | "headless";
	readonly readShutdownIntent?: () => Promise<HostShutdownIntent | undefined>;
	readonly delay?: (durationMs: number) => Promise<void>;
}

export interface HostBridgeSessionBinding {
	readonly sessionId: string;
	readonly cursor: () => number;
	readonly onFence: (value: {
		readonly hostGeneration: number;
		readonly sessionGeneration: number;
		readonly driverRevision: number;
		readonly isDriver: boolean;
	}) => void;
	readonly onResync: (snapshot: unknown, safeCursor: number) => void;
}

export class ReconnectingHostBridge implements HostRequestTransport {
	private readonly options: ReconnectingHostBridgeOptions;
	private readonly eventListeners = new Set<(frame: HostFrameEnvelope) => void>();
	private readonly stateListeners = new Set<(state: HostBridgeState) => void>();
	private connection: ReconnectableHostConnection;
	private connectionGenerationValue = 0;
	private stateValue: HostBridgeState = "ready";
	private removeConnectionEvent: (() => void) | undefined;
	private removeConnectionClose: (() => void) | undefined;
	private reconnecting: Promise<void> | undefined;
	private sessionBinding: HostBridgeSessionBinding | undefined;
	private disposed = false;
	private recoverySequence = 0;

	public constructor(options: ReconnectingHostBridgeOptions) {
		this.options = options;
		this.connection = options.initialConnection;
		this.activate(options.initialConnection);
	}

	public state(): HostBridgeState { return this.stateValue; }
	public connectionGeneration(): number { return this.connectionGenerationValue; }
	public endpoint(): HostEndpointRecord { return this.connection.endpoint; }

	public bindSession(binding: HostBridgeSessionBinding): void { this.sessionBinding = binding; }

	public onStateChange(listener: (state: HostBridgeState) => void): () => void {
		this.stateListeners.add(listener);
		return () => this.stateListeners.delete(listener);
	}

	public onEvent(listener: (frame: HostFrameEnvelope) => void): () => void {
		this.eventListeners.add(listener);
		return () => this.eventListeners.delete(listener);
	}

	public async request(frame: HostFrameEnvelope): Promise<HostFrameEnvelope> {
		if (this.disposed) throw new Error("host_stopped");
		if (this.stateValue !== "ready") throw new Error(stateError(this.stateValue));
		const generation = this.connectionGenerationValue;
		const connection = this.connection;
		let response: HostFrameEnvelope;
		try {
			response = await connection.request(frame);
		} catch {
			await this.ensureReconnect(generation);
			return this.retryCurrent(frame);
		}
		if (generation !== this.connectionGenerationValue) return this.retryCurrent(frame);
		return this.guardOutcome(response);
	}

	public notify(frame: HostFrameEnvelope): void {
		if (this.disposed || this.stateValue !== "ready") return;
		void this.connection.notify?.(frame);
	}

	public async close(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.removeConnectionEvent?.();
		this.removeConnectionClose?.();
		this.eventListeners.clear();
		this.stateListeners.clear();
		await this.connection.close();
	}

	private async retryCurrent(frame: HostFrameEnvelope): Promise<HostFrameEnvelope> {
		if (this.stateValue !== "ready") throw new Error(stateError(this.stateValue));
		return this.guardOutcome(await this.connection.request(frame));
	}

	private guardOutcome(response: HostFrameEnvelope): HostFrameEnvelope {
		if (response.body.code === "uncertain_outcome") {
			this.transition("recovery_required");
			throw new Error("uncertain_outcome");
		}
		return response;
	}

	private activate(connection: ReconnectableHostConnection): void {
		this.removeConnectionEvent?.();
		this.removeConnectionClose?.();
		this.connection = connection;
		this.connectionGenerationValue += 1;
		const generation = this.connectionGenerationValue;
		this.removeConnectionEvent = connection.onEvent((frame) => {
			if (this.disposed || generation !== this.connectionGenerationValue) return;
			for (const listener of this.eventListeners) listener(frame);
		});
		this.removeConnectionClose = connection.onClose(() => {
			if (this.disposed || generation !== this.connectionGenerationValue) return;
			void this.ensureReconnect(generation).catch(() => undefined);
		});
	}

	private async ensureReconnect(failedGeneration: number): Promise<void> {
		if (failedGeneration !== this.connectionGenerationValue && this.stateValue === "ready") return;
		this.reconnecting ??= this.reconnectLoop().finally(() => { this.reconnecting = undefined; });
		return this.reconnecting;
	}

	private async reconnectLoop(): Promise<void> {
		const disconnectedEndpoint = this.connection.endpoint;
		let intent: HostShutdownIntent | undefined;
		try {
			intent = await this.options.readShutdownIntent?.();
		} catch {
			this.transition("recovery_required");
			throw new Error("host_recovery_required");
		}
		if (intent !== undefined && intent.hostRuntimeId === disconnectedEndpoint.hostRuntimeId &&
			intent.hostGeneration === disconnectedEndpoint.hostGeneration &&
			(intent.reason === "manual_stop" || intent.reason === "external_signal")) {
			this.transition("stopped");
			throw new Error("host_stopped");
		}
		this.transition("reconnecting");
		const maxAttempts = this.options.policy === "headless" ? 5 : Number.POSITIVE_INFINITY;
		let attempt = 0;
		while (!this.disposed && attempt < maxAttempts) {
			attempt += 1;
			await (this.options.delay ?? defaultDelay)(Math.min(1_000, 50 * (2 ** Math.min(attempt - 1, 5))));
			let connection: ReconnectableHostConnection | undefined;
			try {
				connection = await this.options.reconnect();
				this.activate(connection);
				await this.recoverSession(connection);
				this.transition("ready");
				return;
			} catch (error) {
				if (connection !== undefined && connection === this.connection) {
					this.removeConnectionEvent?.();
					this.removeConnectionClose?.();
					await connection.close().catch(() => undefined);
				}
				if (errorCode(error) === "host_build_mismatch") {
					this.transition("build_mismatch");
					throw new Error("host_build_mismatch");
				}
			}
		}
		if (this.disposed) throw new Error("host_stopped");
		this.transition("recovery_required");
		throw new Error("host_recovery_required");
	}

	private async recoverSession(connection: ReconnectableHostConnection): Promise<void> {
		const binding = this.sessionBinding;
		if (binding === undefined) return;
		const recoveryId = `${this.connectionGenerationValue}_${++this.recoverySequence}`;
		const opened = await connection.request(commandFrame(`bridge_open_${recoveryId}`, "session.open", { mode: "open", sessionId: binding.sessionId }));
		if (opened.body.ok !== true) throw new Error(errorCode(opened.body));
		const openFence = fenceFrom(opened.body);
		const claimed = await connection.request(commandFrame(`bridge_claim_${recoveryId}`, "session.claim_driver", { sessionId: binding.sessionId, ...openFence }));
		const activeFence = claimed.body.ok === true ? fenceFrom(claimed.body) : openFence;
		binding.onFence({ ...activeFence, isDriver: claimed.body.ok === true });
		const subscribed = await connection.request(commandFrame(`bridge_subscribe_${recoveryId}`, "session.subscribe", { sessionId: binding.sessionId, cursor: binding.cursor(), ...activeFence }));
		if (subscribed.body.ok !== true) {
			if (subscribed.body.code !== "resync_required") throw new Error(errorCode(subscribed.body));
			const snapshot = await connection.request(queryFrame(`bridge_snapshot_${recoveryId}`, "session.snapshot", { sessionId: binding.sessionId }));
			if (snapshot.body.ok !== true) throw new Error(errorCode(snapshot.body));
			binding.onResync(snapshot.body.snapshot, integer(snapshot.body.eventCursor) ?? integer(subscribed.body.safeCursor) ?? binding.cursor());
			return;
		}
		if (!Array.isArray(subscribed.body.events)) return;
		for (const body of subscribed.body.events) {
			if (!isRecord(body)) continue;
			const eventId = typeof body.eventId === "string" ? body.eventId : `bridge_event_${recoveryId}`;
			const frame: HostFrameEnvelope = { frameId: eventId, kind: "subscription_event", protocolVersion: 1, body };
			for (const listener of this.eventListeners) listener(frame);
		}
	}

	private transition(state: HostBridgeState): void {
		if (this.stateValue === state) return;
		this.stateValue = state;
		for (const listener of this.stateListeners) listener(state);
	}
}

function commandFrame(frameId: string, operation: string, body: Record<string, unknown>): HostFrameEnvelope {
	return { frameId, kind: "command_request", protocolVersion: 1, body: { operation, commandId: frameId, ...body } };
}

function queryFrame(frameId: string, operation: string, body: Record<string, unknown>): HostFrameEnvelope {
	return { frameId, kind: "query_request", protocolVersion: 1, body: { operation, ...body } };
}

function fenceFrom(body: Record<string, unknown>): { readonly hostGeneration: number; readonly sessionGeneration: number; readonly driverRevision: number } {
	const hostGeneration = integer(body.hostGeneration);
	const sessionGeneration = integer(body.sessionGeneration);
	const driverRevision = integer(body.driverRevision);
	if (hostGeneration === undefined || sessionGeneration === undefined || driverRevision === undefined) throw new Error("host_recovery_fence_invalid");
	return { hostGeneration, sessionGeneration, driverRevision };
}

function integer(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(value: unknown): string {
	if (value instanceof Error) return value.message;
	if (isRecord(value) && typeof value.code === "string") return value.code;
	return "host_reconnect_failed";
}

function stateError(state: HostBridgeState): string {
	return state === "reconnecting" ? "host_reconnecting" : state === "stopped" ? "host_stopped" : state === "build_mismatch" ? "host_build_mismatch" : "host_recovery_required";
}

function defaultDelay(durationMs: number): Promise<void> {
	return new Promise<void>((resolve) => setTimeout(resolve, durationMs));
}
