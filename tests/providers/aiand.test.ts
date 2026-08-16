import { afterEach, describe, expect, test, vi } from "vitest";
import { InMemoryModelsStore, type ProviderModelsStore } from "../../src/models-store.ts";
import { aiandProvider } from "../../src/providers/aiand.ts";
import { builtinModels, builtinProviders } from "../../src/providers/all.ts";

const AIAND_API_VERSION = ["v", "1"].join("");

afterEach(() => {
	vi.restoreAllMocks();
});

function scopedStore(store: InMemoryModelsStore): ProviderModelsStore {
	return {
		read: () => store.read("aiand"),
		write: (entry) => store.write("aiand", entry),
		delete: () => store.delete("aiand"),
	};
}

function aiandResponse(data: readonly Record<string, unknown>[]): Response {
	return new Response(JSON.stringify({ object: "list", data }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("ai& provider", () => {
	test("exposes the bundled OpenAI-compatible catalog and env-key auth", async () => {
		const provider = aiandProvider();
		const model = provider.getModels().find((entry) => entry.id === "moonshotai/kimi-k2.7-code");

		expect(provider.id).toBe("aiand");
		expect(provider.name).toBe("ai&");
		expect(model).toMatchObject({
			api: "openai-completions",
			provider: "aiand",
			baseUrl: `https://api.aiand.com/${AIAND_API_VERSION}`,
			reasoning: true,
		});
		expect(model?.compat?.requiresReasoningContentOnAssistantMessages).toBeUndefined();

		const auth = await provider.auth.apiKey?.resolve({
			ctx: {
				env: async (name) => (name === "AIAND_API_KEY" ? "aiand-test-key" : undefined),
				fileExists: async () => false,
			},
		});
		expect(auth).toEqual({ auth: { apiKey: "aiand-test-key" }, source: "AIAND_API_KEY" });
	});

	test("does not apply direct DeepSeek compatibility to ai& DeepSeek models", () => {
		const provider = aiandProvider();

		for (const modelId of ["deepseek-ai/deepseek-v4-flash", "deepseek-ai/deepseek-v4-pro"]) {
			const model = provider.getModels().find((entry) => entry.id === modelId);
			expect(model, modelId).toBeDefined();
			expect(model?.compat, modelId).toBeUndefined();
		}
	});

	test("is present in the builtin provider and model collections", () => {
		expect(builtinProviders().find((provider) => provider.id === "aiand")?.name).toBe("ai&");
		expect(builtinModels().getModel("aiand", "moonshotai/kimi-k2.7-code")).toMatchObject({
		provider: "aiand",
		api: "openai-completions",
	});
	});

	test("maps authenticated model metadata to a target model", async () => {
		const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return aiandResponse([
				{
					id: "openai/gpt-oss-120b",
					name: "openai/gpt-oss-120b",
					description: "GPT OSS 120B from ai&",
					context_window: 131072,
					capabilities: ["reasoning", "tool_calling", "vision"],
					reasoning_efforts: ["low", "medium", "high"],
					reasoning_effort_default: "medium",
					currency: "usd",
					input_per_1m: "0.150000",
					output_per_1m: "0.600000",
				},
			]);
		};
		const provider = aiandProvider({ baseUrl: "https://config.aiand.test", fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("ai& provider must support model discovery");

		await refresh({
			credential: { type: "api_key", key: "aiand-test-key" },
			store: scopedStore(new InMemoryModelsStore()),
			allowNetwork: true,
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			url: `https://config.aiand.test/${AIAND_API_VERSION}/models`,
			init: {
				method: "GET",
				headers: { Authorization: "Bearer aiand-test-key", Accept: "application/json" },
			},
		});
		expect(provider.getModels().find((entry) => entry.id === "openai/gpt-oss-120b")).toMatchObject({
			name: "GPT OSS 120B from ai&",
			provider: "aiand",
			baseUrl: `https://config.aiand.test/${AIAND_API_VERSION}`,
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 131072,
			cost: { input: 0.15, output: 0.6, cacheRead: 0, cacheWrite: 0 },
			thinkingLevelMap: {
				minimal: null,
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: null,
				max: null,
			},
		});
		expect(provider.getModels().find((entry) => entry.id === "openai/gpt-oss-120b")?.compat).toBeUndefined();
	});

	test("rejects an empty catalog and keeps the last known good models", async () => {
		let response = aiandResponse([{ id: "aiand/known-good", capabilities: ["tool_calling"] }]);
		const fetchImpl: typeof fetch = async () => response;
		const provider = aiandProvider({ fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("ai& provider must support model discovery");
		const store = scopedStore(new InMemoryModelsStore());
		const context = {
			credential: { type: "api_key" as const, key: "aiand-test-key" },
			store,
			allowNetwork: true,
		};

		await refresh(context);
		expect(provider.getModels().some((entry) => entry.id === "aiand/known-good")).toBe(true);

		response = aiandResponse([]);
		await expect(refresh(context)).rejects.toThrow("empty model catalog");
		expect(provider.getModels().some((entry) => entry.id === "aiand/known-good")).toBe(true);
	});

	test("uses the existing OpenAI completions stream with ai& model identity", async () => {
		const modelId = "moonshotai/kimi-k2.7-code";
		const responseBody = [
			`data: ${JSON.stringify({
				id: "chatcmpl-aiand-test",
				object: "chat.completion.chunk",
				created: 1,
				model: modelId,
				choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }],
			})}`,
			`data: ${JSON.stringify({
				id: "chatcmpl-aiand-test",
				object: "chat.completion.chunk",
				created: 1,
				model: modelId,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			})}`,
			"data: [DONE]",
		].join("\n\n");
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(responseBody, { status: 200, headers: { "content-type": "text/event-stream" } }),
		);
		const provider = aiandProvider();
		const model = provider.getModels().find((entry) => entry.id === modelId);
		if (!model) throw new Error("ai& bundled model is missing");

		const result = await provider
			.stream(
				model,
				{ messages: [{ role: "user", content: "say hello", timestamp: 1 }] },
				{ apiKey: "aiand-test-key" },
			)
			.result();
		expect(result).toMatchObject({
			provider: "aiand",
			model: modelId,
			stopReason: "stop",
		});
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
		const request = fetchSpy.mock.calls[0];
		expect(request?.[0]).toBe(`https://api.aiand.com/${AIAND_API_VERSION}/chat/completions`);
		expect(request?.[1]?.method).toBe("POST");
		const headers = request?.[1]?.headers;
		expect(headers instanceof Headers ? headers.get("authorization") : undefined).toBe("Bearer aiand-test-key");
	});
});
