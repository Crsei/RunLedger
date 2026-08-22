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
import { SettingsResolver } from "../../src/storage/settings-resolver.ts";

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

async function runToolCase(input: {
	content: string | readonly string[];
	settings: Record<string, unknown>;
	store?: "capture" | "fail";
}): Promise<{ readonly text: string; readonly stored: readonly string[] }> {
	const call: ToolCall = { type: "toolCall", id: "policy-call", name: "overflow", arguments: { value: "x" } };
	const tool: AgentTool<typeof parameters> = {
		name: "overflow",
		label: "overflow",
		description: "fixture",
		parameters,
		execute: async (): Promise<AgentToolResult> => ({
			content: (typeof input.content === "string" ? [input.content] : input.content).map((text) => ({ type: "text", text })),
			details: {},
	}),
	};
	const stored: string[] = [];
	const context: AgentContext = { messages: [], tools: [tool] };
	const runtimeSettings = new SettingsResolver({ user: input.settings }).effectiveRuntimeSnapshot();
	await runAgentLoop(
		[{ role: "user", content: [{ type: "text", text: "run" }] }],
		context,
		{
			model: MODEL,
			runtimeSettings,
			shouldStopAfterTurn: ({ messages }) => messages.some((message) => message.role === "toolResult"),
			toolResultOverflowStore: {
				put: async (value) => {
					if (input.store === "fail") throw new Error("artifact store unavailable");
					stored.push(Buffer.from(value.bytes).toString("utf8"));
					return {
						ref: {
							subjectKind: "artifact",
							digest: runtimeDigest(Buffer.from(value.bytes).toString("utf8")),
							mediaType: value.mediaType,
							size: value.bytes.byteLength,
						},
					};
				},
			},
		},
		async () => undefined,
		undefined,
		oneToolThenStop(call),
	);
	const result = context.messages.find((message) => message.role === "toolResult");
	if (result?.role !== "toolResult") throw new Error("tool result missing");
	return {
		text: result.content
			.flatMap((block) => block.content)
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join(""),
		stored,
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

	it("applies the effective artifact spill threshold from the runtime snapshot", async () => {
		const result = await runToolCase({
			content: "abcdefgh",
			settings: { tools: { artifactSpillThreshold: 4 } },
		});

		expect(result.stored).toEqual(["efgh"]);
		expect(result.text).toContain("exceeds 4");
	});

	it("keeps configured head and tail windows while storing the omitted middle", async () => {
		const result = await runToolCase({
			content: "abcdefghijkl",
			settings: {
				tools: {
					artifactSpillThreshold: 8,
					artifactHeadBytes: 2,
					artifactTailBytes: 2,
				},
			},
		});

		expect(result.stored).toEqual(["cdefghij"]);
		expect(result.text).toContain("ab");
		expect(result.text).toContain("kl");
	});

	it("keeps the configured tail lines and applies the per-line column cap", async () => {
		const tailLines = await runToolCase({
			content: "a\nb\nc\nd",
			settings: { tools: { artifactSpillThreshold: 4, artifactTailLines: 2 } },
		});
		expect(tailLines.stored).toEqual(["a\nb\n"]);
		expect(tailLines.text).toContain("c\nd");

		const columns = await runToolCase({
			content: "123456789\nok",
			settings: { tools: { outputMaxColumns: 4 } },
		});
		expect(columns.stored).toEqual(["56789"]);
		expect(columns.text).toContain("1234…");
		expect(columns.text).toContain("ok");
	});

	it("fails closed to inline truncation when artifact persistence is unavailable", async () => {
		const result = await runToolCase({
			content: "abcdefgh",
			settings: { tools: { artifactSpillThreshold: 4 } },
			store: "fail",
		});

		expect(result.text).toContain("truncated");
		expect(result.text).not.toContain("artifact ");
		expect(result.text).not.toContain("tmp/");
	});

	it("uses UTF-8 bytes for spill thresholds and distinguishes column-only truncation", async () => {
		const utf8 = await runToolCase({
			content: "你好世界",
			settings: { tools: { artifactSpillThreshold: 6 } },
		});
		expect(utf8.stored).toEqual(["世界"]);
		expect(utf8.text).toContain("你好");
		expect(utf8.text).toContain("exceeds 6");

		const columns = await runToolCase({
			content: "123456789\nok",
			settings: { tools: { outputMaxColumns: 4 } },
		});
		expect(columns.text).toContain("lines were truncated to 4 columns");
		expect(columns.text).not.toContain("Output exceeds");
	});

	it("keeps later text blocks when only the column width is truncated", async () => {
		const result = await runToolCase({
			content: ["123456789", "later text block"],
			settings: { tools: { outputMaxColumns: 4 } },
		});

		expect(result.text).toContain("1234…");
		expect(result.text).toContain("late…");
		expect(result.stored).toEqual(["56789", "r text block"]);
	});

	it("redacts credential-like text in inline output and governed overflow", async () => {
		const inline = await runToolCase({
			content: "password=hunter2 Authorization: Bearer inline-secret",
			settings: { tools: { artifactSpillThreshold: 256 } },
		});
		expect(inline.text).not.toContain("hunter2");
		expect(inline.text).not.toContain("inline-secret");

		const overflow = await runToolCase({
			content: "visible\npassword=hunter2\nAuthorization: Bearer overflow-secret",
			settings: { tools: { artifactSpillThreshold: 8 } },
		});
		expect(overflow.text).not.toContain("hunter2");
		expect(overflow.text).not.toContain("overflow-secret");
		expect(overflow.stored.join("\n")).not.toContain("hunter2");
		expect(overflow.stored.join("\n")).not.toContain("overflow-secret");
	});
});
