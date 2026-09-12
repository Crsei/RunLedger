import { describe, expect, it } from "vitest";
import { messageAssistantText } from "../../../src/tui/interactive/event-helpers.ts";
import type { AssistantAgentMessage } from "../../../src/runtime/types.ts";

describe("interactive assistant event helpers", () => {
	it("uses the assistant error as visible fallback text when the response body is empty", () => {
		const message: AssistantAgentMessage = {
			role: "assistant",
			content: [],
			api: "openai-completions",
			provider: "deepseek",
			model: "deepseek-v4-pro",
			stopReason: "error",
			errorMessage: "model route denied (profile_unknown)",
			timestamp: 1,
		};

		expect(messageAssistantText(message)).toBe("Error: model route denied (profile_unknown)");
	});
});
