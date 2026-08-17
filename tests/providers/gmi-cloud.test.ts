import { afterEach, describe, expect, test, vi } from "vitest";
import { InMemoryModelsStore, type ProviderModelsStore } from "../../src/models-store.ts";
import { gmiCloudProvider } from "../../src/providers/gmi-cloud.ts";

const GMI_CLOUD_BASE_URL = "https://api.gmi-serving.com/v1";

afterEach(() => {
	vi.restoreAllMocks();
});

function scopedStore(store: InMemoryModelsStore): ProviderModelsStore {
	return {
		read: () => store.read("gmi-cloud"),
		write: (entry) => store.write("gmi-cloud", entry),
		delete: () => store.delete("gmi-cloud"),
	};
}

function gmiCloudResponse(data: readonly Record<string, unknown>[]): Response {
	return new Response(JSON.stringify({ object: "list", data }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

const refreshContext = {
	credential: { type: "api_key" as const, key: "gmi-test-key" },
	store: scopedStore(new InMemoryModelsStore()),
	allowNetwork: true,
};

describe("GMI Cloud provider", () => {
	test("exposes the bundled OpenAI-compatible catalog and env-key auth", async () => {
		const provider = gmiCloudProvider();
		const model = provider.getModels().find((entry) => entry.id === "deepseek-ai/DeepSeek-V4-Flash");

		expect(provider.id).toBe("gmi-cloud");
		expect(provider.name).toBe("GMI Cloud");
		expect(provider.baseUrl).toBe(GMI_CLOUD_BASE_URL);
		expect(model).toMatchObject({
			api: "openai-completions",
			provider: "gmi-cloud",
			baseUrl: GMI_CLOUD_BASE_URL,
		});
		expect(model?.compat).toBeUndefined();

		const auth = await provider.auth.apiKey?.resolve({
			ctx: {
				env: async (name) => (name === "GMI_API_KEY" ? "gmi-test-key" : undefined),
				fileExists: async () => false,
			},
		});
		expect(auth).toEqual({ auth: { apiKey: "gmi-test-key" }, source: "GMI_API_KEY" });
	});

	test("resolves stored credentials and reports unconfigured state", async () => {
		const provider = gmiCloudProvider();
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
		const provider = gmiCloudProvider();
		const model = provider.getModels().find((entry) => entry.id === "deepseek-ai/DeepSeek-V4-Flash");

		expect(model).toMatchObject({
			id: "deepseek-ai/DeepSeek-V4-Flash",
			name: "DeepSeek V4 Flash",
			reasoning: true,
			input: ["text"],
			contextWindow: 1048576,
			maxTokens: 384000,
			cost: { input: 0.14, output: 0.28, cacheRead: 0, cacheWrite: 0 },
		});
	});

	test("maps authenticated model metadata with static reference fallback", async () => {
		const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return gmiCloudResponse([
				{
					id: "deepseek-ai/DeepSeek-V4-Flash",
					name: "DeepSeek V4 Flash (live)",
					reasoning: true,
					modalities: { input: ["text", "image"] },
					limit: { context: 1048576, output: 384000 },
					cost: { input: 0.2, output: 0.4, cache_read: 0, cache_write: 0 },
				},
				{ id: "unknown/gmi-model", name: "New Model", limit: { context: 65536, output: 16384 } },
			]);
		};
		const provider = gmiCloudProvider({ baseUrl: "https://config.gmi-serving.test", fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("GMI Cloud provider must support model discovery");

		await refresh(refreshContext);

		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			url: "https://config.gmi-serving.test/v1/models",
			init: {
				method: "GET",
				headers: { Authorization: "Bearer gmi-test-key", Accept: "application/json" },
			},
		});
		expect(provider.getModels().find((entry) => entry.id === "deepseek-ai/DeepSeek-V4-Flash")).toMatchObject({
			name: "DeepSeek V4 Flash (live)",
			provider: "gmi-cloud",
			baseUrl: "https://config.gmi-serving.test/v1",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1048576,
			maxTokens: 384000,
			cost: { input: 0.2, output: 0.4, cacheRead: 0, cacheWrite: 0 },
		});
		expect(provider.getModels().find((entry) => entry.id === "unknown/gmi-model")).toMatchObject({
			name: "New Model",
			contextWindow: 65536,
			maxTokens: 16384,
		});
	});

	test("rejects an empty catalog and keeps the last known good models", async () => {
		let response = gmiCloudResponse([{ id: "gmi-cloud/known-good" }]);
		const fetchImpl: typeof fetch = async () => response;
		const provider = gmiCloudProvider({ fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("GMI Cloud provider must support model discovery");

		await refresh(refreshContext);
		expect(provider.getModels().some((entry) => entry.id === "gmi-cloud/known-good")).toBe(true);

		response = gmiCloudResponse([]);
		await expect(refresh(refreshContext)).rejects.toThrow("empty model catalog");
		expect(provider.getModels().some((entry) => entry.id === "gmi-cloud/known-good")).toBe(true);
	});

	test("rejects missing keys and HTTP errors", async () => {
		const provider = gmiCloudProvider({ fetch: async () => gmiCloudResponse([]) });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("GMI Cloud provider must support model discovery");

		await expect(
			refresh({ credential: undefined, store: scopedStore(new InMemoryModelsStore()), allowNetwork: true }),
		).rejects.toThrow("GMI Cloud API key is not configured");

		const fetchImpl: typeof fetch = async () =>
			new Response("forbidden", { status: 403, headers: { "content-type": "text/plain" } });
		const failing = gmiCloudProvider({ fetch: fetchImpl });
		const failingRefresh = failing.refreshModels;
		if (!failingRefresh) throw new Error("GMI Cloud provider must support model discovery");
		await expect(failingRefresh(refreshContext)).rejects.toThrow(
			"Could not load GMI Cloud models: 403: forbidden",
		);
	});

	test("uses the existing OpenAI completions stream with GMI Cloud model identity", async () => {
		const modelId = "deepseek-ai/DeepSeek-V4-Flash";
		const responseBody = [
			`data: ${JSON.stringify({
				id: "chatcmpl-gmi-test",
				object: "chat.completion.chunk",
				created: 1,
				model: modelId,
				choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }],
			})}`,
			`data: ${JSON.stringify({
				id: "chatcmpl-gmi-test",
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
		const provider = gmiCloudProvider();
		const model = provider.getModels().find((entry) => entry.id === modelId);
		if (!model) throw new Error("GMI Cloud bundled model is missing");

		const result = await provider
			.stream(
				model,
				{ messages: [{ role: "user", content: "say hello", timestamp: 1 }] },
				{ apiKey: "gmi-test-key" },
			)
			.result();
		expect(result).toMatchObject({
			provider: "gmi-cloud",
			model: modelId,
			stopReason: "stop",
		});
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
		const request = fetchSpy.mock.calls[0];
		expect(request?.[0]).toBe(`${GMI_CLOUD_BASE_URL}/chat/completions`);
		expect(request?.[1]?.method).toBe("POST");
		const headers = request?.[1]?.headers;
		expect(headers instanceof Headers ? headers.get("authorization") : undefined).toBe("Bearer gmi-test-key");
	});
});
