import { describe, expect, it } from "vitest";
import type { AssistantMessage, AssistantMessageEvent, Model } from "../../src/types.ts";
import { AssistantMessageEventStream } from "../../src/utils/event-stream.ts";
import {
	handleContentBlockDelta,
	handleContentBlockStart,
	handleContentBlockStop,
	handleMetadata,
	mapStopReason as mapBedrockStopReason,
	type Block,
} from "../../src/api/bedrock-converse-stream/event-mapper.ts";
import { mapCodexEvents } from "../../src/api/openai-codex-responses/event-mapper.ts";
import { parseWebSocket } from "../../src/api/openai-codex-responses/websocket-transport.ts";
import type { WebSocketEventType, WebSocketLike, WebSocketListener } from "../../src/api/openai-codex-responses/websocket-cache.ts";
import { iterateSseMessages } from "../../src/api/anthropic-messages/sse-decoder.ts";
import { mapStopReason as mapOpenAiStopReason, parseChunkUsage } from "../../src/api/openai-completions/stream-mapper.ts";

describe("provider stream protocol characterization", () => {
	it("preserves the Bedrock text/tool event sequence, usage, and terminal reason", async () => {
		const output = assistant("bedrock-converse-stream", "bedrock");
		const blocks = output.content as Block[];
		const stream = new AssistantMessageEventStream();

		handleContentBlockDelta({ contentBlockIndex: 0, delta: { text: "hello" } }, blocks, output, stream);
		handleContentBlockStop({ contentBlockIndex: 0 }, blocks, output, stream);
		handleContentBlockStart({ contentBlockIndex: 1, start: { toolUse: { toolUseId: "call-1", name: "read" } } }, blocks, output, stream);
		handleContentBlockDelta({ contentBlockIndex: 1, delta: { toolUse: { input: '{"path":"a' } } }, blocks, output, stream);
		handleContentBlockDelta({ contentBlockIndex: 1, delta: { toolUse: { input: '.txt"}' } } }, blocks, output, stream);
		handleContentBlockStop({ contentBlockIndex: 1 }, blocks, output, stream);
		handleMetadata({ usage: { inputTokens: 7, outputTokens: 5, cacheReadInputTokens: 2, totalTokens: 14 } }, bedrockModel(), output);
		output.stopReason = mapBedrockStopReason("tool_use").stopReason;
		stream.end(output);

		const events = await collect(stream);
		expect(events.map((event) => event.type)).toEqual([
			"text_start", "text_delta", "text_end", "toolcall_start", "toolcall_delta", "toolcall_delta", "toolcall_end",
		]);
		expect(output.content).toEqual([
			{ type: "text", text: "hello" },
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.txt" } },
		]);
		expect(output.usage).toMatchObject({ input: 7, output: 5, cacheRead: 2, totalTokens: 14 });
		expect(output.stopReason).toBe("toolUse");
	});

	it("maps Codex WebSocket terminal and failed frames through the same event mapper", async () => {
		const completedSocket = new FakeWebSocket();
		const completed = collect(mapCodexEvents(parseWebSocket(completedSocket)));
		completedSocket.emit("message", { data: JSON.stringify({ type: "response.done", response: { id: "r-1", status: "completed" } }) });
		await expect(completed).resolves.toEqual([
			expect.objectContaining({ type: "response.completed", response: expect.objectContaining({ id: "r-1", status: "completed" }) }),
		]);

		const failedSocket = new FakeWebSocket();
		const failed = collect(mapCodexEvents(parseWebSocket(failedSocket)));
		failedSocket.emit("message", { data: JSON.stringify({ type: "response.failed", response: { error: { code: "rate_limit", message: "slow down" } } }) });
		failedSocket.emit("message", { data: JSON.stringify({ type: "response.completed", response: { status: "failed" } }) });
		await expect(failed).rejects.toMatchObject({ name: "CodexApiError", message: "slow down", code: "rate_limit" });
	});

	it("decodes Anthropic SSE fields when CRLF itself is split across byte chunks", async () => {
		const body = byteStream([
			"event: message_start\r",
			'\ndata: {"type":"message_start"}\r',
			"\n\r",
			"\n",
		]);

		await expect(collect(iterateSseMessages(body))).resolves.toEqual([{
			event: "message_start",
			data: '{"type":"message_start"}',
			raw: ["event: message_start", 'data: {"type":"message_start"}'],
		}]);
	});

	it("preserves OpenAI usage accounting and stop/error taxonomy", () => {
		const usage = parseChunkUsage({
			prompt_tokens: 13,
			completion_tokens: 8,
			prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 },
			completion_tokens_details: { reasoning_tokens: 5 },
		}, openAiModel());

		expect(usage).toMatchObject({ input: 8, output: 8, cacheRead: 3, cacheWrite: 2, reasoning: 5, totalTokens: 21 });
		expect(mapOpenAiStopReason("tool_calls")).toEqual({ stopReason: "toolUse" });
		expect(mapOpenAiStopReason("content_filter")).toEqual({
			stopReason: "error",
			errorMessage: "Provider finish_reason: content_filter",
		});
	});
});

class FakeWebSocket implements WebSocketLike {
	private readonly listeners = new Map<WebSocketEventType, Set<WebSocketListener>>();

	public close(): void {}
	public send(): void {}
	public addEventListener(type: WebSocketEventType, listener: WebSocketListener): void {
		const listeners = this.listeners.get(type) ?? new Set<WebSocketListener>();
		listeners.add(listener);
		this.listeners.set(type, listeners);
	}
	public removeEventListener(type: WebSocketEventType, listener: WebSocketListener): void {
		this.listeners.get(type)?.delete(listener);
	}
	public emit(type: WebSocketEventType, event: unknown): void {
		for (const listener of this.listeners.get(type) ?? []) listener(event);
	}
}

function byteStream(chunks: readonly string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	});
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
	const values: T[] = [];
	for await (const value of source) values.push(value);
	return values;
}

function assistant(api: "bedrock-converse-stream", provider: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api,
		provider,
		model: "fixture-model",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: 0,
	};
}

function bedrockModel(): Model<"bedrock-converse-stream"> {
	return model("bedrock-converse-stream", "bedrock");
}

function openAiModel(): Model<"openai-completions"> {
	return model("openai-completions", "openai");
}

function model<TApi extends "bedrock-converse-stream" | "openai-completions">(api: TApi, provider: string): Model<TApi> {
	return {
		id: "fixture-model",
		name: "Fixture model",
		api,
		provider,
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 1024,
	};
}
