import { describe, expect, it } from "vitest";
import { runtimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import { CompactionStrategyRegistry, type CompactionStrategyInput, type SummaryModelPort } from "../../../src/runtime/context/compaction/strategy.ts";
import { singlePassStrategy, hierarchicalStrategy } from "../../../src/runtime/context/compaction/summary-strategies.ts";
import { SUMMARY_HEADINGS } from "../../../src/runtime/context/compaction/summary-format.ts";
import { createBudgetedSummaryModel } from "../../../src/runtime/context/compaction/budgeted-model.ts";

function summary(fact: string): string { return SUMMARY_HEADINGS.map((heading) => `${heading}: ${fact}`).join("\n"); }
function input(units = ["A".repeat(900), "B".repeat(900), "C".repeat(900)]): CompactionStrategyInput {
	return { inputDigest: runtimeDigest(units), units, limits: { maxInputTokensPerCall: 400, maxSummaryTokens: 140, maxSummaryBytes: 800, maxModelCalls: 8, maxTotalInputTokens: 5000, maxTotalOutputTokens: 1000, maxLevels: 4, deadlineMs: Date.now() + 5000 } };
}
const registry = new CompactionStrategyRegistry([singlePassStrategy, hierarchicalStrategy]);

describe("compaction strategy selection and budgets", () => {
	it("single-pass fails without slicing while hierarchical covers every source unit", async () => {
		const source = input(); const requests: string[] = [];
		const signal = new AbortController().signal;
		const transport: SummaryModelPort = { generate: async ({ content }) => { requests.push(content); return { ok: true, text: summary(content[0] ?? "merged") }; } };
		expect(await registry.generate(singlePassStrategy.key, source, transport, signal)).toEqual({ ok: false, code: "input_too_large" });
		expect(requests).toEqual([]);
		const port = createBudgetedSummaryModel(transport, source.limits, signal);
		const result = await registry.generate(hierarchicalStrategy.key, source, port, signal);
		expect(result.ok).toBe(true);
		expect(requests.slice(0, 3)).toEqual(source.units);
		expect(requests[3]).toBe([summary("A"), summary("B"), summary("C")].join("\n\n"));
		expect(port.usage().calls).toBe(4);
	});
	it("rejects duplicate and unknown versions without a model call", async () => {
		expect(() => new CompactionStrategyRegistry([singlePassStrategy, singlePassStrategy])).toThrow(/duplicate/);
		expect(await registry.generate({ id: "single-pass", version: 2 }, input(), { generate: async () => { throw new Error("must not call"); } }, new AbortController().signal)).toEqual({ ok: false, code: "strategy_unavailable" });
	});
	it("does not retry or switch strategies when the cumulative budget is exhausted", async () => {
		const source = input(); const signal = new AbortController().signal;
		const limits = { ...source.limits, maxModelCalls: 2 };
		const port = createBudgetedSummaryModel({ generate: async () => ({ ok: true, text: summary("partial") }) }, limits, signal);
		expect(await registry.generate(hierarchicalStrategy.key, { ...source, limits }, port, signal)).toEqual({ ok: false, code: "budget_exhausted" });
		expect(port.usage().calls).toBe(2);
	});
	it("cancels transport and rejects a late response", async () => {
		const source = input(["history"]); const controller = new AbortController();
		let complete: ((value: { ok: true; text: string }) => void) | undefined;
		let transportSignal: AbortSignal | undefined;
		const port = createBudgetedSummaryModel({ generate: ({ signal }) => { transportSignal = signal; return new Promise((resolve) => { complete = resolve; }); } }, source.limits, controller.signal);
		const pending = registry.generate(singlePassStrategy.key, source, port, controller.signal);
		controller.abort();
		expect(await pending).toEqual({ ok: false, code: "cancelled" });
		expect(transportSignal?.aborted).toBe(true);
		complete?.({ ok: true, text: "late summary" });
	});
	it("rejects non-shrinking hierarchy and oversized final output", async () => {
		const source = input([summary("A") + "A".repeat(500), summary("B") + "B".repeat(500)]); const signal = new AbortController().signal;
		const generous = { ...source, limits: { ...source.limits, maxSummaryTokens: 400, maxSummaryBytes: 2000 } };
		expect(await registry.generate(hierarchicalStrategy.key, generous, { generate: async ({ content }) => ({ ok: true, text: content }) }, signal)).toEqual({ ok: false, code: "budget_exhausted" });
		expect(await registry.generate(singlePassStrategy.key, input(["source"]), { generate: async () => ({ ok: true, text: "X".repeat(801) }) }, signal)).toEqual({ ok: false, code: "invalid_output" });
	});
});
