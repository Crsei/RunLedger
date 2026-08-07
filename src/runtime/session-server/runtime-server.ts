/**
 * R4:单 Session 的 localhost TCP RuntimeServer(06 §6)。
 *
 * - 只绑定 IPv4 127.0.0.1,端口传 0 由 OS 分配;只服务构造时绑定的一个
 *   sessionId + generation;
 * - 首个 frame 必须是 initialize_request(认证前只允许固定 initialize frame,
 *   §4.6);token 使用 constant-time compare;session/runtime/generation 不匹配、
 *   owner 仍在 starting 或已 stopping/fenced 全部 typed fail closed;
 * - command/query/subscription/ACK/reverse-request 走 bounded JSONL frame;
 *   driver 是 connection-scoped(§6.4);多 client fan-out 带 cursor/replay/
 *   dedupe/backpressure;
 * - 本 server 同时充当 SessionOwner 的 OwnerTransport(bind-before-publish:
 *   listener 先绑定,activate 后才处理 handshake),不提供 direct-controller
 *   fallback:本地 owner view 也走同一 TCP facade。
 */

import net from "node:net";
import {
	SESSION_PROTOCOL_BOUNDS,
	SESSION_PROTOCOL_VERSION,
	isSessionFrameEnvelope,
	isSessionHandshakeRequest,
	handshakeMatchesFence,
	type SessionHandshakeRequest,
	type SessionFrameEnvelope,
} from "./protocol.ts";
import { ownerTokenConstantTimeEqual } from "../session-owner/fence.ts";
import type { OwnerEndpoint, OwnerFence, SessionOwnerState } from "../session-owner/types.ts";
import type { OwnerProbeInput, OwnerProbeResult, OwnerTransport } from "../session-owner/session-owner.ts";
import { bindCandidateListener, probeOwner } from "./owner-probe.ts";
import type { SessionStore, SessionEventRecord } from "../../storage/session-store/session-store.ts";
import { applyDriverTransition, initialDriverState, type DriverStateSnapshot } from "./driver.ts";
import { SessionSubscriptionRegistry } from "./subscription.ts";
import { createRuntimeId, type ConnectionId, type SessionId } from "../protocol/ids.ts";

export const SESSION_MUTATING_COMMAND_KINDS = [
	"prompt",
	"interrupt",
	"approval",
	"process_input",
	"process_resize",
	"process_stop",
	"model_mutation",
	"mode_mutation",
	"domain_mutation",
] as const;
export type SessionMutatingCommandKind = (typeof SESSION_MUTATING_COMMAND_KINDS)[number];

export interface SessionSnapshot {
	readonly sessionId: SessionId;
	readonly headSequence: number;
	readonly sessionStatus: string;
	readonly runtimeState: string;
}

export interface SessionCommandRequest {
	readonly commandId: string;
	readonly kind: string;
	readonly body: Record<string, unknown>;
}

export type SessionCommandResult =
	| { readonly ok: true; readonly kind: string; readonly result: Record<string, unknown> }
	| { readonly ok: false; readonly code: string; readonly detail?: string };

export interface SessionQueryRequest {
	readonly kind: string;
	readonly body: Record<string, unknown>;
}

export interface SessionControllerEvent {
	readonly eventType: string;
	readonly payload: Record<string, unknown>;
	readonly sequence?: number;
}

/** SessionRuntime(R5)或测试 double 实现的领域控制器;server 只做 facade。 */
export interface SessionController {
	readonly sessionId: SessionId;
	snapshot(): SessionSnapshot;
	handleCommand(request: SessionCommandRequest, meta: { readonly connectionId: ConnectionId; readonly clientId: string; readonly isDriver: boolean }): Promise<SessionCommandResult>;
	handleQuery(request: SessionQueryRequest): Promise<Record<string, unknown>>;
	onEvent(listener: (event: SessionControllerEvent) => void): () => void;
	isMutatingKind(kind: string): boolean;
}

interface ServerConnection {
	readonly socket: net.Socket;
	readonly connectionId: ConnectionId;
	clientId: string;
	buffer: Buffer;
	initialized: boolean;
	pendingFrames: number;
	processing: Promise<void>;
	outbox: Buffer[];
	writing: boolean;
	reverseRequests: Map<string, PendingReverseRequest>;
	closed: boolean;
}

