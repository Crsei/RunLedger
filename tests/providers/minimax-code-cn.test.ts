import { afterEach, describe, expect, test, vi } from "vitest";
import { MODELS } from "../../src/models.generated.ts";
import { minimaxCodeCnProvider } from "../../src/providers/minimax-code-cn.ts";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("minimax-code-cn provider", () => {
	test("exposes the bundled catalog, CN base URL, and env-key auth", async () => {
		const provider = minimaxCodeCnProvider();

		expect(provider.id).toBe("minimax-code-cn");
		expect(provider.name).toBe("MiniMax Token Plan (China)");
		expect(provider.baseUrl).toBe("https://api.minimaxi.com/v1");
		expect(provider.getModels().find((entry) => entry.id === "MiniMax-M3")).toMatchObject({
			api: "openai-completions",
			provider: "minimax-code-cn",
			baseUrl: "https://api.minimaxi.com/v1",
		});

		const auth = await provider.auth.apiKey?.resolve({
			ctx: { env: async (name) => (name === "MINIMAX_CODE_CN_API_KEY" ? "mmcn-test-key" : undefined), fileExists: async () => false },
		});
		expect(auth).toEqual({ auth: { apiKey: "mmcn-test-key" }, source: "MINIMAX_CODE_CN_API_KEY" });
	});

	test("is present in the generated builtin catalog", () => {
		expect(MODELS["minimax-code-cn"]).toBeDefined();
		expect(MODELS["minimax-code-cn"]?.["MiniMax-M2.5"]).toMatchObject({
			provider: "minimax-code-cn",
			api: "openai-completions",
		});
	});

	test("carries the generated compat flags on every model", () => {
		const provider = minimaxCodeCnProvider();
		for (const model of provider.getModels()) {
			expect(model.compat).toMatchObject({
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: false,
			});
		}
	});

	test("is static only: no runtime model discovery", () => {
		const provider = minimaxCodeCnProvider();
		expect(provider.refreshModels).toBeUndefined();
	});

	test("uses the existing OpenAI completions stream with minimax-code-cn model identity", async () => {
		const modelId = "MiniMax-M3";
		const responseBody = [
			`data: ${JSON.stringify({
				id: "chatcmpl-mmcn-test",
				object: "chat.completion.chunk",
				created: 1,
				model: modelId,
				choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }],
			})}`,
			`data: ${JSON.stringify({
				id: "chatcmpl-mmcn-test",
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
		const provider = minimaxCodeCnProvider();
		const model = provider.getModels().find((entry) => entry.id === modelId);
		if (!model) throw new Error("minimax-code-cn bundled model is missing");

		const result = await provider
			.stream(
				model,
				{ messages: [{ role: "user", content: "say hello", timestamp: 1 }] },
				{ apiKey: "mmcn-test-key" },
			)
			.result();
		expect(result).toMatchObject({
			provider: "minimax-code-cn",
			model: modelId,
			stopReason: "stop",
		});
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
		const request = fetchSpy.mock.calls[0];
		expect(request?.[0]).toBe("https://api.minimaxi.com/v1/chat/completions");
		expect(request?.[1]?.method).toBe("POST");
		const headers = request?.[1]?.headers;
		expect(headers instanceof Headers ? headers.get("authorization") : undefined).toBe("Bearer mmcn-test-key");
	});
});
