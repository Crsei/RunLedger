import { describe, expect, it } from "vitest";
import type { HostFrameEnvelope } from "../../../src/runtime/host/types.ts";
import { RemoteInteractiveSessionController } from "../../../src/runtime/host/remote-session.ts";
import type { AgentEvent } from "../../../src/runtime/types.ts";

class FakeTransport {
	readonly requests: HostFrameEnvelope[] = [];
	readonly notifications: HostFrameEnvelope[] = [];
	private listener: ((frame: HostFrameEnvelope) => void) | undefined;

	onEvent(listener: (frame: HostFrameEnvelope) => void): () => void {
		this.listener = listener;
		return () => { this.listener = undefined; };
	}

	async request(frame: HostFrameEnvelope): Promise<HostFrameEnvelope> {
		this.requests.push(frame);
		const operation = frame.body.operation;
		return {
			frameId: `response_${frame.frameId}`,
			kind: frame.kind === "query_request" ? "query_result" : "command_result",
			protocolVersion: frame.protocolVersion,
			body: operation === "session.subscribe"
				? { requestFrameId: frame.frameId, ok: true, cursor: 1, events: [{ sessionId: "session_remote", eventId: "event_1", sequence: 1, eventType: "agent_start", event: { type: "agent_start", timestamp: 1 } }] }
				: { requestFrameId: frame.frameId, ok: true, driverRevision: 3 },
		};
	}

	notify(frame: HostFrameEnvelope): void {
		this.notifications.push(frame);
	}

	emit(event: AgentEvent, sequence: number): void {
		this.listener?.({
			frameId: `event_${event.timestamp}`,
			kind: "subscription_event",
			protocolVersion: 1,
			body: { sessionId: "session_remote", eventId: `event_${event.timestamp}`, sequence, event },
		});
	}
}

describe("R4 Host-owned remote session facade", () => {
	it("routes prompt and interrupt through the Host and replays attested events once", async () => {
		const transport = new FakeTransport();
		const controller = new RemoteInteractiveSessionController(transport, {
			sessionId: "session_remote",
			selection: { provider: "fake", thinkingLevel: "off" },
			messages: [],
			warnings: [],
			auditEntries: [],
			toolCount: 0,
			hostGeneration: 1,
			sessionGeneration: 1,
			driverRevision: 2,
			eventCursor: 0,
		});
		const events: string[] = [];
		controller.subscribe((event) => events.push(event.type));
		await controller.resumeEvents();
		await controller.prompt("hello");
		transport.emit({ type: "agent_end", timestamp: 3 }, 3);
		transport.emit({ type: "agent_end", timestamp: 2 }, 2);
		transport.emit({ type: "agent_end", timestamp: 2 }, 2);
		controller.interrupt();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(events).toEqual(["agent_start", "agent_end", "agent_end"]);
		expect(transport.requests.map((request) => request.body.operation)).toEqual([
			"session.subscribe",
			"session.steer",
			"session.interrupt",
		]);
		expect(transport.requests[1]?.body).toMatchObject({ expectedHostGeneration: 1, expectedSessionGeneration: 1, expectedDriverRevision: 2 });
		expect(transport.requests[2]?.body).toMatchObject({ expectedDriverRevision: 3 });
		expect(transport.notifications.at(-1)).toMatchObject({ kind: "ack_cursor", body: { sessionId: "session_remote", cursor: 3 } });
		controller.dispose();
	});

	it("uses the Host query/command domain port without creating a client-side manager", async () => {
		const transport = new FakeTransport();
		const controller = new RemoteInteractiveSessionController(transport, {
			sessionId: "session_remote",
			selection: { thinkingLevel: "off" },
			messages: [],
			warnings: [],
			auditEntries: [],
			toolCount: 0,
			hostGeneration: 2,
			sessionGeneration: 4,
			driverRevision: 8,
			eventCursor: 0,
		});
		await expect(controller.queryHostDomain("mcp.list")).resolves.toMatchObject({ ok: true, driverRevision: 3 });
		await expect(controller.commandHostDomain("plugin.reload", { expectedDomainRevision: 0 })).resolves.toMatchObject({ ok: true, driverRevision: 3 });
		expect(transport.requests[0]).toMatchObject({ kind: "query_request", body: { operation: "mcp.list", sessionId: "session_remote" } });
		expect(transport.requests[1]).toMatchObject({ kind: "command_request", body: { operation: "plugin.reload", sessionId: "session_remote", expectedHostGeneration: 2, expectedSessionGeneration: 4, expectedDriverRevision: 8 } });
		controller.dispose();
	});

	it("rebuilds its client projection from a reconnect resync snapshot", () => {
		const controller = new RemoteInteractiveSessionController(new FakeTransport(), {
			sessionId: "session_remote",
			selection: { thinkingLevel: "off" },
			messages: [], warnings: [], auditEntries: [], toolCount: 0,
			hostGeneration: 1, sessionGeneration: 1, driverRevision: 1, eventCursor: 4,
		});
		controller.applyRecoverySnapshot({
			sessionId: "session_remote",
			selection: { provider: "fake", thinkingLevel: "high" },
			messages: [{ role: "user", content: "restored" }],
			warnings: ["recovered"], auditEntries: [], toolCount: 2,
			hostGeneration: 3, sessionGeneration: 2, driverRevision: 5, eventCursor: 11,
		});
		expect(controller.messages).toEqual([{ role: "user", content: "restored" }]);
		expect(controller.warnings).toEqual(["recovered"]);
		expect(controller.currentSelection).toMatchObject({ thinkingLevel: "high" });
		expect(controller.driverFence()).toEqual({ expectedHostGeneration: 3, expectedSessionGeneration: 2, expectedDriverRevision: 5 });
		expect(controller.recoveryCursor()).toBe(11);
		controller.dispose();
	});
});
