import { describe, expect, it } from "vitest";
import { transformMessages } from "../../src/api/transform-messages.ts";
import type { Api, AssistantMessage, Message, Model } from "../../src/types.ts";

const model: Model<Api> = {
	id: "model",
	name: "Fixture",
	api: "openai-completions",
	provider: "fixture",
	baseUrl: "http://localhost",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8_192,
	maxTokens: 1_024,
};

const usage: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("transformMessages failed-turn boundary", () => {
	it("replaces a failed assistant response with a safe separator before the next user turn", () => {
		const messages: Message[] = [
			{ role: "user", content: [{ type: "text", text: "old request" }], timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "text", text: "partial secret response" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage,
				stopReason: "error",
				errorMessage: "upstream secret detail",
				timestamp: 2,
			},
			{ role: "user", content: [{ type: "text", text: "latest request" }], timestamp: 3 },
		];

		const transformed = transformMessages(messages, model);

		expect(transformed.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
		expect(transformed[1]).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "[Previous assistant response failed before completion.]" }],
			stopReason: "stop",
		});
		expect(JSON.stringify(transformed)).not.toContain("partial secret response");
		expect(JSON.stringify(transformed)).not.toContain("upstream secret detail");
	});
});
