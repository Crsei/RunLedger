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
import { applyToolResultBudget } from "../../src/runtime/agent-loop/tool-call-finalization.ts";
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
			if (message.stopReason === "error" || message.stopReason === "aborted") throw new Error("expected successful fixture message");
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

		expect(Buffer.from(stored[0] ?? []).toString("utf8")).toBe("abcdefgh");
		const result = context.messages.find((message) => message.role === "toolResult");
		expect(result).toBeDefined();
		if (result?.role === "toolResult") {
			const text = result.content[0]?.content.filter((block) => block.type === "text").map((block) => block.text).join("") ?? "";
			expect(text.length).toBeLessThanOrEqual(4);
			expect(text).toContain("…");
			expect(text).not.toContain("tmp/");
			expect(text).not.toContain("tool-output-");
		}
	});
});


describe("Plan 14 complete output budgeting", () => {
  it("preserves the tail across text blocks without a store", async () => {
    const output = await applyToolResultBudget([
      { type: "text", text: "START" + "a".repeat(500) },
      { type: "text", text: "b".repeat(500) + "FINAL_TEST_FAILURE" },
    ], 160, "tail");
    const text = output.filter((block) => block.type === "text").map((block) => block.text).join("");
    expect(text.length).toBeLessThanOrEqual(160);
    expect(text).toContain("START");
    expect(text).toContain("FINAL_TEST_FAILURE");
    expect(text).toContain("omitted");
    expect(text).not.toContain("available through");
  });

  it("stores all original text and retains images in their original sequence", async () => {
    const stored: string[] = [];
    const image = { type: "image" as const, mimeType: "image/png", data: "fixture" };
    const output = await applyToolResultBudget([
      { type: "text", text: "A".repeat(400) }, image,
      { type: "text", text: "TAIL_FAILURE" },
    ], 250, "store", { put: async (input) => {
      stored.push(new TextDecoder().decode(input.bytes));
      return { ref: { subjectKind: "artifact", digest: runtimeDigest(stored[0]), size: input.bytes.length } };
    } });
    expect(stored).toEqual(["A".repeat(400) + "TAIL_FAILURE"]);
    expect(output.filter((block) => block.type === "image")).toEqual([image]);
    expect(output.at(-1)).toMatchObject({ type: "text", text: expect.stringContaining("TAIL_FAILURE") });
    expect(output.filter((block) => block.type === "text").map((block) => block.text).join("").length).toBeLessThanOrEqual(250);
  });

  it.each([0, 1, 4, 12, 64, 160])("bounds metadata and preserves Unicode at budget %i even when storage fails", async (limit) => {
    const output = await applyToolResultBudget([{ type: "text", text: "中文😀".repeat(200) }], limit, "unicode", {
      put: async () => { throw new Error("fixture unavailable"); },
    });
    const text = output.filter((block) => block.type === "text").map((block) => block.text).join("");
    expect(text.length).toBeLessThanOrEqual(limit);
    expect(text).toBe(new TextDecoder().decode(new TextEncoder().encode(text)));
    expect(text).not.toContain("artifact");
  });

  it("bounds the final hook result while preserving its error state", async () => {
    const call: ToolCall = { type: "toolCall", id: "hook-call", name: "hook", arguments: { value: "x" } };
    const context: AgentContext = { messages: [], tools: [{
      name: "hook", label: "hook", description: "fixture", parameters, maxResultSizeChars: 160,
      execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
    }] };
    await runAgentLoop([{ role: "user", content: [{ type: "text", text: "run" }] }], context, {
      model: MODEL,
      afterToolCall: async () => ({ content: [{ type: "text", text: "x".repeat(1000) + "HOOK_FAILURE" }], isError: true }),
    }, async () => undefined, undefined, oneToolThenStop(call));
    const result = context.messages.flatMap((message) => message.role === "toolResult" ? message.content : [])[0];
    expect(result?.isError).toBe(true);
    const text = result?.content.filter((block) => block.type === "text").map((block) => block.text).join("") ?? "";
    expect(text.length).toBeLessThanOrEqual(160);
    expect(text).toContain("HOOK_FAILURE");
  });
});
