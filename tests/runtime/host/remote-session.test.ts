import { describe, expect, it } from "vitest";
import type { HostFrameEnvelope } from "../../../src/runtime/host/types.ts";
import { RemoteInteractiveSessionController } from "../../../src/runtime/host/remote-session.ts";
import type { AgentEvent } from "../../../src/runtime/types.ts";

class FakeTransport {
	readonly requests: HostFrameEnvelope[] = [];
	private listener: ((frame: HostFrameEnvelope) => void) | undefined;

	onEvent(listener: (frame: HostFrameEnvelope) => void): () => void {
		this.listener = listener;
		return () => { this.listener = undefined; };
	}

	async request(frame: HostFrameEnvelope): Promise<HostFrameEnvelope> {
		this.requests.push(frame);
		return {
			frameId: `response_${frame.frameId}`,
			kind: frame.kind === "query_request" ? "query_result" : "command_result",
			protocolVersion: frame.protocolVersion,
			body: { requestFrameId: frame.frameId, ok: true },
		};
	}

	emit(event: AgentEvent): void {
		this.listener?.({
			frameId: `event_${event.timestamp}`,
			kind: "subscription_event",
			protocolVersion: 1,
			body: { sessionId: "session_remote", eventId: `event_${event.timestamp}`, event },
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
		});
		const events: string[] = [];
		controller.subscribe((event) => events.push(event.type));
		await controller.prompt("hello");
		transport.emit({ type: "agent_start", timestamp: 1 });
		transport.emit({ type: "agent_start", timestamp: 1 });
		transport.emit({ type: "agent_end", timestamp: 2 });
		controller.interrupt();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(events).toEqual(["agent_start", "agent_end"]);
		expect(transport.requests.map((request) => request.body.operation)).toEqual([
			"session.prompt",
			"session.interrupt",
		]);
		controller.dispose();
	});
});
