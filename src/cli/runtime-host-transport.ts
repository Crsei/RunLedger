/** R3 local JSONL transport。
 *
 * 传输层只负责 bounded framing、attestation 顺序和 compatibility handshake。
 * command/session/process authority 由上层 Host handler 持有；payload 中的
 * principal 字段永远不会覆盖 channel attestation 得到的 principal。
 */

import net from "node:net";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { Value } from "typebox/value";
import {
	HostCompatibilityEnvelopeSchema,
	HostFrameEnvelopeSchema,
	validateHostCompatibility,
	type HostCompatibilityEnvelope,
} from "../runtime/host/contracts.ts";
import { RUNTIME_HOST_BOUNDS, type HostConnectionPrincipal, type HostFrameEnvelope } from "../runtime/host/types.ts";

export interface HostTransportAttestor {
	attest(socket: net.Socket): Promise<HostConnectionPrincipal | undefined>;
}

export interface HostTransportFrameContext {
	readonly principal: HostConnectionPrincipal;
	readonly frame: HostFrameEnvelope;
}

export interface JsonLineHostServerOptions {
	readonly socketPath: string;
	readonly scope: HostCompatibilityEnvelope;
	readonly attestor: HostTransportAttestor;
	readonly handleFrame: (context: HostTransportFrameContext) => Promise<readonly HostFrameEnvelope[]>;
	readonly onConnectionClosed?: (connectionId: string) => void | Promise<void>;
	readonly maxFrameBytes?: number;
	readonly maxOutbox?: number;
}

export interface JsonLineHostClientOptions {
	readonly maxFrameBytes?: number;
	readonly maxPendingRequests?: number;
}

interface ServerConnection {
	readonly socket: net.Socket;
	buffer: Buffer;
	principal?: HostConnectionPrincipal;
	initialized: boolean;
	pendingFrames: number;
	processing: Promise<void>;
	outbox: Buffer[];
	writing: boolean;
}

interface PendingRequest {
	readonly resolve: (frame: HostFrameEnvelope) => void;
	readonly reject: (error: Error) => void;
}

export class JsonLineHostServer {
	private readonly options: Required<Pick<JsonLineHostServerOptions, "maxFrameBytes" | "maxOutbox">> & Omit<JsonLineHostServerOptions, "maxFrameBytes" | "maxOutbox">;
	private readonly connections = new Set<ServerConnection>();
	private server: net.Server | undefined;

	public constructor(options: JsonLineHostServerOptions) {
		this.options = {
			...options,
			maxFrameBytes: options.maxFrameBytes ?? RUNTIME_HOST_BOUNDS.maxFrameBytes,
			maxOutbox: options.maxOutbox ?? RUNTIME_HOST_BOUNDS.maxConnectionOutbox,
		};
		if (!Number.isSafeInteger(this.options.maxFrameBytes) || this.options.maxFrameBytes < 1) throw new Error("maxFrameBytes must be positive");
		if (!Number.isSafeInteger(this.options.maxOutbox) || this.options.maxOutbox < 1) throw new Error("maxOutbox must be positive");
	}

	public async listen(): Promise<void> {
		await ensureSocketParent(this.options.socketPath);
		await removeStaleSocket(this.options.socketPath);
		this.server = net.createServer((socket) => this.accept(socket));
		await new Promise<void>((resolve, reject) => {
			this.server?.once("error", reject).listen(this.options.socketPath, resolve);
		});
		if (process.platform !== "win32") await chmod(this.options.socketPath, 0o600);
	}

	public async close(): Promise<void> {
		for (const connection of this.connections) connection.socket.destroy();
		this.connections.clear();
		const server = this.server;
		this.server = undefined;
		if (!server) return;
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await unlink(this.options.socketPath).catch(() => undefined);
	}

	/** Sends a bounded unsolicited event to one attested connection. */
	public sendToConnection(connectionId: string, frame: HostFrameEnvelope): boolean {
		const connection = [...this.connections].find((candidate) => candidate.principal?.connectionId === connectionId);
		if (!connection || !connection.initialized || connection.socket.destroyed) return false;
		return this.enqueue(connection, frame);
	}

	private accept(socket: net.Socket): void {
		const connection: ServerConnection = {
			socket,
			buffer: Buffer.alloc(0),
			initialized: false,
			pendingFrames: 0,
			processing: Promise.resolve(),
			outbox: [],
			writing: false,
		};
		this.connections.add(connection);
		socket.on("data", (chunk: Buffer) => this.receive(connection, chunk));
		socket.on("drain", () => this.flush(connection));
		socket.once("close", () => {
			this.connections.delete(connection);
			const connectionId = connection.principal?.connectionId;
			if (connectionId) void this.options.onConnectionClosed?.(connectionId);
		});
		void this.options.attestor.attest(socket).then((principal) => {
			if (!principal || socket.destroyed) {
				socket.destroy();
				return;
			}
			connection.principal = principal;
			this.processFrames(connection);
		}).catch(() => socket.destroy());
	}