interface PendingReverseRequest {
	readonly resolve: (frame: SessionFrameEnvelope) => void;
	readonly reject: (error: Error) => void;
	readonly timeoutId: ReturnType<typeof setTimeout>;
}

export interface SessionRuntimeServerOptions {
	readonly sessionId: SessionId;
	readonly store: SessionStore;
	readonly controller: SessionController;
	/** §8.3 attachment count 变化回调(headless-attached owner loop 用)。 */
	readonly onAttachmentCountChange?: (count: number) => void;
}

export class SessionRuntimeServer implements OwnerTransport {
	private readonly options: SessionRuntimeServerOptions;
	private readonly connections = new Set<ServerConnection>();
	private readonly registry = new SessionSubscriptionRegistry();
	private controller: SessionController;
	private readonly store: SessionStore;
	private server: net.Server | undefined;
	private boundEndpoint: OwnerEndpoint | undefined;
	private fence: OwnerFence | undefined;
	private authTokenHex = "";
	private ownerState: SessionOwnerState = "starting";
	private driverState: DriverStateSnapshot = initialDriverState();
	private activated = false;
	private closing = false;
	private controllerListener: (() => void) | undefined;

	public constructor(options: SessionRuntimeServerOptions) {
		this.options = options;
		this.store = options.store;
		this.controller = options.controller;
		this.controllerListener = options.controller.onEvent((event) => {
			this.broadcastEvent(event);
		});
	}

	/**
	 * R5:late-bind controller。server 先绑定 listener 完成 claim,claim 后
	 * 才能构造 SessionRuntime(需要 fence),再绑定回 server(循环依赖解耦)。
	 */
	public bindController(controller: SessionController): void {
		this.controllerListener?.();
		this.controller = controller;
		this.controllerListener = controller.onEvent((event) => {
			this.broadcastEvent(event);
		});
	}

	// ── OwnerTransport:bind-before-publish ────────────────────────────────

	public async bindCandidate(): Promise<OwnerEndpoint> {
		if (this.server !== undefined) return this.boundEndpoint!;
		const bound = await bindCandidateListener("127.0.0.1", (socket) => {
			if (!this.activated) {
				if (this.connections.size >= SESSION_PROTOCOL_BOUNDS.maxPreActivationPending) {
					socket.destroy();
					return;
				}
				// 认证前连接也走统一连接注册(pre-activation pending)。
			}
			this.accept(socket);
		});
		this.server = bound.server;
		this.boundEndpoint = bound.endpoint;
		return bound.endpoint;
	}

	public async closeCandidate(): Promise<void> {
		await this.close();
	}

	public async probe(endpoint: OwnerEndpoint, input: OwnerProbeInput, timeoutMs: number): Promise<OwnerProbeResult> {
		return probeOwner(endpoint, input, timeoutMs);
	}

	// ── 激活与状态 ────────────────────────────────────────────────────────

	/** §5.1:claim 成功后激活 handshake 处理;fresh claim 用 running/recovery_required。 */
	public activate(fence: OwnerFence, authTokenHex: string, ownerState: "running" | "recovery_required"): void {
		this.fence = fence;
		this.authTokenHex = authTokenHex;
		this.ownerState = ownerState;
		this.activated = true;
		// driverRevision 从 durable 投影列恢复(§6.4 只 append 递增)。
		const row = this.store.database().querySingle("SELECT driver_revision, head_sequence FROM sessions WHERE session_id = ?", [fence.sessionId]);
		this.driverState = initialDriverState();
		this.driverState = { ...this.driverState, driverRevision: Number(row?.driver_revision ?? 0) };
		this.registry.setHead(Number(row?.head_sequence ?? 0));
	}

	public setOwnerState(state: SessionOwnerState): void {
		this.ownerState = state;
		if (state === "stopping") this.close();
	}

	public get endpoint(): OwnerEndpoint | undefined {
		return this.boundEndpoint;
	}

	public get currentFence(): OwnerFence | undefined {
		return this.fence;
	}

	public connectionCounts(): number {
		return [...this.connections].filter((connection) => connection.initialized).length;
	}

	/** §6.4:owner crash/takeover 后 driver 强制 NONE + durable revision 事件。 */
	public recordDriverResetOnTakeover(): boolean {
		if (this.fence === undefined) return false;
		const transition = applyDriverTransition(this.driverState, { kind: "reset_on_takeover" });
		if (!transition.ok) return false;
		this.driverState = { driver: undefined, driverRevision: transition.nextRevision, lastDriverClientId: this.driverState.driver?.clientId };
		this.persistDriverEvent(transition.eventType, {});
		this.driverState = { ...this.driverState, lastDriverClientId: undefined };
		return true;
	}

