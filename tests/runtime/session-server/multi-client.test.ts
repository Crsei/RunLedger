/**
 * R4:multi-client fixtures(06 §6.4/§R4 退出条件)。
 *
 * 三个 client 同时观察同一 SessionRuntime:snapshot→replay→live 连续;
 * observer mutation 在进入 Agent/tool/backend 前被拒绝;slow client 不影响
 * 其他 client;本地 owner view 也通过 TCP facade。
 */

import { afterEach, describe, expect, it } from "vitest";
import { SessionClientTransport } from "../../../src/runtime/session-server/client-transport.ts";
import { SESSION_PROTOCOL_VERSION, type SessionFrameEnvelope } from "../../../src/runtime/session-server/protocol.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { SessionClient } from "../../../src/cli/session-client.ts";
import { SessionRuntimeServer, createTestController, createServerHarness, type ServerHarness } from "./harness.ts";

let harness: ServerHarness | undefined;

afterEach(async () => {
	await harness?.server.close();
	harness?.cleanup();
});

async function setup(): Promise<ServerHarness> {
	harness = await createServerHarness();
	return harness;
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

async function connectWithSubscription(): Promise<{ transport: SessionClientTransport; events: SessionFrameEnvelope[] }> {
	const h = harness!;
	const transport = await SessionClientTransport.connect(h.server.endpoint!.port);
	const events: SessionFrameEnvelope[] = [];
	transport.onEvent((frame) => {
		events.push(frame);
	});
	await transport.request(handshake());
	await transport.request({
		frameId: `sub_${Date.now().toString(36)}`,
		kind: "subscribe_request",
		protocolVersion: SESSION_PROTOCOL_VERSION,
		body: { cursor: 0 },
	});
	return { transport, events };
}

function command(transport: SessionClientTransport, kind: string, body: Record<string, unknown>): Promise<SessionFrameEnvelope> {
	return transport.request({
		frameId: `cmd_${Date.now().toString(36)}`,
		kind: "command_request",
		protocolVersion: SESSION_PROTOCOL_VERSION,
		body: { commandId: `command_${Date.now().toString(36)}`, kind, body },
	});
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("R4 multi-client", () => {
	it("lets three clients observe the same runtime: snapshot → replay → live", async () => {
		await setup();
		const h = harness!;
		const a = await connectWithSubscription();
		const b = await connectWithSubscription();
		const c = await connectWithSubscription();
		// driver 由 a 持有;b、c 是 observer。
		await command(a.transport, "driver_claim", {});
		// live:driver prompt → 所有订阅者收到 subscription_event。
		await command(a.transport, "prompt", { promptText: "hello" });
		await wait(200);
		for (const client of [a, b, c]) {
			const deltas = client.events.filter((frame) => frame.kind === "subscription_event" && frame.body.eventType === "assistant.delta");
			expect(deltas.map((frame) => (frame.body.payload as Record<string, unknown>).text)).toContain("response-1");
		}
		// 新订阅者 replay:从 genesis 收到同一事件。
		const d = await connectWithSubscription();
		await wait(200);
		expect(d.events.some((frame) => frame.kind === "subscription_event" && frame.body.eventType === "assistant.delta")).toBe(true);
		await a.transport.close();
		await b.transport.close();
		await c.transport.close();
		await d.transport.close();
	});

	it("a slow subscriber does not affect the other clients", async () => {
		await setup();
		const h = harness!;
		const slow = await connectWithSubscription();
		const fast = await connectWithSubscription();
		await command(slow.transport, "driver_claim", {});
		// 制造超过 ACK window(256)的事件;slow 不 ACK。
		for (let index = 0; index < 40; index += 1) {
			await command(slow.transport, "prompt", { promptText: `p${index}` });
		}
		await wait(400);
		const slowCount = slow.events.filter((frame) => frame.kind === "subscription_event").length;
		// slow 订阅者被 backpressure 暂停,但连接仍活(不因个别慢而断开其他人)。
		expect(slowCount).toBeLessThanOrEqual(260);
		// fast 客户端在 slow 停摆后仍能继续收到事件。
		const fastBefore = fast.events.length;
		await command(slow.transport, "prompt", { promptText: "after" });
		await wait(200);
		expect(fast.events.length).toBeGreaterThan(fastBefore);
		await slow.transport.close();
		await fast.transport.close();
	});

	it("the local owner view attaches through the same TCP facade (SessionClient)", async () => {
		await setup();
		const h = harness!;
		const client = new SessionClient({
			store: h.store,
			ownerStore: h.ownerStore,
			claimTransport: h.server,
		});
		const opened = await client.attachTo(h.ownerStore.readOwner(h.sessionId)!, h.server.endpoint, h.token);
		expect(opened.ok).toBe(true);
		if (!opened.ok) throw new Error("expected open");
		expect(opened.handle.generation).toBe(h.fence.generation);
		// 本地 view 走 facade:driver claim + prompt 都经 TCP。
		const claimed = await command(opened.handle.transport, "driver_claim", {});
		expect(claimed.body.ok).toBe(true);
		const prompted = await command(opened.handle.transport, "prompt", { promptText: "local" });
		expect(prompted.body.ok).toBe(true);
		await opened.handle.close();
	});

	it("disconnect of the driver clears the role and other clients cannot mutate", async () => {
		await setup();
		const h = harness!;
		const a = await connectWithSubscription();
		const b = await connectWithSubscription();
		await command(a.transport, "driver_claim", {});
		await a.transport.close();
		await wait(150);
		const forbidden = await command(b.transport, "prompt", { promptText: "x" });
		expect(forbidden.body).toMatchObject({ ok: false, code: "observer_mutation_forbidden" });
		// 事件流中 driver.released 已落库。
		expect(h.store.replaySessionEvents(h.sessionId).some((event) => event.eventType === "driver.released")).toBe(true);
		await b.transport.close();
	});

	it("creates and opens a session via the client open path (fresh claim)", async () => {
		await setup();
		const h = harness!;
		const sessionId = createRuntimeId("session", "client-open");
		h.store.createSession({
			sessionId,
			workspaceId: createRuntimeId("workspace", "w"),
			repositoryId: createRuntimeId("repository", "r"),
			settingsDigest: "d".repeat(64),
		});
		// 每个 Session 一个独立 server(server 只服务一个 sessionId + generation)。
		const server2 = new SessionRuntimeServer({
			sessionId,
			store: h.store,
			controller: createTestController({ sessionId, store: h.store, getFence: () => fence2 }),
		});
		let fence2: { sessionId: string; runtimeId: string; generation: number } | undefined;
		const client = new SessionClient({
			store: h.store,
			ownerStore: h.ownerStore,
			claimTransport: server2,
		});
		const opened = await client.openSession(sessionId, {
			claimHandler: async ({ owner }) => {
				// 生产中这里是 embedded-session-runtime 的 claim 接线。
				fence2 = owner.currentFence;
				owner.publish("running");
				server2.activate(owner.currentFence!, owner.currentAuthToken, "running");
				return { endpoint: server2.endpoint!, token: owner.currentAuthToken };
			},
		});
		expect(opened.ok).toBe(true);
		if (!opened.ok) throw new Error("expected open");
		expect(opened.handle.generation).toBe(1);
		expect(opened.handle.isOwner).toBe(false);
		await opened.handle.close();
		await server2.close();
	});
});
