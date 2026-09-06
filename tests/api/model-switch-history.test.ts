import { describe, expect, it } from "vitest";
import { transformMessages } from "../../src/api/transform-messages.ts";
import { convertMessages } from "../../src/api/openai-completions/message-conversion.ts";
import { getCompat } from "../../src/api/openai-completions/compat-detection.ts";
import { convertMessages as convertAnthropicMessages, normalizeToolCallId } from "../../src/api/anthropic-messages/message-conversion.ts";
import { convertResponsesMessages } from "../../src/api/openai-responses-shared.ts";
import type { AssistantMessage, Message, Model, ToolCall, ToolResultMessage } from "../../src/types.ts";

const target: Model<"openai-completions"> = {
	id: "target", provider: "openai", name: "Target", api: "openai-completions", baseUrl: "http://localhost/v1",
	reasoning: false, input: ["text"], contextWindow: 16_384, maxTokens: 1_024,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
function assistant(content: AssistantMessage["content"], extra: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant", provider: "source", model: "source-model", api: "openai-responses", content,
		stopReason: "toolUse", timestamp: 1,
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		...extra,
	};
}
function call(id: string): ToolCall { return { type: "toolCall", id, name: "inspect", arguments: {}, thoughtSignature: "source-only-signature" }; }
function result(id: string, text: string): ToolResultMessage {
	return { role: "toolResult", toolCallId: id, toolName: "inspect", content: [{ type: "text", text }], isError: false, timestamp: 2 };
}

describe("request-time model switch history", () => {
	it("encodes foreign reasoning and tools for the target without changing the original transcript", () => {
		const messages: Message[] = [
			assistant([
				{ type: "thinking", thinking: "Visible reasoning", thinkingSignature: "encrypted-source" },
				{ type: "thinking", thinking: "", thinkingSignature: "opaque-source", redacted: true },
				call("call_1|fc_item"),
			]), result("call_1|fc_item", "tool output"),
			{ role: "user", content: [{ type: "image", data: "image-bytes", mimeType: "image/png" }], timestamp: 3 },
		];
		const original = structuredClone(messages);
		const wire = convertMessages(target, { messages }, getCompat(target));
		expect(wire[0]).toMatchObject({ role: "assistant", tool_calls: [{ id: "call_1" }] });
		expect(wire[1]).toMatchObject({ role: "tool", tool_call_id: "call_1", content: "tool output" });
		expect(JSON.stringify(wire)).toContain("Visible reasoning");
		expect(JSON.stringify(wire)).not.toMatch(/encrypted-source|opaque-source|source-only-signature|image-bytes/);
		expect(messages).toEqual(original);
	});

	it("keeps colliding normalized tool IDs distinct and results paired on the provider wire", () => {
		const messages: Message[] = [assistant([call("same|fc_a"), call("same|fc_b")]), result("same|fc_a", "A"), result("same|fc_b", "B")];
		const wire = convertMessages(target, { messages }, getCompat(target));
		const first = wire[0];
		if (first.role !== "assistant") throw new Error("missing assistant");
		const ids = first.tool_calls?.map((item) => item.id);
		expect(new Set(ids).size).toBe(2);
		expect(wire.slice(1)).toMatchObject([
			{ role: "tool", tool_call_id: ids?.[0], content: "A" },
			{ role: "tool", tool_call_id: ids?.[1], content: "B" },
		]);
	});

	it("pulls a late real result into the tool window instead of emitting a synthetic and a duplicate", () => {
		const messages: Message[] = [assistant([call("a")]), { role: "user", content: "continue", timestamp: 3 }, result("a", "actual result")];
		const output = transformMessages(messages, target);
		expect(output.map((message) => message.role)).toEqual(["assistant", "toolResult", "user"]);
		expect(output[1]).toMatchObject({ content: [{ type: "text", text: "actual result" }], isError: false });
	});

	it("never replays orphan or duplicate tool results as unmatched provider tool messages", () => {
		const messages: Message[] = [assistant([call("a")]), result("a", "first"), result("a", "duplicate"), result("missing", "orphan")];
		const output = transformMessages(messages, target);
		expect(output.filter((message) => message.role === "toolResult")).toEqual([result("a", "first")]);
	});

	it("encodes a Responses tool history for Anthropic without foreign signatures", () => {
		const anthropic: Model<"anthropic-messages"> = { ...target, api: "anthropic-messages", provider: "anthropic", reasoning: true };
		const messages: Message[] = [assistant([
			{ type: "thinking", thinking: "prior reasoning", thinkingSignature: "foreign-encrypted-signature" },
			call("call_with/slash|fc_item"),
		]), result("call_with/slash|fc_item", "file contents")];
		const wire = convertAnthropicMessages(transformMessages(messages, anthropic, normalizeToolCallId), false);
		const text = JSON.stringify(wire);
		expect(text).toContain("prior reasoning");
		expect(text).toContain("file contents");
		expect(text).not.toMatch(/foreign-encrypted-signature|source-only-signature/);
		const use = Array.isArray(wire[0].content) ? wire[0].content.find((block) => block.type === "tool_use") : undefined;
		expect(use).toMatchObject({ type: "tool_use", name: "inspect" });
		if (use?.type !== "tool_use") throw new Error("missing tool use");
		expect(use.id).toMatch(/^[a-zA-Z0-9_-]+$/u);
		expect(wire[1].content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "tool_result", tool_use_id: use.id })]));
	});

	it("encodes a foreign tool history for Responses with matching call and output IDs", () => {
		const responses: Model<"openai-responses"> = { ...target, api: "openai-responses", provider: "openai", reasoning: true };
		const messages: Message[] = [assistant([call("foreign-call")], { api: "anthropic-messages" }), result("foreign-call", "output")];
		const wire = convertResponsesMessages(responses, { messages }, new Set(["openai"]));
		const functionCall = wire.find((item) => item.type === "function_call");
		if (functionCall?.type !== "function_call") throw new Error("missing function call");
		expect(wire).toEqual(expect.arrayContaining([expect.objectContaining({ type: "function_call_output", call_id: functionCall.call_id, output: "output" })]));
		expect(JSON.stringify(wire)).not.toContain("source-only-signature");
	});
});
