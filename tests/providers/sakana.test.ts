import { afterEach, describe, expect, test, vi } from "vitest";
import { InMemoryModelsStore, type ProviderModelsStore } from "../../src/models-store.ts";
import { sakanaProvider } from "../../src/providers/sakana.ts";
import { builtinModels, builtinProviders } from "../../src/providers/all.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

function scopedStore(store: InMemoryModelsStore): ProviderModelsStore {
	return {
		read: () => store.read("sakana"),
		write: (entry) => store.write("sakana", entry),
		delete: () => store.delete("sakana"),
	};
}

function sakanaResponse(data: readonly Record<string, unknown>[]): Response {
	return new Response(JSON.stringify({ object: "list", data }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function sakanaResponsesSse(text: string): string {
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

describe("sakana provider", () => {
	test("exposes the bundled catalog and env-key auth", async () => {
		const provider = sakanaProvider();
		const model = provider.getModels().find((entry) => entry.id === "fugu-ultra");

		expect(provider.id).toBe("sakana");
		expect(provider.name).toBe("Sakana AI");
		expect(provider.baseUrl).toBe("https://api.sakana.ai/v1");
		expect(model).toMatchObject({
			api: "openai-responses",
			provider: "sakana",
			baseUrl: "https://api.sakana.ai/v1",
			reasoning: true,
		});

		const auth = await provider.auth.apiKey?.resolve({
			ctx: { env: async (name) => (name === "SAKANA_API_KEY" ? "sakana-test-key" : undefined), fileExists: async () => false },
		});
		expect(auth).toEqual({ auth: { apiKey: "sakana-test-key" }, source: "SAKANA_API_KEY" });

		const fallback = await provider.auth.apiKey?.resolve({
			ctx: { env: async (name) => (name === "FUGU_API_KEY" ? "fugu-test-key" : undefined), fileExists: async () => false },
		});
		expect(fallback).toEqual({ auth: { apiKey: "fugu-test-key" }, source: "FUGU_API_KEY" });
	});

	test("is present in the builtin provider and model collections", () => {
		expect(builtinProviders().find((provider) => provider.id === "sakana")?.name).toBe("Sakana AI");
		expect(builtinModels().getModel("sakana", "fugu")).toMatchObject({
			provider: "sakana",
			api: "openai-responses",
		});
	});

	test("resolves the base URL from env and appends /v1", () => {
		vi.stubEnv("FUGU_BASE_URL", "https://fugu.sakana.test");
		expect(sakanaProvider().baseUrl).toBe("https://fugu.sakana.test/v1");

		vi.stubEnv("SAKANA_BASE_URL", "https://env.sakana.test/v1");
		expect(sakanaProvider().baseUrl).toBe("https://env.sakana.test/v1");
	});

	test("maps authenticated model metadata and marks new fugu models as reasoning", async () => {
		const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return sakanaResponse([
				{ id: "fugu-ultra-v1.1", name: "Fugu Ultra v1.1", context_length: 1000000, max_completion_tokens: 65536 },
				{ id: "fugu-ultra", name: "Fugu Ultra" },
			]);
		};
		const provider = sakanaProvider({ baseUrl: "https://config.sakana.test", fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("sakana provider must support model discovery");

		await refresh({
			credential: { type: "api_key", key: "sakana-test-key" },
			store: scopedStore(new InMemoryModelsStore()),
			allowNetwork: true,
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			url: "https://config.sakana.test/v1/models",
			init: { method: "GET", headers: { Authorization: "Bearer sakana-test-key", Accept: "application/json" } },
		});
		expect(provider.getModels().find((entry) => entry.id === "fugu-ultra-v1.1")).toMatchObject({
			name: "Fugu Ultra v1.1",
			provider: "sakana",
			baseUrl: "https://config.sakana.test/v1",
			reasoning: true,
			contextWindow: 1000000,
			maxTokens: 65536,
		});
		// 已知 id 的动态条目继承静态 metadata
		expect(provider.getModels().find((entry) => entry.id === "fugu-ultra")).toMatchObject({
			name: "Fugu Ultra",
			reasoning: true,
			cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
		});
	});

	test("rejects an empty catalog and keeps the last known good models", async () => {
		let response = sakanaResponse([{ id: "sakana/known-good" }]);
		const fetchImpl: typeof fetch = async () => response;
		const provider = sakanaProvider({ fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("sakana provider must support model discovery");
		const store = scopedStore(new InMemoryModelsStore());
		const context = { credential: { type: "api_key" as const, key: "sakana-test-key" }, store, allowNetwork: true };

		await refresh(context);
		expect(provider.getModels().some((entry) => entry.id === "sakana/known-good")).toBe(true);

		response = sakanaResponse([]);
		await expect(refresh(context)).rejects.toThrow("empty model catalog");
		expect(provider.getModels().some((entry) => entry.id === "sakana/known-good")).toBe(true);
	});

	test("streams through the openai responses api with sakana model identity", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(sakanaResponsesSse("hello"), { status: 200, headers: { "content-type": "text/event-stream" } }),
		);
		const provider = sakanaProvider();
		const model = provider.getModels().find((entry) => entry.id === "fugu");
		if (!model) throw new Error("sakana bundled model is missing");

		const result = await provider
			.stream(model, { messages: [{ role: "user", content: "say hello", timestamp: 1 }] }, { apiKey: "sakana-test-key" })
			.result();
		expect(result).toMatchObject({ provider: "sakana", model: "fugu", stopReason: "stop" });
		expect(result.content).toMatchObject([{ type: "text", text: "hello" }]);
		const request = fetchSpy.mock.calls[0];
		expect(request?.[0]).toBe("https://api.sakana.ai/v1/responses");
		expect(request?.[1]?.method).toBe("POST");
	});
});
