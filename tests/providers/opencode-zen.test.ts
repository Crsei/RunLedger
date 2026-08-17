import { afterEach, describe, expect, test, vi } from "vitest";
import { InMemoryModelsStore, type ProviderModelsStore } from "../../src/models-store.ts";
import { opencodeZenProvider } from "../../src/providers/opencode-zen.ts";
import { builtinModels, builtinProviders } from "../../src/providers/all.ts";

afterEach(() => {
	vi.restoreAllMocks();
});

function scopedStore(store: InMemoryModelsStore): ProviderModelsStore {
	return {
		read: () => store.read("opencode-zen"),
		write: (entry) => store.write("opencode-zen", entry),
		delete: () => store.delete("opencode-zen"),
	};
}

function catalogResponse(data: readonly Record<string, unknown>[]): Response {
	return new Response(JSON.stringify({ object: "list", data }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("OpenCode Zen provider", () => {
	test("exposes the bundled catalog with per-model baseUrls and env-key auth", async () => {
		const provider = opencodeZenProvider();

		expect(provider.id).toBe("opencode-zen");
		expect(provider.name).toBe("OpenCode Zen");
		expect(provider.baseUrl).toBe("https://opencode.ai/zen/v1");
		expect(provider.getModels().find((entry) => entry.id === "claude-opus-4-5")).toMatchObject({
			api: "anthropic-messages",
			provider: "opencode-zen",
			baseUrl: "https://opencode.ai/zen",
		});
		expect(provider.getModels().find((entry) => entry.id === "gemini-3-pro")).toMatchObject({
			api: "google-generative-ai",
			baseUrl: "https://opencode.ai/zen/v1",
		});
		expect(provider.getModels().find((entry) => entry.id === "minimax-m3")).toMatchObject({
			api: "openai-completions",
			baseUrl: "https://opencode.ai/zen/v1",
		});

		const auth = await provider.auth.apiKey?.resolve({
			ctx: {
				env: async (name) => (name === "OPENCODE_API_KEY" ? "zen-test-key" : undefined),
				fileExists: async () => false,
			},
		});
		expect(auth).toEqual({ auth: { apiKey: "zen-test-key" }, source: "OPENCODE_API_KEY" });
	});

	test("is present in the builtin provider and model collections", () => {
		expect(builtinProviders().find((provider) => provider.id === "opencode-zen")?.name).toBe("OpenCode Zen");
		expect(builtinModels().getModel("opencode-zen", "claude-opus-4-5")).toMatchObject({
			provider: "opencode-zen",
			api: "anthropic-messages",
		});
	});

	test("gates dynamic discovery behind an API key", async () => {
		const fetchImpl = vi.fn(async () => catalogResponse([]));
		const provider = opencodeZenProvider({ fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("OpenCode Zen provider must support model discovery");

		await expect(
			refresh({
				store: scopedStore(new InMemoryModelsStore()),
				allowNetwork: true,
			}),
		).rejects.toThrow("OpenCode Zen API key is not configured");
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	test("maps discovery entries for known models onto bundled api/baseUrl", async () => {
		const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return catalogResponse([
				{ id: "claude-opus-4-5", name: "claude-opus-4-5" },
				{ id: "gemini-3-pro", name: "gemini-3-pro" },
				{ id: "brand-new-model", name: "Brand New Model" },
			]);
		};
		const provider = opencodeZenProvider({ fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("OpenCode Zen provider must support model discovery");

		await refresh({
			credential: { type: "api_key", key: "zen-test-key" },
			store: scopedStore(new InMemoryModelsStore()),
			allowNetwork: true,
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			url: "https://opencode.ai/zen/v1/models",
			init: {
				method: "GET",
				headers: { Authorization: "Bearer zen-test-key", Accept: "application/json" },
			},
		});
		const models = provider.getModels();
		expect(models.find((entry) => entry.id === "claude-opus-4-5")).toMatchObject({
			api: "anthropic-messages",
			baseUrl: "https://opencode.ai/zen",
			reasoning: true,
		});
		expect(models.find((entry) => entry.id === "gemini-3-pro")).toMatchObject({
			api: "google-generative-ai",
			baseUrl: "https://opencode.ai/zen/v1",
		});
		expect(models.find((entry) => entry.id === "brand-new-model")).toMatchObject({
			name: "Brand New Model",
			api: "openai-completions",
			baseUrl: "https://opencode.ai/zen/v1",
		});
	});

	test("resolves unknown models via npm metadata rules", async () => {
		const fetchImpl: typeof fetch = async () =>
			catalogResponse([
				{ id: "new-anthropic", provider: { npm: "@ai-sdk/anthropic" } },
				{ id: "new-openai", provider: { npm: "@ai-sdk/openai" } },
				{ id: "new-google", provider: { npm: "@ai-sdk/google" } },
				{ id: "new-plain" },
			]);
		const provider = opencodeZenProvider({ fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("OpenCode Zen provider must support model discovery");

		await refresh({
			credential: { type: "api_key", key: "zen-test-key" },
			store: scopedStore(new InMemoryModelsStore()),
			allowNetwork: true,
		});

		const models = provider.getModels();
		expect(models.find((entry) => entry.id === "new-anthropic")).toMatchObject({
			api: "anthropic-messages",
			baseUrl: "https://opencode.ai/zen",
		});
		expect(models.find((entry) => entry.id === "new-openai")).toMatchObject({
			api: "openai-responses",
			baseUrl: "https://opencode.ai/zen/v1",
		});
		expect(models.find((entry) => entry.id === "new-google")).toMatchObject({
			api: "google-generative-ai",
			baseUrl: "https://opencode.ai/zen/v1",
		});
		expect(models.find((entry) => entry.id === "new-plain")).toMatchObject({
			api: "openai-completions",
			baseUrl: "https://opencode.ai/zen/v1",
		});
	});

	test("keeps minimax-m3 on openai-completions despite anthropic npm metadata", async () => {
		const fetchImpl: typeof fetch = async () =>
			catalogResponse([
				{ id: "minimax-m3", provider: { npm: "@ai-sdk/anthropic" } },
				{ id: "minimax-m3-free", provider: { npm: "@ai-sdk/anthropic" } },
			]);
		const provider = opencodeZenProvider({ fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("OpenCode Zen provider must support model discovery");

		await refresh({
			credential: { type: "api_key", key: "zen-test-key" },
			store: scopedStore(new InMemoryModelsStore()),
			allowNetwork: true,
		});

		const models = provider.getModels();
		for (const modelId of ["minimax-m3", "minimax-m3-free"]) {
			expect(models.find((entry) => entry.id === modelId)).toMatchObject({
				api: "openai-completions",
				baseUrl: "https://opencode.ai/zen/v1",
			});
		}
	});

	test("rejects an empty catalog and keeps the last known good models", async () => {
		let response = catalogResponse([{ id: "opencode-zen/known-good" }]);
		const fetchImpl: typeof fetch = async () => response;
		const provider = opencodeZenProvider({ fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("OpenCode Zen provider must support model discovery");
		const store = scopedStore(new InMemoryModelsStore());
		const context = {
			credential: { type: "api_key" as const, key: "zen-test-key" },
			store,
			allowNetwork: true,
		};

		await refresh(context);
		expect(provider.getModels().some((entry) => entry.id === "opencode-zen/known-good")).toBe(true);

		response = catalogResponse([]);
		await expect(refresh(context)).rejects.toThrow("empty model catalog");
		expect(provider.getModels().some((entry) => entry.id === "opencode-zen/known-good")).toBe(true);
	});

	test("streams an openai-completions model through the shared adapter", async () => {
		const modelId = "deepseek-v4-flash";
		const responseBody = [
			`data: ${JSON.stringify({
				id: "chatcmpl-zen-test",
				object: "chat.completion.chunk",
				created: 1,
				model: modelId,
				choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }],
			})}`,
			`data: ${JSON.stringify({
				id: "chatcmpl-zen-test",
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
		const provider = opencodeZenProvider();
		const model = provider.getModels().find((entry) => entry.id === modelId);
		if (!model) throw new Error("OpenCode Zen bundled model is missing");

		const result = await provider
			.stream(
				model,
				{ messages: [{ role: "user", content: "say hello", timestamp: 1 }] },
				{ apiKey: "zen-test-key" },
			)
			.result();
		expect(result).toMatchObject({
			provider: "opencode-zen",
			model: modelId,
			stopReason: "stop",
		});
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
		const request = fetchSpy.mock.calls[0];
		expect(request?.[0]).toBe("https://opencode.ai/zen/v1/chat/completions");
	});
});