	// ── frame 路由 ────────────────────────────────────────────────────────

	private accept(socket: net.Socket): void {
		if (this.connections.size >= SESSION_PROTOCOL_BOUNDS.maxPreActivationPending && !this.activated) {
			socket.destroy();
			return;
		}
		const connection: ServerConnection = {
			socket,
			connectionId: createRuntimeId("connection", `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`),
			clientId: "",
			buffer: Buffer.alloc(0),
			initialized: false,
			pendingFrames: 0,
			processing: Promise.resolve(),
			outbox: [],
			writing: false,
			reverseRequests: new Map(),
			closed: false,
		};
		this.connections.add(connection);
		socket.on("data", (chunk: Buffer) => this.receive(connection, chunk));
		socket.on("drain", () => this.flush(connection));
		socket.once("close", () => this.onDisconnect(connection));
		socket.on("error", () => this.destroy(connection));
	}

	private receive(connection: ServerConnection, chunk: Buffer): void {
		if (connection.closed || connection.socket.destroyed) return;
		connection.buffer = Buffer.concat([connection.buffer, chunk]);
		const bound = connection.initialized ? SESSION_PROTOCOL_BOUNDS.maxFrameBytes : SESSION_PROTOCOL_BOUNDS.maxInitializeFrameBytes;
		if (!connection.initialized && connection.buffer.length > SESSION_PROTOCOL_BOUNDS.maxInitializeFrameBytes) {
			this.destroy(connection);
			return;
		}
		this.processFrames(connection, bound);
	}

	private processFrames(connection: ServerConnection, bound: number): void {
		while (true) {
			const newline = connection.buffer.indexOf(0x0a);
			if (newline < 0) {
				if (connection.buffer.length > bound) this.destroy(connection);
				return;
			}
			const line = connection.buffer.subarray(0, newline);
			connection.buffer = connection.buffer.subarray(newline + 1);
			if (line.length === 0) continue;
			if (line.length > bound) {
				this.destroy(connection);
				return;
			}
			let value: unknown;
			try {
				value = JSON.parse(line.toString("utf8")) as unknown;
			} catch {
				this.destroy(connection);
				return;
			}
			if (!isSessionFrameEnvelope(value)) {
				this.destroy(connection);
				return;
			}
			const frame = value as SessionFrameEnvelope;
			if (connection.initialized && (frame.kind === "ack_cursor" || frame.kind === "reverse_response")) {
				void this.route(connection, frame).catch(() => this.destroy(connection));
				continue;
			}
			connection.pendingFrames += 1;
			if (connection.pendingFrames > SESSION_PROTOCOL_BOUNDS.maxPreActivationPending) {
				this.destroy(connection);
				return;
			}
			connection.processing = connection.processing
				.then(() => this.route(connection, frame))
				.catch(() => this.destroy(connection))
				.finally(() => {
					connection.pendingFrames = Math.max(0, connection.pendingFrames - 1);
				});
		}
	}

