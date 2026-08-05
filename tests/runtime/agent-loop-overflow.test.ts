import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { runAgentLoop } from "../../src/runtime/agent-loop.ts";
import type {
	AgentContext,
	AgentTool,
	AgentToolResult,
	LlmContext,
	StreamFn,
} from "../../src/runtime/types.ts";
import { createAssistantMessageEventStream } from "../../src/utils/event-stream.ts";
import type { Api, AssistantMessage, Model, ToolCall } from "../../src/types.ts";
import { runtimeDigest } from "../../src/runtime/protocol/foundation.ts";

const MODEL: Model<Api> = {
	id: "overflow-model",
	name: "Overflow Model",
	api: "mock",
	provider: "overflow-provider",
	baseUrl: "http://localhost",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8_192,
	maxTokens: 1_024,
};

const USAGE: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const parameters = Type.Object({ value: Type.String() });

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: MODEL.api,
		provider: MODEL.provider,
		model: MODEL.id,
		usage: USAGE,
		stopReason,
		timestamp: Date.now(),
	};
}

function oneToolThenStop(call: ToolCall): StreamFn {
	return (_model, context: LlmContext) => {
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const hasResult = context.messages.some((message) => message.role === "toolResult");
			const message = hasResult ? assistant([{ type: "text", text: "done" }], "stop") : assistant([call], "toolUse");
			stream.push({ type: "start", partial: { ...message, content: [] } });
			if (!hasResult) stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
			stream.push({ type: "done", reason: message.stopReason, message });
			stream.end(message);
		});
		return stream;
	};
}

describe("agent-loop tool result overflow boundary", () => {
	it("stores overflow through the injected Host port and never returns a filesystem path", async () => {
		const call: ToolCall = { type: "toolCall", id: "overflow-call", name: "overflow", arguments: { value: "x" } };
		const tool: AgentTool<typeof parameters> = {
			name: "overflow",
			label: "overflow",
			description: "fixture",
			parameters,
			maxResultSizeChars: 4,
			execute: async (): Promise<AgentToolResult> => ({ content: [{ type: "text", text: "abcdefgh" }], details: {} }),
		};
		const stored: Uint8Array[] = [];
		const context: AgentContext = { messages: [], tools: [tool] };

		await runAgentLoop(
			[{ role: "user", content: [{ type: "text", text: "run" }] }],
			context,
			{
				model: MODEL,
				shouldStopAfterTurn: ({ messages }) => messages.some((message) => message.role === "toolResult"),
				toolResultOverflowStore: {
					put: async (input) => {
						stored.push(input.bytes);
						return {
							ref: {
								subjectKind: "artifact",
							digest: runtimeDigest(Buffer.from(input.bytes).toString("utf8")),
								mediaType: input.mediaType,
								size: input.bytes.byteLength,
							},
						};
					},
				},
			},
			async () => undefined,
			undefined,
			oneToolThenStop(call),
		);

		expect(Buffer.from(stored[0] ?? []).toString("utf8")).toBe("efgh");
		const result = context.messages.find((message) => message.role === "toolResult");
		expect(result).toBeDefined();
		if (result?.role === "toolResult") {
			const text = result.content[0]?.content[0];
			expect(text?.type).toBe("text");
			if (text?.type === "text") {
				expect(text.text).toContain("artifact");
				expect(text.text).not.toContain("tmp/");
				expect(text.text).not.toContain("tool-output-");
			}
		}
	});
});
