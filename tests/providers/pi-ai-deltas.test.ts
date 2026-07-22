import { describe, expect, it } from "vitest";
import { convertMessages } from "../../src/api/openai-completions.ts";
import { envApiKeyAuth } from "../../src/auth/helpers.ts";
import { InMemoryModelsStore } from "../../src/models-store.ts";
import { amazonBedrockProvider } from "../../src/providers/amazon-bedrock.ts";
import type {
	AssistantMessage,
	Context,
	Model,
	ToolResultMessage,
	Usage,
} from "../../src/types.ts";
import { isContextOverflow } from "../../src/utils/overflow.ts";

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const MODEL: Model<"openai-completions"> = {
	id: "fixture-model",
	name: "Fixture Model",
	api: "openai-completions",
	provider: "openrouter",
	baseUrl: "https://openrouter.ai/api/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4_096,
};

const COMPAT: Parameters<typeof convertMessages>[2] = {
	supportsStore: false,
	supportsDeveloperRole: true,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresReasoningContentOnAssistantMessages: false,
	thinkingFormat: "openai",
	chatTemplateKwargs: {},
	openRouterRouting: {},
	vercelGatewayRouting: {},
	zaiToolStream: false,
	supportsStrictMode: true,
	sendSessionAffinityHeaders: false,
	sessionAffinityFormat: "openrouter",
	supportsLongCacheRetention: true,
};

function assistantWithToolCalls(ids: readonly string[]): AssistantMessage {
	return {
		role: "assistant",
		content: ids.map((id, index) => ({
			type: "toolCall" as const,
			id,
			name: `tool_${index}`,
			arguments: { index },
		})),
		api: "openai-responses",
		provider: "openai-codex",
		model: "fixture-source",
		usage: ZERO_USAGE,
		stopReason: "toolUse",
		timestamp: 1,
	};
}

function toolResults(ids: readonly string[]): ToolResultMessage[] {
	return ids.map((toolCallId, index) => ({
		role: "toolResult",
		toolCallId,
		toolName: `tool_${index}`,
		content: [{ type: "text", text: `result-${index}` }],
		isError: false,
		timestamp: index + 2,
	}));
}

function convertedToolIds(ids: readonly string[]): { calls: string[]; results: string[] } {
	const context: Context = {
		messages: [assistantWithToolCalls(ids), ...toolResults(ids)],
	};
	const converted = convertMessages(MODEL, context, COMPAT);
	const assistant = converted.find((message) => message.role === "assistant");
	if (!assistant || assistant.role !== "assistant") throw new Error("missing assistant fixture");
	const calls = assistant.tool_calls?.map((call) => call.id) ?? [];
	const results = converted
		.filter((message) => message.role === "tool")
		.map((message) => message.tool_call_id);
	return { calls, results };
}

function errorMessage(errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "qwen-token-plan",
		model: "fixture",
		usage: ZERO_USAGE,
		stopReason: "error",
		errorMessage,
		timestamp: 1,
	};
}

describe("pi-ai bounded delta adoption", () => {
	it("preserves item identity when one Responses call id has multiple items", () => {
		const ids = ["call_shared|item/one", "call_shared|item+two"];
		const normalized = convertedToolIds(ids);

		expect(normalized.calls).toEqual(["call_shared_item_one", "call_shared_item_two"]);
		expect(normalized.results).toEqual(normalized.calls);
		expect(new Set(normalized.calls).size).toBe(normalized.calls.length);
	});

	it("hashes long Responses ids without collisions and stays inside the 40-character limit", () => {
		const ids = [`call_shared|${"x".repeat(80)}A`, `call_shared|${"x".repeat(80)}B`];
		const normalized = convertedToolIds(ids);

		expect(normalized.calls).toHaveLength(2);
		expect(normalized.calls[0]).not.toBe(normalized.calls[1]);
		expect(normalized.calls.every((id) => id.length <= 40)).toBe(true);
		expect(normalized.results).toEqual(normalized.calls);
	});

	it("round-trips tool execution usage without adding it to provider context accounting", () => {
		const message: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call-usage",
			toolName: "remote_executor",
			content: [{ type: "text", text: "done" }],
			usage: {
				...ZERO_USAGE,
				input: 7,
				output: 11,
				totalTokens: 18,
				cost: { ...ZERO_USAGE.cost, total: 0.02 },
			},
			isError: false,
			timestamp: 1,
		};
		const restored = JSON.parse(JSON.stringify(message)) as ToolResultMessage;

		expect(restored.usage).toEqual(message.usage);
		const [providerMessage] = convertMessages(MODEL, { messages: [restored] }, COMPAT);
		expect(providerMessage).toEqual({ role: "tool", content: "done", tool_call_id: "call-usage" });
		expect(providerMessage).not.toHaveProperty("usage");
	});

	it("propagates stored provider env without leaking secret values into the source label", async () => {
		const ctx = {
			env: async (_name: string) => undefined,
			fileExists: async (_path: string) => false,
		};
		const credential = {
			type: "api_key" as const,
			key: "stored-secret",
			env: { AWS_PROFILE: "audit-profile", CUSTOM_ENDPOINT: "internal.example" },
		};

		const generic = await envApiKeyAuth("Fixture key", ["FIXTURE_API_KEY"]).resolve({ ctx, credential });
		const bedrock = await amazonBedrockProvider().auth.apiKey?.resolve({ ctx, credential });

		expect(generic).toEqual({
			auth: { apiKey: "stored-secret" },
			env: credential.env,
			source: "stored credential",
		});
		expect(bedrock).toEqual({
			auth: { apiKey: "stored-secret" },
			env: credential.env,
			source: "stored credential",
		});
		expect(generic?.source).not.toContain(credential.key);
		expect(bedrock?.source).not.toContain(credential.key);
	});

	it("round-trips model catalog Last-Modified metadata through the scoped store", async () => {
		const store = new InMemoryModelsStore();
		await store.write("fixture", { models: [MODEL], lastModified: 1_721_600_000, checkedAt: 1_721_600_100 });

		const restored = await store.read("fixture");
		expect(restored?.lastModified).toBe(1_721_600_000);
		expect(restored?.checkedAt).toBe(1_721_600_100);
		expect(restored?.models).toEqual([MODEL]);
	});

	it("detects DashScope input-range overflow while retaining rate-limit exclusion", () => {
		expect(
			isContextOverflow(
				errorMessage("400 invalid_parameter_error: Range of input length should be [1, 131072]"),
			),
		).toBe(true);
		expect(
			isContextOverflow(
				errorMessage("Rate limit exceeded: Range of input length should be [1, 131072]; retry later"),
			),
		).toBe(false);
	});
});