	private async route(connection: ServerConnection, frame: SessionFrameEnvelope): Promise<void> {
		if (connection.closed) return;
		if (!connection.initialized) {
			if (frame.kind !== "initialize_request") {
				this.destroy(connection);
				return;
			}
			this.handleInitialize(connection, frame);
			return;
		}
		switch (frame.kind) {
			case "initialize_request":
				this.enqueue(connection, this.response(frame, "initialize_response", { accepted: false, code: "already_initialized" }));
				return;
			case "reverse_response": {
				const requestFrameId = stringValue(frame.body.requestFrameId);
				if (requestFrameId === undefined) {
					this.destroy(connection);
					return;
				}
				const pending = connection.reverseRequests.get(requestFrameId);
				if (!pending) {
					this.destroy(connection);
					return;
				}
				connection.reverseRequests.delete(requestFrameId);
				clearTimeout(pending.timeoutId);
				pending.resolve(frame);
				return;
			}
			case "command_request":
				await this.handleCommandRequest(connection, frame);
				return;
			case "query_request":
				await this.handleQueryRequest(connection, frame);
				return;
			case "subscribe_request": {
				const cursor = numberValue(frame.body.cursor) ?? 0;
				const view = this.registry.subscribe(connection.connectionId, cursor);
				if (view === undefined) {
					this.enqueue(connection, this.response(frame, "command_result", { ok: false, code: "subscription_conflict" }));
					return;
				}
				const outcome = this.registry.replay(connection.connectionId, cursor, this.recentEvents());
				if (!outcome.ok) {
					this.enqueue(connection, this.response(frame, "resync_required", { cursor: this.registry.headSequence }));
					return;
				}
				for (const event of outcome.events) {
					if (!this.enqueueSubscriptionEvent(connection, event)) return;
				}
				this.enqueue(connection, this.response(frame, "command_result", { ok: true, kind: "subscribe", cursor: view.cursor }));
				return;
			}
			case "ack_cursor": {
				const cursor = numberValue(frame.body.cursor);
				if (cursor === undefined) {
					this.destroy(connection);
					return;
				}
				this.registry.ack(connection.connectionId, cursor);
				return;
			}
			default:
				this.enqueue(connection, this.response(frame, "command_result", { ok: false, code: "frame_malformed" }));
		}
	}

	/** §6.2 handshake:首个 frame 校验身份 + constant-time token + owner state。 */
	private handleInitialize(connection: ServerConnection, frame: SessionFrameEnvelope): void {
		const request = frame.body;
		if (!isSessionHandshakeRequest(request)) {
			this.destroy(connection);
			return;
		}
		const typed = request as SessionHandshakeRequest;
		if (this.fence === undefined || !this.activated) {
			this.rejectAndClose(connection, frame, "owner_starting");
			return;
		}
		if (!handshakeMatchesFence(typed, this.fence).ok) {
			this.rejectAndClose(connection, frame, "handshake_identity_mismatch");
			return;
		}
		if (!ownerTokenConstantTimeEqual(typed.authToken, this.authTokenHex)) {
			this.rejectAndClose(connection, frame, "handshake_token_mismatch");
			return;
		}
		if (this.ownerState === "stopping" || this.closing) {
			this.rejectAndClose(connection, frame, "owner_stopping");
			return;
		}
		if (this.ownerState === "starting") {
			this.rejectAndClose(connection, frame, "owner_starting");
			return;
		}
		connection.initialized = true;
		connection.clientId = typed.clientId;
		const snapshot = this.controller.snapshot();
		this.enqueue(connection, this.response(frame, "initialize_response", {
			accepted: true,
			runtimeId: this.fence.runtimeId,
			generation: this.fence.generation,
			protocolCapabilities: ["session.core"],
			snapshotCursor: snapshot.headSequence,
			driverRevision: this.driverState.driverRevision,
			sessionStatus: snapshot.sessionStatus,
		}));
		this.options.onAttachmentCountChange?.(this.connectionCounts());
	}

	/** 认证失败:发送 typed initialize_response 后优雅关闭(flush 后 end)。 */
	private rejectAndClose(connection: ServerConnection, frame: SessionFrameEnvelope, code: string): void {
		this.enqueue(connection, this.response(frame, "initialize_response", { accepted: false, code }));
		if (!connection.socket.destroyed) {
			connection.socket.end();
		}
	}

	private async handleCommandRequest(connection: ServerConnection, frame: SessionFrameEnvelope): Promise<void> {
		const commandId = stringValue(frame.body.commandId);
		const kind = stringValue(frame.body.kind);
		const requestBody = objectValue(frame.body.body);
		if (commandId === undefined || kind === undefined || requestBody === undefined) {
			this.enqueue(connection, this.response(frame, "command_result", { ok: false, code: "frame_malformed" }));
			return;
		}
		// driver claim/release 是 server 层 connection-scoped authority,不进 controller。
		if (kind === "driver_claim") {
			const result = this.claimDriver(connection);
			this.enqueue(connection, this.response(frame, "command_result", result));
			return;
		}
		if (kind === "driver_release") {
			const result = this.releaseDriver(connection);
			this.enqueue(connection, this.response(frame, "command_result", result));
			return;
		}
		const isDriver = this.driverState.driver?.connectionId === connection.connectionId;
		if (this.controller.isMutatingKind(kind) && !isDriver) {
			this.enqueue(connection, this.response(frame, "command_result", { ok: false, code: "observer_mutation_forbidden" }));
			return;
		}
		const result = await this.controller.handleCommand(
			{ commandId, kind, body: requestBody },
			{ connectionId: connection.connectionId, clientId: connection.clientId, isDriver },
		);
		this.enqueue(connection, this.response(frame, "command_result", result));
	}

