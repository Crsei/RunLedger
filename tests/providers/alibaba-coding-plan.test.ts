import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AuthInteraction, AuthPrompt } from "../../src/auth/types.ts";
import { InMemoryModelsStore, type ProviderModelsStore } from "../../src/models-store.ts";
import { MODELS } from "../../src/models.generated.ts";
import { alibabaCodingPlanProvider } from "../../src/providers/alibaba-coding-plan.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

beforeEach(() => {
	// 保证发现路径不依赖宿主机的 ALIBABA_CODING_PLAN_BASE_URL
	vi.stubEnv("ALIBABA_CODING_PLAN_BASE_URL", "");
});

function scopedStore(store: InMemoryModelsStore): ProviderModelsStore {
	return {
		read: () => store.read("alibaba-coding-plan"),
		write: (entry) => store.write("alibaba-coding-plan", entry),
		delete: () => store.delete("alibaba-coding-plan"),
	};
}

function codingPlanResponse(data: readonly Record<string, unknown>[]): Response {
	return new Response(JSON.stringify({ object: "list", data }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

const AUTH_CTX = { env: async () => undefined, fileExists: async () => false };

describe("alibaba-coding-plan provider", () => {
	test("exposes the bundled catalog, intl base URL, and env-key auth", async () => {
		const provider = alibabaCodingPlanProvider();

		expect(provider.id).toBe("alibaba-coding-plan");
		expect(provider.name).toBe("Alibaba Coding Plan");
		expect(provider.baseUrl).toBe("https://coding-intl.dashscope.aliyuncs.com/v1");
		expect(provider.getModels().find((entry) => entry.id === "qwen3.7-max")).toMatchObject({
			api: "openai-completions",
			provider: "alibaba-coding-plan",
			baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
		});

		const auth = await provider.auth.apiKey?.resolve({
			ctx: { env: async (name) => (name === "ALIBABA_CODING_PLAN_API_KEY" ? "acp-test-key" : undefined), fileExists: async () => false },
		});
		expect(auth).toEqual({ auth: { apiKey: "acp-test-key" }, source: "ALIBABA_CODING_PLAN_API_KEY" });
	});

	test("is present in the generated builtin catalog", () => {
		expect(MODELS["alibaba-coding-plan"]).toBeDefined();
		expect(MODELS["alibaba-coding-plan"]?.["qwen3.7-plus"]).toMatchObject({
			provider: "alibaba-coding-plan",
			api: "openai-completions",
		});
	});

	test("resolves a stored credential with a custom base URL", async () => {
		const provider = alibabaCodingPlanProvider();
		const auth = await provider.auth.apiKey?.resolve({
			ctx: AUTH_CTX,
			credential: {
				type: "api_key",
				key: "acp-stored-key",
				env: { codingPlanBaseUrl: "https://cn-custom.example.com/v1" },
			},
		});
		expect(auth).toEqual({
			auth: { apiKey: "acp-stored-key", baseUrl: "https://cn-custom.example.com/v1" },
			source: "stored credential",
		});
	});

	test("lets the env base URL override the stored custom base URL", async () => {
		const provider = alibabaCodingPlanProvider();
		const auth = await provider.auth.apiKey?.resolve({
			ctx: {
				env: async (name) => (name === "ALIBABA_CODING_PLAN_BASE_URL" ? "https://env.example.com/v1" : undefined),
				fileExists: async () => false,
			},
			credential: {
				type: "api_key",
				key: "acp-stored-key",
				env: { codingPlanBaseUrl: "https://cn-custom.example.com/v1" },
			},
		});
		expect(auth).toEqual({
			auth: { apiKey: "acp-stored-key", baseUrl: "https://env.example.com/v1" },
			source: "stored credential",
		});
	});

	test("login stores a plain key for International/China and a base URL for Custom", async () => {
		const provider = alibabaCodingPlanProvider();
		const login = provider.auth.apiKey?.login;
		if (!login) throw new Error("alibaba-coding-plan must support interactive login");

		const international = await login({
			prompt: async (prompt: AuthPrompt) => (prompt.type === "select" ? "international" : "intl-key"),
			notify: () => {},
		} as unknown as AuthInteraction);
		expect(international).toEqual({ type: "api_key", key: "intl-key" });

		const china = await login({
			prompt: async (prompt: AuthPrompt) => (prompt.type === "select" ? "china" : "cn-key"),
			notify: () => {},
		} as unknown as AuthInteraction);
		expect(china).toEqual({ type: "api_key", key: "cn-key" });

		const custom = await login({
			prompt: async (prompt: AuthPrompt) => {
				if (prompt.type === "select") return "custom";
				if (prompt.type === "text") return "https://self-host.example.com/v1";
				return "custom-key";
			},
			notify: () => {},
		} as unknown as AuthInteraction);
		expect(custom).toEqual({
			type: "api_key",
			key: "custom-key",
			env: { codingPlanBaseUrl: "https://self-host.example.com/v1" },
		});
	});

	test("discovers models at the effective base URL", async () => {
		const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return codingPlanResponse([
				{ id: "qwen3.7-max", name: "Qwen3.7 Max", context_length: 1048576, max_completion_tokens: 32768 },
			]);
		};
		const provider = alibabaCodingPlanProvider({ fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("alibaba-coding-plan provider must support model discovery");

		await refresh({
			credential: {
				type: "api_key",
				key: "acp-test-key",
				env: { codingPlanBaseUrl: "https://cn-custom.example.com/v1" },
			},
			store: scopedStore(new InMemoryModelsStore()),
			allowNetwork: true,
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			url: "https://cn-custom.example.com/v1/models",
			init: {
				method: "GET",
				headers: { Authorization: "Bearer acp-test-key", Accept: "application/json" },
			},
		});
		expect(provider.getModels().find((entry) => entry.id === "qwen3.7-max")).toMatchObject({
			name: "Qwen3.7 Max",
			provider: "alibaba-coding-plan",
			baseUrl: "https://cn-custom.example.com/v1",
			contextWindow: 1048576,
			maxTokens: 32768,
			reasoning: true,
		});
	});

	test("rejects an empty catalog and keeps the last known good models", async () => {
		let response = codingPlanResponse([{ id: "acp/known-good", name: "Known Good" }]);
		const fetchImpl: typeof fetch = async () => response;
		const provider = alibabaCodingPlanProvider({ fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("alibaba-coding-plan provider must support model discovery");
		const store = scopedStore(new InMemoryModelsStore());
		const context = {
			credential: { type: "api_key" as const, key: "acp-test-key" },
			store,
			allowNetwork: true,
		};

		await refresh(context);
		expect(provider.getModels().some((entry) => entry.id === "acp/known-good")).toBe(true);

		response = codingPlanResponse([]);
		await expect(refresh(context)).rejects.toThrow("empty model catalog");
		expect(provider.getModels().some((entry) => entry.id === "acp/known-good")).toBe(true);
	});

	test("uses the existing OpenAI completions stream with alibaba-coding-plan model identity", async () => {
		const modelId = "qwen3.7-max";
		const responseBody = [
			`data: ${JSON.stringify({
				id: "chatcmpl-acp-test",
				object: "chat.completion.chunk",
				created: 1,
				model: modelId,
				choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }],
			})}`,
			`data: ${JSON.stringify({
				id: "chatcmpl-acp-test",
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
		const provider = alibabaCodingPlanProvider();
		const model = provider.getModels().find((entry) => entry.id === modelId);
		if (!model) throw new Error("alibaba-coding-plan bundled model is missing");

		const result = await provider
			.stream(
				model,
				{ messages: [{ role: "user", content: "say hello", timestamp: 1 }] },
				{ apiKey: "acp-test-key" },
			)
			.result();
		expect(result).toMatchObject({
			provider: "alibaba-coding-plan",
			model: modelId,
			stopReason: "stop",
		});
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
		const request = fetchSpy.mock.calls[0];
		expect(request?.[0]).toBe("https://coding-intl.dashscope.aliyuncs.com/v1/chat/completions");
		expect(request?.[1]?.method).toBe("POST");
		const headers = request?.[1]?.headers;
		expect(headers instanceof Headers ? headers.get("authorization") : undefined).toBe("Bearer acp-test-key");
	});
});
