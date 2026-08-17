import { afterEach, describe, expect, test, vi } from "vitest";
import { MODELS } from "../../src/models.generated.ts";
import { InMemoryModelsStore, type ProviderModelsStore } from "../../src/models-store.ts";
import { siliconflowCnProvider } from "../../src/providers/siliconflow-cn.ts";

const SILICONFLOW_CN_BASE_URL = "https://api.siliconflow.cn/v1";

afterEach(() => {
	vi.restoreAllMocks();
});

function scopedStore(store: InMemoryModelsStore): ProviderModelsStore {
	return {
		read: () => store.read("siliconflow-cn"),
		write: (entry) => store.write("siliconflow-cn", entry),
		delete: () => store.delete("siliconflow-cn"),
	};
}

function modelsResponse(data: readonly Record<string, unknown>[]): Response {
	return new Response(JSON.stringify({ object: "list", data }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("siliconflow-cn provider", () => {
	test("exposes the bundled OpenAI-compatible catalog and env-key auth", () => {
		const provider = siliconflowCnProvider();
		const model = provider.getModels().find((entry) => entry.id === "deepseek-ai/DeepSeek-V4-Pro");

		expect(provider.id).toBe("siliconflow-cn");
		expect(provider.name).toBe("SiliconFlow (China)");
		expect(provider.baseUrl).toBe(SILICONFLOW_CN_BASE_URL);
		expect(model).toMatchObject({
			api: "openai-completions",
			provider: "siliconflow-cn",
			baseUrl: SILICONFLOW_CN_BASE_URL,
			reasoning: true,
			contextWindow: 1048576,
		});
	});

	test("is present in the builtin generated model catalog", () => {
		const catalog = MODELS["siliconflow-cn"] as Record<string, { provider?: string; api?: string }> | undefined;
		expect(catalog?.["deepseek-ai/DeepSeek-V4-Pro"]).toMatchObject({
			provider: "siliconflow-cn",
			api: "openai-completions",
		});
	});

	test("resolves the env-key auth and reports unconfigured without a key", async () => {
		const provider = siliconflowCnProvider();
		const auth = await provider.auth.apiKey?.resolve({
			ctx: {
				env: async (name) => (name === "SILICONFLOW_CN_API_KEY" ? "sfcn-key" : undefined),
				fileExists: async () => false,
			},
			credential: undefined,
		});
		expect(auth).toEqual({ auth: { apiKey: "sfcn-key" }, source: "SILICONFLOW_CN_API_KEY" });

		const unconfigured = await provider.auth.apiKey?.resolve({
			ctx: {
				env: async () => undefined,
				fileExists: async () => false,
			},
			credential: undefined,
		});
		expect(unconfigured).toBeUndefined();
	});

	test("discovers chat models and drops non-chat ids by the same token filter", async () => {
		const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return modelsResponse([
				{ id: "BAAI/bge-large-zh-v1.5" },
				{ id: "Qwen/Qwen2.5-7B-Instruct", description: "chat model" },
				{ id: "FunAudioLLM/SenseVoiceSmall" },
				{ id: "thudm/ltx-video" },
			]);
		};
		const provider = siliconflowCnProvider({ fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("siliconflow-cn provider must support model discovery");

		await refresh({
			credential: { type: "api_key", key: "sfcn-key" },
			store: scopedStore(new InMemoryModelsStore()),
			allowNetwork: true,
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(`${SILICONFLOW_CN_BASE_URL}/models`);
		expect(calls[0]?.init?.headers).toMatchObject({
			Accept: "application/json",
			Authorization: "Bearer sfcn-key",
		});

		const ids = provider.getModels().map((model) => model.id);
		expect(ids).toContain("Qwen/Qwen2.5-7B-Instruct");
		expect(ids).not.toContain("BAAI/bge-large-zh-v1.5");
		expect(ids).not.toContain("FunAudioLLM/SenseVoiceSmall");
		expect(ids).not.toContain("thudm/ltx-video");
		expect(provider.getModels().find((model) => model.id === "Qwen/Qwen2.5-7B-Instruct")).toMatchObject({
			name: "chat model",
			provider: "siliconflow-cn",
			baseUrl: SILICONFLOW_CN_BASE_URL,
		});
	});

	test("is gated: discovery without a credential throws", async () => {
		const provider = siliconflowCnProvider({ fetch: async () => modelsResponse([]) });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("siliconflow-cn provider must support model discovery");

		await expect(
			refresh({ store: scopedStore(new InMemoryModelsStore()), allowNetwork: true }),
		).rejects.toThrow("SiliconFlow (China) API key is not configured");
	});

	test("rejects an empty catalog and keeps the last known good models", async () => {
		let response = modelsResponse([{ id: "zai-org/GLM-5.1" }]);
		const fetchImpl: typeof fetch = async () => response;
		const provider = siliconflowCnProvider({ fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("siliconflow-cn provider must support model discovery");
		const store = scopedStore(new InMemoryModelsStore());
		const context = {
			credential: { type: "api_key" as const, key: "sfcn-key" },
			store,
			allowNetwork: true,
		};

		await refresh(context);
		expect(provider.getModels().some((entry) => entry.id === "zai-org/GLM-5.1")).toBe(true);

		response = modelsResponse([]);
		await expect(refresh(context)).rejects.toThrow("empty model catalog");
		expect(provider.getModels().some((entry) => entry.id === "zai-org/GLM-5.1")).toBe(true);
	});

	test("uses the existing OpenAI completions stream with siliconflow-cn model identity", async () => {
		const modelId = "zai-org/GLM-5.1";
		const responseBody = [
			`data: ${JSON.stringify({
				id: "chatcmpl-siliconflow-cn-test",
				object: "chat.completion.chunk",
				created: 1,
				model: modelId,
				choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }],
			})}`,
			`data: ${JSON.stringify({
				id: "chatcmpl-siliconflow-cn-test",
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
		const provider = siliconflowCnProvider();
		const model = provider.getModels().find((entry) => entry.id === modelId);
		if (!model) throw new Error("siliconflow-cn bundled model is missing");

		const result = await provider
			.stream(
				model,
				{ messages: [{ role: "user", content: "say hello", timestamp: 1 }] },
				{ apiKey: "sfcn-key" },
			)
			.result();
		expect(result).toMatchObject({
			provider: "siliconflow-cn",
			model: modelId,
			stopReason: "stop",
		});
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
		const request = fetchSpy.mock.calls[0];
		expect(request?.[0]).toBe(`${SILICONFLOW_CN_BASE_URL}/chat/completions`);
		expect(request?.[1]?.method).toBe("POST");
	});
});