	private async handleQueryRequest(connection: ServerConnection, frame: SessionFrameEnvelope): Promise<void> {
		const kind = stringValue(frame.body.kind);
		const body = objectValue(frame.body.body);
		if (kind === undefined || body === undefined) {
			this.enqueue(connection, this.response(frame, "query_result", { ok: false, code: "frame_malformed" }));
			return;
		}
		const result = await this.controller.handleQuery({ kind, body });
		this.enqueue(connection, this.response(frame, "query_result", result));
	}

	// ── driver(connection-scoped,§6.4)────────────────────────────────────

	private claimDriver(connection: ServerConnection): { readonly ok: true; readonly driverRevision: number } | { readonly ok: false; readonly code: "driver_revision_conflict" } {
		if (this.fence === undefined) return { ok: false, code: "driver_revision_conflict" };
		const transition = applyDriverTransition(this.driverState, { kind: "claim", holder: { connectionId: connection.connectionId, clientId: connection.clientId } });
		if (!transition.ok) return transition;
		this.driverState = { driver: { connectionId: connection.connectionId, clientId: connection.clientId }, driverRevision: transition.nextRevision, lastDriverClientId: this.driverState.lastDriverClientId };
		this.persistDriverEvent(transition.eventType, { connectionId: connection.connectionId });
		this.driverState = { ...this.driverState, lastDriverClientId: connection.clientId };
		return { ok: true, driverRevision: transition.nextRevision };
	}

	private releaseDriver(connection: ServerConnection): { readonly ok: true; readonly driverRevision: number } | { readonly ok: false; readonly code: "driver_revision_conflict" } {
		const transition = applyDriverTransition(this.driverState, { kind: "release", holder: { connectionId: connection.connectionId, clientId: connection.clientId } });
		if (!transition.ok) return transition;
		this.driverState = { driver: undefined, driverRevision: transition.nextRevision, lastDriverClientId: this.driverState.driver?.clientId };
		this.persistDriverEvent(transition.eventType, { connectionId: connection.connectionId });
		return { ok: true, driverRevision: transition.nextRevision };
	}

	/** §6.4 durable driver 事件:owner-fenced 单事务 append + revision 投影列递增。 */
	private persistDriverEvent(eventType: "driver.claimed" | "driver.released" | "driver.reset_on_takeover", extra: Record<string, unknown>): void {
		if (this.fence === undefined) return;
		const payload: Record<string, unknown> = {
			sessionId: this.fence.sessionId,
			runtimeId: this.fence.runtimeId,
			generation: this.fence.generation,
			driverRevision: this.driverState.driverRevision,
			...extra,
		};
		try {
			this.store.appendDriverEvent(this.fence, eventType, payload);
		} catch {
			// durable 失败不破坏连接层;fence 失效应由 heartbeat/write fence 触发 self-stop。
		}
	}

	// ── fan-out 与事件广播 ────────────────────────────────────────────────

	private recentEvents(): readonly SessionEventRecord[] {
		if (this.fence === undefined) return [];
		try {
			return this.store.replaySessionEvents(this.fence.sessionId);
		} catch {
			return [];
		}
	}

	private broadcastEvent(event: SessionControllerEvent): void {
		for (const connection of this.connections) {
			if (!connection.initialized || connection.closed) continue;
			const cursor = this.registry.view(connection.connectionId)?.cursor ?? 0;
			const outcome = this.registry.replay(connection.connectionId, cursor, this.recentEvents());
			if (!outcome.ok) {
				this.enqueue(connection, this.frameFor("resync_required", { cursor: this.registry.headSequence }));
				continue;
			}
			for (const durable of outcome.events) {
				if (!this.enqueueSubscriptionEvent(connection, durable)) break;
			}
		}
		if (event.sequence !== undefined) this.registry.setHead(event.sequence);
	}

	private enqueueSubscriptionEvent(connection: ServerConnection, event: SessionEventRecord): boolean {
		return this.enqueue(connection, this.frameFor("subscription_event", {
			eventId: event.eventId,
			sequence: event.sequence,
			eventType: event.eventType,
			payload: safeJson(event.payloadJson),
		}));
	}