	private receive(connection: ServerConnection, chunk: Buffer): void {
		if (connection.socket.destroyed) return;
		connection.buffer = Buffer.concat([connection.buffer, chunk]);
		// Before channel attestation only one initialize frame is admissible. Do
		// not let newline-delimited small frames bypass the byte bound while an
		// asynchronous peer credential helper is still running.
		if (!connection.principal && connection.buffer.length > this.options.maxFrameBytes) {
			connection.socket.destroy();
			return;
		}
		if (connection.buffer.indexOf(0x0a) < 0 && connection.buffer.length > this.options.maxFrameBytes) {
			connection.socket.destroy();
			return;
		}
		this.processFrames(connection);
	}

	private processFrames(connection: ServerConnection): void {
		if (!connection.principal || connection.socket.destroyed) return;
		while (true) {
			const newline = connection.buffer.indexOf(0x0a);
			if (newline < 0) return;
			const line = connection.buffer.subarray(0, newline);
			connection.buffer = connection.buffer.subarray(newline + 1);
			if (line.length === 0) continue;
			if (line.length > this.options.maxFrameBytes) {
				connection.socket.destroy();
				return;
			}
			let frame: unknown;
			try {
				frame = JSON.parse(line.toString("utf8")) as unknown;
			} catch {
				connection.socket.destroy();
				return;
			}
			if (!Value.Check(HostFrameEnvelopeSchema, frame)) {
				connection.socket.destroy();
				return;
			}
			connection.pendingFrames += 1;
			if (connection.pendingFrames > RUNTIME_HOST_BOUNDS.maxPreActivationPending) {
				connection.socket.destroy();
				return;
			}
			const typedFrame = frame as HostFrameEnvelope;
				connection.processing = connection.processing
					.then(() => this.route(connection, typedFrame))
					.catch(() => {
						connection.socket.destroy();
					})
				.finally(() => {
					connection.pendingFrames = Math.max(0, connection.pendingFrames - 1);
				});
		}
	}

	private async route(connection: ServerConnection, frame: HostFrameEnvelope): Promise<void> {
		if (!connection.principal || connection.socket.destroyed) return;
		if (!connection.initialized) {
			if (frame.kind !== "initialize_request") {
				connection.socket.destroy();
				return;
			}
			const actual = frame.body.compatibility;
			const valid = Value.Check(HostCompatibilityEnvelopeSchema, actual)
				? validateHostCompatibility(this.options.scope, actual as HostCompatibilityEnvelope)
				: { ok: false as const, code: "invalid_compatibility_envelope" as const };
			if (!valid.ok) {
				this.enqueue(connection, this.response(frame, "initialize_response", { accepted: false, code: valid.code }));
				connection.socket.destroy();
				return;
			}
			connection.initialized = true;
			this.enqueue(connection, this.response(frame, "initialize_response", {
				accepted: true,
				compatibility: this.options.scope,
			}));
			return;
		}
		if (frame.kind === "initialize_request") {
			this.enqueue(connection, this.response(frame, "initialize_response", { accepted: false, code: "already_initialized" }));
			return;
		}
		const responses = await this.options.handleFrame({ principal: connection.principal, frame });
		for (const response of responses) this.enqueue(connection, response);
	}

	private response(
		request: HostFrameEnvelope,
		kind: HostFrameEnvelope["kind"],
		body: Record<string, unknown>,
	): HostFrameEnvelope {
		return {
			frameId: `response_${request.frameId}`,
			kind,
			protocolVersion: request.protocolVersion,
			body: { requestFrameId: request.frameId, ...body },
		};
	}

	private enqueue(connection: ServerConnection, frame: HostFrameEnvelope): boolean {
		if (!Value.Check(HostFrameEnvelopeSchema, frame)) {
			connection.socket.destroy();
			return false;
		}
		let encoded: Buffer;
		try {
			encoded = Buffer.from(`${JSON.stringify(frame)}\n`, "utf8");
		} catch {
			connection.socket.destroy();
			return false;
		}
		if (encoded.length > this.options.maxFrameBytes || connection.outbox.length >= this.options.maxOutbox) {
			connection.socket.destroy();
			return false;
		}
		connection.outbox.push(encoded);
		this.flush(connection);
		return true;
	}

