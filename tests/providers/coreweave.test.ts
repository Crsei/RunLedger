import { afterEach, describe, expect, test, vi } from "vitest";
import type { AuthContext } from "../../src/auth/types.ts";
import { createModels } from "../../src/models.ts";
import { MODELS } from "../../src/models.generated.ts";
import { InMemoryModelsStore, type ProviderModelsStore } from "../../src/models-store.ts";
import { coreweaveProvider } from "../../src/providers/coreweave.ts";

const COREWEAVE_BASE_URL = "https://api.inference.wandb.ai/v1";

afterEach(() => {
	vi.restoreAllMocks();
});

function scopedStore(store: InMemoryModelsStore): ProviderModelsStore {
	return {
		read: () => store.read("coreweave"),
		write: (entry) => store.write("coreweave", entry),
		delete: () => store.delete("coreweave"),
	};
}

function envContext(values: Record<string, string | undefined>): AuthContext {
	return {
		env: async (name) => values[name],
		fileExists: async () => false,
	};
}

function modelsResponse(data: readonly Record<string, unknown>[]): Response {
	return new Response(JSON.stringify({ object: "list", data }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("coreweave provider", () => {
	test("exposes the bundled OpenAI-compatible catalog with the serverless inference base URL", () => {
		const provider = coreweaveProvider();
		const model = provider.getModels().find((entry) => entry.id === "openai/gpt-oss-120b");

		expect(provider.id).toBe("coreweave");
		expect(provider.name).toBe("CoreWeave Serverless Inference");
		expect(model).toMatchObject({
			api: "openai-completions",
			provider: "coreweave",
			baseUrl: COREWEAVE_BASE_URL,
		});
		expect(provider.getModels().length).toBe(34);
		expect(provider.refreshModels).toBeTypeOf("function");
	});

	test("is present in the builtin generated model catalog", () => {
		const catalog = MODELS["coreweave"] as Record<string, { provider?: string; api?: string }> | undefined;
		expect(catalog?.["openai/gpt-oss-120b"]).toMatchObject({
			provider: "coreweave",
			api: "openai-completions",
		});
	});

	test("resolves auth from COREWEAVE_API_KEY plus COREWEAVE_PROJECT", async () => {
		const provider = coreweaveProvider();
		const auth = await provider.auth.apiKey?.resolve({
			ctx: envContext({ COREWEAVE_API_KEY: "cw-key", COREWEAVE_PROJECT: "acme/serve" }),
			credential: undefined,
		});
		expect(auth).toEqual({
			auth: { apiKey: "cw-key", headers: { "OpenAI-Project": "acme/serve" } },
			env: { COREWEAVE_PROJECT: "acme/serve" },
			source: "COREWEAVE_API_KEY",
		});
	});

	test("resolves auth from WANDB fallbacks with entity-prefixed project and stored-credential precedence", async () => {
		const provider = coreweaveProvider();
		const auth = await provider.auth.apiKey?.resolve({
			ctx: envContext({
				WANDB_API_KEY: "wandb-key",
				WANDB_ENTITY: "team",
				WANDB_PROJECT: "runs",
			}),
			credential: undefined,
		});
		expect(auth).toEqual({
			auth: { apiKey: "wandb-key", headers: { "OpenAI-Project": "team/runs" } },
			env: { COREWEAVE_PROJECT: "team/runs" },
			source: "WANDB_API_KEY",
		});

		const stored = await provider.auth.apiKey?.resolve({
			ctx: envContext({}),
			credential: { type: "api_key", key: "stored-key", env: { WANDB_PROJECT: "already/namespaced" } },
		});
		expect(stored).toEqual({
			auth: { apiKey: "stored-key", headers: { "OpenAI-Project": "already/namespaced" } },
			env: { COREWEAVE_PROJECT: "already/namespaced" },
			source: "stored credential",
		});
	});

	test("fails closed when key or project is missing", async () => {
		const provider = coreweaveProvider();
		const noProject = await provider.auth.apiKey?.resolve({
			ctx: envContext({ COREWEAVE_API_KEY: "cw-key" }),
			credential: undefined,
		});
		expect(noProject).toBeUndefined();

		const noKey = await provider.auth.apiKey?.resolve({
			ctx: envContext({ COREWEAVE_PROJECT: "acme/serve" }),
			credential: undefined,
		});
		expect(noKey).toBeUndefined();

		const empty = await provider.auth.apiKey?.resolve({
			ctx: envContext({}),
			credential: undefined,
		});
		expect(empty).toBeUndefined();
	});

	test("discovers models with credential, sending Authorization and OpenAI-Project", async () => {
		const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return modelsResponse([
				{
					id: "openai/gpt-oss-120b",
					name: "openai/gpt-oss-120b",
					description: "GPT OSS 120B on CoreWeave",
					context_window: 131072,
					capabilities: ["reasoning", "tool_calling", "vision"],
				},
			]);
		};
		const provider = coreweaveProvider({
			baseUrl: "https://config.coreweave.test",
			fetch: fetchImpl,
			authContext: envContext({}),
		});
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("coreweave provider must support model discovery");

		await refresh({
			credential: { type: "api_key", key: "cw-key", env: { COREWEAVE_PROJECT: "acme/serve" } },
			store: scopedStore(new InMemoryModelsStore()),
			allowNetwork: true,
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			url: "https://config.coreweave.test/v1/models",
			init: {
				method: "GET",
				headers: {
					Authorization: "Bearer cw-key",
					Accept: "application/json",
					"OpenAI-Project": "acme/serve",
				},
			},
		});
		expect(provider.getModels().find((entry) => entry.id === "openai/gpt-oss-120b")).toMatchObject({
			name: "GPT OSS 120B on CoreWeave",
			provider: "coreweave",
			baseUrl: "https://config.coreweave.test/v1",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 131072,
		});
	});

	test("discovery runs without a credential, resolving the project from the auth context", async () => {
		const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return modelsResponse([{ id: "coreweave/ungated-model" }]);
		};
		const provider = coreweaveProvider({
			fetch: fetchImpl,
			authContext: envContext({ COREWEAVE_PROJECT: "acme/serve" }),
		});
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("coreweave provider must support model discovery");

		await refresh({
			store: scopedStore(new InMemoryModelsStore()),
			allowNetwork: true,
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(`${COREWEAVE_BASE_URL}/models`);
		const headers = calls[0]?.init?.headers as Record<string, string> | undefined;
		expect(headers).toMatchObject({ Accept: "application/json", "OpenAI-Project": "acme/serve" });
		expect(headers?.["Authorization"]).toBeUndefined();
	});

	test("rejects an empty catalog and keeps the last known good models", async () => {
		let response = modelsResponse([{ id: "coreweave/known-good", capabilities: ["tool_calling"] }]);
		const fetchImpl: typeof fetch = async () => response;
		const provider = coreweaveProvider({ fetch: fetchImpl, authContext: envContext({}) });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("coreweave provider must support model discovery");
		const store = scopedStore(new InMemoryModelsStore());
		const context = {
			credential: { type: "api_key" as const, key: "cw-key", env: { COREWEAVE_PROJECT: "acme/serve" } },
			store,
			allowNetwork: true,
		};

		await refresh(context);
		expect(provider.getModels().some((entry) => entry.id === "coreweave/known-good")).toBe(true);

		response = modelsResponse([]);
		await expect(refresh(context)).rejects.toThrow("empty model catalog");
		expect(provider.getModels().some((entry) => entry.id === "coreweave/known-good")).toBe(true);
	});

	test("streams through the completions API with the OpenAI-Project header, and fails closed without it", async () => {
		const modelId = "openai/gpt-oss-120b";
		const responseBody = [
			`data: ${JSON.stringify({
				id: "chatcmpl-coreweave-test",
				object: "chat.completion.chunk",
				created: 1,
				model: modelId,
				choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }],
			})}`,
			`data: ${JSON.stringify({
				id: "chatcmpl-coreweave-test",
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
		const authContext = envContext({ COREWEAVE_API_KEY: "cw-key", COREWEAVE_PROJECT: "acme/serve" });
		const models = createModels({ authContext });
		models.setProvider(coreweaveProvider());
		const model = models.getModel("coreweave", modelId);
		if (!model) throw new Error("coreweave bundled model is missing");

		const result = await models
			.stream(model, { messages: [{ role: "user", content: "say hello", timestamp: 1 }] })
			.result();
		expect(result).toMatchObject({ provider: "coreweave", model: modelId, stopReason: "stop" });
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);

		const request = fetchSpy.mock.calls[0];
		expect(request?.[0]).toBe(`${COREWEAVE_BASE_URL}/chat/completions`);
		const headers = request?.[1]?.headers;
		expect(headers instanceof Headers ? headers.get("authorization") : undefined).toBe("Bearer cw-key");
		expect(headers instanceof Headers ? headers.get("openai-project") : undefined).toBe("acme/serve");

		// 缺少 project 时 fail closed:auth 解析为 undefined,stream 以 error 终止。
		const unconfigured = createModels({ authContext: envContext({ COREWEAVE_API_KEY: "cw-key" }) });
		unconfigured.setProvider(coreweaveProvider());
		const unconfiguredModel = unconfigured.getModel("coreweave", modelId);
		if (!unconfiguredModel) throw new Error("coreweave bundled model is missing");
		const failed = await unconfigured
			.stream(unconfiguredModel, { messages: [{ role: "user", content: "hi", timestamp: 1 }] })
			.result();
		expect(failed.stopReason).toBe("error");
		expect(failed.errorMessage).toMatch(/not configured/u);
	});
});
