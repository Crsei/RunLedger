import { describe, expect, it } from "vitest";
import { parseChunkUsage } from "../../src/api/openai-completions/stream-mapper.ts";
import { seedUsageAccumulator, usageSnapshot } from "../../src/runtime/usage/index.ts";
import { createDefaultFooterFieldRegistry, fitProjectedFooterRows } from "../../src/tui/footer/field-registry.ts";
import type { AssistantMessage, Model } from "../../src/types.ts";

const model: Model<"openai-completions"> = {
	id: "cache-fixture", name: "Cache fixture", api: "openai-completions", provider: "deepseek",
	baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
	cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 1024,
};

function message(usage: AssistantMessage["usage"]): AssistantMessage {
	return { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage, stopReason: "stop", timestamp: 1 };
}

function footer(messages: AssistantMessage[]): string[] {
	const usage = usageSnapshot(seedUsageAccumulator(messages), undefined, "idle");
	const projection = createDefaultFooterFieldRegistry().project({ nowMs: 1, modelId: model.id, isStreaming: false, queue: { steering: 0, followUp: 0 }, usage });
	return fitProjectedFooterRows(projection.rows, 189).flatMap((row) => row.fields.map((field) => field.segment.text));
}

describe("completions cache usage reaches the Footer", () => {
	it("shows DeepSeek hits without a separate cache write field, including existing session records", () => {
		const usage = parseChunkUsage({ prompt_tokens: 29392, completion_tokens: 1319, prompt_cache_hit_tokens: 29056 }, model);
		expect(footer([message(usage)])).toContain("hit 98.9%");
		const { reported: _reported, ...legacy } = usage;
		expect(footer([message(legacy), message(usage)])).toContain("hit 98.9%");
		expect(legacy).not.toHaveProperty("reported");
	});

	it("preserves explicit zero hits and fully cached prompts", () => {
		expect(footer([message(parseChunkUsage({ prompt_tokens: 100, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } }, model))])).toContain("hit 0.0%");
		expect(footer([message(parseChunkUsage({ prompt_tokens: 100, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 100 } }, model))])).toContain("hit 100.0%");
	});

	it("keeps missing cache reads, explicitly unknown writes, other protocols and empty usage unknown", () => {
		const usage = parseChunkUsage({ prompt_tokens: 100, completion_tokens: 1 }, model);
		expect(footer([message(usage)]).some((text) => text.startsWith("hit "))).toBe(false);
		const cached = parseChunkUsage({ prompt_tokens: 100, completion_tokens: 1, prompt_cache_hit_tokens: 90 }, model);
		const { reported: _reported, ...legacy } = cached;
		for (const entry of [
			message({ ...legacy, reported: { cacheWrite: false } }),
			{ ...message(legacy), api: "anthropic-messages" as const },
			message(parseChunkUsage({}, model)),
		]) expect(footer([entry]).some((text) => text.startsWith("hit "))).toBe(false);
	});
});
