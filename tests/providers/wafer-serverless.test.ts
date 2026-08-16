import { afterEach, describe, expect, test, vi } from "vitest";
import { InMemoryModelsStore, type ProviderModelsStore } from "../../src/models-store.ts";
import { MODELS } from "../../src/models.generated.ts";
import { waferServerlessProvider } from "../../src/providers/wafer-serverless.ts";

const WAFER_BASE = "https://pass.wafer.ai/v1";

afterEach(() => {
	vi.restoreAllMocks();
});

function scopedStore(store: InMemoryModelsStore): ProviderModelsStore {
	return {
		read: () => store.read("wafer-serverless"),
		write: (entry) => store.write("wafer-serverless", entry),
		delete: () => store.delete("wafer-serverless"),
	};
}

function waferResponse(data: readonly Record<string, unknown>[]): Response {
	return new Response(JSON.stringify({ object: "list", data }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("wafer-serverless provider", () => {
	test("exposes the bundled catalog, base URL, and env-key auth", async () => {
		const provider = waferServerlessProvider();

		expect(provider.id).toBe("wafer-serverless");
		expect(provider.name).toBe("Wafer Serverless");
		expect(provider.baseUrl).toBe(WAFER_BASE);
		expect(provider.getModels().find((entry) => entry.id === "DeepSeek-V4-Pro")).toMatchObject({
			api: "openai-completions",
			provider: "wafer-serverless",
			baseUrl: WAFER_BASE,
		});

		const auth = await provider.auth.apiKey?.resolve({
			ctx: { env: async (name) => (name === "WAFER_SERVERLESS_API_KEY" ? "wafer-test-key" : undefined), fileExists: async () => false },
		});
		expect(auth).toEqual({ auth: { apiKey: "wafer-test-key" }, source: "WAFER_SERVERLESS_API_KEY" });
	});

	test("is present in the generated builtin catalog", () => {
		expect(MODELS["wafer-serverless"]).toBeDefined();
		expect(MODELS["wafer-serverless"]?.["Kimi-K2.7-Code"]).toMatchObject({
			provider: "wafer-serverless",
			api: "openai-completions",
		});
	});

	test("maps the wafer envelope: capabilities, pricing, display name, and token cap", async () => {
		const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return waferResponse([
				{
					id: "DeepSeek-V4-Flash-0731-Fast",
					wafer: {
						context_length: 131072,
						capabilities: { vision: true, reasoning: true, tools: true },
						pricing: {
							input_cents_per_million: 28,
							output_cents_per_million: 56,
							cache_read_cents_per_million: 7,
						},
						display_name: "DeepSeek V4 Flash Fast",
					},
				},
			]);
		};
		const provider = waferServerlessProvider({ fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("wafer-serverless provider must support model discovery");

		await refresh({
			credential: { type: "api_key", key: "wafer-test-key" },
			store: scopedStore(new InMemoryModelsStore()),
			allowNetwork: true,
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			url: `${WAFER_BASE}/models`,
			init: {
				method: "GET",
				headers: { Authorization: "Bearer wafer-test-key", Accept: "application/json" },
			},
		});
		expect(provider.getModels().find((entry) => entry.id === "DeepSeek-V4-Flash-0731-Fast")).toMatchObject({
			name: "DeepSeek V4 Flash Fast",
			provider: "wafer-serverless",
			baseUrl: WAFER_BASE,
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 131072,
			maxTokens: 65536,
			cost: { input: 0.35, output: 0.7, cacheRead: 0.0875, cacheWrite: 0 },
			compat: { supportsDeveloperRole: false },
		});
	});

	test("caps max tokens at 65536 and defaults reasoning/vision off without envelope flags", async () => {
		const fetchImpl: typeof fetch = async () =>
			waferResponse([
				{ id: "wafer-small", wafer: { context_length: 10000, display_name: "Wafer Small" } },
				{ id: "wafer-huge", wafer: { context_length: 1000000, display_name: "Wafer Huge" } },
			]);
		const provider = waferServerlessProvider({ fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("wafer-serverless provider must support model discovery");

		await refresh({
			credential: { type: "api_key", key: "wafer-test-key" },
			store: scopedStore(new InMemoryModelsStore()),
			allowNetwork: true,
		});

		expect(provider.getModels().find((entry) => entry.id === "wafer-small")).toMatchObject({
			name: "Wafer Small",
			reasoning: false,
			input: ["text"],
			contextWindow: 10000,
			maxTokens: 10000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		expect(provider.getModels().find((entry) => entry.id === "wafer-huge")).toMatchObject({
			contextWindow: 1000000,
			maxTokens: 65536,
		});
	});

	test("rejects an empty catalog and keeps the last known good models", async () => {
		let response = waferResponse([{ id: "wafer/known-good", wafer: { display_name: "Known Good" } }]);
		const fetchImpl: typeof fetch = async () => response;
		const provider = waferServerlessProvider({ fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("wafer-serverless provider must support model discovery");
		const store = scopedStore(new InMemoryModelsStore());
		const context = {
			credential: { type: "api_key" as const, key: "wafer-test-key" },
			store,
			allowNetwork: true,
		};

		await refresh(context);
		expect(provider.getModels().some((entry) => entry.id === "wafer/known-good")).toBe(true);

		response = waferResponse([]);
		await expect(refresh(context)).rejects.toThrow("empty model catalog");
		expect(provider.getModels().some((entry) => entry.id === "wafer/known-good")).toBe(true);
	});

	test("uses the existing OpenAI completions stream with wafer-serverless model identity", async () => {
		const modelId = "DeepSeek-V4-Pro";
		const responseBody = [
			`data: ${JSON.stringify({
				id: "chatcmpl-wafer-test",
				object: "chat.completion.chunk",
				created: 1,
				model: modelId,
				choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }],
			})}`,
			`data: ${JSON.stringify({
				id: "chatcmpl-wafer-test",
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
		const provider = waferServerlessProvider();
		const model = provider.getModels().find((entry) => entry.id === modelId);
		if (!model) throw new Error("wafer-serverless bundled model is missing");

		const result = await provider
			.stream(
				model,
				{ messages: [{ role: "user", content: "say hello", timestamp: 1 }] },
				{ apiKey: "wafer-test-key" },
			)
			.result();
		expect(result).toMatchObject({
			provider: "wafer-serverless",
			model: modelId,
			stopReason: "stop",
		});
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
		const request = fetchSpy.mock.calls[0];
		expect(request?.[0]).toBe(`${WAFER_BASE}/chat/completions`);
		expect(request?.[1]?.method).toBe("POST");
		const headers = request?.[1]?.headers;
		expect(headers instanceof Headers ? headers.get("authorization") : undefined).toBe("Bearer wafer-test-key");
	});
});
