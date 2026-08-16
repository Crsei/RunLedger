import { afterEach, describe, expect, test, vi } from "vitest";
import { MODELS } from "../../src/models.generated.ts";
import { InMemoryModelsStore, type ProviderModelsStore } from "../../src/models-store.ts";
import { zhipuCodingPlanProvider } from "../../src/providers/zhipu-coding-plan.ts";

const ZHIPU_BASE_URL = "https://open.bigmodel.cn/api/coding/paas/v4";

afterEach(() => {
	vi.restoreAllMocks();
});

function scopedStore(store: InMemoryModelsStore): ProviderModelsStore {
	return {
		read: () => store.read("zhipu-coding-plan"),
		write: (entry) => store.write("zhipu-coding-plan", entry),
		delete: () => store.delete("zhipu-coding-plan"),
	};
}

function modelsResponse(data: readonly Record<string, unknown>[]): Response {
	return new Response(JSON.stringify({ object: "list", data }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("zhipu-coding-plan provider", () => {
	test("exposes the bundled OpenAI-compatible catalog with zai-style compat", () => {
		const provider = zhipuCodingPlanProvider();
		const model = provider.getModels().find((entry) => entry.id === "glm-5.1");

		expect(provider.id).toBe("zhipu-coding-plan");
		expect(provider.name).toBe("Zhipu Coding Plan");
		expect(provider.baseUrl).toBe(ZHIPU_BASE_URL);
		expect(model).toMatchObject({
			api: "openai-completions",
			provider: "zhipu-coding-plan",
			baseUrl: ZHIPU_BASE_URL,
			reasoning: true,
			compat: { thinkingFormat: "zai", supportsDeveloperRole: false },
		});
		expect(provider.getModels().length).toBe(12);
	});

	test("is present in the builtin generated model catalog", () => {
		const catalog = MODELS["zhipu-coding-plan"] as Record<string, { provider?: string; api?: string }> | undefined;
		expect(catalog?.["glm-5.1"]).toMatchObject({
			provider: "zhipu-coding-plan",
			api: "openai-completions",
		});
	});

	test("resolves the env-key auth and reports unconfigured without a key", async () => {
		const provider = zhipuCodingPlanProvider();
		const auth = await provider.auth.apiKey?.resolve({
			ctx: {
				env: async (name) => (name === "ZHIPU_API_KEY" ? "zhipu-key" : undefined),
				fileExists: async () => false,
			},
			credential: undefined,
		});
		expect(auth).toEqual({ auth: { apiKey: "zhipu-key" }, source: "ZHIPU_API_KEY" });

		const unconfigured = await provider.auth.apiKey?.resolve({
			ctx: {
				env: async () => undefined,
				fileExists: async () => false,
			},
			credential: undefined,
		});
		expect(unconfigured).toBeUndefined();
	});

	test("discovers models against the v4 base URL with the Authorization header", async () => {
		const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return modelsResponse([
				{ id: "glm-5.2", name: "GLM-5.2", context_window: 262144, capabilities: ["reasoning"] },
			]);
		};
		const provider = zhipuCodingPlanProvider({ fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("zhipu-coding-plan provider must support model discovery");

		await refresh({
			credential: { type: "api_key", key: "zhipu-key" },
			store: scopedStore(new InMemoryModelsStore()),
			allowNetwork: true,
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(`${ZHIPU_BASE_URL}/models`);
		expect(calls[0]?.init?.headers).toMatchObject({
			Accept: "application/json",
			Authorization: "Bearer zhipu-key",
		});
		// 参考模型保底:wire 未带 compat,仍保留 bundled zai 风格 compat。
		expect(provider.getModels().find((entry) => entry.id === "glm-5.2")).toMatchObject({
			name: "GLM-5.2",
			provider: "zhipu-coding-plan",
			baseUrl: ZHIPU_BASE_URL,
			reasoning: true,
			contextWindow: 262144,
			compat: { thinkingFormat: "zai", supportsDeveloperRole: false },
		});
	});

	test("is gated: discovery without a credential throws", async () => {
		const provider = zhipuCodingPlanProvider({ fetch: async () => modelsResponse([]) });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("zhipu-coding-plan provider must support model discovery");

		await expect(
			refresh({ store: scopedStore(new InMemoryModelsStore()), allowNetwork: true }),
		).rejects.toThrow("Zhipu Coding Plan API key is not configured");
	});

	test("rejects an empty catalog and keeps the last known good models", async () => {
		let response = modelsResponse([{ id: "glm-4.7" }]);
		const fetchImpl: typeof fetch = async () => response;
		const provider = zhipuCodingPlanProvider({ fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("zhipu-coding-plan provider must support model discovery");
		const store = scopedStore(new InMemoryModelsStore());
		const context = {
			credential: { type: "api_key" as const, key: "zhipu-key" },
			store,
			allowNetwork: true,
		};

		await refresh(context);
		expect(provider.getModels().some((entry) => entry.id === "glm-4.7")).toBe(true);

		response = modelsResponse([]);
		await expect(refresh(context)).rejects.toThrow("empty model catalog");
		expect(provider.getModels().some((entry) => entry.id === "glm-4.7")).toBe(true);
	});

	test("uses the existing OpenAI completions stream with zhipu-coding-plan model identity", async () => {
		const modelId = "glm-5.1";
		const responseBody = [
			`data: ${JSON.stringify({
				id: "chatcmpl-zhipu-test",
				object: "chat.completion.chunk",
				created: 1,
				model: modelId,
				choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }],
			})}`,
			`data: ${JSON.stringify({
				id: "chatcmpl-zhipu-test",
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
		const provider = zhipuCodingPlanProvider();
		const model = provider.getModels().find((entry) => entry.id === modelId);
		if (!model) throw new Error("zhipu-coding-plan bundled model is missing");

		const result = await provider
			.stream(
				model,
				{ messages: [{ role: "user", content: "say hello", timestamp: 1 }] },
				{ apiKey: "zhipu-key" },
			)
			.result();
		expect(result).toMatchObject({
			provider: "zhipu-coding-plan",
			model: modelId,
			stopReason: "stop",
		});
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
		const request = fetchSpy.mock.calls[0];
		expect(request?.[0]).toBe(`${ZHIPU_BASE_URL}/chat/completions`);
		expect(request?.[1]?.method).toBe("POST");
	});
});
