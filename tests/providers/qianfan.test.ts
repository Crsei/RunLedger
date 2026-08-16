import { afterEach, describe, expect, test, vi } from "vitest";
import { InMemoryModelsStore, type ProviderModelsStore } from "../../src/models-store.ts";
import { qianfanProvider } from "../../src/providers/qianfan.ts";

const QIANFAN_BASE_URL = "https://qianfan.baidubce.com/v2";

afterEach(() => {
	vi.restoreAllMocks();
});

function scopedStore(store: InMemoryModelsStore): ProviderModelsStore {
	return {
		read: () => store.read("qianfan"),
		write: (entry) => store.write("qianfan", entry),
		delete: () => store.delete("qianfan"),
	};
}

function qianfanResponse(data: readonly Record<string, unknown>[]): Response {
	return new Response(JSON.stringify({ object: "list", data }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

const refreshContext = {
	credential: { type: "api_key" as const, key: "qianfan-test-key" },
	store: scopedStore(new InMemoryModelsStore()),
	allowNetwork: true,
};

describe("Qianfan provider", () => {
	test("exposes the bundled OpenAI-compatible catalog, v2 baseUrl, and env-key auth", async () => {
		const provider = qianfanProvider();
		const model = provider.getModels().find((entry) => entry.id === "deepseek-v3.2");

		expect(provider.id).toBe("qianfan");
		expect(provider.name).toBe("Qianfan");
		expect(provider.baseUrl).toBe(QIANFAN_BASE_URL);
		expect(model).toMatchObject({
			api: "openai-completions",
			provider: "qianfan",
			baseUrl: QIANFAN_BASE_URL,
		});
		expect(model?.compat).toBeUndefined();
		// 缺 /v2 时自动补齐
		expect(qianfanProvider({ baseUrl: "https://qianfan.baidubce.com" }).baseUrl).toBe(QIANFAN_BASE_URL);

		const auth = await provider.auth.apiKey?.resolve({
			ctx: {
				env: async (name) => (name === "QIANFAN_API_KEY" ? "qianfan-test-key" : undefined),
				fileExists: async () => false,
			},
		});
		expect(auth).toEqual({ auth: { apiKey: "qianfan-test-key" }, source: "QIANFAN_API_KEY" });
	});

	test("resolves stored credentials and reports unconfigured state", async () => {
		const provider = qianfanProvider();
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
		const provider = qianfanProvider();
		const model = provider.getModels().find((entry) => entry.id === "deepseek-v3.2");

		expect(model).toMatchObject({
			id: "deepseek-v3.2",
			name: "DeepSeek V3.2",
			reasoning: true,
			input: ["text"],
			contextWindow: 98304,
			maxTokens: 32768,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
	});

	test("maps authenticated model metadata with static reference fallback", async () => {
		const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return qianfanResponse([
				{
					id: "deepseek-v3.2",
					name: "DeepSeek V3.2 (live)",
					reasoning: true,
					modalities: { input: ["text", "image"] },
					limit: { context: 131072, output: 32768 },
					cost: { input: 1, output: 2, cache_read: 0.5, cache_write: 0 },
				},
				{ id: "unknown/qianfan-model", name: "New Model", limit: { context: 65536, output: 16384 } },
			]);
		};
		const provider = qianfanProvider({ baseUrl: "https://config.qianfan.test", fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("Qianfan provider must support model discovery");

		await refresh(refreshContext);

		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			url: "https://config.qianfan.test/v2/models",
			init: {
				method: "GET",
				headers: { Authorization: "Bearer qianfan-test-key", Accept: "application/json" },
			},
		});
		expect(provider.getModels().find((entry) => entry.id === "deepseek-v3.2")).toMatchObject({
			name: "DeepSeek V3.2 (live)",
			provider: "qianfan",
			baseUrl: "https://config.qianfan.test/v2",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 131072,
			maxTokens: 32768,
			cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
		});
		expect(provider.getModels().find((entry) => entry.id === "unknown/qianfan-model")).toMatchObject({
			name: "New Model",
			contextWindow: 65536,
			maxTokens: 16384,
		});
	});

	test("rejects an empty catalog and keeps the last known good models", async () => {
		let response = qianfanResponse([{ id: "qianfan/known-good" }]);
		const fetchImpl: typeof fetch = async () => response;
		const provider = qianfanProvider({ fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("Qianfan provider must support model discovery");

		await refresh(refreshContext);
		expect(provider.getModels().some((entry) => entry.id === "qianfan/known-good")).toBe(true);

		response = qianfanResponse([]);
		await expect(refresh(refreshContext)).rejects.toThrow("empty model catalog");
		expect(provider.getModels().some((entry) => entry.id === "qianfan/known-good")).toBe(true);
	});

	test("rejects missing keys and HTTP errors", async () => {
		const provider = qianfanProvider({ fetch: async () => qianfanResponse([]) });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("Qianfan provider must support model discovery");

		await expect(
			refresh({ credential: undefined, store: scopedStore(new InMemoryModelsStore()), allowNetwork: true }),
		).rejects.toThrow("Qianfan API key is not configured");

		const fetchImpl: typeof fetch = async () =>
			new Response("unauthorized", { status: 401, headers: { "content-type": "text/plain" } });
		const failing = qianfanProvider({ fetch: fetchImpl });
		const failingRefresh = failing.refreshModels;
		if (!failingRefresh) throw new Error("Qianfan provider must support model discovery");
		await expect(failingRefresh(refreshContext)).rejects.toThrow("Could not load Qianfan models: 401: unauthorized");
	});

	test("uses the existing OpenAI completions stream with Qianfan model identity", async () => {
		const modelId = "deepseek-v3.2";
		const responseBody = [
			`data: ${JSON.stringify({
				id: "chatcmpl-qianfan-test",
				object: "chat.completion.chunk",
				created: 1,
				model: modelId,
				choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }],
			})}`,
			`data: ${JSON.stringify({
				id: "chatcmpl-qianfan-test",
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
		const provider = qianfanProvider();
		const model = provider.getModels().find((entry) => entry.id === modelId);
		if (!model) throw new Error("Qianfan bundled model is missing");

		const result = await provider
			.stream(
				model,
				{ messages: [{ role: "user", content: "say hello", timestamp: 1 }] },
				{ apiKey: "qianfan-test-key" },
			)
			.result();
		expect(result).toMatchObject({
			provider: "qianfan",
			model: modelId,
			stopReason: "stop",
		});
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
		const request = fetchSpy.mock.calls[0];
		expect(request?.[0]).toBe(`${QIANFAN_BASE_URL}/chat/completions`);
		expect(request?.[1]?.method).toBe("POST");
		const headers = request?.[1]?.headers;
		expect(headers instanceof Headers ? headers.get("authorization") : undefined).toBe("Bearer qianfan-test-key");
	});
});
