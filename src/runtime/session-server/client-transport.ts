/**
 * R4:Session RuntimeServer 的 TCP client transport(06 §6.1)。
 *
 * - JSONL bounded frame;请求/响应按 frameId 配对,事件/ACK 走 notify;
 * - reverse_request 由注入 handler 响应(reverse_response);
 * - node:net 只允许出现在 session-server transport(边界检查 raw-transport 规则)。
 */

import net from "node:net";
import { SESSION_PROTOCOL_BOUNDS, SESSION_PROTOCOL_VERSION, isSessionFrameEnvelope, type SessionFrameEnvelope } from "./protocol.ts";

export interface SessionClientTransportOptions {
	readonly maxFrameBytes?: number;
	readonly maxPendingRequests?: number;
	readonly reverseRequestHandler?: (frame: SessionFrameEnvelope, signal: AbortSignal) => Promise<Record<string, unknown>> | Record<string, unknown>;
}

interface PendingRequest {
	readonly resolve: (frame: SessionFrameEnvelope) => void;
	readonly reject: (error: Error) => void;
}

export class SessionClientTransport {
	private readonly socket: net.Socket;
	private readonly maxFrameBytes: number;
	private readonly maxPendingRequests: number;
	private reverseRequestHandler: SessionClientTransportOptions["reverseRequestHandler"];
	private readonly reverseControllers = new Set<AbortController>();
	private readonly pending = new Map<string, PendingRequest>();
	private readonly eventListeners = new Set<(frame: SessionFrameEnvelope) => void>();
	private readonly closeListeners = new Set<(error: Error) => void>();
	private buffer = Buffer.alloc(0);
	private closed = false;
	private closeNotified = false;

	private constructor(socket: net.Socket, options: SessionClientTransportOptions) {
		this.socket = socket;
		this.maxFrameBytes = options.maxFrameBytes ?? SESSION_PROTOCOL_BOUNDS.maxFrameBytes;
		this.maxPendingRequests = options.maxPendingRequests ?? SESSION_PROTOCOL_BOUNDS.maxReverseRequestWaiters;
		this.reverseRequestHandler = options.reverseRequestHandler;
		socket.on("data", (chunk: Buffer) => this.receive(chunk));
		socket.once("close", () => this.signalClosed(new Error("connection closed")));
		socket.once("error", (error) => this.signalClosed(error));
	}

	public static async connect(port: number, options: SessionClientTransportOptions = {}): Promise<SessionClientTransport> {
		const socket = net.createConnection({ host: "127.0.0.1", port });
		await new Promise<void>((resolve, reject) => {
			socket.once("connect", resolve);
			socket.once("error", reject);
		});
		return new SessionClientTransport(socket, options);
	}

	/**
	 * 连接建立后注入 reverse-request handler(TUI 在 SessionClient 连接后才
	 * 装配 InteractiveMode)。reverse_request 只由用户 login/approval 触发,
	 * 无构造期竞态;未注入前 headless 客户端按 fail-closed 处理。
	 */
	public setReverseRequestHandler(handler: SessionClientTransportOptions["reverseRequestHandler"]): void {
		this.reverseRequestHandler = handler;
	}

	public request(frame: SessionFrameEnvelope): Promise<SessionFrameEnvelope> {
		if (this.closed) return Promise.reject(new Error("connection is closed"));
		if (this.pending.size >= this.maxPendingRequests) return Promise.reject(new Error("request capacity exceeded"));
		if (!isSessionFrameEnvelope(frame)) return Promise.reject(new Error("invalid session frame"));
		let encoded: Buffer;
		try {
			encoded = Buffer.from(`${JSON.stringify(frame)}\n`, "utf8");
		} catch {
			return Promise.reject(new Error("frame is not JSON serializable"));
		}
		if (encoded.length > this.maxFrameBytes) return Promise.reject(new Error("frame exceeds bound"));
		return new Promise<SessionFrameEnvelope>((resolve, reject) => {
			this.pending.set(frame.frameId, { resolve, reject });
			this.socket.write(encoded, (error?: Error | null) => {
				if (error) {
					this.pending.delete(frame.frameId);
					reject(error);
				}
			});
		});
	}

