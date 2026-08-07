/**
 * R4:RuntimeServer transport fixtures(06 §6.1/§6.2)。
 *
 * 真实 TCP 127.0.0.1:0:token/identity/session/generation 不匹配、owner 状态
 * gate、oversize/malformed frame、认证前只允许 initialize、port 释放与重绑定。
 */

import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { SessionClientTransport } from "../../../src/runtime/session-server/client-transport.ts";
import { SESSION_PROTOCOL_VERSION } from "../../../src/runtime/session-server/protocol.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { createServerHarness, type ServerHarness } from "./harness.ts";

let harness: ServerHarness | undefined;

afterEach(async () => {
	await harness?.server.close();
	harness?.cleanup();
});

async function setup(): Promise<ServerHarness> {
	harness = await createServerHarness();
	return harness;
}

function handshakeFrame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	const h = harness!;
	return {
		frameId: `init_${Date.now().toString(36)}`,
		kind: "initialize_request",
		protocolVersion: SESSION_PROTOCOL_VERSION,
		body: {
			protocolVersion: SESSION_PROTOCOL_VERSION,
			sessionId: h.sessionId,
			expectedRuntimeId: h.fence.runtimeId,
			expectedGeneration: h.fence.generation,
			authToken: h.token,
			clientId: "client_test",
			clientCapabilities: [],
			...overrides,
		},
	};
}

async function tryHandshake(overrides: Record<string, unknown> = {}): Promise<{ readonly accepted: boolean; readonly code?: string }> {
	const h = harness!;
	const transport = await SessionClientTransport.connect(h.server.endpoint!.port);
	try {
		const response = await transport.request(handshakeFrame(overrides) as never);
		return {
			accepted: response.body.accepted === true,
			code: typeof response.body.code === "string" ? response.body.code : undefined,
		};
	} finally {
		await transport.close();
	}
}

describe("R4 transport handshake", () => {
	it("accepts a correct handshake with the row token", async () => {
		await setup();
		const result = await tryHandshake();
		expect(result.accepted).toBe(true);
	});

	it("rejects a wrong token", async () => {
		await setup();
		const result = await tryHandshake({ authToken: "f".repeat(64) });
		expect(result).toEqual({ accepted: false, code: "handshake_token_mismatch" });
	});

	it("rejects a wrong runtime / generation / session", async () => {
		await setup();
		const wrongRuntime = await tryHandshake({ expectedRuntimeId: "runtime_other" });
		expect(wrongRuntime).toEqual({ accepted: false, code: "handshake_identity_mismatch" });
		const wrongGeneration = await tryHandshake({ expectedGeneration: 99 });
		expect(wrongGeneration).toEqual({ accepted: false, code: "handshake_identity_mismatch" });
		const wrongSession = await tryHandshake({ sessionId: createRuntimeId("session", "other") });
		expect(wrongSession).toEqual({ accepted: false, code: "handshake_identity_mismatch" });
	});

	it("rejects a malformed initialize frame and closes the connection", async () => {
		await setup();
		const h = harness!;
		const socket = await new Promise<net.Socket>((resolve, reject) => {
			const s = net.createConnection({ host: "127.0.0.1", port: h.server.endpoint!.port });
			s.once("connect", () => resolve(s));
			s.once("error", reject);
		});
		const closed = new Promise<boolean>((resolve) => {
			socket.once("close", () => resolve(true));
		});
		socket.write(`${JSON.stringify({ frameId: "x", kind: "initialize_request", protocolVersion: 1, body: { not: "the right shape" } })}\n`);
		expect(await closed).toBe(true);
	});

	it("rejects oversized pre-auth frames", async () => {
		await setup();
		const h = harness!;
		const socket = await new Promise<net.Socket>((resolve, reject) => {
			const s = net.createConnection({ host: "127.0.0.1", port: h.server.endpoint!.port });
			s.once("connect", () => resolve(s));
			s.once("error", reject);
		});
		const closed = new Promise<boolean>((resolve) => {
			socket.once("close", () => resolve(true));
		});
		const big = { frameId: "x", kind: "initialize_request", protocolVersion: 1, body: { padding: "a".repeat(8 * 1024) } };
		socket.write(`${JSON.stringify(big)}\n`);
		expect(await closed).toBe(true);
	});

	it("rejects non-initialize first frames", async () => {
		await setup();
		const h = harness!;
		const transport = await SessionClientTransport.connect(h.server.endpoint!.port);
		const closed = new Promise<void>((resolve) => {
			transport.onClose(() => resolve());
		});
		transport.notify({
			frameId: "cmd_1",
			kind: "command_request",
			protocolVersion: SESSION_PROTOCOL_VERSION,
			body: { commandId: "command_1", kind: "prompt", body: {} },
		});
		await closed;
	});

	it("rejects handshake while the owner is still starting", async () => {
		const h = await setup();
		// 停掉已激活的 server,重新构造 starting 状态:直接对同一 server 改状态。
		h.server.setOwnerState("starting");
		const result = await tryHandshake();
		expect(result).toEqual({ accepted: false, code: "owner_starting" });
	});

	it("rejects handshake when the owner is stopping and frees the port after close", async () => {
		const h = await setup();
		const port = h.server.endpoint!.port;
		h.server.setOwnerState("stopping");
		await new Promise((resolve) => setTimeout(resolve, 100));
		// 端口已释放:新连接被拒绝(无 listener)。
		await expect(
			SessionClientTransport.connect(port),
		).rejects.toBeTruthy();
	});
});
