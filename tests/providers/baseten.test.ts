import { afterEach, describe, expect, test, vi } from "vitest";
import { InMemoryModelsStore, type ProviderModelsStore } from "../../src/models-store.ts";
import { basetenProvider } from "../../src/providers/baseten.ts";

const BASETEN_BASE_URL = "https://inference.baseten.co/v1";

afterEach(() => {
	vi.restoreAllMocks();
});

function scopedStore(store: InMemoryModelsStore): ProviderModelsStore {
	return {
		read: () => store.read("baseten"),
		write: (entry) => store.write("baseten", entry),
		delete: () => store.delete("baseten"),
	};
}

function basetenResponse(data: readonly Record<string, unknown>[]): Response {
	return new Response(JSON.stringify({ object: "list", data }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

const refreshContext = {
	credential: { type: "api_key" as const, key: "baseten-test-key" },
	store: scopedStore(new InMemoryModelsStore()),
	allowNetwork: true,
};

describe("Baseten provider", () => {
	test("exposes the bundled OpenAI-compatible catalog, baseUrl normalization, and env-key auth", async () => {
		const provider = basetenProvider();
		const model = provider.getModels().find((entry) => entry.id === "zai-org/GLM-5.2");

		expect(provider.id).toBe("baseten");
		expect(provider.name).toBe("Baseten");
		expect(provider.baseUrl).toBe(BASETEN_BASE_URL);
		expect(model).toMatchObject({
			api: "openai-completions",
			provider: "baseten",
			baseUrl: BASETEN_BASE_URL,
		});
		expect(model?.compat).toBeUndefined();
		// 缺 /v1 时自动补齐
		expect(basetenProvider({ baseUrl: "https://inference.baseten.test" }).baseUrl).toBe(
			"https://inference.baseten.test/v1",
		);

		const auth = await provider.auth.apiKey?.resolve({
			ctx: {
				env: async (name) => (name === "BASETEN_API_KEY" ? "baseten-test-key" : undefined),
				fileExists: async () => false,
			},
		});
		expect(auth).toEqual({ auth: { apiKey: "baseten-test-key" }, source: "BASETEN_API_KEY" });
	});

	test("resolves stored credentials and reports unconfigured state", async () => {
		const provider = basetenProvider();
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
		const provider = basetenProvider();
		const model = provider.getModels().find((entry) => entry.id === "zai-org/GLM-5.2");

		expect(model).toMatchObject({
			id: "zai-org/GLM-5.2",
			name: "GLM 5.2",
			reasoning: true,
			input: ["text"],
			contextWindow: 1048576,
			maxTokens: 262144,
			cost: { input: 1.4, output: 4.4, cacheRead: 0.14, cacheWrite: 0 },
		});
		expect(provider.getModels().some((entry) => entry.id === "deepseek-ai/DeepSeek-V4-Pro")).toBe(true);
	});

	test("maps authenticated model metadata with static reference fallback", async () => {
		const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return basetenResponse([
				{
					id: "zai-org/GLM-5.2",
					name: "GLM 5.2 (live)",
					reasoning: true,
					modalities: { input: ["text", "image"] },
					limit: { context: 1048576, output: 262144 },
					cost: { input: 1.5, output: 4.5, cache_read: 0.15, cache_write: 0 },
				},
				// 未命中静态目录的新模型
				{ id: "unknown/baseten-model", name: "New Model", limit: { context: 65536, output: 16384 } },
				// 命中静态目录但只给 id:回退到静态参考
				{ id: "deepseek-ai/DeepSeek-V4-Flash-0731" },
			]);
		};
		const provider = basetenProvider({ baseUrl: "https://config.baseten.test", fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("Baseten provider must support model discovery");

		await refresh(refreshContext);

		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			url: "https://config.baseten.test/v1/models",
			init: {
				method: "GET",
				headers: { Authorization: "Bearer baseten-test-key", Accept: "application/json" },
			},
		});
		const mapped = provider.getModels().find((entry) => entry.id === "zai-org/GLM-5.2");
		expect(mapped).toMatchObject({
			name: "GLM 5.2 (live)",
			provider: "baseten",
			baseUrl: "https://config.baseten.test/v1",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1048576,
			maxTokens: 262144,
			cost: { input: 1.5, output: 4.5, cacheRead: 0.15, cacheWrite: 0 },
		});
		expect(provider.getModels().find((entry) => entry.id === "unknown/baseten-model")).toMatchObject({
			name: "New Model",
			contextWindow: 65536,
			maxTokens: 16384,
		});
		expect(provider.getModels().find((entry) => entry.id === "deepseek-ai/DeepSeek-V4-Flash-0731")).toMatchObject({
			name: "Deepseek V4 Flash 0731",
			contextWindow: 1048576,
			maxTokens: 1048576,
			cost: { input: 0.13, output: 0.26, cacheRead: 0.028, cacheWrite: 0 },
		});
	});

	test("rejects an empty catalog and keeps the last known good models", async () => {
		let response = basetenResponse([{ id: "baseten/known-good" }]);
		const fetchImpl: typeof fetch = async () => response;
		const provider = basetenProvider({ fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("Baseten provider must support model discovery");

		await refresh(refreshContext);
		expect(provider.getModels().some((entry) => entry.id === "baseten/known-good")).toBe(true);

		response = basetenResponse([]);
		await expect(refresh(refreshContext)).rejects.toThrow("empty model catalog");
		expect(provider.getModels().some((entry) => entry.id === "baseten/known-good")).toBe(true);
	});

	test("rejects missing keys and HTTP errors", async () => {
		const provider = basetenProvider({ fetch: async () => basetenResponse([]) });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("Baseten provider must support model discovery");

		await expect(
			refresh({ credential: undefined, store: scopedStore(new InMemoryModelsStore()), allowNetwork: true }),
		).rejects.toThrow("Baseten API key is not configured");

		const fetchImpl: typeof fetch = async () =>
			new Response("bad request", { status: 400, headers: { "content-type": "text/plain" } });
		const failing = basetenProvider({ fetch: fetchImpl });
		const failingRefresh = failing.refreshModels;
		if (!failingRefresh) throw new Error("Baseten provider must support model discovery");
		await expect(failingRefresh(refreshContext)).rejects.toThrow("Could not load Baseten models: 400: bad request");
	});

	test("uses the existing OpenAI completions stream with Baseten model identity", async () => {
		const modelId = "zai-org/GLM-5.2";
		const responseBody = [
			`data: ${JSON.stringify({
				id: "chatcmpl-baseten-test",
				object: "chat.completion.chunk",
				created: 1,
				model: modelId,
				choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }],
			})}`,
			`data: ${JSON.stringify({
				id: "chatcmpl-baseten-test",
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
		const provider = basetenProvider();
		const model = provider.getModels().find((entry) => entry.id === modelId);
		if (!model) throw new Error("Baseten bundled model is missing");

		const result = await provider
			.stream(
				model,
				{ messages: [{ role: "user", content: "say hello", timestamp: 1 }] },
				{ apiKey: "baseten-test-key" },
			)
			.result();
		expect(result).toMatchObject({
			provider: "baseten",
			model: modelId,
			stopReason: "stop",
		});
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
		const request = fetchSpy.mock.calls[0];
		expect(request?.[0]).toBe(`${BASETEN_BASE_URL}/chat/completions`);
		expect(request?.[1]?.method).toBe("POST");
		const headers = request?.[1]?.headers;
		expect(headers instanceof Headers ? headers.get("authorization") : undefined).toBe("Bearer baseten-test-key");
	});
});
