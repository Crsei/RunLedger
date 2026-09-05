import { describe, expect, test } from "vitest";
import { InMemoryModelsStore } from "../../src/models-store.ts";
import { abliterationProvider } from "../../src/providers/abliteration.ts";
import { clinePassProvider } from "../../src/providers/cline-pass.ts";
import { deepinfraProvider } from "../../src/providers/deepinfra.ts";
import { yoloAutoProvider } from "../../src/providers/yolo-auto.ts";

const cases = [
	{ id: "abliteration", factory: abliterationProvider, path: "/models", payload: { data: [{ id: "new-model" }] }, expected: { id: "new-model", reasoning: true, api: "openai-responses" } },
	{ id: "cline-pass", factory: clinePassProvider, path: "/ai/cline/recommended-models", payload: { clinePass: [{ id: "cline-pass/kimi-k3" }, { id: "bad-id" }], free: [{ id: "free/model" }] }, expected: { id: "kimi-k3", compat: { wireModelId: "cline-pass/kimi-k3" } } },
	{ id: "deepinfra", factory: deepinfraProvider, path: "/models?filter=with_meta&sort_by=omp", payload: { data: [{ id: "new-model", metadata: { context_length: 32000, max_tokens: 32000, tags: ["chat", "reasoning", "vision"], pricing: { input_tokens: 0.2, output_tokens: 0.5 } } }] }, expected: { id: "new-model", reasoning: true, input: ["text", "image"], contextWindow: 32000, maxTokens: 8192, cost: { input: 0.2, output: 0.5 } } },
	{ id: "yolo-auto", factory: yoloAutoProvider, path: "/models", payload: { data: [{ id: "new-model", context_length: 32000 }] }, expected: { id: "new-model", contextWindow: 32000, cost: { input: 0, output: 0 }, compat: { supportsStore: false, supportsDeveloperRole: false } } },
] as const;

describe("oh-my-pi provider discovery", () => {
	test.each(cases)("$id maps its catalog and retains last known good on failure", async ({ id, factory, path, payload, expected }) => {
		let response: unknown = payload;
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const fetchImpl: typeof fetch = async (url, init) => {
			calls.push({ url: String(url), init });
			return Response.json(response);
		};
		const provider = factory({ baseUrl: "http://localhost:9876/v1", fetch: fetchImpl });
		expect(provider.refreshModels).toBeTypeOf("function");
		const store = new InMemoryModelsStore();
		const context = {
			credential: { type: "api_key" as const, key: "fixture-key" }, allowNetwork: true,
			store: { read: () => store.read(id), write: (entry: Parameters<typeof store.write>[1]) => store.write(id, entry), delete: () => store.delete(id) },
		};
		await provider.refreshModels!(context);
		expect(calls[0]?.url).toBe(`http://localhost:9876/v1${path}`);
		expect(provider.getModels().find((model) => model.id === expected.id)).toMatchObject(expected);
		if (id === "cline-pass") {
			expect(provider.getModels().find((model) => model.id === "free/model")).toMatchObject({ compat: { wireModelId: "free/model" }, cost: { input: 0, output: 0 } });
		}
		const knownGood = JSON.stringify(provider.getModels());
		for (const invalid of [{ data: [] }, {}, { clinePass: [{ id: "bad-id" }] }]) {
			response = invalid;
			await expect(provider.refreshModels!(context)).rejects.toThrow();
			expect(JSON.stringify(provider.getModels())).toBe(knownGood);
		}
		const before = calls.length;
		await provider.refreshModels!({ ...context, allowNetwork: false });
		await provider.refreshModels!({ ...context, signal: AbortSignal.abort() });
		expect(calls).toHaveLength(before);
	});

	test("Abliteration accepts its documented alternate env key", async () => {
		const auth = await abliterationProvider().auth.apiKey?.resolve({ ctx: { env: async (name) => name === "ABLIT_KEY" ? "fixture-key" : undefined, fileExists: async () => false } });
		expect(auth?.source).toBe("ABLIT_KEY");
	});
});
