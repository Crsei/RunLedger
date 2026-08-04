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
});
