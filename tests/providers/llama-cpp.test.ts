import { afterEach, describe, expect, test, vi } from "vitest";
import { InMemoryModelsStore, type ProviderModelsStore } from "../../src/models-store.ts";
import { llamaCppProvider } from "../../src/providers/llama-cpp.ts";

afterEach(() => {
	vi.restoreAllMocks();
});

function scopedStore(store: InMemoryModelsStore): ProviderModelsStore {
	return {
		read: () => store.read("llama.cpp"),
		write: (entry) => store.write("llama.cpp", entry),
		delete: () => store.delete("llama.cpp"),
	};
}

function modelsResponse(data: readonly Record<string, unknown>[]): Response {
	return new Response(JSON.stringify({ object: "list", data }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("llama.cpp provider", () => {
	test("exposes local identity with default base URL and no static catalog", () => {
		const provider = llamaCppProvider();
		expect(provider.id).toBe("llama.cpp");
		expect(provider.name).toBe("llama.cpp (Local OpenAI-compatible)");
		expect(provider.baseUrl).toBe("http://127.0.0.1:8080/v1");
		expect(provider.getModels()).toEqual([]);
	});

	test("honors LLAMA_CPP_BASE_URL and appends /v1 when missing", () => {
		vi.stubEnv("LLAMA_CPP_BASE_URL", "http://gpu-box:8080/");
		expect(llamaCppProvider().baseUrl).toBe("http://gpu-box:8080/v1");
	});

	test("resolves stored key, env key, and local no-auth sentinel", async () => {
		const provider = llamaCppProvider();
		const auth = provider.auth.apiKey;
		expect(auth).toBeDefined();
		const env = async (name: string) => (name === "LLAMA_CPP_API_KEY" ? "env-key" : undefined);

		expect(await auth!.resolve({ ctx: { env }, credential: { type: "api_key", key: "stored" } })).toEqual({
			auth: { apiKey: "stored" },
			source: "stored credential",
		});
		expect(await auth!.resolve({ ctx: { env }, credential: undefined })).toEqual({
			auth: { apiKey: "env-key" },
			source: "LLAMA_CPP_API_KEY",
		});
		expect(await auth!.resolve({ ctx: { env: async () => undefined }, credential: undefined })).toEqual({
			auth: { apiKey: "llama-cpp-local" },
			source: "local no-auth",
		});
	});

	test("maps the /models discovery payload and dedupes ids", async () => {
		const fetchImpl = vi.fn(async () =>
			modelsResponse([
				{ id: "qwen3-8b", name: "Qwen3 8B", context_window: 32768, max_tokens: 8192 },
				{ id: "qwen3-8b", name: "dup" },
				{ id: "llama-3.2-3b" },
			]),
		);
		const provider = llamaCppProvider({ fetch: fetchImpl as unknown as typeof fetch });
		await provider.refreshModels?.({
			credential: { type: "api_key", key: "env-key" },
			store: scopedStore(new InMemoryModelsStore()),
			allowNetwork: true,
		});
		const models = provider.getModels();
		expect(models.map((model) => model.id)).toEqual(["qwen3-8b", "llama-3.2-3b"]);
		const qwen = models[0];
		expect(qwen?.api).toBe("openai-completions");
		expect(qwen?.provider).toBe("llama.cpp");
		expect(qwen?.contextWindow).toBe(32768);
		expect(qwen?.maxTokens).toBe(8192);
		expect(models[1]?.contextWindow).toBe(4096);
		expect(models[1]?.maxTokens).toBe(4096);
	});

	test("rejects HTTP errors, bad payloads, and empty catalogs without replacing models", async () => {
		const store = new InMemoryModelsStore();
		const scoped = scopedStore(store);
		const make = (fetchImpl: typeof fetch) => llamaCppProvider({ fetch: fetchImpl });
		const refresh = (provider: ReturnType<typeof llamaCppProvider>, credential = true) =>
			provider.refreshModels?.({
				credential: credential ? { type: "api_key", key: "k" } : undefined,
				store: scoped,
				allowNetwork: true,
			});

		const httpError = make(vi.fn(async () => new Response("denied", { status: 401 })));
		await expect(refresh(httpError)).rejects.toThrow(/401/);
		expect(httpError.getModels()).toEqual([]);

		const badPayload = make(vi.fn(async () => new Response(JSON.stringify({ data: "nope" }), { status: 200 })));
		await expect(refresh(badPayload)).rejects.toThrow(/Invalid llama.cpp model catalog/);

		const empty = make(vi.fn(async () => modelsResponse([])));
		await expect(refresh(empty)).rejects.toThrow(/empty model catalog/);

		// 成功后再失败:保留 last-known-good(动态列表不替换为空)。
		const flaky = make(
			vi
				.fn()
				.mockResolvedValueOnce(modelsResponse([{ id: "local-model", context_window: 8192 }]))
				.mockResolvedValueOnce(new Response("boom", { status: 500 })),
		);
		await refresh(flaky);
		expect(flaky.getModels().map((model) => model.id)).toEqual(["local-model"]);
		await expect(refresh(flaky)).rejects.toThrow(/500/);
		expect(flaky.getModels().map((model) => model.id)).toEqual(["local-model"]);
	});
});