	private flush(connection: ServerConnection): void {
		if (connection.writing || connection.socket.destroyed) return;
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
}

async function ensureSocketParent(socketPath: string): Promise<void> {
	const parent = dirname(socketPath);
		await mkdir(parent, { recursive: true, mode: 0o700 });
	const info = await lstat(parent);
	if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Host socket parent is not a directory");
}

async function removeStaleSocket(socketPath: string): Promise<void> {
	let info;
	try {
		info = await lstat(socketPath);
	} catch (error) {
		if (isNotFound(error)) return;
		throw error;
	}
	if (info.isSymbolicLink() || !info.isSocket()) throw new Error("Host socket path is not a stale Unix socket");
	const probe = net.createConnection(socketPath);
	const active = await new Promise<boolean>((resolve) => {
		let settled = false;
		const finish = (value: boolean): void => {
			if (settled) return;
			settled = true;
			probe.destroy();
			resolve(value);
		};
		probe.once("connect", () => finish(true));
		probe.once("error", () => finish(false));
		probe.setTimeout(100, () => finish(false));
	});
	if (active) throw new Error("Host socket is already active");
	await unlink(socketPath);
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export class JsonLineHostClient {
	private readonly socket: net.Socket;
	private readonly maxFrameBytes: number;
	private readonly maxPendingRequests: number;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly eventListeners = new Set<(frame: HostFrameEnvelope) => void>();
	private buffer = Buffer.alloc(0);
	private closed = false;

	private constructor(socket: net.Socket, options: JsonLineHostClientOptions) {
		this.socket = socket;
		this.maxFrameBytes = options.maxFrameBytes ?? RUNTIME_HOST_BOUNDS.maxFrameBytes;
		this.maxPendingRequests = options.maxPendingRequests ?? RUNTIME_HOST_BOUNDS.maxReverseRequestWaiters;
		socket.on("data", (chunk: Buffer) => this.receive(chunk));
		socket.once("close", () => this.failPending(new Error("Host connection closed")));
		socket.once("error", (error) => this.failPending(error));
	}

	public static async connect(socketPath: string, options: JsonLineHostClientOptions = {}): Promise<JsonLineHostClient> {
		const socket = net.createConnection(socketPath);
		await new Promise<void>((resolve, reject) => socket.once("connect", resolve).once("error", reject));
		return new JsonLineHostClient(socket, options);
	}

	public request(frame: HostFrameEnvelope): Promise<HostFrameEnvelope> {
		if (this.closed) return Promise.reject(new Error("Host connection is closed"));
		if (this.pending.size >= this.maxPendingRequests) return Promise.reject(new Error("Host request capacity exceeded"));
		if (!Value.Check(HostFrameEnvelopeSchema, frame)) return Promise.reject(new Error("invalid Host frame"));
		let encoded: Buffer;
		try {
			encoded = Buffer.from(`${JSON.stringify(frame)}\n`, "utf8");
		} catch {
			return Promise.reject(new Error("Host frame is not JSON serializable"));
		}
		if (encoded.length > this.maxFrameBytes) return Promise.reject(new Error("Host frame exceeds bound"));
		return new Promise<HostFrameEnvelope>((resolve, reject) => {
			this.pending.set(frame.frameId, { resolve, reject });
			this.socket.write(encoded, (error?: Error | null) => {
				if (error) {
					this.pending.delete(frame.frameId);
					reject(error);
				}
			});
		});
	}

	/** Fire-and-forget bounded control frame, used for subscription cursor ACKs. */
	public notify(frame: HostFrameEnvelope): void {
		if (this.closed || !Value.Check(HostFrameEnvelopeSchema, frame)) return;
		let encoded: Buffer;
		try {
			encoded = Buffer.from(`${JSON.stringify(frame)}\n`, "utf8");
		} catch {
			return;
		}
		if (encoded.length > this.maxFrameBytes) return;
		this.socket.write(encoded, (error?: Error | null) => {
			if (error) this.socket.destroy(error);
		});
	}

	public onEvent(listener: (frame: HostFrameEnvelope) => void): () => void {
		this.eventListeners.add(listener);
		return () => this.eventListeners.delete(listener);
	}

	public async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await new Promise<void>((resolve) => this.socket.end(() => resolve()));
		this.failPending(new Error("Host connection closed"));
	}

	private receive(chunk: Buffer): void {
		if (this.closed) return;
		this.buffer = Buffer.concat([this.buffer, chunk]);
		if (this.buffer.indexOf(0x0a) < 0 && this.buffer.length > this.maxFrameBytes) {
			this.socket.destroy();
			return;
		}
		while (true) {
			const newline = this.buffer.indexOf(0x0a);
			if (newline < 0) return;
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
			if (!Value.Check(HostFrameEnvelopeSchema, value)) {
				this.socket.destroy();
				return;
			}
			const frame = value as HostFrameEnvelope;
			const requestFrameId = frame.body.requestFrameId;
			if (typeof requestFrameId !== "string") {
				for (const listener of this.eventListeners) {
					try {
						listener(frame);
					} catch {
						// One observer cannot break transport delivery to the others.
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
		if (this.closed && this.pending.size === 0) return;
		this.closed = true;
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
	}
}
