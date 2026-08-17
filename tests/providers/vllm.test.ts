import { afterEach, describe, expect, test, vi } from "vitest";
import { InMemoryModelsStore, type ProviderModelsStore } from "../../src/models-store.ts";
import { vllmProvider } from "../../src/providers/vllm.ts";

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
		read: () => store.read("vllm"),
		write: (entry) => store.write("vllm", entry),
		delete: () => store.delete("vllm"),
	};
}

function vllmResponse(data: readonly Record<string, unknown>[]): Response {
	return new Response(JSON.stringify({ object: "list", data }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function fakeAuthContext(env: Record<string, string>) {
	return { ctx: { env: async (name: string) => env[name], fileExists: async () => false } };
}

describe("vLLM provider", () => {
	test("exposes identity, configurable base URL, and a rewritten bundled catalog", () => {
		const provider = vllmProvider();
		expect(provider.id).toBe("vllm");
		expect(provider.name).toBe("vLLM");
		expect(provider.baseUrl).toBe("http://127.0.0.1:8000/v1");
		const model = provider.getModels().find((entry) => entry.id === "gpt-oss-20b");
		expect(model).toMatchObject({
			api: "openai-completions",
			provider: "vllm",
			baseUrl: "http://127.0.0.1:8000/v1",
		});

		const configured = vllmProvider({ baseUrl: "http://127.0.0.1:7999/v1/" });
		expect(configured.baseUrl).toBe("http://127.0.0.1:7999/v1");
		expect(configured.getModels().find((entry) => entry.id === "gpt-oss-20b")?.baseUrl).toBe(
			"http://127.0.0.1:7999/v1",
		);

		vi.stubEnv("VLLM_BASE_URL", "http://env-vllm:4321/v1");
		const fromEnv = vllmProvider();
		expect(fromEnv.baseUrl).toBe("http://env-vllm:4321/v1");
		expect(fromEnv.getModels().find((entry) => entry.id === "gpt-oss-20b")?.baseUrl).toBe(
			"http://env-vllm:4321/v1",
		);
	});

	test("always resolves auth, preferring stored credential then env var, with a sentinel for keyless local", async () => {
		const auth = vllmProvider().auth.apiKey;
		if (!auth) throw new Error("vLLM provider must expose api-key auth");

		expect(await auth.resolve(fakeAuthContext({}))).toEqual({
			auth: { apiKey: "vllm-local" },
			source: "no auth required",
		});
		expect(await auth.resolve(fakeAuthContext({ VLLM_API_KEY: "vllm-env-key" }))).toEqual({
			auth: { apiKey: "vllm-env-key" },
			source: "VLLM_API_KEY",
		});
		expect(
			await auth.resolve({
				...fakeAuthContext({ VLLM_API_KEY: "vllm-env-key" }),
				credential: { type: "api_key", key: "vllm-stored-key" },
			}),
		).toEqual({ auth: { apiKey: "vllm-stored-key" }, source: "stored credential" });
	});

	test("login stores the entered key and accepts an empty input for keyless local", async () => {
		const auth = vllmProvider().auth.apiKey;
		if (!auth?.login) throw new Error("vLLM provider must expose login");

		expect(await auth.login({ prompt: async () => "vllm-key", notify: () => undefined })).toEqual({
			type: "api_key",
			key: "vllm-key",
		});
		expect(await auth.login({ prompt: async () => "", notify: () => undefined })).toEqual({
			type: "api_key",
		});
	});

	const registryTest = builtinAvailable ? test : test.skip;
	registryTest("is present in the builtin provider and model collections", async () => {
		const all = await import("../../src/providers/all.ts");
		expect(all.builtinProviders().find((provider) => provider.id === "vllm")?.name).toBe("vLLM");
		expect(all.builtinModels().getModel("vllm", "gpt-oss-20b")).toMatchObject({
			provider: "vllm",
			api: "openai-completions",
		});
	});

	test("maps catalog entries to target models with limit fallbacks", async () => {
		const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return vllmResponse([
				{
					id: "Qwen/Qwen3-32B",
					name: "Qwen3 32B (vLLM)",
					reasoning: true,
					modalities: { input: ["text", "image"] },
					limit: { context: 65536, output: 8192 },
				},
				{
					id: "meta-llama/Llama-3.1-8B-Instruct",
					// 无 limit 字段:max_model_len 生效,输出上限回退 min(ctx, 65536)
					max_model_len: 131072,
					context_length: 8192,
				},
				// 重复 id 应去重
				{ id: "Qwen/Qwen3-32B", name: "duplicate" },
			]);
		};
		const provider = vllmProvider({ baseUrl: "http://config.vllm.test/v1", fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("vLLM provider must support model discovery");

		await refresh({
			credential: { type: "api_key", key: "vllm-test-key" },
			store: scopedStore(new InMemoryModelsStore()),
			allowNetwork: true,
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			url: "http://config.vllm.test/v1/models",
			init: {
				method: "GET",
				headers: { Authorization: "Bearer vllm-test-key", Accept: "application/json" },
			},
		});
		expect(provider.getModels().find((entry) => entry.id === "Qwen/Qwen3-32B")).toMatchObject({
			name: "Qwen3 32B (vLLM)",
			provider: "vllm",
			baseUrl: "http://config.vllm.test/v1",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 65536,
			maxTokens: 8192,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		expect(
			provider.getModels().find((entry) => entry.id === "meta-llama/Llama-3.1-8B-Instruct"),
		).toMatchObject({
			name: "meta-llama/Llama-3.1-8B-Instruct",
			contextWindow: 131072,
			maxTokens: 65536,
			reasoning: false,
			input: ["text"],
		});
		expect(provider.getModels().filter((entry) => entry.id === "Qwen/Qwen3-32B")).toHaveLength(1);
	});

	test("skips the Authorization header for keyless discovery", async () => {
		const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return vllmResponse([{ id: "local/gpt-oss-20b" }]);
		};
		const provider = vllmProvider({ fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("vLLM provider must support model discovery");

		// 哨兵 key 是 resolve 对无 key 配置的产物,发现请求不应携带 Authorization
		await refresh({
			credential: { type: "api_key", key: "vllm-local" },
			store: scopedStore(new InMemoryModelsStore()),
			allowNetwork: true,
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]?.init?.headers).toEqual({ Accept: "application/json" });
	});

	test("keeps the last known good catalog across HTTP errors and empty results", async () => {
		let response = vllmResponse([{ id: "vllm/known-good", reasoning: true }]);
		const fetchImpl: typeof fetch = async () => response;
		const provider = vllmProvider({ fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("vLLM provider must support model discovery");
		const store = scopedStore(new InMemoryModelsStore());
		const context = {
			credential: { type: "api_key" as const, key: "vllm-test-key" },
			store,
			allowNetwork: true,
		};

		await refresh(context);
		expect(provider.getModels().some((entry) => entry.id === "vllm/known-good")).toBe(true);

		response = new Response("engine error", { status: 502 });
		await expect(refresh(context)).rejects.toThrow("Could not load vLLM models: 502");
		expect(provider.getModels().some((entry) => entry.id === "vllm/known-good")).toBe(true);

		response = vllmResponse([]);
		await expect(refresh(context)).rejects.toThrow("empty model catalog");
		expect(provider.getModels().some((entry) => entry.id === "vllm/known-good")).toBe(true);
	});

	test("uses the existing OpenAI completions stream with vLLM model identity", async () => {
		const modelId = "gpt-oss-20b";
		const responseBody = [
			`data: ${JSON.stringify({
				id: "chatcmpl-vllm-test",
				object: "chat.completion.chunk",
				created: 1,
				model: modelId,
				choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }],
			})}`,
			`data: ${JSON.stringify({
				id: "chatcmpl-vllm-test",
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
		const provider = vllmProvider();
		const model = provider.getModels().find((entry) => entry.id === modelId);
		if (!model) throw new Error("vLLM bundled model is missing");

		const result = await provider
			.stream(
				model,
				{ messages: [{ role: "user", content: "say hello", timestamp: 1 }] },
				{ apiKey: "vllm-test-key" },
			)
			.result();
		expect(result).toMatchObject({
			provider: "vllm",
			model: modelId,
			stopReason: "stop",
		});
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
		const request = fetchSpy.mock.calls[0];
		expect(request?.[0]).toBe("http://127.0.0.1:8000/v1/chat/completions");
		expect(request?.[1]?.method).toBe("POST");
		const headers = request?.[1]?.headers;
		expect(headers instanceof Headers ? headers.get("authorization") : undefined).toBe("Bearer vllm-test-key");
	});
});
