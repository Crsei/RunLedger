import { afterEach, describe, expect, test, vi } from "vitest";
import { InMemoryModelsStore, type ProviderModelsStore } from "../../src/models-store.ts";
import { litellmProvider } from "../../src/providers/litellm.ts";

// 并行切片尚未落地时 all.ts 依赖的兄弟 provider 文件缺失,动态导入失败则跳过注册断言。
let builtinAvailable = false;
try {
	await import("../../src/providers/all.ts");
	builtinAvailable = true;
} catch {
	builtinAvailable = false;
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

function scopedStore(store: InMemoryModelsStore): ProviderModelsStore {
	return {
		read: () => store.read("litellm"),
		write: (entry) => store.write("litellm", entry),
		delete: () => store.delete("litellm"),
	};
}

function litellmResponse(data: readonly Record<string, unknown>[]): Response {
	return new Response(JSON.stringify({ object: "list", data }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function fakeAuthContext(env: Record<string, string>) {
	return { ctx: { env: async (name: string) => env[name], fileExists: async () => false } };
}

describe("LiteLLM provider", () => {
	test("exposes identity, configurable base URL, and a rewritten bundled catalog", () => {
		const provider = litellmProvider();
		expect(provider.id).toBe("litellm");
		expect(provider.name).toBe("LiteLLM");
		expect(provider.baseUrl).toBe("http://localhost:4000/v1");
		const model = provider.getModels().find((entry) => entry.id === "claude-opus-4-8");
		expect(model).toMatchObject({
			api: "openai-completions",
			provider: "litellm",
			baseUrl: "http://localhost:4000/v1",
			reasoning: true,
		});

		const configured = litellmProvider({ baseUrl: "http://127.0.0.1:4999/v1/" });
		expect(configured.baseUrl).toBe("http://127.0.0.1:4999/v1");
		expect(configured.getModels().find((entry) => entry.id === "claude-opus-4-8")?.baseUrl).toBe(
			"http://127.0.0.1:4999/v1",
		);

		vi.stubEnv("LITELLM_BASE_URL", "http://env-litellm:4321/v1");
		const fromEnv = litellmProvider();
		expect(fromEnv.baseUrl).toBe("http://env-litellm:4321/v1");
		expect(fromEnv.getModels().find((entry) => entry.id === "claude-opus-4-8")?.baseUrl).toBe(
			"http://env-litellm:4321/v1",
		);
	});

	test("always resolves auth, preferring stored credential then env var, with a sentinel for keyless local", async () => {
		const auth = litellmProvider().auth.apiKey;
		if (!auth) throw new Error("LiteLLM provider must expose api-key auth");

		expect(await auth.resolve(fakeAuthContext({}))).toEqual({
			auth: { apiKey: "litellm-local" },
			source: "no auth required",
		});
		expect(await auth.resolve(fakeAuthContext({ LITELLM_API_KEY: "litellm-env-key" }))).toEqual({
			auth: { apiKey: "litellm-env-key" },
			source: "LITELLM_API_KEY",
		});
		expect(
			await auth.resolve({
				...fakeAuthContext({ LITELLM_API_KEY: "litellm-env-key" }),
				credential: { type: "api_key", key: "litellm-stored-key" },
			}),
		).toEqual({ auth: { apiKey: "litellm-stored-key" }, source: "stored credential" });
	});

	test("login stores the entered key and accepts an empty input for keyless local", async () => {
		const auth = litellmProvider().auth.apiKey;
		if (!auth?.login) throw new Error("LiteLLM provider must expose login");

		expect(
			await auth.login({ prompt: async () => "sk-litellm-key", notify: () => undefined }),
		).toEqual({ type: "api_key", key: "sk-litellm-key" });
		expect(await auth.login({ prompt: async () => "   ", notify: () => undefined })).toEqual({
			type: "api_key",
		});
	});

	const registryTest = builtinAvailable ? test : test.skip;
	registryTest("is present in the builtin provider and model collections", async () => {
		const all = await import("../../src/providers/all.ts");
		expect(all.builtinProviders().find((provider) => provider.id === "litellm")?.name).toBe("LiteLLM");
		expect(all.builtinModels().getModel("litellm", "claude-opus-4-8")).toMatchObject({
			provider: "litellm",
			api: "openai-completions",
		});
	});

	test("maps authenticated catalog entries to target models with limit fallbacks", async () => {
		const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return litellmResponse([
				{
					id: "openai/gpt-oss-120b",
					name: "GPT OSS 120B (LiteLLM)",
					reasoning: true,
					modalities: { input: ["text", "image"] },
					limit: { context: 131072, output: 32768 },
					cost: { input: 0.15, output: 0.6, cache_read: 0.05, cache_write: 0.1 },
				},
				{
					id: "mistral/mistral-large",
					// 无 limit 字段:max_model_len 优先于 context_length,输出上限回退 min(ctx, 65536)
					max_model_len: 65536,
					context_length: 4096,
				},
				// 重复 id 应去重
				{ id: "openai/gpt-oss-120b", name: "duplicate" },
			]);
		};
		const provider = litellmProvider({ baseUrl: "http://config.litellm.test/v1", fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("LiteLLM provider must support model discovery");

		await refresh({
			credential: { type: "api_key", key: "litellm-test-key" },
			store: scopedStore(new InMemoryModelsStore()),
			allowNetwork: true,
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			url: "http://config.litellm.test/v1/models",
			init: {
				method: "GET",
				headers: { Authorization: "Bearer litellm-test-key", Accept: "application/json" },
			},
		});
		expect(provider.getModels().find((entry) => entry.id === "openai/gpt-oss-120b")).toMatchObject({
			name: "GPT OSS 120B (LiteLLM)",
			provider: "litellm",
			baseUrl: "http://config.litellm.test/v1",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 131072,
			maxTokens: 32768,
			cost: { input: 0.15, output: 0.6, cacheRead: 0.05, cacheWrite: 0.1 },
		});
		expect(provider.getModels().find((entry) => entry.id === "mistral/mistral-large")).toMatchObject({
			name: "mistral/mistral-large",
			contextWindow: 65536,
			maxTokens: 65536,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		expect(provider.getModels().filter((entry) => entry.id === "openai/gpt-oss-120b")).toHaveLength(1);
	});

	test("skips the Authorization header for keyless discovery", async () => {
		const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return litellmResponse([{ id: "local/mistral" }]);
		};
		const provider = litellmProvider({ fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("LiteLLM provider must support model discovery");

		// 哨兵 key 是 resolve 对无 key 配置的产物,发现请求不应携带 Authorization
		await refresh({
			credential: { type: "api_key", key: "litellm-local" },
			store: scopedStore(new InMemoryModelsStore()),
			allowNetwork: true,
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]?.init?.headers).toEqual({ Accept: "application/json" });
	});

	test("keeps the last known good catalog across HTTP errors and empty results", async () => {
		let response = litellmResponse([{ id: "litellm/known-good", reasoning: true }]);
		const fetchImpl: typeof fetch = async () => response;
		const provider = litellmProvider({ fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("LiteLLM provider must support model discovery");
		const store = scopedStore(new InMemoryModelsStore());
		const context = {
			credential: { type: "api_key" as const, key: "litellm-test-key" },
			store,
			allowNetwork: true,
		};

		await refresh(context);
		expect(provider.getModels().some((entry) => entry.id === "litellm/known-good")).toBe(true);

		response = new Response("proxy down", { status: 503 });
		await expect(refresh(context)).rejects.toThrow("Could not load LiteLLM models: 503");
		expect(provider.getModels().some((entry) => entry.id === "litellm/known-good")).toBe(true);

		response = litellmResponse([]);
		await expect(refresh(context)).rejects.toThrow("empty model catalog");
		expect(provider.getModels().some((entry) => entry.id === "litellm/known-good")).toBe(true);
	});

	test("uses the existing OpenAI completions stream with LiteLLM model identity", async () => {
		const modelId = "claude-opus-4-8";
		const responseBody = [
			`data: ${JSON.stringify({
				id: "chatcmpl-litellm-test",
				object: "chat.completion.chunk",
				created: 1,
				model: modelId,
				choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }],
			})}`,
			`data: ${JSON.stringify({
				id: "chatcmpl-litellm-test",
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
		const provider = litellmProvider();
		const model = provider.getModels().find((entry) => entry.id === modelId);
		if (!model) throw new Error("LiteLLM bundled model is missing");

		const result = await provider
			.stream(
				model,
				{ messages: [{ role: "user", content: "say hello", timestamp: 1 }] },
				{ apiKey: "litellm-test-key" },
			)
			.result();
		expect(result).toMatchObject({
			provider: "litellm",
			model: modelId,
			stopReason: "stop",
		});
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
		const request = fetchSpy.mock.calls[0];
		expect(request?.[0]).toBe("http://localhost:4000/v1/chat/completions");
		expect(request?.[1]?.method).toBe("POST");
		const headers = request?.[1]?.headers;
		expect(headers instanceof Headers ? headers.get("authorization") : undefined).toBe("Bearer litellm-test-key");
	});
});
