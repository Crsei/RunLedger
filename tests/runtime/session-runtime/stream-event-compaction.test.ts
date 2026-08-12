import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "../../../src/types.ts";
import type { AgentEvent, AgentEventSink } from "../../../src/runtime/types.ts";
import type { SessionDomainPort } from "../../../src/runtime/session-runtime/session-runtime.ts";
import { createRuntimeHarness, type RuntimeHarness } from "./harness.ts";
import { SessionStreamEventCoalescer } from "../../../src/runtime/session-runtime/stream-event-coalescer.ts";

const harnesses: RuntimeHarness[] = [];

afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await harness.server.close();
		harness.store.database().close();
		harness.cleanup();
	}
});

describe("Session Runtime durable stream compaction", () => {
	it("flushes the first visible delta within 50ms and keeps aggregate evidence across flushes", () => {
		vi.useFakeTimers();
		try {
			const emitted: AgentEvent[] = [];
			const coalescer = new SessionStreamEventCoalescer({ emit: (event) => emitted.push(event) });
			coalescer.accept(delta("ab", 1));
			vi.advanceTimersByTime(49);
			expect(emitted).toEqual([]);
			vi.advanceTimersByTime(1);
			expect(emitted).toHaveLength(1);

			coalescer.accept(delta("cd", 2));
			coalescer.accept({ type: "message_end", timestamp: 3, role: "assistant", stopReason: "stop", message: assistant("abcd") });
			expect(emitted).toHaveLength(3);
			expect(emitted[1]).toMatchObject({
				type: "message_update",
				assistantMessageEvent: {
					delta: "cd",
					aggregateSize: 4,
					aggregateDigest: "88d4266fd4e6338d13b845fcf289579d209c897823b9217da3e161936f031589",
				},
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("releases content state after its end boundary", () => {
		const emitted: AgentEvent[] = [];
		const coalescer = new SessionStreamEventCoalescer({ emit: (event) => emitted.push(event) });
		coalescer.accept(delta("ab", 1));
		coalescer.accept({
			type: "message_update",
			timestamp: 2,
			assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "ab", partial: assistant("ab") },
		});
		coalescer.accept(delta("z", 3));
		coalescer.flush();

		const last = emitted.at(-1);
		expect(last).toMatchObject({
			type: "message_update",
			assistantMessageEvent: {
				delta: "z",
				aggregateSize: 1,
				aggregateDigest: "594e519ae499312b29433b7dd8a97ff068defcba9755b6d5d00e84c524d67b06",
			},
		});
	});

	it("flushes pending delta before a new message start resets stream state", () => {
		const emitted: AgentEvent[] = [];
		const coalescer = new SessionStreamEventCoalescer({ emit: (event) => emitted.push(event) });
		coalescer.accept(delta("pending", 1));
		coalescer.accept({ type: "message_start", timestamp: 2, role: "assistant" });

		expect(emitted).toHaveLength(2);
		expect(emitted[0]).toMatchObject({
			type: "message_update",
			assistantMessageEvent: { delta: "pending", aggregateSize: 7 },
		});
		expect(emitted[1]).toMatchObject({ type: "message_start" });
	});

	it("persists delta-only message updates with approximately linear N to 2N growth", async () => {
		let listener: AgentEventSink | undefined;
		const domain = {
			controller: {
				subscribe: (next: AgentEventSink) => {
					listener = next;
					return () => undefined;
				},
			},
			snapshot: () => ({
				messages: [],
				warnings: [],
				auditEntries: [],
				selection: { thinkingLevel: "off" },
				toolCount: 0,
				inFlight: true,
				providerStatuses: [],
			}),
		} as unknown as SessionDomainPort;
		const harness = await createRuntimeHarness("stream-compaction", { domain });
		harnesses.push(harness);
		expect(listener).toBeTypeOf("function");
		if (listener === undefined) return;

		await emitSyntheticMessage(listener, 256, 1);
		await emitSyntheticMessage(listener, 512, 2);
		const durable = harness.store.replaySessionEvents(harness.sessionId)
			.filter((event) => event.eventType === "agent.event");
		const firstPayloads = durable.filter((event) => event.createdAtMs >= 10_000 && event.createdAtMs < 20_000).map((event) => event.payloadJson);
		const secondPayloads = durable.filter((event) => event.createdAtMs >= 20_000 && event.createdAtMs < 30_000).map((event) => event.payloadJson);
		const firstBytes = firstPayloads.reduce((sum, value) => sum + Buffer.byteLength(value), 0);
		const secondBytes = secondPayloads.reduce((sum, value) => sum + Buffer.byteLength(value), 0);

		expect(secondBytes / firstBytes).toBeLessThanOrEqual(2.5);
		const updates = [...firstPayloads, ...secondPayloads]
			.map((value) => JSON.parse(value) as Record<string, unknown>)
			.filter((event) => event.type === "message_update");
		expect(updates.length).toBeGreaterThan(0);
		for (const update of updates) {
			expect(JSON.stringify(update)).not.toContain('"partial"');
			expect(update).toMatchObject({
				assistantMessageEvent: {
					type: "text_delta",
					aggregateDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
					aggregateSize: expect.any(Number),
				},
			});
		}
	});
});

function delta(value: string, timestamp: number): AgentEvent {
	return {
		type: "message_update",
		timestamp,
		assistantMessageEvent: {
			type: "text_delta",
			contentIndex: 0,
			delta: value,
			partial: assistant(value),
		},
	};
}

async function emitSyntheticMessage(listener: AgentEventSink, size: number, ordinal: number): Promise<void> {
	const timestamp = ordinal * 10_000;
	const empty = assistant("");
	await listener({ type: "message_start", timestamp, role: "assistant" });
	for (let index = 1; index <= size; index += 1) {
		const text = "x".repeat(index);
		await listener({
			type: "message_update",
			timestamp: timestamp + index,
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "x",
				partial: { ...empty, content: [{ type: "text", text }] },
			},
		} as AgentEvent);
	}
	await listener({
		type: "message_end",
		timestamp: timestamp + size + 1,
		role: "assistant",
		stopReason: "stop",
		message: assistant("x".repeat(size)),
	});
}

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: text.length === 0 ? [] : [{ type: "text", text }],
		api: "mock",
		provider: "mock",
		model: "mock-1",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}
