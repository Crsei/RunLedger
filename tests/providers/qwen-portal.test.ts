import { afterEach, describe, expect, test, vi } from "vitest";
import { InMemoryModelsStore, type ProviderModelsStore } from "../../src/models-store.ts";
import { MODELS } from "../../src/models.generated.ts";
import { qwenPortalProvider } from "../../src/providers/qwen-portal.ts";

afterEach(() => {
	vi.restoreAllMocks();
});

function scopedStore(store: InMemoryModelsStore): ProviderModelsStore {
	return {
		read: () => store.read("qwen-portal"),
		write: (entry) => store.write("qwen-portal", entry),
		delete: () => store.delete("qwen-portal"),
	};
}

function qwenPortalResponse(data: readonly Record<string, unknown>[]): Response {
	return new Response(JSON.stringify({ object: "list", data }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("qwen-portal provider", () => {
	test("exposes the bundled catalog, base URL, and oauth-token-first auth", async () => {
		const provider = qwenPortalProvider();

		expect(provider.id).toBe("qwen-portal");
		expect(provider.name).toBe("Qwen Portal");
		expect(provider.baseUrl).toBe("https://portal.qwen.ai/v1");
		expect(provider.getModels().find((entry) => entry.id === "coder-model")).toMatchObject({
			api: "openai-completions",
			provider: "qwen-portal",
			baseUrl: "https://portal.qwen.ai/v1",
		});

		const auth = await provider.auth.apiKey?.resolve({
			ctx: { env: async (name) => (name === "QWEN_OAUTH_TOKEN" ? "qp-oauth-token" : undefined), fileExists: async () => false },
		});
		expect(auth).toEqual({ auth: { apiKey: "qp-oauth-token" }, source: "QWEN_OAUTH_TOKEN" });
	});

	test("is present in the generated builtin catalog", () => {
		expect(MODELS["qwen-portal"]).toBeDefined();
		expect(MODELS["qwen-portal"]?.["vision-model"]).toMatchObject({
			provider: "qwen-portal",
			api: "openai-completions",
		});
	});

	test("falls back to QWEN_PORTAL_API_KEY when the oauth token is unset", async () => {
		const provider = qwenPortalProvider();
		const auth = await provider.auth.apiKey?.resolve({
			ctx: { env: async (name) => (name === "QWEN_PORTAL_API_KEY" ? "qp-portal-key" : undefined), fileExists: async () => false },
		});
		expect(auth).toEqual({ auth: { apiKey: "qp-portal-key" }, source: "QWEN_PORTAL_API_KEY" });
	});

	test("maps authenticated model metadata to a target model", async () => {
		const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return qwenPortalResponse([
				{ id: "coder-model", name: "Qwen Coder", context_length: 160000, max_completion_tokens: 12000 },
				{ id: "qwen3-test", name: "Qwen3 Test" },
			]);
		};
		const provider = qwenPortalProvider({ fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("qwen-portal provider must support model discovery");

		await refresh({
			credential: { type: "api_key", key: "qp-test-key" },
			store: scopedStore(new InMemoryModelsStore()),
			allowNetwork: true,
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			url: "https://portal.qwen.ai/v1/models",
			init: {
				method: "GET",
				headers: { Authorization: "Bearer qp-test-key", Accept: "application/json" },
			},
		});
		expect(provider.getModels().find((entry) => entry.id === "coder-model")).toMatchObject({
			name: "Qwen Coder",
			provider: "qwen-portal",
			baseUrl: "https://portal.qwen.ai/v1",
			contextWindow: 160000,
			maxTokens: 12000,
		});
		expect(provider.getModels().find((entry) => entry.id === "qwen3-test")).toMatchObject({
			name: "Qwen3 Test",
			contextWindow: 4096,
			maxTokens: 4096,
		});
	});

	test("rejects an empty catalog and keeps the last known good models", async () => {
		let response = qwenPortalResponse([{ id: "portal/known-good", name: "Known Good" }]);
		const fetchImpl: typeof fetch = async () => response;
		const provider = qwenPortalProvider({ fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("qwen-portal provider must support model discovery");
		const store = scopedStore(new InMemoryModelsStore());
		const context = {
			credential: { type: "api_key" as const, key: "qp-test-key" },
			store,
			allowNetwork: true,
		};

		await refresh(context);
		expect(provider.getModels().some((entry) => entry.id === "portal/known-good")).toBe(true);

		response = qwenPortalResponse([]);
		await expect(refresh(context)).rejects.toThrow("empty model catalog");
		expect(provider.getModels().some((entry) => entry.id === "portal/known-good")).toBe(true);
	});

	test("uses the existing OpenAI completions stream with qwen-portal model identity", async () => {
		const modelId = "coder-model";
		const responseBody = [
			`data: ${JSON.stringify({
				id: "chatcmpl-qp-test",
				object: "chat.completion.chunk",
				created: 1,
				model: modelId,
				choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }],
			})}`,
			`data: ${JSON.stringify({
				id: "chatcmpl-qp-test",
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
		const provider = qwenPortalProvider();
		const model = provider.getModels().find((entry) => entry.id === modelId);
		if (!model) throw new Error("qwen-portal bundled model is missing");

		const result = await provider
			.stream(
				model,
				{ messages: [{ role: "user", content: "say hello", timestamp: 1 }] },
				{ apiKey: "qp-test-key" },
			)
			.result();
		expect(result).toMatchObject({
			provider: "qwen-portal",
			model: modelId,
			stopReason: "stop",
		});
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
		const request = fetchSpy.mock.calls[0];
		expect(request?.[0]).toBe("https://portal.qwen.ai/v1/chat/completions");
		expect(request?.[1]?.method).toBe("POST");
		const headers = request?.[1]?.headers;
		expect(headers instanceof Headers ? headers.get("authorization") : undefined).toBe("Bearer qp-test-key");
	});
});
