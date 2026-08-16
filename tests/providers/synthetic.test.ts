import { afterEach, describe, expect, test, vi } from "vitest";
import { MODELS } from "../../src/models.generated.ts";
import { InMemoryModelsStore, type ProviderModelsStore } from "../../src/models-store.ts";
import { syntheticProvider } from "../../src/providers/synthetic.ts";

const SYNTHETIC_BASE_URL = "https://api.synthetic.new/openai/v1";

afterEach(() => {
	vi.restoreAllMocks();
});

function scopedStore(store: InMemoryModelsStore): ProviderModelsStore {
	return {
		read: () => store.read("synthetic"),
		write: (entry) => store.write("synthetic", entry),
		delete: () => store.delete("synthetic"),
	};
}

function modelsResponse(data: readonly Record<string, unknown>[]): Response {
	return new Response(JSON.stringify({ object: "list", data }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("synthetic provider", () => {
	test("exposes the bundled OpenAI-compatible catalog and env-key auth", () => {
		const provider = syntheticProvider();
		const model = provider.getModels().find((entry) => entry.id === "hf:Qwen/Qwen3.6-27B");

		expect(provider.id).toBe("synthetic");
		expect(provider.name).toBe("Synthetic");
		expect(provider.baseUrl).toBe(SYNTHETIC_BASE_URL);
		expect(model).toMatchObject({
			api: "openai-completions",
			provider: "synthetic",
			baseUrl: SYNTHETIC_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
		});
	});

	test("is present in the builtin generated model catalog", () => {
		const catalog = MODELS["synthetic"] as Record<string, { provider?: string; api?: string }> | undefined;
		expect(catalog?.["hf:Qwen/Qwen3.6-27B"]).toMatchObject({
			provider: "synthetic",
			api: "openai-completions",
		});
	});

	test("resolves the env-key auth and reports unconfigured without a key", async () => {
		const provider = syntheticProvider();
		const auth = await provider.auth.apiKey?.resolve({
			ctx: {
				env: async (name) => (name === "SYNTHETIC_API_KEY" ? "syn-key" : undefined),
				fileExists: async () => false,
			},
			credential: undefined,
		});
		expect(auth).toEqual({ auth: { apiKey: "syn-key" }, source: "SYNTHETIC_API_KEY" });

		const unconfigured = await provider.auth.apiKey?.resolve({
			ctx: {
				env: async () => undefined,
				fileExists: async () => false,
			},
			credential: undefined,
		});
		expect(unconfigured).toBeUndefined();
	});

	test("maps supported_features, input_modalities, max_output_length and $-prefixed pricing", async () => {
		const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return modelsResponse([
				{
					id: "syn:large:vision",
					name: "Large Vision Router",
					context_length: 262144,
					supported_features: ["reasoning", "tools"],
					input_modalities: ["text", "image"],
					max_output_length: 32768,
					reasoning_parameters: { efforts: ["none", "low", "high"] },
					pricing: {
						prompt: "$0.000001",
						completion: "$0.000004",
						input_cache_reads: "$0.0000001",
						input_cache_writes: "0",
					},
				},
			]);
		};
		const provider = syntheticProvider({ fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("synthetic provider must support model discovery");

		await refresh({
			credential: { type: "api_key", key: "syn-key" },
			store: scopedStore(new InMemoryModelsStore()),
			allowNetwork: true,
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(`${SYNTHETIC_BASE_URL}/models`);
		expect(calls[0]?.init?.headers).toMatchObject({
			Accept: "application/json",
			Authorization: "Bearer syn-key",
		});

		expect(provider.getModels().find((entry) => entry.id === "syn:large:vision")).toMatchObject({
			name: "Large Vision Router",
			provider: "synthetic",
			baseUrl: SYNTHETIC_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 262144,
			maxTokens: 32768,
			cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 0 },
			thinkingLevelMap: { minimal: "none", low: "low", high: "high" },
		});
	});

	test("treats a none-only effort vocabulary as non-reasoning and falls back to the reference when silent", async () => {
		const fetchImpl: typeof fetch = async () =>
			modelsResponse([
				// 仅 none 档位:纯 off 开关,不点亮 reasoning。
				{ id: "syn:small:text", reasoning_parameters: { efforts: ["none"] } },
				// wire 静默:参考模型投票(reasoning/vision)。
				{ id: "hf:Qwen/Qwen3.6-27B" },
			]);
		const provider = syntheticProvider({ fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("synthetic provider must support model discovery");

		await refresh({
			credential: { type: "api_key", key: "syn-key" },
			store: scopedStore(new InMemoryModelsStore()),
			allowNetwork: true,
		});

		const noneEffort = provider.getModels().find((entry) => entry.id === "syn:small:text");
		expect(noneEffort).toMatchObject({ reasoning: false, input: ["text"] });
		expect(noneEffort?.thinkingLevelMap).toEqual({ minimal: "none" });

		const silent = provider.getModels().find((entry) => entry.id === "hf:Qwen/Qwen3.6-27B");
		expect(silent).toMatchObject({ reasoning: true, input: ["text", "image"] });
	});

	test("is gated: discovery without a credential throws", async () => {
		const provider = syntheticProvider({ fetch: async () => modelsResponse([]) });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("synthetic provider must support model discovery");

		await expect(
			refresh({ store: scopedStore(new InMemoryModelsStore()), allowNetwork: true }),
		).rejects.toThrow("Synthetic API key is not configured");
	});

	test("rejects an empty catalog and keeps the last known good models", async () => {
		let response = modelsResponse([{ id: "syn:large:text" }]);
		const fetchImpl: typeof fetch = async () => response;
		const provider = syntheticProvider({ fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("synthetic provider must support model discovery");
		const store = scopedStore(new InMemoryModelsStore());
		const context = {
			credential: { type: "api_key" as const, key: "syn-key" },
			store,
			allowNetwork: true,
		};

		await refresh(context);
		expect(provider.getModels().some((entry) => entry.id === "syn:large:text")).toBe(true);

		response = modelsResponse([]);
		await expect(refresh(context)).rejects.toThrow("empty model catalog");
		expect(provider.getModels().some((entry) => entry.id === "syn:large:text")).toBe(true);
	});

	test("uses the existing OpenAI completions stream with synthetic model identity", async () => {
		const modelId = "syn:large:vision";
		const responseBody = [
			`data: ${JSON.stringify({
				id: "chatcmpl-synthetic-test",
				object: "chat.completion.chunk",
				created: 1,
				model: modelId,
				choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }],
			})}`,
			`data: ${JSON.stringify({
				id: "chatcmpl-synthetic-test",
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
		const provider = syntheticProvider();
		const model = provider.getModels().find((entry) => entry.id === "hf:zai-org/GLM-5.2");
		if (!model) throw new Error("synthetic bundled model is missing");

		const result = await provider
			.stream(
				model,
				{ messages: [{ role: "user", content: "say hello", timestamp: 1 }] },
				{ apiKey: "syn-key" },
			)
			.result();
		expect(result).toMatchObject({
			provider: "synthetic",
			model: "hf:zai-org/GLM-5.2",
			stopReason: "stop",
		});
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
		const request = fetchSpy.mock.calls[0];
		expect(request?.[0]).toBe(`${SYNTHETIC_BASE_URL}/chat/completions`);
		expect(request?.[1]?.method).toBe("POST");
	});
});
