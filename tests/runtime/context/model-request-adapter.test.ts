import { describe, expect, it } from "vitest";
import { mockModel } from "../../../src/runtime/providers/mock-stream.ts";
import { defaultConvertToLlm } from "../../../src/runtime/agent-loop.ts";
import { assembleAgentModelContext } from "../../../src/runtime/context/model-request-adapter.ts";
import type { AgentMessage, LlmContext } from "../../../src/runtime/types.ts";

function user(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }] };
}

function assistant(text: string): AgentMessage {
	return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };
}

describe("Host model request context adapter", () => {
	it("sends only the ContextEngine projection and returns a bounded receipt", async () => {
		const messages = [user("first"), user("second")];
		const context: LlmContext = {
			systemPrompt: "immutable system policy",
			messages: await defaultConvertToLlm(messages),
			tools: [],
		};

		const assembled = assembleAgentModelContext({
			model: mockModel,
			context,
			turn: 1,
			sessionId: "session-adapter-test",
		});

		expect(assembled.context.systemPrompt).toBe(context.systemPrompt);
		expect(assembled.context.messages).toEqual(context.messages);
		expect(assembled.receipt.fragmentIds.length).toBeGreaterThan(0);
		expect(assembled.receipt.estimatedInputTokens).toBeGreaterThan(0);
		expect(assembled.receipt.reservedOutputTokens).toBe(mockModel.maxTokens);
		expect(assembled.receipt.diagnostics).toEqual([]);
	});

	it("makes the receipt digest independent of provider-added message timestamps", async () => {
		const messages = [user("same input")];
		const first = assembleAgentModelContext({
			model: mockModel,
			context: { systemPrompt: "system", messages: await defaultConvertToLlm(messages), tools: [] },
			turn: 1,
			sessionId: "session-adapter-test",
		});
		await new Promise((resolve) => setTimeout(resolve, 2));
		const second = assembleAgentModelContext({
			model: mockModel,
			context: { systemPrompt: "system", messages: await defaultConvertToLlm(messages), tools: [] },
			turn: 1,
			sessionId: "session-adapter-test",
		});

		expect(first.receipt.contextDigest).toEqual(second.receipt.contextDigest);
		expect(first.receipt.projectionDigest).toEqual(second.receipt.projectionDigest);
	});

	it("uses a distinct request identity when a later prompt changes the projected context", async () => {
		const first = assembleAgentModelContext({
			model: mockModel,
			context: { systemPrompt: "system", messages: await defaultConvertToLlm([user("first")]), tools: [] },
			turn: 1,
			sessionId: "session-adapter-multiple-prompts",
		});
		const second = assembleAgentModelContext({
			model: mockModel,
			context: { systemPrompt: "system", messages: await defaultConvertToLlm([user("first"), assistant("reply"), user("second")]), tools: [] },
			turn: 1,
			sessionId: "session-adapter-multiple-prompts",
		});

		expect(second.receipt.requestId).not.toBe(first.receipt.requestId);
	});

	it("overlays Host domain sources (Plan Mode / approved memory) into the same projection", async () => {
		const context: LlmContext = {
			systemPrompt: "system",
			messages: await defaultConvertToLlm([user("hello")]),
			tools: [],
		};
		const assembled = assembleAgentModelContext({
			model: mockModel,
			context,
			turn: 1,
			sessionId: "session-adapter-test",
			sources: [
				{
					fragmentId: "plan-mode-3",
					key: "plan-mode",
					layer: "mode",
					content: "plan mode: active\nrevision: 3",
					trust: "trusted",
					priority: "required",
				},
				{
					fragmentId: "memory-abc",
					key: "memory-abc",
					layer: "memory",
					content: "[workspace memory-abc] release process",
					trust: "trusted",
					taint: "external",
					priority: "optional",
				},
			],
		});

		expect(assembled.receipt.fragmentIds).toContain("plan-mode-3");
		expect(assembled.receipt.fragmentIds).toContain("memory-abc");
		expect(assembled.context.systemPrompt).toBe("system");
		expect(assembled.context.messages).toEqual(context.messages);
		expect(assembled.receipt.diagnostics).toEqual([]);
	});

	it("keeps the assembled projection deterministic when domain sources repeat", async () => {
		const context: LlmContext = {
			systemPrompt: "system",
			messages: await defaultConvertToLlm([user("hello")]),
			tools: [],
		};
		const base = {
			model: mockModel,
			context,
			turn: 2,
			sessionId: "session-adapter-test",
			sources: [
				{
					fragmentId: "plan-mode-4",
					key: "plan-mode",
					layer: "mode" as const,
					content: "plan mode: active",
					trust: "trusted" as const,
					priority: "required" as const,
				},
			],
		};
		const first = assembleAgentModelContext(base);
		const second = assembleAgentModelContext(base);
		expect(first.receipt.projectionDigest).toEqual(second.receipt.projectionDigest);
	});
});