	/** 向指定 connection 发送 reverse request(approval/credential UI),等待 reverse_response。 */
	public requestToConnection(
		connectionId: ConnectionId,
		request: { readonly kind: string; readonly body: Record<string, unknown> },
		timeoutMs: number = SESSION_PROTOCOL_BOUNDS.maxWaitMs,
	): Promise<SessionFrameEnvelope> {
		const connection = [...this.connections].find((candidate) => candidate.connectionId === connectionId && candidate.initialized);
		if (!connection || connection.closed) return Promise.reject(new Error("connection unavailable"));
		if (connection.reverseRequests.size >= SESSION_PROTOCOL_BOUNDS.maxReverseRequestWaiters) {
			return Promise.reject(new Error("reverse request capacity exceeded"));
		}
		const frame = this.frameFor("reverse_request", { kind: request.kind, body: request.body });
		return new Promise<SessionFrameEnvelope>((resolve, reject) => {
			const timeoutId = setTimeout(() => {
				connection.reverseRequests.delete(frame.frameId);
				reject(new Error("reverse request timed out"));
			}, timeoutMs);
			connection.reverseRequests.set(frame.frameId, { resolve, reject, timeoutId });
			if (!this.enqueue(connection, frame)) {
				clearTimeout(timeoutId);
				connection.reverseRequests.delete(frame.frameId);
				reject(new Error("reverse request could not be delivered"));
			}
		});
	}

	// ── outbox / backpressure / lifecycle ─────────────────────────────────

	private enqueue(connection: ServerConnection, frame: SessionFrameEnvelope): boolean {
		if (connection.closed) return false;
		if (!isSessionFrameEnvelope(frame)) {
			this.destroy(connection);
			return false;
		}
		let encoded: Buffer;
		try {
			encoded = Buffer.from(`${JSON.stringify(frame)}\n`, "utf8");
		} catch {
			this.destroy(connection);
			return false;
		}
		if (encoded.length > SESSION_PROTOCOL_BOUNDS.maxFrameBytes || connection.outbox.length >= SESSION_PROTOCOL_BOUNDS.maxConnectionOutbox) {
			this.destroy(connection);
			return false;
		}
		connection.outbox.push(encoded);
		this.flush(connection);
		return true;
	}

	private flush(connection: ServerConnection): void {
		if (connection.writing || connection.closed || connection.socket.destroyed) return;
		connection.writing = true;
		try {
			while (connection.outbox.length > 0) {
				const next = connection.outbox.shift();
				if (!next) break;
				if (!connection.socket.write(next)) break;
			}
		} finally {
			connection.writing = false;
		}
	}

	private onDisconnect(connection: ServerConnection): void {
		if (connection.closed) return;
		connection.closed = true;
		this.connections.delete(connection);
		this.registry.unsubscribe(connection.connectionId);
		if (this.driverState.driver?.connectionId === connection.connectionId) {
			this.releaseDriver(connection);
		}
		for (const pending of connection.reverseRequests.values()) {
			clearTimeout(pending.timeoutId);
			pending.reject(new Error("connection closed"));
		}
		connection.reverseRequests.clear();
		if (connection.initialized) this.options.onAttachmentCountChange?.(this.connectionCounts());
	}

	private destroy(connection: ServerConnection): void {
		if (!connection.closed) connection.socket.destroy();
	}

	public async close(): Promise<void> {
		if (this.closing) return;
		this.closing = true;
		for (const connection of this.connections) {
			connection.socket.destroy();
			this.onDisconnect(connection);
		}
		this.connections.clear();
		this.controllerListener?.();
		this.controllerListener = undefined;
		const server = this.server;
		this.server = undefined;
		if (server) {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	}

	private response(request: SessionFrameEnvelope, kind: SessionFrameEnvelope["kind"], body: Record<string, unknown>): SessionFrameEnvelope {
		return this.frameFor(kind, { requestFrameId: request.frameId, ...body });
	}

	private frameFor(kind: SessionFrameEnvelope["kind"], body: Record<string, unknown>): SessionFrameEnvelope {
		return {
			frameId: `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
			kind,
			protocolVersion: SESSION_PROTOCOL_VERSION,
			body,
		};
	}
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function safeJson(text: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(text) as unknown;
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : { raw: text };
	} catch {
		return { raw: text };
	}
}
