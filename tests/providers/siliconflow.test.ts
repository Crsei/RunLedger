import { afterEach, describe, expect, test, vi } from "vitest";
import { MODELS } from "../../src/models.generated.ts";
import { InMemoryModelsStore, type ProviderModelsStore } from "../../src/models-store.ts";
import { siliconflowProvider } from "../../src/providers/siliconflow.ts";

const SILICONFLOW_BASE_URL = "https://api.siliconflow.com/v1";

afterEach(() => {
	vi.restoreAllMocks();
});

function scopedStore(store: InMemoryModelsStore): ProviderModelsStore {
	return {
		read: () => store.read("siliconflow"),
		write: (entry) => store.write("siliconflow", entry),
		delete: () => store.delete("siliconflow"),
	};
}

function modelsResponse(data: readonly Record<string, unknown>[]): Response {
	return new Response(JSON.stringify({ object: "list", data }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("siliconflow provider", () => {
	test("exposes the bundled OpenAI-compatible catalog and env-key auth", () => {
		const provider = siliconflowProvider();
		const model = provider.getModels().find((entry) => entry.id === "deepseek-ai/DeepSeek-V4-Pro");

		expect(provider.id).toBe("siliconflow");
		expect(provider.name).toBe("SiliconFlow");
		expect(provider.baseUrl).toBe(SILICONFLOW_BASE_URL);
		expect(model).toMatchObject({
			api: "openai-completions",
			provider: "siliconflow",
			baseUrl: SILICONFLOW_BASE_URL,
			reasoning: true,
			contextWindow: 1048576,
		});
	});

	test("is present in the builtin generated model catalog", () => {
		const catalog = MODELS["siliconflow"] as Record<string, { provider?: string; api?: string }> | undefined;
		expect(catalog?.["deepseek-ai/DeepSeek-V4-Pro"]).toMatchObject({
			provider: "siliconflow",
			api: "openai-completions",
		});
	});

	test("resolves the env-key auth and reports unconfigured without a key", async () => {
		const provider = siliconflowProvider();
		const auth = await provider.auth.apiKey?.resolve({
			ctx: {
				env: async (name) => (name === "SILICONFLOW_API_KEY" ? "sf-key" : undefined),
				fileExists: async () => false,
			},
			credential: undefined,
		});
		expect(auth).toEqual({ auth: { apiKey: "sf-key" }, source: "SILICONFLOW_API_KEY" });

		const unconfigured = await provider.auth.apiKey?.resolve({
			ctx: {
				env: async () => undefined,
				fileExists: async () => false,
			},
			credential: undefined,
		});
		expect(unconfigured).toBeUndefined();
	});

	test("discovers chat models and drops non-chat ids by token filter", async () => {
		const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return modelsResponse([
				{ id: "BAAI/bge-m3" },
				{ id: "Pro/Qwen/Qwen2.5-7B-Instruct", name: "Qwen2.5 7B Instruct" },
				{ id: "Qwen/Qwen2.5-VL-72B-Instruct", description: "vision chat model" },
				{ id: "wangrongsheng/stable-diffusion-3-medium" },
				{ id: "Pro/Qwen/Qwen2.5-7B-Instruct", name: "duplicate" },
			]);
		};
		const provider = siliconflowProvider({ fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("siliconflow provider must support model discovery");

		await refresh({
			credential: { type: "api_key", key: "sf-key" },
			store: scopedStore(new InMemoryModelsStore()),
			allowNetwork: true,
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(`${SILICONFLOW_BASE_URL}/models`);
		expect(calls[0]?.init?.headers).toMatchObject({
			Accept: "application/json",
			Authorization: "Bearer sf-key",
		});

		const models = provider.getModels();
		const ids = models.map((model) => model.id);
		expect(ids).toContain("Pro/Qwen/Qwen2.5-7B-Instruct");
		expect(ids).toContain("Qwen/Qwen2.5-VL-72B-Instruct");
		expect(ids).not.toContain("BAAI/bge-m3");
		expect(ids).not.toContain("wangrongsheng/stable-diffusion-3-medium");
		expect(models.find((model) => model.id === "Pro/Qwen/Qwen2.5-7B-Instruct")).toMatchObject({
			name: "Qwen2.5 7B Instruct",
			provider: "siliconflow",
			baseUrl: SILICONFLOW_BASE_URL,
		});
		// 参考模型保底:wire 裸 id 行保留 bundled 元数据。
		expect(models.find((model) => model.id === "Qwen/Qwen2.5-VL-72B-Instruct")?.reasoning).toBe(false);
	});

	test("is gated: discovery without a credential throws", async () => {
		const provider = siliconflowProvider({ fetch: async () => modelsResponse([]) });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("siliconflow provider must support model discovery");

		await expect(
			refresh({ store: scopedStore(new InMemoryModelsStore()), allowNetwork: true }),
		).rejects.toThrow("SiliconFlow API key is not configured");
	});

	test("rejects an empty catalog and keeps the last known good models", async () => {
		let response = modelsResponse([{ id: "deepseek-ai/DeepSeek-V4-Pro" }]);
		const fetchImpl: typeof fetch = async () => response;
		const provider = siliconflowProvider({ fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("siliconflow provider must support model discovery");
		const store = scopedStore(new InMemoryModelsStore());
		const context = {
			credential: { type: "api_key" as const, key: "sf-key" },
			store,
			allowNetwork: true,
		};

		await refresh(context);
		expect(provider.getModels().some((entry) => entry.id === "deepseek-ai/DeepSeek-V4-Pro")).toBe(true);

		response = modelsResponse([]);
		await expect(refresh(context)).rejects.toThrow("empty model catalog");
		expect(provider.getModels().some((entry) => entry.id === "deepseek-ai/DeepSeek-V4-Pro")).toBe(true);
	});

	test("uses the existing OpenAI completions stream with siliconflow model identity", async () => {
		const modelId = "deepseek-ai/DeepSeek-V4-Pro";
		const responseBody = [
			`data: ${JSON.stringify({
				id: "chatcmpl-siliconflow-test",
				object: "chat.completion.chunk",
				created: 1,
				model: modelId,
				choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }],
			})}`,
			`data: ${JSON.stringify({
				id: "chatcmpl-siliconflow-test",
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
		const provider = siliconflowProvider();
		const model = provider.getModels().find((entry) => entry.id === modelId);
		if (!model) throw new Error("siliconflow bundled model is missing");

		const result = await provider
			.stream(
				model,
				{ messages: [{ role: "user", content: "say hello", timestamp: 1 }] },
				{ apiKey: "sf-key" },
			)
			.result();
		expect(result).toMatchObject({
			provider: "siliconflow",
			model: modelId,
			stopReason: "stop",
		});
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
		const request = fetchSpy.mock.calls[0];
		expect(request?.[0]).toBe(`${SILICONFLOW_BASE_URL}/chat/completions`);
		expect(request?.[1]?.method).toBe("POST");
	});
});
