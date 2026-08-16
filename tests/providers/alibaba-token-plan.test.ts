import { afterEach, describe, expect, test, vi } from "vitest";
import { InMemoryModelsStore, type ProviderModelsStore } from "../../src/models-store.ts";
import { MODELS } from "../../src/models.generated.ts";
import { alibabaTokenPlanProvider } from "../../src/providers/alibaba-token-plan.ts";

const TOKEN_PLAN_INTL_BASE = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";
const TOKEN_PLAN_CN_BASE = "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

function scopedStore(store: InMemoryModelsStore): ProviderModelsStore {
	return {
		read: () => store.read("alibaba-token-plan"),
		write: (entry) => store.write("alibaba-token-plan", entry),
		delete: () => store.delete("alibaba-token-plan"),
	};
}

function tokenPlanResponse(data: readonly Record<string, unknown>[]): Response {
	return new Response(JSON.stringify({ object: "list", data }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("alibaba-token-plan provider", () => {
	test("exposes the bundled catalog, intl base URL, and env-key auth", async () => {
		const provider = alibabaTokenPlanProvider();

		expect(provider.id).toBe("alibaba-token-plan");
		expect(provider.name).toBe("QwenCloud Token Plan");
		expect(provider.baseUrl).toBe(TOKEN_PLAN_INTL_BASE);
		expect(provider.getModels().find((entry) => entry.id === "qwen3.7-plus")).toMatchObject({
			api: "openai-completions",
			provider: "alibaba-token-plan",
			baseUrl: TOKEN_PLAN_INTL_BASE,
		});

		const auth = await provider.auth.apiKey?.resolve({
			ctx: { env: async (name) => (name === "ALIBABA_TOKEN_PLAN_API_KEY" ? "sk-first" : undefined), fileExists: async () => false },
		});
		expect(auth).toEqual({ auth: { apiKey: "sk-first" }, source: "ALIBABA_TOKEN_PLAN_API_KEY" });
	});

	test("is present in the generated builtin catalog", () => {
		expect(MODELS["alibaba-token-plan"]).toBeDefined();
		expect(MODELS["alibaba-token-plan"]?.["qwen3.8-max"]).toMatchObject({
			provider: "alibaba-token-plan",
			api: "openai-completions",
		});
	});

	test("falls back to the BAILIAN env var when the first is unset", async () => {
		const provider = alibabaTokenPlanProvider();
		const auth = await provider.auth.apiKey?.resolve({
			ctx: { env: async (name) => (name === "BAILIAN_TOKEN_PLAN_API_KEY" ? "sk-bailian" : undefined), fileExists: async () => false },
		});
		expect(auth).toEqual({ auth: { apiKey: "sk-bailian" }, source: "BAILIAN_TOKEN_PLAN_API_KEY" });
	});

	test("parses a stored JSON credential, ignoring cookie for wire auth", async () => {
		const provider = alibabaTokenPlanProvider();
		const auth = await provider.auth.apiKey?.resolve({
			ctx: { env: async () => undefined, fileExists: async () => false },
			credential: {
				type: "api_key",
				key: JSON.stringify({ token: "sk-abc123", cookie: "quota=1", baseUrl: TOKEN_PLAN_CN_BASE }),
			},
		});
		expect(auth).toEqual({
			auth: { apiKey: "sk-abc123", baseUrl: TOKEN_PLAN_CN_BASE },
			source: "stored credential",
		});
	});

	test("resolves a bare token with an env base URL override", async () => {
		const provider = alibabaTokenPlanProvider();
		const auth = await provider.auth.apiKey?.resolve({
			ctx: { env: async (name) => (name === "ALIBABA_TOKEN_PLAN_BASE_URL" ? TOKEN_PLAN_CN_BASE : undefined), fileExists: async () => false },
			credential: { type: "api_key", key: "sk-bare" },
		});
		expect(auth).toEqual({
			auth: { apiKey: "sk-bare", baseUrl: TOKEN_PLAN_CN_BASE },
			source: "stored credential",
		});
	});

	test("discovers chat models at the credential base URL and filters non-chat prefixes", async () => {
		const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return tokenPlanResponse([
				{ id: "fun-asr-test", name: "fun-asr-test" },
				{ id: "text-embedding-v4", name: "text-embedding-v4" },
				{ id: "qwen3.7-plus", name: "Qwen3.7 Plus", context_length: 2000000, max_completion_tokens: 128000 },
				{ id: "brand-new-model", name: "Brand New Model" },
			]);
		};
		const provider = alibabaTokenPlanProvider({ fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("alibaba-token-plan provider must support model discovery");

		await refresh({
			credential: { type: "api_key", key: JSON.stringify({ token: "sk-abc123", baseUrl: TOKEN_PLAN_CN_BASE }) },
			store: scopedStore(new InMemoryModelsStore()),
			allowNetwork: true,
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			url: `${TOKEN_PLAN_CN_BASE}/models`,
			init: {
				method: "GET",
				headers: { Authorization: "Bearer sk-abc123", Accept: "application/json" },
			},
		});
		const models = provider.getModels();
		expect(models.some((entry) => entry.id === "fun-asr-test")).toBe(false);
		expect(models.some((entry) => entry.id === "text-embedding-v4")).toBe(false);
		expect(models.find((entry) => entry.id === "qwen3.7-plus")).toMatchObject({
			name: "Qwen3.7 Plus",
			provider: "alibaba-token-plan",
			baseUrl: TOKEN_PLAN_CN_BASE,
			contextWindow: 2000000,
			maxTokens: 128000,
			reasoning: true,
			input: ["text", "image"],
			compat: { supportsDeveloperRole: false },
		});
		expect(models.find((entry) => entry.id === "brand-new-model")).toMatchObject({
			name: "Brand New Model",
			contextWindow: 4096,
			maxTokens: 4096,
		});
	});

	test("rejects an empty catalog and keeps the last known good models", async () => {
		let response = tokenPlanResponse([{ id: "token-plan/known-good", name: "Known Good" }]);
		const fetchImpl: typeof fetch = async () => response;
		const provider = alibabaTokenPlanProvider({ fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("alibaba-token-plan provider must support model discovery");
		const store = scopedStore(new InMemoryModelsStore());
		const context = {
			credential: { type: "api_key" as const, key: "sk-known-good" },
			store,
			allowNetwork: true,
		};

		await refresh(context);
		expect(provider.getModels().some((entry) => entry.id === "token-plan/known-good")).toBe(true);

		response = tokenPlanResponse([]);
		await expect(refresh(context)).rejects.toThrow("empty model catalog");
		expect(provider.getModels().some((entry) => entry.id === "token-plan/known-good")).toBe(true);
	});

	test("uses the existing OpenAI completions stream with alibaba-token-plan model identity", async () => {
		const modelId = "qwen3.7-plus";
		const responseBody = [
			`data: ${JSON.stringify({
				id: "chatcmpl-tp-test",
				object: "chat.completion.chunk",
				created: 1,
				model: modelId,
				choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }],
			})}`,
			`data: ${JSON.stringify({
				id: "chatcmpl-tp-test",
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
		const provider = alibabaTokenPlanProvider();
		const model = provider.getModels().find((entry) => entry.id === modelId);
		if (!model) throw new Error("alibaba-token-plan bundled model is missing");

		const result = await provider
			.stream(
				model,
				{ messages: [{ role: "user", content: "say hello", timestamp: 1 }] },
				{ apiKey: "sk-abc123" },
			)
			.result();
		expect(result).toMatchObject({
			provider: "alibaba-token-plan",
			model: modelId,
			stopReason: "stop",
		});
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
		const request = fetchSpy.mock.calls[0];
		expect(request?.[0]).toBe(`${TOKEN_PLAN_INTL_BASE}/chat/completions`);
		expect(request?.[1]?.method).toBe("POST");
		const headers = request?.[1]?.headers;
		expect(headers instanceof Headers ? headers.get("authorization") : undefined).toBe("Bearer sk-abc123");
	});
});
