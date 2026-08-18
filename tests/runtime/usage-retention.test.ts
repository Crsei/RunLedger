import { describe, expect, it } from "vitest";
import { runAgentLoop, defaultConvertToLlm } from "../../src/runtime/agent-loop.ts";
import { MemoryLedger } from "../../src/runtime/ledger/memory-ledger.ts";
import { mockModel } from "../../src/runtime/providers/mock-stream.ts";
import { projectSessionReplay } from "../../src/storage/session-codec.ts";
import type { AgentEvent, AgentMessage } from "../../src/runtime/types.ts";
import type { AssistantMessage } from "../../src/types.ts";
import { createAssistantMessageEventStream } from "../../src/utils/event-stream.ts";

const usage: AssistantMessage["usage"] = {
	input: 120,
	output: 30,
	cacheRead: 800,
	cacheWrite: 12,
	totalTokens: 962,
	cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
	reported: {
		input: true,
		output: true,
		cacheRead: true,
		cacheWrite: true,
		cost: true,
	},
};

function providerMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "retained" }],
		api: mockModel.api,
		provider: mockModel.provider,
		model: mockModel.id,
		usage,
		durationMs: 250,
		ttftMs: 90,
		timingSource: "provider",
		stopReason: "stop",
		timestamp: 1_000,
	};
}

describe("provider usage and timing retention", () => {
	it("keeps usage provenance and timing through loop events, ledger replay data, and LLM conversion", async () => {
		const message = providerMessage();
		const streamFn = () => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: "stop", message });
				stream.end(message);
			});
			return stream;
		};
		const ledger = new MemoryLedger();
		const events: AgentEvent[] = [];

		await runAgentLoop(
			[],
			{ messages: [], tools: undefined },
			{ model: mockModel, ledger },
			(event) => { events.push(event); },
			undefined,
			streamFn,
		);

		const end = events.find((event) => event.type === "message_end" && event.role === "assistant");
		const start = events.find((event) => event.type === "agent_start");
		expect(end?.runId).toBe(start?.runId);
		expect(end?.message).toMatchObject({
			usage,
			durationMs: 250,
			ttftMs: 90,
			timingSource: "provider",
		});

		const entry = ledger.entries().find((candidate) => candidate.type === "message" && candidate.payload.role === "assistant");
		expect(entry?.payload.message).toMatchObject({
			usage,
			durationMs: 250,
			ttftMs: 90,
			 timingSource: "provider",
		});
		const replay = projectSessionReplay(entry === undefined ? [] : [entry]);
		expect(replay.messages).toContainEqual(expect.objectContaining({
			role: "assistant",
			usage,
			durationMs: 250,
			ttftMs: 90,
			timingSource: "provider",
		}));

		const assistant = end?.message as AgentMessage;
		const converted = defaultConvertToLlm([assistant])[0];
		expect(converted).toMatchObject({
			usage,
			durationMs: 250,
			ttftMs: 90,
			timingSource: "provider",
		});
	});

	it("measures only a successful provider stream when provider duration is absent", async () => {
		const message: AssistantMessage = {
			...providerMessage(),
			durationMs: undefined,
			ttftMs: undefined,
			timingSource: undefined,
		};
		const streamFn = () => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(async () => {
				stream.push({ type: "start", partial: message });
				await new Promise((resolve) => setTimeout(resolve, 5));
				stream.push({ type: "done", reason: "stop", message });
				stream.end(message);
			});
			return stream;
		};
		const events: AgentEvent[] = [];

		await runAgentLoop(
			[],
			{ messages: [], tools: undefined },
			{ model: mockModel },
			(event) => { events.push(event); },
			undefined,
			streamFn,
		);

		const end = events.find((event) => event.type === "message_end" && event.role === "assistant");
		if (end?.message?.role !== "assistant") throw new Error("assistant completion missing");
		expect(end.message.timingSource).toBe("measured");
		expect(end.message.durationMs).toBeGreaterThan(0);
		expect(end.message.ttftMs).toBeUndefined();
	});
});
