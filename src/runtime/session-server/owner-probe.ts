/**
 * R3/R4:Session Owner 的 localhost TCP transport(06 §5.3/§6.1)。
 *
 * - 只绑定 IPv4 127.0.0.1,端口传 0 由 OS 分配;不绑定 0.0.0.0/LAN/public;
 * - probe 是 authenticated initialize/health probe:连接 exact 127.0.0.1:port,
 *   发送 initialize_request(携带 row 中的 token),收到 accepted 才算健康;
 *   accept 成功但认证无响应只记一次失败;
 * - node:net 只允许出现在本 transport(边界检查 raw-transport 规则)。
 */

import net from "node:net";
import { SESSION_PROTOCOL_VERSION } from "./protocol.ts";
import type { OwnerEndpoint } from "../session-owner/types.ts";
import type { OwnerProbeInput, OwnerProbeResult, OwnerTransport } from "../session-owner/session-owner.ts";

const probeFrameId = (): string => `probe_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
const probeClientId = (): string => `client_probe_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

export interface BoundCandidateListener {
	readonly server: net.Server;
	readonly endpoint: OwnerEndpoint;
	close(): Promise<void>;
}

/** §5.1 bind-before-publish:绑定 127.0.0.1:0 并回写 OS 分配的实际端口。 */
export async function bindCandidateListener(
	host: "127.0.0.1" = "127.0.0.1",
	onConnection?: (socket: net.Socket) => void,
): Promise<BoundCandidateListener> {
	const server = net.createServer((socket) => {
		if (onConnection === undefined) {
			socket.destroy();
			return;
		}
		onConnection(socket);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, host, () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (address === null || typeof address === "string") {
		server.close();
		throw new Error("candidate listener must be a TCP endpoint");
	}
	return {
		server,
		endpoint: { host, port: address.port },
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
			}),
	};
}

/**
 * §5.3 authenticated health probe。返回 ok 表示该 endpoint 上的 owner 认证成功
 * 且仍存活;任何失败都只记一次 probe failure,不做部分成功判定。
 */
export function probeOwner(
	endpoint: OwnerEndpoint,
	input: OwnerProbeInput,
	timeoutMs: number,
): Promise<OwnerProbeResult> {
	return new Promise<OwnerProbeResult>((resolve) => {
		const socket = net.createConnection({ host: endpoint.host, port: endpoint.port });
		let settled = false;
		let buffer = "";
		const finish = (result: OwnerProbeResult): void => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(result);
		};
		socket.setTimeout(timeoutMs);
		socket.once("error", () => finish({ ok: false, code: "connect_failed" }));
		socket.once("timeout", () => finish({ ok: false, code: "timeout" }));
		socket.once("close", () => finish({ ok: false, code: "connect_failed" }));
		socket.once("connect", () => {
			const frame = {
				frameId: probeFrameId(),
				kind: "initialize_request",
				protocolVersion: SESSION_PROTOCOL_VERSION,
				body: {
					protocolVersion: SESSION_PROTOCOL_VERSION,
					sessionId: input.sessionId,
					expectedRuntimeId: input.expectedRuntimeId,
					expectedGeneration: input.expectedGeneration,
					authToken: input.authToken,
					clientId: probeClientId(),
					clientCapabilities: [],
				},
			};
			socket.write(`${JSON.stringify(frame)}\n`);
		});
		socket.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			let response: unknown;
			try {
				response = JSON.parse(buffer.slice(0, newline)) as unknown;
			} catch {
				finish({ ok: false, code: "malformed" });
				return;
			}
			if (typeof response !== "object" || response === null) {
				finish({ ok: false, code: "malformed" });
				return;
			}
			const body = (response as { body?: { accepted?: unknown } }).body;
			finish(body?.accepted === true ? { ok: true } : { ok: false, code: "rejected" });
		});
	});
}

/** 面向 SessionOwner 的默认 transport:bind + probe 都走 localhost TCP。 */
export function createTcpOwnerTransport(onConnection?: (socket: net.Socket) => void): OwnerTransport {
	let bound: BoundCandidateListener | undefined;
	return {
		async bindCandidate(): Promise<OwnerEndpoint> {
			bound = await bindCandidateListener("127.0.0.1", onConnection);
			return bound.endpoint;
		},
		async closeCandidate(): Promise<void> {
			await bound?.close();
			bound = undefined;
		},
		async probe(endpoint: OwnerEndpoint, input: OwnerProbeInput, timeoutMs: number): Promise<OwnerProbeResult> {
			return probeOwner(endpoint, input, timeoutMs);
		},
	};
}
