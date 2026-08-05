import { describe, expect, it } from "vitest";
import { mockModel } from "../../../src/runtime/providers/mock-stream.ts";
import { defaultConvertToLlm } from "../../../src/runtime/agent-loop.ts";
import { assembleAgentModelContext } from "../../../src/runtime/context/model-request-adapter.ts";
import type { AgentMessage, LlmContext } from "../../../src/runtime/types.ts";

function user(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }] };
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
});
