import { afterEach, describe, expect, test, vi } from "vitest";
import { InMemoryModelsStore, type ProviderModelsStore } from "../../src/models-store.ts";
import { lmStudioProvider } from "../../src/providers/lm-studio.ts";

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
		read: () => store.read("lm-studio"),
		write: (entry) => store.write("lm-studio", entry),
		delete: () => store.delete("lm-studio"),
	};
}

function lmStudioResponse(data: readonly Record<string, unknown>[]): Response {
	return new Response(JSON.stringify({ object: "list", data }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function fakeAuthContext(env: Record<string, string>) {
	return { ctx: { env: async (name: string) => env[name], fileExists: async () => false } };
}

describe("LM Studio provider", () => {
	test("exposes identity, configurable base URL, and a rewritten bundled catalog", () => {
		const provider = lmStudioProvider();
		expect(provider.id).toBe("lm-studio");
		expect(provider.name).toBe("LM Studio");
		expect(provider.baseUrl).toBe("http://127.0.0.1:1234/v1");
		const model = provider.getModels().find((entry) => entry.id === "llama-3-8b");
		expect(model).toMatchObject({
			api: "openai-completions",
			provider: "lm-studio",
			baseUrl: "http://127.0.0.1:1234/v1",
		});

		const configured = lmStudioProvider({ baseUrl: "http://127.0.0.1:5999/v1/" });
		expect(configured.baseUrl).toBe("http://127.0.0.1:5999/v1");
		expect(configured.getModels().find((entry) => entry.id === "llama-3-8b")?.baseUrl).toBe(
			"http://127.0.0.1:5999/v1",
		);

		vi.stubEnv("LM_STUDIO_BASE_URL", "http://env-lmstudio:4321/v1");
		const fromEnv = lmStudioProvider();
		expect(fromEnv.baseUrl).toBe("http://env-lmstudio:4321/v1");
		expect(fromEnv.getModels().find((entry) => entry.id === "llama-3-8b")?.baseUrl).toBe(
			"http://env-lmstudio:4321/v1",
		);
	});

	test("always resolves auth, preferring stored credential then env var, with a sentinel for keyless local", async () => {
		const auth = lmStudioProvider().auth.apiKey;
		if (!auth) throw new Error("LM Studio provider must expose api-key auth");

		expect(await auth.resolve(fakeAuthContext({}))).toEqual({
			auth: { apiKey: "lm-studio-local" },
			source: "no auth required",
		});
		expect(await auth.resolve(fakeAuthContext({ LM_STUDIO_API_KEY: "lm-studio-env-key" }))).toEqual({
			auth: { apiKey: "lm-studio-env-key" },
			source: "LM_STUDIO_API_KEY",
		});
		expect(
			await auth.resolve({
				...fakeAuthContext({ LM_STUDIO_API_KEY: "lm-studio-env-key" }),
				credential: { type: "api_key", key: "lm-studio-stored-key" },
			}),
		).toEqual({ auth: { apiKey: "lm-studio-stored-key" }, source: "stored credential" });
	});

	test("login stores the entered key and accepts an empty input for keyless local", async () => {
		const auth = lmStudioProvider().auth.apiKey;
		if (!auth?.login) throw new Error("LM Studio provider must expose login");

		expect(
			await auth.login({ prompt: async () => "lm-studio-key", notify: () => undefined }),
		).toEqual({ type: "api_key", key: "lm-studio-key" });
		expect(await auth.login({ prompt: async () => "", notify: () => undefined })).toEqual({
			type: "api_key",
		});
	});

	const registryTest = builtinAvailable ? test : test.skip;
	registryTest("is present in the builtin provider and model collections", async () => {
		const all = await import("../../src/providers/all.ts");
		expect(all.builtinProviders().find((provider) => provider.id === "lm-studio")?.name).toBe("LM Studio");
		expect(all.builtinModels().getModel("lm-studio", "llama-3-8b")).toMatchObject({
			provider: "lm-studio",
			api: "openai-completions",
		});
	});

	test("maps catalog entries to target models with limit fallbacks", async () => {
		const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return lmStudioResponse([
				{
					id: "mlx-community/Llama-3.3-70B",
					name: "Llama 3.3 70B (LM Studio)",
					reasoning: false,
					modalities: { input: ["text"] },
					limit: { context: 131072, output: 16384 },
					cost: { input: 1, output: 2, cache_read: 0, cache_write: 0 },
				},
				{
					id: "local/qwen2.5-coder",
					// 无 limit 字段:context_length 生效,输出上限回退 min(ctx, 65536)
					context_length: 65536,
				},
			]);
		};
		const provider = lmStudioProvider({ baseUrl: "http://config.lmstudio.test/v1", fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("LM Studio provider must support model discovery");

		await refresh({
			credential: { type: "api_key", key: "lm-studio-test-key" },
			store: scopedStore(new InMemoryModelsStore()),
			allowNetwork: true,
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			url: "http://config.lmstudio.test/v1/models",
			init: {
				method: "GET",
				headers: { Authorization: "Bearer lm-studio-test-key", Accept: "application/json" },
			},
		});
		expect(provider.getModels().find((entry) => entry.id === "mlx-community/Llama-3.3-70B")).toMatchObject({
			name: "Llama 3.3 70B (LM Studio)",
			provider: "lm-studio",
			baseUrl: "http://config.lmstudio.test/v1",
			reasoning: false,
			input: ["text"],
			contextWindow: 131072,
			maxTokens: 16384,
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		});
		expect(provider.getModels().find((entry) => entry.id === "local/qwen2.5-coder")).toMatchObject({
			name: "local/qwen2.5-coder",
			contextWindow: 65536,
			maxTokens: 65536,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
	});

	test("skips the Authorization header for keyless discovery", async () => {
		const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return lmStudioResponse([{ id: "local/llama-3.2-3b" }]);
		};
		const provider = lmStudioProvider({ fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("LM Studio provider must support model discovery");

		// 哨兵 key 是 resolve 对无 key 配置的产物,发现请求不应携带 Authorization
		await refresh({
			credential: { type: "api_key", key: "lm-studio-local" },
			store: scopedStore(new InMemoryModelsStore()),
			allowNetwork: true,
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]?.init?.headers).toEqual({ Accept: "application/json" });
	});

	test("keeps the last known good catalog across HTTP errors and empty results", async () => {
		let response = lmStudioResponse([{ id: "lm-studio/known-good", reasoning: true }]);
		const fetchImpl: typeof fetch = async () => response;
		const provider = lmStudioProvider({ fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("LM Studio provider must support model discovery");
		const store = scopedStore(new InMemoryModelsStore());
		const context = {
			credential: { type: "api_key" as const, key: "lm-studio-test-key" },
			store,
			allowNetwork: true,
		};

		await refresh(context);
		expect(provider.getModels().some((entry) => entry.id === "lm-studio/known-good")).toBe(true);

		response = new Response("server offline", { status: 500 });
		await expect(refresh(context)).rejects.toThrow("Could not load LM Studio models: 500");
		expect(provider.getModels().some((entry) => entry.id === "lm-studio/known-good")).toBe(true);

		response = lmStudioResponse([]);
		await expect(refresh(context)).rejects.toThrow("empty model catalog");
		expect(provider.getModels().some((entry) => entry.id === "lm-studio/known-good")).toBe(true);
	});

	test("uses the existing OpenAI completions stream with LM Studio model identity", async () => {
		const modelId = "llama-3-8b";
		const responseBody = [
			`data: ${JSON.stringify({
				id: "chatcmpl-lmstudio-test",
				object: "chat.completion.chunk",
				created: 1,
				model: modelId,
				choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }],
			})}`,
			`data: ${JSON.stringify({
				id: "chatcmpl-lmstudio-test",
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
		const provider = lmStudioProvider();
		const model = provider.getModels().find((entry) => entry.id === modelId);
		if (!model) throw new Error("LM Studio bundled model is missing");

		const result = await provider
			.stream(
				model,
				{ messages: [{ role: "user", content: "say hello", timestamp: 1 }] },
				{ apiKey: "lm-studio-test-key" },
			)
			.result();
		expect(result).toMatchObject({
			provider: "lm-studio",
			model: modelId,
			stopReason: "stop",
		});
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
		const request = fetchSpy.mock.calls[0];
		expect(request?.[0]).toBe("http://127.0.0.1:1234/v1/chat/completions");
		expect(request?.[1]?.method).toBe("POST");
		const headers = request?.[1]?.headers;
		expect(headers instanceof Headers ? headers.get("authorization") : undefined).toBe("Bearer lm-studio-test-key");
	});
});
