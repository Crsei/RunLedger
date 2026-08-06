import { describe, expect, it } from "vitest";
import type { HostFrameEnvelope } from "../../src/runtime/host/types.ts";
import { runtimeDigest } from "../../src/runtime/protocol/foundation.ts";
import { createRuntimeId } from "../../src/runtime/protocol/ids.ts";
import { createHostEndpointRecord, type HostEndpointRecord } from "../../src/storage/host/endpoint-store.ts";
import { createHostShutdownIntent } from "../../src/storage/host/shutdown-intent-store.ts";
import {
	ReconnectingHostBridge,
	type ReconnectableHostConnection,
} from "../../src/cli/reconnecting-host-bridge.ts";

class FakeConnection implements ReconnectableHostConnection {
	readonly requests: HostFrameEnvelope[] = [];
	closeCalls = 0;
	private readonly events = new Set<(frame: HostFrameEnvelope) => void>();
	private readonly closes = new Set<(error: Error) => void>();

	constructor(
		readonly endpoint: HostEndpointRecord,
		private readonly responder: (frame: HostFrameEnvelope) => Promise<HostFrameEnvelope>,
	) {}

	request(frame: HostFrameEnvelope): Promise<HostFrameEnvelope> {
		this.requests.push(frame);
		return this.responder(frame);
	}
	onEvent(listener: (frame: HostFrameEnvelope) => void): () => void { this.events.add(listener); return () => this.events.delete(listener); }
	onClose(listener: (error: Error) => void): () => void { this.closes.add(listener); return () => this.closes.delete(listener); }
	notify(): void {}
	async close(): Promise<void> { this.closeCalls += 1; }
	emit(frame: HostFrameEnvelope): void { for (const listener of this.events) listener(frame); }
	disconnect(): void { for (const listener of this.closes) listener(new Error("Host connection closed")); }
}

