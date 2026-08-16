import { afterEach, describe, expect, test, vi } from "vitest";
import { InMemoryModelsStore, type ProviderModelsStore } from "../../src/models-store.ts";
import { novitaProvider } from "../../src/providers/novita.ts";

const NOVITA_BASE_URL = "https://api.novita.ai/openai/v1";

afterEach(() => {
	vi.restoreAllMocks();
});

function scopedStore(store: InMemoryModelsStore): ProviderModelsStore {
	return {
		read: () => store.read("novita"),
		write: (entry) => store.write("novita", entry),
		delete: () => store.delete("novita"),
	};
}

function novitaResponse(data: readonly Record<string, unknown>[]): Response {
	return new Response(JSON.stringify({ object: "list", data }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

const refreshContext = {
	credential: { type: "api_key" as const, key: "novita-test-key" },
	store: scopedStore(new InMemoryModelsStore()),
	allowNetwork: true,
};

describe("Novita provider", () => {
	test("exposes the bundled OpenAI-compatible catalog, baseUrl normalization, and env-key auth", async () => {
		const provider = novitaProvider();
		const model = provider.getModels().find((entry) => entry.id === "Sao10K/L3-8B-Stheno-v3.2");

		expect(provider.id).toBe("novita");
		expect(provider.name).toBe("Novita");
		expect(provider.baseUrl).toBe(NOVITA_BASE_URL);
		expect(model).toMatchObject({
			api: "openai-completions",
			provider: "novita",
			baseUrl: NOVITA_BASE_URL,
		});
		expect(model?.compat).toBeUndefined();
		// 缺 /v1 时自动补齐
		expect(novitaProvider({ baseUrl: "https://api.novita.test/openai" }).baseUrl).toBe(
			"https://api.novita.test/openai/v1",
		);

		const auth = await provider.auth.apiKey?.resolve({
			ctx: {
				env: async (name) => (name === "NOVITA_API_KEY" ? "novita-test-key" : undefined),
				fileExists: async () => false,
			},
		});
		expect(auth).toEqual({ auth: { apiKey: "novita-test-key" }, source: "NOVITA_API_KEY" });
	});

	test("resolves stored credentials and reports unconfigured state", async () => {
		const provider = novitaProvider();
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
		const provider = novitaProvider();
		const model = provider.getModels().find((entry) => entry.id === "Sao10K/L3-8B-Stheno-v3.2");

		expect(model).toMatchObject({
			id: "Sao10K/L3-8B-Stheno-v3.2",
			name: "L3 8B Stheno V3.2",
			reasoning: false,
			input: ["text"],
			contextWindow: 8192,
			maxTokens: 32000,
			cost: { input: 0.05, output: 0.05, cacheRead: 0, cacheWrite: 0 },
		});
	});

	test("maps authenticated model metadata with Novita per-1M pricing", async () => {
		const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return novitaResponse([
				{
					id: "Sao10K/L3-8B-Stheno-v3.2",
					name: "L3 8B Stheno V3.2 (live)",
					status: 1,
					endpoints: ["chat/completions"],
					max_output_tokens: 32000,
					// 按 1/10,000 美元/百万 token 报价
					input_token_price_per_m: 500,
					output_token_price_per_m: 500,
					pricing: { input_cache_read: { price_per_m: 100 } },
					limit: { context: 8192, output: 32000 },
					modalities: { input: ["text"] },
				},
				{ id: "unknown/novita-model", name: "New Model", status: 1, endpoints: ["chat/completions"], max_output_tokens: 4096 },
			]);
		};
		const provider = novitaProvider({ baseUrl: "https://config.novita.test", fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("Novita provider must support model discovery");

		await refresh(refreshContext);

		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			url: "https://config.novita.test/v1/models",
			init: {
				method: "GET",
				headers: { Authorization: "Bearer novita-test-key", Accept: "application/json" },
			},
		});
		expect(provider.getModels().find((entry) => entry.id === "Sao10K/L3-8B-Stheno-v3.2")).toMatchObject({
			name: "L3 8B Stheno V3.2 (live)",
			provider: "novita",
			baseUrl: "https://config.novita.test/v1",
			reasoning: false,
			input: ["text"],
			contextWindow: 8192,
			maxTokens: 32000,
			cost: { input: 0.05, output: 0.05, cacheRead: 0.01, cacheWrite: 0 },
		});
		expect(provider.getModels().find((entry) => entry.id === "unknown/novita-model")).toMatchObject({
			name: "New Model",
			contextWindow: 4096,
			maxTokens: 4096,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
	});

	test("filters discovery entries by status, id prefix, endpoints, and max output", async () => {
		const fetchImpl: typeof fetch = async () =>
			novitaResponse([
				// 保留:status 缺省 + 字符串 max_output_tokens
				{ id: "keep/chat", name: "Keep", endpoints: ["chat/completions"], max_output_tokens: "8192" },
				// 剔除:status 非 1
				{ id: "drop/inactive", status: 2, endpoints: ["chat/completions"], max_output_tokens: 8192 },
				// 剔除:ai_infer_test 前缀
				{ id: "ai_infer_test/bench", status: 1, endpoints: ["chat/completions"], max_output_tokens: 8192 },
				// 剔除:不支持 chat/completions
				{ id: "drop/no-chat", status: 1, endpoints: ["completions"], max_output_tokens: 8192 },
				// 剔除:max_output_tokens 非正
				{ id: "drop/no-output", status: 1, endpoints: ["chat/completions"], max_output_tokens: 0 },
			]);
		const provider = novitaProvider({ fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("Novita provider must support model discovery");

		await refresh(refreshContext);

		expect(provider.getModels().some((entry) => entry.id === "keep/chat")).toBe(true);
		for (const droppedId of ["drop/inactive", "ai_infer_test/bench", "drop/no-chat", "drop/no-output"]) {
			expect(provider.getModels().some((entry) => entry.id === droppedId), droppedId).toBe(false);
		}
	});

	test("rejects an empty catalog and keeps the last known good models", async () => {
		let response = novitaResponse([{ id: "novita/known-good", endpoints: ["chat/completions"], max_output_tokens: 8192 }]);
		const fetchImpl: typeof fetch = async () => response;
		const provider = novitaProvider({ fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("Novita provider must support model discovery");

		await refresh(refreshContext);
		expect(provider.getModels().some((entry) => entry.id === "novita/known-good")).toBe(true);

		response = novitaResponse([]);
		await expect(refresh(refreshContext)).rejects.toThrow("empty model catalog");
		expect(provider.getModels().some((entry) => entry.id === "novita/known-good")).toBe(true);
	});

	test("rejects missing keys and HTTP errors", async () => {
		const provider = novitaProvider({ fetch: async () => novitaResponse([]) });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("Novita provider must support model discovery");

		await expect(
			refresh({ credential: undefined, store: scopedStore(new InMemoryModelsStore()), allowNetwork: true }),
		).rejects.toThrow("Novita API key is not configured");

		const fetchImpl: typeof fetch = async () =>
			new Response("unauthorized", { status: 401, headers: { "content-type": "text/plain" } });
		const failing = novitaProvider({ fetch: fetchImpl });
		const failingRefresh = failing.refreshModels;
		if (!failingRefresh) throw new Error("Novita provider must support model discovery");
		await expect(failingRefresh(refreshContext)).rejects.toThrow("Could not load Novita models: 401: unauthorized");
	});

	test("uses the existing OpenAI completions stream with Novita model identity", async () => {
		const modelId = "Sao10K/L3-8B-Stheno-v3.2";
		const responseBody = [
			`data: ${JSON.stringify({
				id: "chatcmpl-novita-test",
				object: "chat.completion.chunk",
				created: 1,
				model: modelId,
				choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }],
			})}`,
			`data: ${JSON.stringify({
				id: "chatcmpl-novita-test",
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
		const provider = novitaProvider();
		const model = provider.getModels().find((entry) => entry.id === modelId);
		if (!model) throw new Error("Novita bundled model is missing");

		const result = await provider
			.stream(
				model,
				{ messages: [{ role: "user", content: "say hello", timestamp: 1 }] },
				{ apiKey: "novita-test-key" },
			)
			.result();
		expect(result).toMatchObject({
			provider: "novita",
			model: modelId,
			stopReason: "stop",
		});
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
		const request = fetchSpy.mock.calls[0];
		expect(request?.[0]).toBe(`${NOVITA_BASE_URL}/chat/completions`);
		expect(request?.[1]?.method).toBe("POST");
		const headers = request?.[1]?.headers;
		expect(headers instanceof Headers ? headers.get("authorization") : undefined).toBe("Bearer novita-test-key");
	});
});