	/** Fire-and-forget bounded control frame(ACK / reverse_response)。 */
	public notify(frame: SessionFrameEnvelope): void {
		if (this.closed || !isSessionFrameEnvelope(frame)) return;
		let encoded: Buffer;
		try {
			encoded = Buffer.from(`${JSON.stringify(frame)}\n`, "utf8");
		} catch {
			return;
		}
		if (encoded.length > this.maxFrameBytes) return;
		this.socket.write(encoded, (error?: Error | null) => {
			if (error) this.socket.destroy();
		});
	}

	public onEvent(listener: (frame: SessionFrameEnvelope) => void): () => void {
		this.eventListeners.add(listener);
		return () => this.eventListeners.delete(listener);
	}

	public onClose(listener: (error: Error) => void): () => void {
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	public async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await new Promise<void>((resolve) => {
			this.socket.end(() => resolve());
		});
		this.failPending(new Error("connection closed"));
	}

	private receive(chunk: Buffer): void {
		if (this.closed) return;
		this.buffer = Buffer.concat([this.buffer, chunk]);
		while (true) {
			const newline = this.buffer.indexOf(0x0a);
			if (newline < 0) {
				if (this.buffer.length > this.maxFrameBytes) this.socket.destroy();
				return;
			}
			const line = this.buffer.subarray(0, newline);
			this.buffer = this.buffer.subarray(newline + 1);
			if (line.length === 0) continue;
			if (line.length > this.maxFrameBytes) {
				this.socket.destroy();
				return;
			}
			let value: unknown;
			try {
				value = JSON.parse(line.toString("utf8")) as unknown;
			} catch {
				this.socket.destroy();
				return;
			}
			if (!isSessionFrameEnvelope(value)) {
				this.socket.destroy();
				return;
			}
			const frame = value as SessionFrameEnvelope;
			if (frame.kind === "reverse_request") {
				void this.handleReverseRequest(frame);
				continue;
			}
			const requestFrameId = frame.body.requestFrameId;
			if (typeof requestFrameId !== "string") {
				for (const listener of this.eventListeners) {
					try {
						listener(frame);
					} catch {
						// 单个 observer 失败不影响其他投递。
					}
				}
				continue;
			}
			const pending = this.pending.get(requestFrameId);
			if (!pending) continue;
			this.pending.delete(requestFrameId);
			pending.resolve(frame);
		}
	}

	private failPending(error: Error): void {
		this.closed = true;
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
		for (const controller of this.reverseControllers) controller.abort(error);
		this.reverseControllers.clear();
	}

	private signalClosed(error: Error): void {
		this.failPending(error);
		if (this.closeNotified) return;
		this.closeNotified = true;
		for (const listener of this.closeListeners) {
			try {
				listener(error);
			} catch {
				// Close observers are isolated.
			}
		}
	}

	private async handleReverseRequest(frame: SessionFrameEnvelope): Promise<void> {
		if (this.closed) return;
		if (this.reverseControllers.size >= SESSION_PROTOCOL_BOUNDS.maxReverseRequestWaiters) {
			this.notify(this.reverseResponse(frame, { ok: false, code: "reverse_request_capacity_exceeded" }));
			return;
		}
		const controller = new AbortController();
		this.reverseControllers.add(controller);
		try {
			const result =
				this.reverseRequestHandler === undefined
					? { ok: false, code: "reverse_request_unhandled" }
					: await this.reverseRequestHandler(frame, controller.signal);
			this.notify(this.reverseResponse(frame, result ?? { ok: false, code: "reverse_request_unhandled" }));
		} catch {
			this.notify(this.reverseResponse(frame, { ok: false, code: "reverse_request_failed" }));
		} finally {
			this.reverseControllers.delete(controller);
		}
	}

	private reverseResponse(request: SessionFrameEnvelope, body: Record<string, unknown>): SessionFrameEnvelope {
		return {
			frameId: `reverse_response_${request.frameId}`,
			kind: "reverse_response",
			protocolVersion: SESSION_PROTOCOL_VERSION,
			body: { ...body, requestFrameId: request.frameId },
		};
	}
}
