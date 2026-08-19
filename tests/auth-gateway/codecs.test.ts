import { describe, expect, test } from "vitest";
import type { AssistantMessage, AssistantMessageEvent, Context } from "../../src/types.ts";
import { decodeRequest as decodeChatRequest, encodeStream as encodeChatStream } from "../../src/auth-gateway/codecs/chat-completions.ts";
import { decodeRequest as decodeMessagesRequest, encodeStream as encodeMessagesStream } from "../../src/auth-gateway/codecs/messages.ts";
import { decodeRequest as decodeResponsesRequest, encodeStream as encodeResponsesStream } from "../../src/auth-gateway/codecs/responses.ts";
import { decodeRequest as decodePiRequest, encodeStream as encodePiStream } from "../../src/auth-gateway/codecs/pi-messages.ts";

function usage() {
	return {
		input: 7,
		output: 3,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 10,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function partial(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "fixture",
		model: "fixture-model",
		responseId: "response_fixture",
		usage: usage(),
		stopReason: "stop",
		timestamp: 1,
	};
}

function eventStream(events: readonly AssistantMessageEvent[]) {
	return events;
}

async function collect(source: AsyncIterable<string>): Promise<string[]> {
	const lines: string[] = [];
	for await (const line of source) lines.push(line);
	return lines;
}

describe("auth-gateway pure wire codecs", () => {
	test("decodes OpenAI Chat Completions messages, tools, images, and options", () => {
		const decoded = decodeChatRequest({
			model: "team/fixture-model",
			stream: true,
			messages: [
				{ role: "system", content: "Be concise" },
				{ role: "user", content: [{ type: "text", text: "Look" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
				{ role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } }] },
				{ role: "tool", tool_call_id: "call_1", content: "value", name: "lookup" },
			],
			tools: [{ type: "function", function: { name: "lookup", description: "Look up", parameters: { type: "object" } } }],
			temperature: 0.2,
			max_tokens: 64,
			unknown_field: "ignored",
		});

		expect(decoded.model).toBe("team/fixture-model");
		expect(decoded.stream).toBe(true);
		expect(decoded.context.systemPrompt).toBe("Be concise");
		expect(decoded.context.messages).toEqual(expect.arrayContaining([
			expect.objectContaining({ role: "user", content: expect.arrayContaining([{ type: "image", mimeType: "image/png", data: "AAAA" }]) }),
			expect.objectContaining({ role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "lookup", arguments: { q: "x" } }] }),
			expect.objectContaining({ role: "toolResult", toolCallId: "call_1", toolName: "lookup" }),
		]));
		expect(decoded.context.tools).toEqual([{ name: "lookup", description: "Look up", parameters: { type: "object" } }]);
		expect(decoded.options).toMatchObject({ temperature: 0.2, maxTokens: 64 });
	});

	test("encodes Chat Completions text/tool deltas, usage, and terminal done", async () => {
		const message = partial();
		const lines = await collect(encodeChatStream(eventStream([
			{ type: "start", partial: message },
			{ type: "text_start", contentIndex: 0, partial: message },
			{ type: "text_delta", contentIndex: 0, delta: "hello", partial: message },
			{ type: "toolcall_start", contentIndex: 1, partial: message },
			{ type: "toolcall_delta", contentIndex: 1, delta: '{"q":"x"}', partial: message },
			{ type: "done", reason: "toolUse", message: { ...message, stopReason: "toolUse" } },
		])));

		expect(lines.join("")).toContain('"delta":{"role":"assistant"}');
		expect(lines.join("")).toContain('"content":"hello"');
		expect(lines.join("")).toContain('"arguments":"{\\"q\\":\\"x\\"}"');
		expect(lines.join("")).toContain('"finish_reason":"tool_calls"');
		expect(lines.join("")).toContain('"prompt_tokens":7');
		expect(lines.at(-1)).toBe("data: [DONE]\n\n");
	});

	test("decodes Anthropic Messages system/content blocks, tool use/results, and thinking", () => {
		const decoded = decodeMessagesRequest({
			model: "claude-fixture",
			stream: true,
			system: [{ type: "text", text: "System one" }, { type: "text", text: "System two" }],
			messages: [
				{ role: "user", content: [{ type: "text", text: "question" }] },
				{ role: "assistant", content: [{ type: "thinking", thinking: "reason" }, { type: "tool_use", id: "tool_1", name: "lookup", input: { q: "x" } }] },
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "tool_1", content: [{ type: "text", text: "value" }] }] },
			],
			tools: [{ name: "lookup", description: "Look up", input_schema: { type: "object" } }],
			max_tokens: 32,
		});

		expect(decoded.context.systemPrompt).toBe("System one\n\nSystem two");
		expect(decoded.context.messages).toEqual(expect.arrayContaining([
			expect.objectContaining({ role: "assistant", content: expect.arrayContaining([{ type: "thinking", thinking: "reason" }, { type: "toolCall", id: "tool_1", name: "lookup", arguments: { q: "x" } }]) }),
			expect.objectContaining({ role: "toolResult", toolCallId: "tool_1", toolName: "lookup" }),
		]));
		expect(decoded.context.tools).toEqual([{ name: "lookup", description: "Look up", parameters: { type: "object" } }]);
		expect(decoded.options).toMatchObject({ maxTokens: 32 });
	});

	test("encodes Anthropic message lifecycle and error terminal event", async () => {
		const message = partial();
		const lines = await collect(encodeMessagesStream(eventStream([
			{ type: "start", partial: message },
			{ type: "text_start", contentIndex: 0, partial: message },
			{ type: "text_delta", contentIndex: 0, delta: "hello", partial: message },
			{ type: "text_end", contentIndex: 0, content: "hello", partial: message },
			{ type: "error", reason: "error", error: { ...message, stopReason: "error", errorMessage: "upstream failed" } },
		])));

		expect(lines.map((line) => line.split("\n")[0])).toEqual(expect.arrayContaining(["event: message_start", "event: content_block_start", "event: content_block_delta", "event: content_block_stop", "event: error"]));
		expect(lines.join("")).toContain("upstream failed");
	});

	test("decodes Responses instructions/input items and function calls", () => {
		const decoded = decodeResponsesRequest({
			model: "responses-fixture",
			stream: true,
			instructions: "Follow policy",
			input: [
				{ type: "message", role: "user", content: [{ type: "input_text", text: "question" }] },
				{ type: "function_call", call_id: "call_2", name: "lookup", arguments: '{"q":"x"}' },
				{ type: "function_call_output", call_id: "call_2", output: "value" },
				{ type: "reasoning", summary: [{ type: "summary_text", text: "reason" }] },
			],
			tools: [{ type: "function", name: "lookup", description: "Look up", parameters: { type: "object" } }],
			max_output_tokens: 48,
			reasoning: { effort: "high" },
		});

		expect(decoded.context.systemPrompt).toBe("Follow policy");
		expect(decoded.context.messages).toEqual(expect.arrayContaining([
			expect.objectContaining({ role: "user" }),
			expect.objectContaining({ role: "assistant", content: expect.arrayContaining([{ type: "toolCall", id: "call_2", name: "lookup", arguments: { q: "x" } }]) }),
			expect.objectContaining({ role: "toolResult", toolCallId: "call_2" }),
			expect.objectContaining({ role: "assistant", content: [{ type: "thinking", thinking: "reason" }] }),
		]));
		expect(decoded.options).toMatchObject({ maxTokens: 48, reasoning: "high" });
	});

	test("encodes Responses output deltas and usage completion", async () => {
		const message = partial();
		const lines = await collect(encodeResponsesStream(eventStream([
			{ type: "start", partial: message },
			{ type: "text_start", contentIndex: 0, partial: message },
			{ type: "text_delta", contentIndex: 0, delta: "hello", partial: message },
			{ type: "text_end", contentIndex: 0, content: "hello", partial: message },
			{ type: "done", reason: "stop", message },
		])));

		const dataLines = lines.map((line) => line.split("\n")[0] ?? "");
		expect(dataLines.some((line) => line.includes('"type":"response.created"'))).toBe(true);
		expect(dataLines.some((line) => line.includes('"type":"response.output_text.delta"'))).toBe(true);
		expect(dataLines.some((line) => line.includes('"type":"response.completed"'))).toBe(true);
		expect(lines.join("")).toContain('"input_tokens":7');
	});

	test("keeps one Responses item id across function-call start, delta, and completion", async () => {
		const toolCall = { type: "toolCall" as const, id: "call_2", name: "lookup", arguments: { q: "x" } };
		const message: AssistantMessage = {
			...partial(),
			content: [
				{ type: "text", text: "before tool" },
				toolCall,
			],
		};
		const lines = await collect(encodeResponsesStream(eventStream([
			{ type: "start", partial: message },
			{ type: "toolcall_start", contentIndex: 1, partial: message },
			{ type: "toolcall_delta", contentIndex: 1, delta: '{"q":"x"}', partial: message },
			{ type: "toolcall_end", contentIndex: 1, toolCall, partial: message },
		])));
		const events = lines.map((line) => JSON.parse(line.slice("data: ".length).trim()) as {
			type: string;
			item_id?: string;
			item?: { id?: string };
		});
		const added = events.find((event) => event.type === "response.output_item.added");
		const delta = events.find((event) => event.type === "response.function_call_arguments.delta");
		const done = events.find((event) => event.type === "response.function_call_arguments.done");

		expect(added?.item?.id).toBe("fc_call_2");
		expect(delta?.item_id).toBe(added?.item?.id);
		expect(done?.item_id).toBe(added?.item?.id);
	});

	test("passes native pi-messages context through validation and maps terminal events", async () => {
		const context: Context = {
			systemPrompt: "native",
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
		};
		const decoded = decodePiRequest({ model: "native-model", context, options: { reasoning: "medium", ignored: true }, stream: true });
		expect(decoded).toMatchObject({ model: "native-model", context, options: { reasoning: "medium" }, stream: true });

		const message = partial();
		const lines = await collect(encodePiStream(eventStream([
			{ type: "start", partial: message },
			{ type: "text_delta", contentIndex: 0, delta: "hello", partial: message },
			{ type: "done", reason: "stop", message },
		])));
		const payloads = lines.map((line) => JSON.parse(line.slice("data: ".length).trim()) as { type: string });
		expect(payloads.map((payload) => payload.type)).toEqual(["start", "text_delta", "done"]);
	});

	test("rejects malformed requests instead of guessing a context", () => {
		expect(() => decodeChatRequest({ model: "fixture" })).toThrow(/messages/i);
		expect(() => decodeMessagesRequest({ model: "fixture" })).toThrow(/messages/i);
		expect(() => decodeResponsesRequest({ model: "fixture", input: 42 })).toThrow(/input/i);
		expect(() => decodePiRequest({ model: "fixture", context: { messages: [{ role: "unknown" }] } })).toThrow(/unsupported|role/i);
	});
});
