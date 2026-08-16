import { afterEach, describe, expect, test, vi } from "vitest";
import { InMemoryModelsStore, type ProviderModelsStore } from "../../src/models-store.ts";
import { bedrockMantleProvider } from "../../src/providers/bedrock-mantle.ts";
import { builtinModels, builtinProviders } from "../../src/providers/all.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

function scopedStore(store: InMemoryModelsStore): ProviderModelsStore {
	return {
		read: () => store.read("bedrock-mantle"),
		write: (entry) => store.write("bedrock-mantle", entry),
		delete: () => store.delete("bedrock-mantle"),
	};
}

function bedrockResponse(data: readonly Record<string, unknown>[]): Response {
	return new Response(JSON.stringify({ object: "list", data }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function bedrockResponsesSse(text: string): string {
	const events = [
		{
			type: "response.output_item.added",
			item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: text },
		{
			type: "response.output_item.done",
			item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text }] },
		},
		{
			type: "response.completed",
			response: {
				status: "completed",
				usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } },
			},
		},
	];
	return `${events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
}

describe("bedrock-mantle provider", () => {
	test("substitutes the region into base URLs and static model baseUrl", () => {
		const provider = bedrockMantleProvider({ region: "us-west-2" });
		const model = provider.getModels().find((entry) => entry.id === "openai.gpt-5.4");

		expect(provider.id).toBe("bedrock-mantle");
		expect(provider.name).toBe("Amazon Bedrock Mantle");
		expect(provider.baseUrl).toBe("https://bedrock-mantle.us-west-2.api.aws/openai/v1");
		expect(model).toMatchObject({
			api: "openai-responses",
			provider: "bedrock-mantle",
			baseUrl: "https://bedrock-mantle.us-west-2.api.aws/openai/v1",
			reasoning: true,
		});
	});

	test("resolves the region from AWS_REGION with a us-east-1 fallback", () => {
		expect(bedrockMantleProvider({ region: "eu-central-1" }).baseUrl).toBe(
			"https://bedrock-mantle.eu-central-1.api.aws/openai/v1",
		);
		vi.stubEnv("AWS_REGION", "ap-southeast-1");
		expect(bedrockMantleProvider().baseUrl).toBe("https://bedrock-mantle.ap-southeast-1.api.aws/openai/v1");
		vi.stubEnv("AWS_DEFAULT_REGION", "sa-east-1");
		vi.stubEnv("AWS_REGION", "");
		expect(bedrockMantleProvider().baseUrl).toBe("https://bedrock-mantle.sa-east-1.api.aws/openai/v1");
		vi.stubEnv("AWS_DEFAULT_REGION", "");
		expect(bedrockMantleProvider().baseUrl).toBe("https://bedrock-mantle.us-east-1.api.aws/openai/v1");
	});

	test("resolves ambient bearer auth and fails closed without one", async () => {
		const provider = bedrockMantleProvider();
		const resolve = provider.auth.apiKey;
		if (!resolve) throw new Error("bedrock-mantle provider must expose api-key auth");

		await expect(
			resolve.resolve({ ctx: { env: async () => undefined, fileExists: async () => false } }),
		).resolves.toBeUndefined();

		const ambient = await resolve.resolve({
			ctx: { env: async (name) => (name === "AWS_BEARER_TOKEN_BEDROCK" ? "ambient-bearer" : undefined), fileExists: async () => false },
		});
		expect(ambient).toEqual({ auth: { apiKey: "ambient-bearer" }, source: "AWS_BEARER_TOKEN_BEDROCK" });

		const stored = await resolve.resolve({
			ctx: { env: async () => undefined, fileExists: async () => false },
			credential: { type: "api_key", key: "stored-bearer" },
		});
		expect(stored).toEqual({ auth: { apiKey: "stored-bearer" }, source: "stored credential" });
	});

	test("is present in the builtin provider and model collections", () => {
		expect(builtinProviders().find((provider) => provider.id === "bedrock-mantle")?.name).toBe("Amazon Bedrock Mantle");
		expect(builtinModels().getModel("bedrock-mantle", "openai.gpt-5.4")).toMatchObject({
			provider: "bedrock-mantle",
			api: "openai-responses",
		});
	});

	test("discovers models on the /v1 endpoint with the bearer token", async () => {
		const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return bedrockResponse([
				{ id: "openai.gpt-5.6-luna", name: "GPT-5.6 Luna", context_length: 272000, max_completion_tokens: 128000 },
				{ id: "new.mantle-model", name: "New Mantle Model" },
			]);
		};
		const provider = bedrockMantleProvider({ region: "us-west-2", fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("bedrock-mantle provider must support model discovery");

		await refresh({
			credential: { type: "api_key", key: "mantle-bearer" },
			store: scopedStore(new InMemoryModelsStore()),
			allowNetwork: true,
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			url: "https://bedrock-mantle.us-west-2.api.aws/v1/models",
			init: { method: "GET", headers: { Authorization: "Bearer mantle-bearer", Accept: "application/json" } },
		});
		// 已知 id 的动态条目继承静态 metadata(含 thinkingLevelMap)
		expect(provider.getModels().find((entry) => entry.id === "openai.gpt-5.6-luna")).toMatchObject({
			name: "GPT-5.6 Luna",
			provider: "bedrock-mantle",
			baseUrl: "https://bedrock-mantle.us-west-2.api.aws/openai/v1",
			reasoning: true,
			contextWindow: 272000,
			maxTokens: 128000,
		});
		expect(provider.getModels().find((entry) => entry.id === "new.mantle-model")).toMatchObject({
			reasoning: false,
			contextWindow: 4096,
			maxTokens: 4096,
		});
	});

	test("rejects an empty catalog and keeps the last known good models", async () => {
		let response = bedrockResponse([{ id: "mantle/known-good" }]);
		const fetchImpl: typeof fetch = async () => response;
		const provider = bedrockMantleProvider({ fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("bedrock-mantle provider must support model discovery");
		const store = scopedStore(new InMemoryModelsStore());
		const context = { credential: { type: "api_key" as const, key: "mantle-bearer" }, store, allowNetwork: true };

		await refresh(context);
		expect(provider.getModels().some((entry) => entry.id === "mantle/known-good")).toBe(true);

		response = bedrockResponse([]);
		await expect(refresh(context)).rejects.toThrow("empty model catalog");
		expect(provider.getModels().some((entry) => entry.id === "mantle/known-good")).toBe(true);
	});

	test("streams through the openai responses api with bedrock-mantle model identity", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(bedrockResponsesSse("hello"), { status: 200, headers: { "content-type": "text/event-stream" } }),
		);
		const provider = bedrockMantleProvider({ region: "us-east-1" });
		const model = provider.getModels().find((entry) => entry.id === "openai.gpt-5.4");
		if (!model) throw new Error("bedrock-mantle bundled model is missing");

		const result = await provider
			.stream(model, { messages: [{ role: "user", content: "say hello", timestamp: 1 }] }, { apiKey: "mantle-bearer" })
			.result();
		expect(result).toMatchObject({ provider: "bedrock-mantle", model: "openai.gpt-5.4", stopReason: "stop" });
		expect(result.content).toMatchObject([{ type: "text", text: "hello" }]);
		const request = fetchSpy.mock.calls[0];
		expect(request?.[0]).toBe("https://bedrock-mantle.us-east-1.api.aws/openai/v1/responses");
		expect(request?.[1]?.method).toBe("POST");
	});
});
