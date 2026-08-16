import { afterEach, describe, expect, test, vi } from "vitest";
import { InMemoryModelsStore, type ProviderModelsStore } from "../../src/models-store.ts";
import { nanogptProvider } from "../../src/providers/nanogpt.ts";

const NANOGPT_BASE_URL = "https://nano-gpt.com/api/v1";

afterEach(() => {
	vi.restoreAllMocks();
});

function scopedStore(store: InMemoryModelsStore): ProviderModelsStore {
	return {
		read: () => store.read("nanogpt"),
		write: (entry) => store.write("nanogpt", entry),
		delete: () => store.delete("nanogpt"),
	};
}

function nanogptResponse(data: readonly Record<string, unknown>[]): Response {
	return new Response(JSON.stringify({ object: "list", data }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

const refreshContext = {
	credential: { type: "api_key" as const, key: "nanogpt-test-key" },
	store: scopedStore(new InMemoryModelsStore()),
	allowNetwork: true,
};

describe("NanoGPT provider", () => {
	test("exposes the bundled OpenAI-compatible catalog and env-key auth", async () => {
		const provider = nanogptProvider();
		const model = provider.getModels().find((entry) => entry.id === "Alibaba-NLP/Tongyi-DeepResearch-30B-A3B");

		expect(provider.id).toBe("nanogpt");
		expect(provider.name).toBe("NanoGPT");
		expect(provider.baseUrl).toBe(NANOGPT_BASE_URL);
		expect(model).toMatchObject({
			api: "openai-completions",
			provider: "nanogpt",
			baseUrl: NANOGPT_BASE_URL,
		});
		expect(model?.compat).toBeUndefined();
		// 缺 /v1 时自动补齐
		expect(nanogptProvider({ baseUrl: "https://nano-gpt.test" }).baseUrl).toBe("https://nano-gpt.test/v1");

		const auth = await provider.auth.apiKey?.resolve({
			ctx: {
				env: async (name) => (name === "NANO_GPT_API_KEY" ? "nanogpt-test-key" : undefined),
				fileExists: async () => false,
			},
		});
		expect(auth).toEqual({ auth: { apiKey: "nanogpt-test-key" }, source: "NANO_GPT_API_KEY" });
	});

	test("resolves stored credentials and reports unconfigured state", async () => {
		const provider = nanogptProvider();
		const ctx = { env: async () => undefined, fileExists: async () => false };

		const stored = await provider.auth.apiKey?.resolve({
			ctx,
			credential: { type: "api_key", key: "stored-key" },
		});
		expect(stored).toEqual({ auth: { apiKey: "stored-key" }, source: "stored credential" });

		const unconfigured = await provider.auth.apiKey?.resolve({ ctx });
		expect(unconfigured).toBeUndefined();
	});

	test("ships the generated static catalog", () => {
		const provider = nanogptProvider();
		const model = provider.getModels().find((entry) => entry.id === "Alibaba-NLP/Tongyi-DeepResearch-30B-A3B");

		expect(model).toMatchObject({
			id: "Alibaba-NLP/Tongyi-DeepResearch-30B-A3B",
			name: "Alibaba-NLP/Tongyi-DeepResearch-30B-A3B",
			reasoning: false,
			input: ["text"],
			contextWindow: 4096,
			maxTokens: 4096,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		// :thinking 变体仍存在于静态目录
		expect(provider.getModels().some((entry) => entry.id === "anthropic/claude-opus-4.6:thinking")).toBe(true);
	});

	test("maps authenticated model metadata and drops thinking/non-text ids", async () => {
		const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return nanogptResponse([
				{
					id: "deepseek-ai/deepseek-v4-pro",
					name: "DeepSeek V4 Pro (live)",
					reasoning: true,
					modalities: { input: ["text"] },
					limit: { context: 131072, output: 32768 },
					cost: { input: 1, output: 4, cache_read: 0.5, cache_write: 0 },
				},
				{ id: "unknown/nanogpt-model", name: "New Model", limit: { context: 65536, output: 16384 } },
				// :thinking 变体与非文本模型被剔除
				{ id: "unknown-vendor/model-x:thinking" },
				{ id: "unknown-vendor/model-x:thinking:high" },
				{ id: "openai/whisper-1" },
				{ id: "openai/tts-1" },
				{ id: "openai/text-embedding-3-small" },
				{ id: "openai/realtime-1" },
			]);
		};
		const provider = nanogptProvider({ baseUrl: "https://config.nanogpt.test", fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("NanoGPT provider must support model discovery");

		await refresh(refreshContext);

		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			url: "https://config.nanogpt.test/v1/models",
			init: {
				method: "GET",
				headers: { Authorization: "Bearer nanogpt-test-key", Accept: "application/json" },
			},
		});
		expect(provider.getModels().find((entry) => entry.id === "deepseek-ai/deepseek-v4-pro")).toMatchObject({
			name: "DeepSeek V4 Pro (live)",
			provider: "nanogpt",
			baseUrl: "https://config.nanogpt.test/v1",
			reasoning: true,
			input: ["text"],
			contextWindow: 131072,
			maxTokens: 32768,
			cost: { input: 1, output: 4, cacheRead: 0.5, cacheWrite: 0 },
		});
		expect(provider.getModels().find((entry) => entry.id === "unknown/nanogpt-model")).toMatchObject({
			name: "New Model",
			contextWindow: 65536,
			maxTokens: 16384,
		});
		for (const droppedId of [
			"unknown-vendor/model-x:thinking",
			"unknown-vendor/model-x:thinking:high",
			"openai/whisper-1",
			"openai/tts-1",
			"openai/text-embedding-3-small",
			"openai/realtime-1",
		]) {
			expect(provider.getModels().some((entry) => entry.id === droppedId), droppedId).toBe(false);
		}
	});

	test("rejects an empty catalog and keeps the last known good models", async () => {
		let response = nanogptResponse([{ id: "nanogpt/known-good" }]);
		const fetchImpl: typeof fetch = async () => response;
		const provider = nanogptProvider({ fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("NanoGPT provider must support model discovery");

		await refresh(refreshContext);
		expect(provider.getModels().some((entry) => entry.id === "nanogpt/known-good")).toBe(true);

		response = nanogptResponse([]);
		await expect(refresh(refreshContext)).rejects.toThrow("empty model catalog");
		expect(provider.getModels().some((entry) => entry.id === "nanogpt/known-good")).toBe(true);
	});

	test("rejects missing keys and HTTP errors", async () => {
		const provider = nanogptProvider({ fetch: async () => nanogptResponse([]) });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("NanoGPT provider must support model discovery");

		await expect(
			refresh({ credential: undefined, store: scopedStore(new InMemoryModelsStore()), allowNetwork: true }),
		).rejects.toThrow("NanoGPT API key is not configured");

		const fetchImpl: typeof fetch = async () =>
			new Response("unauthorized", { status: 401, headers: { "content-type": "text/plain" } });
		const failing = nanogptProvider({ fetch: fetchImpl });
		const failingRefresh = failing.refreshModels;
		if (!failingRefresh) throw new Error("NanoGPT provider must support model discovery");
		await expect(failingRefresh(refreshContext)).rejects.toThrow(
			"Could not load NanoGPT models: 401: unauthorized",
		);
	});

	test("uses the existing OpenAI completions stream with NanoGPT model identity", async () => {
		const modelId = "Alibaba-NLP/Tongyi-DeepResearch-30B-A3B";
		const responseBody = [
			`data: ${JSON.stringify({
				id: "chatcmpl-nanogpt-test",
				object: "chat.completion.chunk",
				created: 1,
				model: modelId,
				choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }],
			})}`,
			`data: ${JSON.stringify({
				id: "chatcmpl-nanogpt-test",
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
		const provider = nanogptProvider();
		const model = provider.getModels().find((entry) => entry.id === modelId);
		if (!model) throw new Error("NanoGPT bundled model is missing");

		const result = await provider
			.stream(
				model,
				{ messages: [{ role: "user", content: "say hello", timestamp: 1 }] },
				{ apiKey: "nanogpt-test-key" },
			)
			.result();
		expect(result).toMatchObject({
			provider: "nanogpt",
			model: modelId,
			stopReason: "stop",
		});
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
		const request = fetchSpy.mock.calls[0];
		expect(request?.[0]).toBe(`${NANOGPT_BASE_URL}/chat/completions`);
		expect(request?.[1]?.method).toBe("POST");
		const headers = request?.[1]?.headers;
		expect(headers instanceof Headers ? headers.get("authorization") : undefined).toBe("Bearer nanogpt-test-key");
	});
});