describe("reconnecting Host bridge", () => {
	it("increments connection generation, rejects stale events and retries the identical command", async () => {
		const first = new FakeConnection(endpoint(1), async () => { throw new Error("Host connection closed"); });
		const second = new FakeConnection(endpoint(2), async (frame) => response(frame, { ok: true, receipt: "replayed" }));
		let reconnects = 0;
		const bridge = new ReconnectingHostBridge({
			initialConnection: first,
			reconnect: async () => { reconnects += 1; return second; },
			policy: "tui",
			delay: async () => {},
		});
		const events: string[] = [];
		bridge.onEvent((frame) => events.push(frame.frameId));
		const command: HostFrameEnvelope = { frameId: "same-frame", kind: "command_request", protocolVersion: 1, body: { operation: "session.prompt", commandId: "same-command", text: "hello" } };
		await expect(bridge.request(command)).resolves.toMatchObject({ body: { ok: true, receipt: "replayed" } });
		first.emit({ frameId: "stale", kind: "subscription_event", protocolVersion: 1, body: {} });
		second.emit({ frameId: "current", kind: "subscription_event", protocolVersion: 1, body: {} });
		expect(events).toEqual(["current"]);
		expect(reconnects).toBe(1);
		expect(second.requests.at(-1)).toEqual(command);
		expect(bridge.connectionGeneration()).toBe(2);
		await bridge.close();
	});

	it("reopens, claims and resumes the bound session from its last cursor", async () => {
		const first = new FakeConnection(endpoint(3), async () => { throw new Error("closed"); });
		const second = new FakeConnection(endpoint(4), async (frame) => {
			switch (frame.body.operation) {
				case "session.open": return response(frame, { ok: true, sessionId: "session_bridge", hostGeneration: 4, sessionGeneration: 2, driverRevision: 6, snapshot: { sessionId: "session_bridge" } });
				case "session.claim_driver": return response(frame, { ok: true, hostGeneration: 4, sessionGeneration: 2, driverRevision: 7 });
				case "session.subscribe": return response(frame, { ok: true, events: [{ sessionId: "session_bridge", eventId: "session_bridge-9", sequence: 9, event: { type: "agent_end", timestamp: 9 } }] });
				default: return response(frame, { ok: true });
			}
		});
		const fences: unknown[] = [];
		const bridge = new ReconnectingHostBridge({ initialConnection: first, reconnect: async () => second, policy: "tui", delay: async () => {} });
		bridge.bindSession({
			sessionId: "session_bridge",
			cursor: () => 8,
			onFence: (value) => fences.push(value),
			onResync: () => { throw new Error("unexpected resync"); },
		});
		const events: string[] = [];
		bridge.onEvent((frame) => events.push(frame.frameId));
		await bridge.request({ frameId: "query-after-crash", kind: "query_request", protocolVersion: 1, body: { operation: "session.snapshot" } });
		expect(second.requests.slice(0, 3).map((frame) => frame.body.operation)).toEqual(["session.open", "session.claim_driver", "session.subscribe"]);
		expect(second.requests[2]?.body.cursor).toBe(8);
		expect(fences).toEqual([{ hostGeneration: 4, sessionGeneration: 2, driverRevision: 7, isDriver: true }]);
		expect(events).toEqual(["session_bridge-9"]);
	});

	it("does not reconnect after an identity-matched manual stop", async () => {
		const current = endpoint(5);
		const first = new FakeConnection(current, async () => { throw new Error("closed"); });
		let reconnects = 0;
		const bridge = new ReconnectingHostBridge({
			initialConnection: first,
			reconnect: async () => { reconnects += 1; return first; },
			policy: "tui",
			delay: async () => {},
			readShutdownIntent: async () => createHostShutdownIntent({
				workspaceStorageKey: current.workspaceStorageKey,
				hostRuntimeId: current.hostRuntimeId,
				hostGeneration: current.hostGeneration,
				reason: "manual_stop",
				requestedAt: "2026-08-07T00:00:00.000Z",
			}),
		});
		await expect(bridge.request({ frameId: "stopped", kind: "query_request", protocolVersion: 1, body: {} })).rejects.toThrow("host_stopped");
		expect(bridge.state()).toBe("stopped");
		expect(reconnects).toBe(0);
	});

	it("bounds headless recovery to five connect-or-spawn attempts", async () => {
		const first = new FakeConnection(endpoint(6), async () => { throw new Error("closed"); });
		let reconnects = 0;
		const bridge = new ReconnectingHostBridge({
			initialConnection: first,
			reconnect: async () => { reconnects += 1; throw new Error("unreachable"); },
			policy: "headless",
			delay: async () => {},
		});
		await expect(bridge.request({ frameId: "headless", kind: "query_request", protocolVersion: 1, body: {} })).rejects.toThrow("host_recovery_required");
		expect(reconnects).toBe(5);
		expect(bridge.state()).toBe("recovery_required");
	});

	it("closes a replacement connection when session recovery fails before retrying", async () => {
		const first = new FakeConnection(endpoint(7), async () => { throw new Error("closed"); });
		const failedReplacement = new FakeConnection(endpoint(8), async (frame) => response(frame, {
			ok: false,
			code: frame.body.operation === "session.open" ? "session_not_found" : "unexpected_request",
		}));
		const recovered = new FakeConnection(endpoint(9), async (frame) => {
			switch (frame.body.operation) {
				case "session.open": return response(frame, { ok: true, hostGeneration: 9, sessionGeneration: 1, driverRevision: 1 });
				case "session.claim_driver": return response(frame, { ok: true, hostGeneration: 9, sessionGeneration: 1, driverRevision: 2 });
				case "session.subscribe": return response(frame, { ok: true, events: [] });
				default: return response(frame, { ok: true });
			}
		});
		let reconnects = 0;
		const bridge = new ReconnectingHostBridge({
			initialConnection: first,
			reconnect: async () => {
				reconnects += 1;
				return reconnects === 1 ? failedReplacement : recovered;
			},
			policy: "headless",
			delay: async () => {},
		});
		bridge.bindSession({
			sessionId: "session_bridge",
			cursor: () => 0,
			onFence: () => {},
			onResync: () => {},
		});

		await expect(bridge.request({ frameId: "recover-after-failure", kind: "query_request", protocolVersion: 1, body: { operation: "session.snapshot" } })).resolves.toMatchObject({ body: { ok: true } });
		expect(failedReplacement.closeCalls).toBe(1);
		expect(recovered.closeCalls).toBe(0);
		await bridge.close();
	});

	it("does not reconnect or replay when the Host reports an uncertain command outcome", async () => {
		const first = new FakeConnection(endpoint(10), async (frame) => response(frame, { ok: false, code: "uncertain_outcome" }));
		let reconnects = 0;
		const bridge = new ReconnectingHostBridge({
			initialConnection: first,
			reconnect: async () => { reconnects += 1; return first; },
			policy: "headless",
			delay: async () => {},
		});

		await expect(bridge.request({
			frameId: "uncertain-command",
			kind: "command_request",
			protocolVersion: 1,
			body: { operation: "session.prompt", commandId: "uncertain-command", text: "once" },
		})).rejects.toThrow("uncertain_outcome");
		expect(reconnects).toBe(0);
		expect(first.requests).toHaveLength(1);
		expect(bridge.state()).toBe("recovery_required");
	});

	it("fails closed when shutdown intent cannot be verified", async () => {
		const first = new FakeConnection(endpoint(11), async () => { throw new Error("closed"); });
		let reconnects = 0;
		const bridge = new ReconnectingHostBridge({
			initialConnection: first,
			reconnect: async () => { reconnects += 1; return first; },
			policy: "headless",
			delay: async () => {},
			readShutdownIntent: async () => { throw new Error("invalid Host shutdown intent"); },
		});

		await expect(bridge.request({ frameId: "invalid-intent", kind: "query_request", protocolVersion: 1, body: {} })).rejects.toThrow("host_recovery_required");
		expect(reconnects).toBe(0);
		expect(bridge.state()).toBe("recovery_required");
	});
});

function endpoint(generation: number): HostEndpointRecord {
	return createHostEndpointRecord({
		protocolVersion: 1,
		managementProtocolVersion: 1,
		workspaceStorageKey: "ws-" + "a".repeat(64),
		hostRuntimeId: createRuntimeId("runtime", `bridge-${generation}`),
		hostGeneration: generation,
		hostProcessId: process.pid,
		hostProcessStartIdentityDigest: runtimeDigest(`process-${generation}`),
		hostBuildDigest: runtimeDigest("build"),
		state: "ready",
		compatibilityDigest: runtimeDigest("scope"),
		publishedAt: "2026-08-07T00:00:00.000Z",
	});
}

function response(request: HostFrameEnvelope, body: Record<string, unknown>): HostFrameEnvelope {
	return { frameId: `response-${request.frameId}`, kind: request.kind === "query_request" ? "query_result" : "command_result", protocolVersion: 1, body: { requestFrameId: request.frameId, ...body } };
}
