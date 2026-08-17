import { afterEach, describe, expect, test, vi } from "vitest";
import { MODELS } from "../../src/models.generated.ts";
import { InMemoryModelsStore, type ProviderModelsStore } from "../../src/models-store.ts";
import { veniceProvider } from "../../src/providers/venice.ts";

const VENICE_BASE_URL = "https://api.venice.ai/api/v1";

afterEach(() => {
	vi.restoreAllMocks();
});

function scopedStore(store: InMemoryModelsStore): ProviderModelsStore {
	return {
		read: () => store.read("venice"),
		write: (entry) => store.write("venice", entry),
		delete: () => store.delete("venice"),
	};
}

function modelsResponse(data: readonly Record<string, unknown>[]): Response {
	return new Response(JSON.stringify({ object: "list", data }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("venice provider", () => {
	test("exposes the bundled OpenAI-compatible catalog with streaming-usage compat", () => {
		const provider = veniceProvider();
		const model = provider.getModels().find((entry) => entry.id === "aion-labs-aion-2-0");

		expect(provider.id).toBe("venice");
		expect(provider.name).toBe("Venice");
		expect(provider.baseUrl).toBe(VENICE_BASE_URL);
		expect(model).toMatchObject({
			api: "openai-completions",
			provider: "venice",
			baseUrl: VENICE_BASE_URL,
			compat: { supportsUsageInStreaming: false },
		});
		expect(provider.getModels().length).toBe(134);
	});

	test("is present in the builtin generated model catalog", () => {
		const catalog = MODELS["venice"] as Record<string, { provider?: string; api?: string }> | undefined;
		expect(catalog?.["aion-labs-aion-2-0"]).toMatchObject({
			provider: "venice",
			api: "openai-completions",
		});
	});

	test("resolves the env-key auth and reports unconfigured without a key", async () => {
		const provider = veniceProvider();
		const auth = await provider.auth.apiKey?.resolve({
			ctx: {
				env: async (name) => (name === "VENICE_API_KEY" ? "venice-key" : undefined),
				fileExists: async () => false,
			},
			credential: undefined,
		});
		expect(auth).toEqual({ auth: { apiKey: "venice-key" }, source: "VENICE_API_KEY" });

		const unconfigured = await provider.auth.apiKey?.resolve({
			ctx: {
				env: async () => undefined,
				fileExists: async () => false,
			},
			credential: undefined,
		});
		expect(unconfigured).toBeUndefined();
	});

	test("discovers models with a credential, sending the Authorization header", async () => {
		const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return modelsResponse([{ id: "venice/new-model", name: "New Venice Model" }]);
		};
		const provider = veniceProvider({ fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("venice provider must support model discovery");

		await refresh({
			credential: { type: "api_key", key: "venice-key" },
			store: scopedStore(new InMemoryModelsStore()),
			allowNetwork: true,
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(`${VENICE_BASE_URL}/models`);
		expect(calls[0]?.init?.headers).toMatchObject({
			Accept: "application/json",
			Authorization: "Bearer venice-key",
		});
		expect(provider.getModels().find((entry) => entry.id === "venice/new-model")).toMatchObject({
			name: "New Venice Model",
			provider: "venice",
			baseUrl: VENICE_BASE_URL,
		});
	});

	test("discovery is not gated: runs without a credential and omits Authorization", async () => {
		const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return modelsResponse([{ id: "llama-3.3-70b" }]);
		};
		const provider = veniceProvider({ fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("venice provider must support model discovery");

		await refresh({
			store: scopedStore(new InMemoryModelsStore()),
			allowNetwork: true,
		});

		expect(calls).toHaveLength(1);
		const headers = calls[0]?.init?.headers as Record<string, string> | undefined;
		expect(headers).toMatchObject({ Accept: "application/json" });
		expect(headers?.["Authorization"]).toBeUndefined();
		expect(provider.getModels().some((entry) => entry.id === "llama-3.3-70b")).toBe(true);
	});

	test("rejects an empty catalog and keeps the last known good models", async () => {
		let response = modelsResponse([{ id: "venice/known-good" }]);
		const fetchImpl: typeof fetch = async () => response;
		const provider = veniceProvider({ fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("venice provider must support model discovery");
		const store = scopedStore(new InMemoryModelsStore());
		const context = { store, allowNetwork: true };

		await refresh(context);
		expect(provider.getModels().some((entry) => entry.id === "venice/known-good")).toBe(true);

		response = modelsResponse([]);
		await expect(refresh(context)).rejects.toThrow("empty model catalog");
		expect(provider.getModels().some((entry) => entry.id === "venice/known-good")).toBe(true);
	});

	test("uses the existing OpenAI completions stream with venice model identity", async () => {
		const modelId = "aion-labs-aion-2-0";
		const responseBody = [
			`data: ${JSON.stringify({
				id: "chatcmpl-venice-test",
				object: "chat.completion.chunk",
				created: 1,
				model: modelId,
				choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }],
			})}`,
			`data: ${JSON.stringify({
				id: "chatcmpl-venice-test",
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
		const provider = veniceProvider();
		const model = provider.getModels().find((entry) => entry.id === modelId);
		if (!model) throw new Error("venice bundled model is missing");

		const result = await provider
			.stream(
				model,
				{ messages: [{ role: "user", content: "say hello", timestamp: 1 }] },
				{ apiKey: "venice-key" },
			)
			.result();
		expect(result).toMatchObject({
			provider: "venice",
			model: modelId,
			stopReason: "stop",
		});
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
		const request = fetchSpy.mock.calls[0];
		expect(request?.[0]).toBe(`${VENICE_BASE_URL}/chat/completions`);
		expect(request?.[1]?.method).toBe("POST");
		const headers = request?.[1]?.headers;
		expect(headers instanceof Headers ? headers.get("authorization") : undefined).toBe("Bearer venice-key");
	});
});
