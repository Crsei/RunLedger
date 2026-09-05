import { afterEach, describe, expect, test, vi } from "vitest";
import { builtinModels, builtinProviders } from "../../src/providers/all.ts";
import type { Provider } from "../../src/models.ts";

afterEach(() => vi.restoreAllMocks());

function providerById(id: string): Provider {
	const provider = builtinProviders().find((entry) => entry.id === id);
	expect(provider, `builtin provider ${id}`).toBeDefined();
	return provider!;
}

const cases = [
	["abliteration", "abliterated-model", "ABLITERATION_API_KEY", "openai-responses"],
	["cline-pass", "kimi-k3", "CLINE_API_KEY", "openai-completions"],
	["deepinfra", "deepseek-ai/DeepSeek-V4-Flash-0731", "DEEPINFRA_API_KEY", "openai-completions"],
	["yolo-auto", "deepseek-flash-v4", "YOLO_AUTO_API_KEY", "openai-completions"],
] as const;

describe("oh-my-pi 18.1.9 provider update", () => {
	test.each(cases)("registers %s with isolated stored/env authentication", async (id, modelId, env, api) => {
		const provider = providerById(id);
		expect(builtinProviders().filter((entry) => entry.id === id)).toHaveLength(1);
		expect(provider.getModels().find((entry) => entry.id === modelId)).toMatchObject({ provider: id, api });
		const ctx = { env: async (name: string) => name === env ? "fixture-key" : undefined, fileExists: async () => false };
		expect(await provider.auth.apiKey?.resolve({ ctx })).toMatchObject({ auth: { apiKey: "fixture-key" } });
		expect(await provider.auth.apiKey?.resolve({ ctx, credential: { type: "api_key", key: "stored-fixture" } }))
			.toMatchObject({ auth: { apiKey: "stored-fixture" } });
		expect(await provider.auth.apiKey?.resolve({ ctx: { ...ctx, env: async () => undefined } })).toBeUndefined();
		const models = builtinModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
		const model = models.getModel(id, modelId)!;
		expect((await models.streamSimple(model, { messages: [] }).result()).stopReason).toBe("error");
	});

	test("refreshes previously ported and native catalogs", () => {
		const models = builtinModels();
		expect(models.getModel("zhipu-coding-plan", "glm-5.3")).toMatchObject({ reasoning: true });
		expect(models.getModel("deepseek", "deepseek-v4-flash-vision-exp")).toMatchObject({ input: ["text", "image"] });
		expect(models.getModel("openai", "gpt-5.6-cyber")).toMatchObject({ api: "openai-responses" });
	});

	test.each([
		["cline-pass", "kimi-k3", "cline-pass/kimi-k3"],
		["cline-pass", "deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-flash"],
		["deepinfra", "deepseek-ai/DeepSeek-V4-Flash-0731", "deepseek-ai/DeepSeek-V4-Flash-0731"],
		["yolo-auto", "deepseek-flash-v4", "deepseek-flash-v4"],
	])("streams %s/%s with the correct wire model", async (id, modelId, wireId) => {
		const provider = providerById(id);
		const model = provider.getModels().find((entry) => entry.id === modelId)!;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(chatResponse());
		const result = await provider.streamSimple(model, {
			systemPrompt: "Be concise.", messages: [{ role: "user", content: "hello", timestamp: 1 }],
		}, { apiKey: "fixture-key", reasoning: "high", sessionId: "fixture-session" }).result();
		expect(result).toMatchObject({ provider: id, model: modelId, stopReason: "stop", content: [{ type: "text", text: "hello" }] });
		const call = fetchSpy.mock.calls[0]!;
		const body = JSON.parse(String(call[1]?.body));
		expect(body.model).toBe(wireId);
		if (id === "cline-pass") {
			const headers = new Headers(call[1]?.headers);
			expect(headers.get("X-CLIENT-TYPE")).toBe("cline-sdk");
			expect(headers.get("X-Task-ID")).toBe("fixture-session");
		}
		if (id === "yolo-auto") {
			expect(body.chat_template_kwargs).toEqual({ thinking: true, reasoning_effort: "high" });
			expect(body.store).toBeUndefined();
			expect(body.messages[0].role).toBe("system");
		}
	});

	test("ClinePass sends reasoning budgets and an explicit disabled state", async () => {
		const provider = providerById("cline-pass");
		const model = provider.getModels().find((entry) => entry.id === "qwen3.7-plus")!;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => chatResponse());
		await provider.streamSimple(model, { messages: [] }, { apiKey: "fixture-key", reasoning: "high" }).result();
		expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body)).reasoning).toEqual({ max_tokens: 104857 });
		await provider.streamSimple(model, { messages: [] }, { apiKey: "fixture-key" }).result();
		expect(JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body)).reasoning).toEqual({ enabled: false });
	});

	test("Yolo-Auto disables reasoning for explicit tool choice", async () => {
		const provider = providerById("yolo-auto");
		const model = provider.getModels()[0]!;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(chatResponse());
		await provider.stream(model, { messages: [] }, { apiKey: "fixture-key", reasoningEffort: "high", toolChoice: "required" }).result();
		expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body)).chat_template_kwargs).toEqual({ thinking: false });
	});

	test("Abliteration does not request unsupported encrypted reasoning", async () => {
		const provider = providerById("abliteration");
		const model = provider.getModels()[0]!;
		let payload: unknown;
		await provider.streamSimple(model, { messages: [] }, {
			apiKey: "fixture-key", reasoning: "high",
			onPayload: (body) => { payload = body; throw new Error("fixture stop before network"); },
		}).result();
		expect(payload).toMatchObject({ model: "abliterated-model", reasoning: { effort: "high" } });
		expect(payload).not.toHaveProperty("include");
	});

	test("Responses encrypted-reasoning opt-out also overrides xAI defaults", async () => {
		const provider = providerById("xai");
		const original = provider.getModels().find((entry) => entry.api === "openai-responses" && entry.reasoning)!;
		const model = { ...original, compat: { ...original.compat, includeEncryptedReasoning: false } };
		let payload: unknown;
		await provider.streamSimple(model, { messages: [] }, {
			apiKey: "fixture-key", reasoning: "high",
			onPayload: (body) => { payload = body; throw new Error("fixture stop before network"); },
		}).result();
		expect(payload).toHaveProperty("reasoning");
		expect(payload).not.toHaveProperty("include");
	});
});

function chatResponse(): Response {
	return new Response([
		`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }] })}`,
		`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
		"data: [DONE]",
	].join("\n\n"), { headers: { "content-type": "text/event-stream" } });
}
