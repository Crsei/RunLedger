import { afterEach, describe, expect, test, vi } from "vitest";
import { MODELS } from "../../src/models.generated.ts";
import { firepassProvider } from "../../src/providers/firepass.ts";

const FIREPASS_BASE_URL = "https://api.fireworks.ai/inference/v1";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("firepass provider", () => {
	test("exposes the bundled OpenAI-compatible catalog as a static provider", () => {
		const provider = firepassProvider();
		const model = provider.getModels().find((entry) => entry.id === "kimi-k2.6-turbo");

		expect(provider.id).toBe("firepass");
		expect(provider.name).toBe("Fire Pass");
		expect(provider.baseUrl).toBe(FIREPASS_BASE_URL);
		expect(model).toMatchObject({
			api: "openai-completions",
			provider: "firepass",
			baseUrl: FIREPASS_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
		});
	});

	test("is static-only: no dynamic model discovery", () => {
		const provider = firepassProvider();
		expect(provider.refreshModels).toBeUndefined();
	});

	test("is present in the builtin generated model catalog", () => {
		const catalog = MODELS["firepass"] as Record<string, { provider?: string; api?: string }> | undefined;
		expect(catalog?.["kimi-k2.6-turbo"]).toMatchObject({
			provider: "firepass",
			api: "openai-completions",
		});
	});

	test("resolves the env-key auth and reports unconfigured without a key", async () => {
		const provider = firepassProvider();
		const auth = await provider.auth.apiKey?.resolve({
			ctx: {
				env: async (name) => (name === "FIREPASS_API_KEY" ? "fpk_test_key" : undefined),
				fileExists: async () => false,
			},
			credential: undefined,
		});
		expect(auth).toEqual({ auth: { apiKey: "fpk_test_key" }, source: "FIREPASS_API_KEY" });

		const stored = await provider.auth.apiKey?.resolve({
			ctx: {
				env: async () => undefined,
				fileExists: async () => false,
			},
			credential: { type: "api_key", key: "stored-fpk-key" },
		});
		expect(stored).toEqual({ auth: { apiKey: "stored-fpk-key" }, source: "stored credential" });

		const unconfigured = await provider.auth.apiKey?.resolve({
			ctx: {
				env: async () => undefined,
				fileExists: async () => false,
			},
			credential: undefined,
		});
		expect(unconfigured).toBeUndefined();
	});

	test("uses the existing OpenAI completions stream with firepass model identity", async () => {
		const modelId = "kimi-k2.6-turbo";
		const responseBody = [
			`data: ${JSON.stringify({
				id: "chatcmpl-firepass-test",
				object: "chat.completion.chunk",
				created: 1,
				model: modelId,
				choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }],
			})}`,
			`data: ${JSON.stringify({
				id: "chatcmpl-firepass-test",
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
		const provider = firepassProvider();
		const model = provider.getModels().find((entry) => entry.id === modelId);
		if (!model) throw new Error("firepass bundled model is missing");

		const result = await provider
			.stream(
				model,
				{ messages: [{ role: "user", content: "say hello", timestamp: 1 }] },
				{ apiKey: "fpk_test_key" },
			)
			.result();
		expect(result).toMatchObject({
			provider: "firepass",
			model: modelId,
			stopReason: "stop",
		});
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
		const request = fetchSpy.mock.calls[0];
		expect(request?.[0]).toBe(`${FIREPASS_BASE_URL}/chat/completions`);
		expect(request?.[1]?.method).toBe("POST");
		const headers = request?.[1]?.headers;
		expect(headers instanceof Headers ? headers.get("authorization") : undefined).toBe("Bearer fpk_test_key");
	});
});
