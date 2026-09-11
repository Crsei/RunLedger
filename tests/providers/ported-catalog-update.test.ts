import { describe, expect, test } from "vitest";
import { mergePortedProviderModels } from "../../scripts/ported-provider-catalog.ts";
import type { Model } from "../../src/types.ts";

const model: Model<"openai-completions"> = {
	id: "deepseek/deepseek-v3-turbo", name: "retired", api: "openai-completions", provider: "novita",
	baseUrl: "https://api.novita.ai/v3/openai", reasoning: false, input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 1024,
};

describe("ported provider snapshot merge", () => {
	test("removes source-retired models but preserves target-only providers and IDs", () => {
		const result = mergePortedProviderModels([model, { ...model, id: "target-only" }, { ...model, provider: "opencode" }]);
		expect(result.some((entry) => entry.provider === "novita" && entry.id === model.id)).toBe(false);
		expect(result.some((entry) => entry.provider === "novita" && entry.id === "target-only")).toBe(true);
		expect(result.some((entry) => entry.provider === "opencode" && entry.id === model.id)).toBe(true);
	});

	test("keeps native transport and compat while updating upstream model limits", () => {
		const native = { ...model, provider: "xai", id: "grok-4.3", compat: { supportsStore: false },
			cost: { ...model.cost, tiers: [{ inputTokensAbove: 200000, input: 4, output: 8, cacheRead: 0.4, cacheWrite: 0 }] } };
		const result = mergePortedProviderModels([native]).find((entry) => entry.provider === "xai" && entry.id === "grok-4.3");
		expect(result).toMatchObject({ api: "openai-completions", baseUrl: native.baseUrl, compat: native.compat });
		expect(result?.contextWindow).toBeGreaterThan(4096);
		expect(result?.cost.tiers).toEqual(native.cost.tiers);
	});

	test("produces only supported APIs and is stable when run again", () => {
		const first = mergePortedProviderModels([]);
		expect(new Set(first.map((entry) => entry.api))).not.toContain("openrouter");
		expect(first.filter((entry) => entry.provider === "google-vertex").every((entry) => entry.api === "google-vertex")).toBe(true);
		expect(mergePortedProviderModels(first)).toEqual(first);
	});

	/**
	 * 目标侧退役:来源快照仍带着该 id,但 provider 已确认不再提供。
	 * 必须同时从 vendored 行与其它来源行中移除,否则它会经由 models.dev/冻结输入复活。
	 */
	test("drops target-retired ids from both the vendored rows and other sources", () => {
		const fromOtherSource: Model<"openai-completions"> = {
			...model, id: "ox-alpha-free", provider: "opencode-go",
			baseUrl: "https://opencode.ai/zen/go/v1",
		};
		const result = mergePortedProviderModels([fromOtherSource]);
		expect(result.some((entry) => entry.provider === "opencode-go" && entry.id === "ox-alpha-free")).toBe(false);
		// 未退役的邻居仍在,证明不是整段 provider 被丢弃。
		expect(result.some((entry) => entry.provider === "opencode-go")).toBe(true);
	});
});
