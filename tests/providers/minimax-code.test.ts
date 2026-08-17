import { afterEach, describe, expect, test, vi } from "vitest";
import { MODELS } from "../../src/models.generated.ts";
import { minimaxCodeProvider } from "../../src/providers/minimax-code.ts";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("minimax-code provider", () => {
	test("exposes the bundled catalog, intl base URL, and env-key auth", async () => {
		const provider = minimaxCodeProvider();

		expect(provider.id).toBe("minimax-code");
		expect(provider.name).toBe("MiniMax Token Plan (International)");
		expect(provider.baseUrl).toBe("https://api.minimax.io/v1");
		expect(provider.getModels().find((entry) => entry.id === "MiniMax-M3")).toMatchObject({
			api: "openai-completions",
			provider: "minimax-code",
			baseUrl: "https://api.minimax.io/v1",
		});

		const auth = await provider.auth.apiKey?.resolve({
			ctx: { env: async (name) => (name === "MINIMAX_CODE_API_KEY" ? "mm-test-key" : undefined), fileExists: async () => false },
		});
		expect(auth).toEqual({ auth: { apiKey: "mm-test-key" }, source: "MINIMAX_CODE_API_KEY" });
	});

	test("is present in the generated builtin catalog", () => {
		expect(MODELS["minimax-code"]).toBeDefined();
		expect(MODELS["minimax-code"]?.["MiniMax-M2.5"]).toMatchObject({
			provider: "minimax-code",
			api: "openai-completions",
		});
	});

	test("carries the generated compat flags on every model", () => {
		const provider = minimaxCodeProvider();
		for (const model of provider.getModels()) {
			expect(model.compat).toMatchObject({
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: false,
			});
		}
	});

	test("is static only: no runtime model discovery", () => {
		const provider = minimaxCodeProvider();
		expect(provider.refreshModels).toBeUndefined();
	});

	test("uses the existing OpenAI completions stream with minimax-code model identity", async () => {
		const modelId = "MiniMax-M3";
		const responseBody = [
			`data: ${JSON.stringify({
				id: "chatcmpl-mm-test",
				object: "chat.completion.chunk",
				created: 1,
				model: modelId,
				choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }],
			})}`,
			`data: ${JSON.stringify({
				id: "chatcmpl-mm-test",
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
		const provider = minimaxCodeProvider();
		const model = provider.getModels().find((entry) => entry.id === modelId);
		if (!model) throw new Error("minimax-code bundled model is missing");

		const result = await provider
			.stream(
				model,
				{ messages: [{ role: "user", content: "say hello", timestamp: 1 }] },
				{ apiKey: "mm-test-key" },
			)
			.result();
		expect(result).toMatchObject({
			provider: "minimax-code",
			model: modelId,
			stopReason: "stop",
		});
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
		const request = fetchSpy.mock.calls[0];
		expect(request?.[0]).toBe("https://api.minimax.io/v1/chat/completions");
		expect(request?.[1]?.method).toBe("POST");
		const headers = request?.[1]?.headers;
		expect(headers instanceof Headers ? headers.get("authorization") : undefined).toBe("Bearer mm-test-key");
	});
});
