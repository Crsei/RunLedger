import { expect, test } from "bun:test";
import type { Socket } from "node:net";
import { SessionClientTransport } from "../../src/runtime/session-server/client-transport.ts";
import { SESSION_PROTOCOL_VERSION } from "../../src/runtime/session-server/protocol.ts";
import { createServerHarness, type ServerHarness } from "../runtime/session-server/harness.ts";

async function connect(harness: ServerHarness, clientId: string): Promise<SessionClientTransport> {
	const transport = await SessionClientTransport.connect(harness.server.endpoint!.port);
	const response = await transport.request({
		frameId: `initialize_${clientId}`,
		kind: "initialize_request",
		protocolVersion: SESSION_PROTOCOL_VERSION,
		body: {
			protocolVersion: SESSION_PROTOCOL_VERSION,
			sessionId: harness.sessionId,
			expectedRuntimeId: harness.fence.runtimeId,
			expectedGeneration: harness.fence.generation,
			authToken: harness.token,
			clientId: `client_${clientId}`,
			clientCapabilities: [],
		},
	});
	expect(response.body.accepted).toBe(true);
	return transport;
}

test("peer EOF releases a driver with an outstanding response and preserves the remaining attachment", async () => {
	const harness = await createServerHarness();
	const driver = await connect(harness, "driver");
	const observer = await connect(harness, "observer");
	try {
		const claimed = await driver.request({
			frameId: "claim_driver",
			kind: "command_request",
			protocolVersion: SESSION_PROTOCOL_VERSION,
			body: { commandId: "claim_driver", kind: "driver_claim", body: {} },
		});
		expect(claimed.body.ok).toBe(true);
		const connections = (harness.server as unknown as {
			readonly connections: ReadonlySet<{ readonly socket: Socket; readonly clientId: string }>;
		}).connections;
		const driverSocket = [...connections].find((connection) => connection.clientId === "client_driver")!.socket;
		const detachedAtEof = new Promise<{ count: number; hasDriver: boolean }>((resolve) => {
			driverSocket.once("end", () => resolve({
				count: harness.server.connectionCounts(),
				hasDriver: harness.server.driverConnectionId() !== undefined,
			}));
		});
		// UI 退出时仍可能有快照响应在途；EOF 必须结束 attachment，无需等待写队列排空。
		driver.notify({
			frameId: "last_snapshot",
			kind: "query_request",
			protocolVersion: SESSION_PROTOCOL_VERSION,
			body: { kind: "snapshot", body: {} },
		});
		await driver.close();
		expect(await detachedAtEof).toEqual({ count: 1, hasDriver: false });
		expect(harness.server.connectionCounts()).toBe(1);
		expect(harness.server.driverConnectionId()).toBeUndefined();
		const response = await observer.request({
			frameId: "remaining_snapshot",
			kind: "query_request",
			protocolVersion: SESSION_PROTOCOL_VERSION,
			body: { kind: "snapshot", body: {} },
		});
		expect(response.body.ok).toBe(true);
	} finally {
		await driver.close();
		await observer.close();
		await harness.server.close();
		harness.store.database().close();
		harness.cleanup();
	}
});
