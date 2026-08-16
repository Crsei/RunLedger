import { afterEach, describe, expect, test, vi } from "vitest";
import { InMemoryModelsStore, type ProviderModelsStore } from "../../src/models-store.ts";
import { zenmuxProvider } from "../../src/providers/zenmux.ts";
import { builtinModels, builtinProviders } from "../../src/providers/all.ts";

afterEach(() => {
	vi.restoreAllMocks();
});

function scopedStore(store: InMemoryModelsStore): ProviderModelsStore {
	return {
		read: () => store.read("zenmux"),
		write: (entry) => store.write("zenmux", entry),
		delete: () => store.delete("zenmux"),
	};
}

function catalogResponse(data: readonly Record<string, unknown>[]): Response {
	return new Response(JSON.stringify({ object: "list", data }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("ZenMux provider", () => {
	test("exposes the split bundled catalog and env-key auth", async () => {
		const provider = zenmuxProvider();

		expect(provider.id).toBe("zenmux");
		expect(provider.name).toBe("ZenMux");
		expect(provider.baseUrl).toBe("https://zenmux.ai/api/v1");
		expect(provider.getModels().find((entry) => entry.id === "anthropic/claude-3.5-haiku")).toMatchObject({
			api: "anthropic-messages",
			provider: "zenmux",
			baseUrl: "https://zenmux.ai/api/anthropic",
		});
		expect(provider.getModels().find((entry) => entry.id === "openai/gpt-4.1")).toMatchObject({
			api: "openai-completions",
			baseUrl: "https://zenmux.ai/api/v1",
		});

		const auth = await provider.auth.apiKey?.resolve({
			ctx: {
				env: async (name) => (name === "ZENMUX_API_KEY" ? "zenmux-test-key" : undefined),
				fileExists: async () => false,
			},
		});
		expect(auth).toEqual({ auth: { apiKey: "zenmux-test-key" }, source: "ZENMUX_API_KEY" });
	});

	test("is present in the builtin provider and model collections", () => {
		expect(builtinProviders().find((provider) => provider.id === "zenmux")?.name).toBe("ZenMux");
		expect(builtinModels().getModel("zenmux", "anthropic/claude-3.5-haiku")).toMatchObject({
			provider: "zenmux",
			api: "anthropic-messages",
		});
	});

	test("discovers models without a key and maps anthropic/openai entries", async () => {
		const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return catalogResponse([
				{
					id: "anthropic/claude-3.5-haiku",
					display_name: "Claude 3.5 Haiku",
					owned_by: "anthropic",
					capabilities: { reasoning: true },
					input_modalities: ["text", "image"],
					pricings: {
						prompt: [{ value: 0.8 }],
						completion: [{ value: 4 }],
						input_cache_read: [{ value: 0.08 }],
						input_cache_write_1_h: [{ value: 1 }],
					},
					context_length: 200000,
					max_completion_tokens: 64000,
				},
				{
					id: "openai/gpt-4.1",
					display_name: "GPT-4.1",
					owned_by: "openai",
					capabilities: { reasoning: false },
					input_modalities: ["text"],
					pricings: {
						prompt: [{ value: 2 }],
						completion: [{ value: 8 }],
						input_cache_read: [{ value: 0.5 }],
					},
					context_length: 1047576,
					max_completion_tokens: 32768,
				},
				{ id: "some-claude", owned_by: "anthropic", display_name: "Some Claude" },
			]);
		};
		const provider = zenmuxProvider({ fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("ZenMux provider must support model discovery");

		await refresh({
			store: scopedStore(new InMemoryModelsStore()),
			allowNetwork: true,
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			url: "https://zenmux.ai/api/v1/models",
			init: { method: "GET", headers: { Accept: "application/json" } },
		});
		expect(calls[0].init?.headers).not.toHaveProperty("Authorization");

		const models = provider.getModels();
		expect(models.find((entry) => entry.id === "anthropic/claude-3.5-haiku")).toMatchObject({
			name: "Claude 3.5 Haiku",
			api: "anthropic-messages",
			baseUrl: "https://zenmux.ai/api/anthropic",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
			contextWindow: 200000,
			maxTokens: 64000,
		});
		expect(models.find((entry) => entry.id === "openai/gpt-4.1")).toMatchObject({
			name: "GPT-4.1",
			api: "openai-completions",
			baseUrl: "https://zenmux.ai/api/v1",
			reasoning: false,
			cost: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 },
			contextWindow: 1047576,
			maxTokens: 32768,
		});
		expect(models.find((entry) => entry.id === "some-claude")).toMatchObject({
			name: "Some Claude",
			api: "anthropic-messages",
			baseUrl: "https://zenmux.ai/api/anthropic",
		});
	});

	test("rejects an empty catalog and keeps the last known good models", async () => {
		let response = catalogResponse([{ id: "zenmux/known-good" }]);
		const fetchImpl: typeof fetch = async () => response;
		const provider = zenmuxProvider({ fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("ZenMux provider must support model discovery");
		const store = scopedStore(new InMemoryModelsStore());
		const context = { store, allowNetwork: true };

		await refresh(context);
		expect(provider.getModels().some((entry) => entry.id === "zenmux/known-good")).toBe(true);

		response = catalogResponse([]);
		await expect(refresh(context)).rejects.toThrow("empty model catalog");
		expect(provider.getModels().some((entry) => entry.id === "zenmux/known-good")).toBe(true);
	});

	test("dispatches openai-completions models through the OpenAI adapter", async () => {
		const modelId = "openai/gpt-4.1";
		const responseBody = [
			`data: ${JSON.stringify({
				id: "chatcmpl-zenmux-test",
				object: "chat.completion.chunk",
				created: 1,
				model: modelId,
				choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }],
			})}`,
			`data: ${JSON.stringify({
				id: "chatcmpl-zenmux-test",
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
		const provider = zenmuxProvider();
		const model = provider.getModels().find((entry) => entry.id === modelId);
		if (!model) throw new Error("ZenMux bundled model is missing");

		const result = await provider
			.stream(
				model,
				{ messages: [{ role: "user", content: "say hello", timestamp: 1 }] },
				{ apiKey: "zenmux-test-key" },
			)
			.result();
		expect(result).toMatchObject({
			provider: "zenmux",
			model: modelId,
			stopReason: "stop",
		});
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
		const request = fetchSpy.mock.calls[0];
		expect(request?.[0]).toBe("https://zenmux.ai/api/v1/chat/completions");
	});

	test("dispatches anthropic-messages models through the Anthropic adapter", async () => {
		const modelId = "anthropic/claude-3.5-haiku";
		const responseBody = [
			`event: message_start\ndata: ${JSON.stringify({
				type: "message_start",
				message: {
					id: "msg_01",
					type: "message",
					role: "assistant",
					model: modelId,
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: 10, output_tokens: 1 },
				},
			})}`,
			`event: content_block_start\ndata: ${JSON.stringify({
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			})}`,
			`event: content_block_delta\ndata: ${JSON.stringify({
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "hello" },
			})}`,
			`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
			`event: message_delta\ndata: ${JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn", stop_sequence: null },
				usage: { output_tokens: 2 },
			})}`,
			`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
		].join("\n\n");
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(responseBody, { status: 200, headers: { "content-type": "text/event-stream" } }),
		);
		const provider = zenmuxProvider();
		const model = provider.getModels().find((entry) => entry.id === modelId);
		if (!model) throw new Error("ZenMux bundled model is missing");

		const result = await provider
			.stream(
				model,
				{ messages: [{ role: "user", content: "say hello", timestamp: 1 }] },
				{ apiKey: "zenmux-test-key" },
			)
			.result();
		expect(result).toMatchObject({
			provider: "zenmux",
			model: modelId,
			stopReason: "stop",
		});
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
		const request = fetchSpy.mock.calls[0];
		expect(request?.[0]).toBe("https://zenmux.ai/api/anthropic/v1/messages");
		const headers = request?.[1]?.headers;
		expect(headers instanceof Headers ? headers.get("x-api-key") : undefined).toBe("zenmux-test-key");
	});
});
