import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createSessionEventStreamRef, type RuntimeEventV3 } from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { AgentLoopSessionEvents } from "../../../src/runtime/session/agent-loop-events.ts";
import { replayConversationEvents } from "../../../src/runtime/session/conversation-replay.ts";
import { EventWriter } from "../../../src/runtime/session/event-writer.ts";
import { MemoryEventStore } from "../../../src/runtime/session/memory-event-store.ts";
import type { WriterFence } from "../../../src/runtime/session/types.ts";

const DIGEST = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function setup() {
	const authorityId = createRuntimeId("authority", "conversation");
	const tenantId = createRuntimeId("tenant", "conversation");
	const principalId = createRuntimeId("principal", "conversation");
	const sessionId = createRuntimeId("session", "conversation");
	const stream = createSessionEventStreamRef({ authorityId, tenantId }, sessionId);
	const runtimeId = createRuntimeId("runtime", "conversation");
	const fence: WriterFence = {
		authorityId,
		tenantId,
		stream,
		leaseId: createRuntimeId("lease", "conversation"),
		ownerRuntimeId: runtimeId,
		writerEpoch: 1,
		fencingToken: "conversation-fence",
	};
	const store = new MemoryEventStore({
		authorityId,
		tenantId,
		stream,
		validateFence: () => true,
	});
	const writer = new EventWriter({ authorityId, tenantId, stream, store, fence });
	const bridge = new AgentLoopSessionEvents({ writer, principalId, runtimeId, featureDigest: DIGEST });
	return { store, bridge };
}

async function events(context: ReturnType<typeof setup>): Promise<readonly RuntimeEventV3[]> {
	const page = await context.store.readPage(context.store.streamRef(), { limit: 100 });
	if (!page.ok) throw new Error(page.error.message);
	return page.value.events;
}

describe("replayConversationEvents", () => {
	it("round-trips canonical user, assistant, and tool result messages", async () => {
		const context = setup();
		const input = [
			{ role: "user", content: [{ type: "text", text: "hello" }] },
			{ role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" },
			{
				role: "toolResult",
				content: [{
					type: "toolResult",
					toolCallId: "provider-call",
					toolName: "echo",
					content: [{ type: "text", text: "hello" }],
					isError: false,
				}],
			},
		] as const;
		for (const message of input) await context.bridge.recordMessage(message);
		const replay = replayConversationEvents(await events(context));
		expect(replay).toEqual({ ok: true, value: input });
	});

	it("rejects an independently corrupted message digest", async () => {
		const context = setup();
		await context.bridge.recordMessage({ role: "user", content: [{ type: "text", text: "hello" }] });
		const source = [...await events(context)];
		const index = source.findIndex((event) => event.type === "conversation.message_recorded");
		const original = source[index];
		if (!original || original.type !== "conversation.message_recorded") throw new Error("fixture missing");
		source[index] = {
			...original,
			payload: { ...original.payload, contentDigest: canonicalDigest("different") },
		};
		expect(replayConversationEvents(source)).toMatchObject({ ok: false, error: { code: "hash_mismatch" } });
	});
});
