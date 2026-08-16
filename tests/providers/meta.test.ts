import { afterEach, describe, expect, test, vi } from "vitest";
import { InMemoryModelsStore, type ProviderModelsStore } from "../../src/models-store.ts";
import { metaProvider } from "../../src/providers/meta.ts";
import { builtinModels, builtinProviders } from "../../src/providers/all.ts";

afterEach(() => {
	vi.restoreAllMocks();
});

function scopedStore(store: InMemoryModelsStore): ProviderModelsStore {
	return {
		read: () => store.read("meta"),
		write: (entry) => store.write("meta", entry),
		delete: () => store.delete("meta"),
	};
}

function metaResponse(data: readonly Record<string, unknown>[]): Response {
	return new Response(JSON.stringify({ object: "list", data }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function metaResponsesSse(text: string): string {
	const events = [
		{
			type: "response.output_item.added",
			item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: text },
		{
			type: "response.output_item.done",
			item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text }] },
		},
		{
			type: "response.completed",
			response: {
				status: "completed",
				usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } },
			},
		},
	];
	return `${events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
}

describe("meta provider", () => {
	test("exposes the bundled catalog and env-key auth", async () => {
		const provider = metaProvider();
		const model = provider.getModels().find((entry) => entry.id === "muse-spark-1.2");

		expect(provider.id).toBe("meta");
		expect(provider.name).toBe("Meta Model API");
		expect(provider.baseUrl).toBe("https://api.meta.ai/v1");
		expect(model).toMatchObject({
			api: "openai-responses",
			provider: "meta",
			baseUrl: "https://api.meta.ai/v1",
			reasoning: true,
			input: ["text", "image"],
		});

		const auth = await provider.auth.apiKey?.resolve({
			ctx: { env: async (name) => (name === "MODEL_API_KEY" ? "meta-test-key" : undefined), fileExists: async () => false },
		});
		expect(auth).toEqual({ auth: { apiKey: "meta-test-key" }, source: "MODEL_API_KEY" });

		const fallback = await provider.auth.apiKey?.resolve({
			ctx: { env: async (name) => (name === "META_API_KEY" ? "meta-fallback-key" : undefined), fileExists: async () => false },
		});
		expect(fallback).toEqual({ auth: { apiKey: "meta-fallback-key" }, source: "META_API_KEY" });
	});

	test("is present in the builtin provider and model collections", () => {
		expect(builtinProviders().find((provider) => provider.id === "meta")?.name).toBe("Meta Model API");
		expect(builtinModels().getModel("meta", "muse-spark-1.2")).toMatchObject({
			provider: "meta",
			api: "openai-responses",
		});
	});

	test("maps authenticated model metadata to a target model", async () => {
		const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return metaResponse([
				{ id: "muse-spark-2.0", name: "Muse Spark 2.0", context_length: 262144, max_completion_tokens: 65536 },
				{ id: "muse-spark-1.2", name: "Muse Spark 1.2" },
			]);
		};
		const provider = metaProvider({ baseUrl: "https://config.meta.test", fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("meta provider must support model discovery");

		await refresh({
			credential: { type: "api_key", key: "meta-test-key" },
			store: scopedStore(new InMemoryModelsStore()),
			allowNetwork: true,
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			url: "https://config.meta.test/v1/models",
			init: { method: "GET", headers: { Authorization: "Bearer meta-test-key", Accept: "application/json" } },
		});
		expect(provider.getModels().find((entry) => entry.id === "muse-spark-2.0")).toMatchObject({
			name: "Muse Spark 2.0",
			provider: "meta",
			baseUrl: "https://config.meta.test/v1",
			reasoning: false,
			contextWindow: 262144,
			maxTokens: 65536,
		});
		// 已知 id 的动态条目继承静态 metadata
		expect(provider.getModels().find((entry) => entry.id === "muse-spark-1.2")).toMatchObject({
			name: "Muse Spark 1.2",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1048576,
		});
	});

	test("rejects an empty catalog and keeps the last known good models", async () => {
		let response = metaResponse([{ id: "meta/known-good" }]);
		const fetchImpl: typeof fetch = async () => response;
		const provider = metaProvider({ fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("meta provider must support model discovery");
		const store = scopedStore(new InMemoryModelsStore());
		const context = { credential: { type: "api_key" as const, key: "meta-test-key" }, store, allowNetwork: true };

		await refresh(context);
		expect(provider.getModels().some((entry) => entry.id === "meta/known-good")).toBe(true);

		response = metaResponse([]);
		await expect(refresh(context)).rejects.toThrow("empty model catalog");
		expect(provider.getModels().some((entry) => entry.id === "meta/known-good")).toBe(true);
	});

	test("streams through the openai responses api with meta model identity", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(metaResponsesSse("hello"), { status: 200, headers: { "content-type": "text/event-stream" } }),
		);
		const provider = metaProvider();
		const model = provider.getModels().find((entry) => entry.id === "muse-spark-1.1");
		if (!model) throw new Error("meta bundled model is missing");

		const result = await provider
			.stream(model, { messages: [{ role: "user", content: "say hello", timestamp: 1 }] }, { apiKey: "meta-test-key" })
			.result();
		expect(result).toMatchObject({ provider: "meta", model: "muse-spark-1.1", stopReason: "stop" });
		expect(result.content).toMatchObject([{ type: "text", text: "hello" }]);
		const request = fetchSpy.mock.calls[0];
		expect(request?.[0]).toBe("https://api.meta.ai/v1/responses");
		expect(request?.[1]?.method).toBe("POST");
	});
});
