import { afterEach, describe, expect, test, vi } from "vitest";
import { InMemoryModelsStore, type ProviderModelsStore } from "../../src/models-store.ts";
import { aimlapiProvider } from "../../src/providers/aimlapi.ts";

const AIMLAPI_BASE_URL = "https://api.aimlapi.com/v1";

afterEach(() => {
	vi.restoreAllMocks();
});

function scopedStore(store: InMemoryModelsStore): ProviderModelsStore {
	return {
		read: () => store.read("aimlapi"),
		write: (entry) => store.write("aimlapi", entry),
		delete: () => store.delete("aimlapi"),
	};
}

function aimlapiResponse(data: readonly Record<string, unknown>[]): Response {
	return new Response(JSON.stringify({ object: "list", data }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

const refreshContext = {
	credential: { type: "api_key" as const, key: "aimlapi-test-key" },
	store: scopedStore(new InMemoryModelsStore()),
	allowNetwork: true,
};

describe("AIML API provider", () => {
	test("exposes the bundled OpenAI-compatible catalog and env-key auth", async () => {
		const provider = aimlapiProvider();
		const model = provider.getModels().find((entry) => entry.id === "alibaba/qwen3-32b");

		expect(provider.id).toBe("aimlapi");
		expect(provider.name).toBe("AIML API");
		expect(provider.baseUrl).toBe(AIMLAPI_BASE_URL);
		expect(model).toMatchObject({
			api: "openai-completions",
			provider: "aimlapi",
			baseUrl: AIMLAPI_BASE_URL,
		});
		expect(model?.compat).toBeUndefined();

		const auth = await provider.auth.apiKey?.resolve({
			ctx: {
				env: async (name) => (name === "AIMLAPI_API_KEY" ? "aimlapi-test-key" : undefined),
				fileExists: async () => false,
			},
		});
		expect(auth).toEqual({ auth: { apiKey: "aimlapi-test-key" }, source: "AIMLAPI_API_KEY" });
	});

	test("resolves stored credentials and reports unconfigured state", async () => {
		const provider = aimlapiProvider();
		const ctx = { env: async () => undefined, fileExists: async () => false };

		const stored = await provider.auth.apiKey?.resolve({
			ctx,
			credential: { type: "api_key", key: "stored-key" },
		});
		expect(stored).toEqual({ auth: { apiKey: "stored-key" }, source: "stored credential" });

		const unconfigured = await provider.auth.apiKey?.resolve({ ctx });
		expect(unconfigured).toBeUndefined();
	});

	test("ships the generated static catalog including non-chat entries", () => {
		const provider = aimlapiProvider();
		const model = provider.getModels().find((entry) => entry.id === "alibaba/qwen3-32b");

		expect(model).toMatchObject({
			id: "alibaba/qwen3-32b",
			name: "alibaba/qwen3-32b",
			reasoning: false,
			input: ["text"],
			contextWindow: 131072,
			maxTokens: 40960,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		// 图像/视频模型仍在静态目录中,仅动态发现时被过滤
		expect(provider.getModels().some((entry) => entry.id === "alibaba/wan2.2-14b-animate-move")).toBe(true);
	});

	test("maps authenticated model metadata and drops non-chat model ids", async () => {
		const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return aimlapiResponse([
				{
					id: "openai/gpt-oss-120b",
					name: "GPT OSS 120B (AIML)",
					reasoning: true,
					modalities: { input: ["text", "image"] },
					limit: { context: 131072, output: 40960 },
					cost: { input: 0.15, output: 0.6, cache_read: 0.05, cache_write: 0.1 },
				},
				// 未命中静态目录的新模型:使用现场字段 + 默认值
				{ id: "unknown/chat-model", name: "Unknown Chat", limit: { context: 8192 } },
				// 非聊天模型:按 id 特征剔除
				{ id: "openai/whisper-1" },
				{ id: "openai/dall-e-3" },
				{ id: "openai/text-embedding-3-small" },
				{ id: "openai/tts-1" },
			]);
		};
		const provider = aimlapiProvider({ baseUrl: "https://config.aimlapi.test", fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("AIML API provider must support model discovery");

		await refresh(refreshContext);

		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			url: "https://config.aimlapi.test/v1/models",
			init: {
				method: "GET",
				headers: { Authorization: "Bearer aimlapi-test-key", Accept: "application/json" },
			},
		});
		const mapped = provider.getModels().find((entry) => entry.id === "openai/gpt-oss-120b");
		expect(mapped).toMatchObject({
			name: "GPT OSS 120B (AIML)",
			provider: "aimlapi",
			baseUrl: "https://config.aimlapi.test/v1",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 131072,
			maxTokens: 40960,
			cost: { input: 0.15, output: 0.6, cacheRead: 0.05, cacheWrite: 0.1 },
		});
		const fallback = provider.getModels().find((entry) => entry.id === "unknown/chat-model");
		expect(fallback).toMatchObject({ name: "Unknown Chat", contextWindow: 8192, maxTokens: 4096 });
		for (const droppedId of ["openai/whisper-1", "openai/dall-e-3", "openai/text-embedding-3-small", "openai/tts-1"]) {
			expect(provider.getModels().some((entry) => entry.id === droppedId), droppedId).toBe(false);
		}
	});

	test("dedupes repeated model ids", async () => {
		const fetchImpl: typeof fetch = async () =>
			aimlapiResponse([{ id: "openai/gpt-oss-120b" }, { id: "openai/gpt-oss-120b", name: "Dup" }]);
		const provider = aimlapiProvider({ fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("AIML API provider must support model discovery");

		await refresh(refreshContext);

		const matches = provider.getModels().filter((entry) => entry.id === "openai/gpt-oss-120b");
		expect(matches).toHaveLength(1);
	});

	test("rejects an empty catalog and keeps the last known good models", async () => {
		let response = aimlapiResponse([{ id: "aimlapi/known-good" }]);
		const fetchImpl: typeof fetch = async () => response;
		const provider = aimlapiProvider({ fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("AIML API provider must support model discovery");

		await refresh(refreshContext);
		expect(provider.getModels().some((entry) => entry.id === "aimlapi/known-good")).toBe(true);

		response = aimlapiResponse([]);
		await expect(refresh(refreshContext)).rejects.toThrow("empty model catalog");
		expect(provider.getModels().some((entry) => entry.id === "aimlapi/known-good")).toBe(true);
	});

	test("rejects missing keys and HTTP errors", async () => {
		const provider = aimlapiProvider({ fetch: async () => aimlapiResponse([]) });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("AIML API provider must support model discovery");

		await expect(
			refresh({ credential: undefined, store: scopedStore(new InMemoryModelsStore()), allowNetwork: true }),
		).rejects.toThrow("AIML API key is not configured");

		const fetchImpl: typeof fetch = async () =>
			new Response("unauthorized", { status: 401, headers: { "content-type": "text/plain" } });
		const failing = aimlapiProvider({ fetch: fetchImpl });
		const failingRefresh = failing.refreshModels;
		if (!failingRefresh) throw new Error("AIML API provider must support model discovery");
		await expect(failingRefresh(refreshContext)).rejects.toThrow("Could not load AIML API models: 401: unauthorized");
	});

	test("uses the existing OpenAI completions stream with AIML API model identity", async () => {
		const modelId = "alibaba/qwen3-32b";
		const responseBody = [
			`data: ${JSON.stringify({
				id: "chatcmpl-aimlapi-test",
				object: "chat.completion.chunk",
				created: 1,
				model: modelId,
				choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }],
			})}`,
			`data: ${JSON.stringify({
				id: "chatcmpl-aimlapi-test",
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
		const provider = aimlapiProvider();
		const model = provider.getModels().find((entry) => entry.id === modelId);
		if (!model) throw new Error("AIML API bundled model is missing");

		const result = await provider
			.stream(
				model,
				{ messages: [{ role: "user", content: "say hello", timestamp: 1 }] },
				{ apiKey: "aimlapi-test-key" },
			)
			.result();
		expect(result).toMatchObject({
			provider: "aimlapi",
			model: modelId,
			stopReason: "stop",
		});
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
		const request = fetchSpy.mock.calls[0];
		expect(request?.[0]).toBe(`${AIMLAPI_BASE_URL}/chat/completions`);
		expect(request?.[1]?.method).toBe("POST");
		const headers = request?.[1]?.headers;
		expect(headers instanceof Headers ? headers.get("authorization") : undefined).toBe("Bearer aimlapi-test-key");
	});
});
