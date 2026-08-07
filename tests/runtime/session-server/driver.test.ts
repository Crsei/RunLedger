/**
 * R4:connection-scoped driver fixtures(06 §6.4)。
 *
 * 覆盖:driver claim/release、同 connection 幂等、他 connection 冲突、
 * disconnect 强制 NONE + durable revision 事件、takeover reset、
 * observer mutation 在进入 controller 前被拒。
 */

import { afterEach, describe, expect, it } from "vitest";
import { SessionClientTransport } from "../../../src/runtime/session-server/client-transport.ts";
import { SESSION_PROTOCOL_VERSION, type SessionFrameEnvelope } from "../../../src/runtime/session-server/protocol.ts";
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

async function connect(): Promise<SessionClientTransport> {
	const h = harness!;
	const transport = await SessionClientTransport.connect(h.server.endpoint!.port);
	await transport.request(handshake());
	return transport;
}

function handshake(): SessionFrameEnvelope {
	const h = harness!;
	return {
		frameId: `init_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
		kind: "initialize_request",
		protocolVersion: SESSION_PROTOCOL_VERSION,
		body: {
			protocolVersion: SESSION_PROTOCOL_VERSION,
			sessionId: h.sessionId,
			expectedRuntimeId: h.fence.runtimeId,
			expectedGeneration: h.fence.generation,
			authToken: h.token,
			clientId: `client_${Math.random().toString(36).slice(2, 8)}`,
			clientCapabilities: [],
		},
	};
}

function command(transport: SessionClientTransport, kind: string, body: Record<string, unknown>): Promise<SessionFrameEnvelope> {
	return transport.request({
		frameId: `cmd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
		kind: "command_request",
		protocolVersion: SESSION_PROTOCOL_VERSION,
		body: { commandId: `command_${Date.now().toString(36)}`, kind, body },
	});
}

function driverEvents(): readonly { eventType: string; payload: Record<string, unknown> }[] {
	const h = harness!;
	return h.store
		.replaySessionEvents(h.sessionId)
		.filter((event) => event.eventType.startsWith("driver."))
		.map((event) => ({ eventType: event.eventType, payload: JSON.parse(event.payloadJson) as Record<string, unknown> }));
}

describe("R4 connection-scoped driver", () => {
	it("claims the driver role on one connection and rejects a second contender", async () => {
		await setup();
		const a = await connect();
		const b = await connect();
		const claimed = await command(a, "driver_claim", {});
		expect(claimed.body.ok).toBe(true);
		expect(claimed.body.driverRevision).toBe(1);
		const conflict = await command(b, "driver_claim", {});
		expect(conflict.body).toMatchObject({ ok: false, code: "driver_revision_conflict" });
		const events = driverEvents();
		expect(events).toHaveLength(1);
		expect(events[0]!.eventType).toBe("driver.claimed");
		expect(events[0]!.payload).toMatchObject({ driverRevision: 1 });
		await a.close();
		await b.close();
	});

	it("allows the same connection to claim idempotently", async () => {
		await setup();
		const a = await connect();
		const first = await command(a, "driver_claim", {});
		expect(first.body.ok).toBe(true);
		const second = await command(a, "driver_claim", {});
		expect(second.body.ok).toBe(true);
		expect(second.body.driverRevision).toBe(2);
		await a.close();
	});

	it("releases the driver on disconnect and increments the durable revision", async () => {
		await setup();
		const a = await connect();
		await command(a, "driver_claim", {});
		const b = await connect();
		await a.close();
		await new Promise((resolve) => setTimeout(resolve, 150));
		const events = driverEvents();
		expect(events.map((event) => event.eventType)).toEqual(["driver.claimed", "driver.released"]);
		expect(events[1]!.payload.driverRevision).toBe(2);
		// 新 connection 必须显式 claim,不自动恢复 authority。
		const claimed = await command(b, "driver_claim", {});
		expect(claimed.body.ok).toBe(true);
		expect(claimed.body.driverRevision).toBe(3);
		await b.close();
	});

	it("forces driver NONE with a reset event on owner takeover", async () => {
		await setup();
		const h = harness!;
		const a = await connect();
		await command(a, "driver_claim", {});
		expect(h.server.recordDriverResetOnTakeover()).toBe(true);
		const events = driverEvents();
		expect(events.map((event) => event.eventType)).toEqual(["driver.claimed", "driver.reset_on_takeover"]);
		const payload = events[1]!.payload as Record<string, unknown>;
		expect(payload.driverRevision).toBe(2);
		expect(payload.connectionId).toBeUndefined();
		// reset 后原 connection 需重新 claim。
		const claimed = await command(a, "driver_claim", {});
		expect(claimed.body.ok).toBe(true);
		expect(claimed.body.driverRevision).toBe(3);
		await a.close();
	});

	it("rejects observer mutation before it reaches the controller", async () => {
		await setup();
		const a = await connect();
		const b = await connect();
		await command(a, "driver_claim", {});
		const forbidden = await command(b, "prompt", { promptText: "hi" });
		expect(forbidden.body).toMatchObject({ ok: false, code: "observer_mutation_forbidden" });
		// 事件流里没有 assistant.delta(controller 未被调用)。
		const h = harness!;
		expect(h.store.replaySessionEvents(h.sessionId).some((event) => event.eventType === "assistant.delta")).toBe(false);
		// driver connection 可以 prompt。
		const allowed = await command(a, "prompt", { promptText: "hi" });
		expect(allowed.body.ok).toBe(true);
		await a.close();
		await b.close();
	});

	it("does not grant driver authority from last_driver_client_id on a new connection", async () => {
		await setup();
		const h = harness!;
		const a = await connect();
		await command(a, "driver_claim", {});
		await a.close();
		await new Promise((resolve) => setTimeout(resolve, 150));
		// 同一 clientId 的新连接也不能自动成为 driver。
		const sameClient = await SessionClientTransport.connect(h.server.endpoint!.port);
		const handshakeBody = handshake();
		(handshakeBody.body as Record<string, unknown>).clientId = "client_repeat";
		const first = { ...handshake(), body: { ...handshakeBody.body } };
		await sameClient.request(first);
		const forbidden = await command(sameClient, "prompt", { promptText: "x" });
		expect(forbidden.body).toMatchObject({ ok: false, code: "observer_mutation_forbidden" });
		await sameClient.close();
	});
});
