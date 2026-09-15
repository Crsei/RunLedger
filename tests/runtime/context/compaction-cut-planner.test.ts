import { describe, expect, it } from "vitest";
import type { AssistantMessage, Message } from "../../../src/types.ts";
import { historyDigest, planHistoryCut } from "../../../src/runtime/context/compaction/history.ts";
import { adjustedRetainTokens, compactionContextTokens, effectiveReserveTokens, estimateHistoryTokens, observeCompactionBudget, resolveBudgetReserveTokens, resolveThresholdTokens } from "../../../src/runtime/context/compaction/budget.ts";
import { parseCompactionSettings } from "../../../src/runtime/context/compaction/settings.ts";

function answer(text = "done", overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return { role: "assistant", content: [{ type: "text", text }], provider: "fixture", model: "fixture", api: "openai-completions", timestamp: 10, stopReason: "stop",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, ...overrides };
}
function history(): Message[] {
	return [0, 1, 2].flatMap((n): Message[] => [{ role: "user", content: `turn-${n} ${"detail ".repeat(100)}`, timestamp: n }, answer()]);
}
describe("token compaction cut and budget", () => {
	it("retains whole turns at the exact token boundary and one token above", () => {
		const messages = history(); const digest = historyDigest(messages);
		const latest = estimateHistoryTokens(messages.slice(4));
		expect(planHistoryCut(messages, latest)).toMatchObject({ ok: true, count: 4 });
		expect(planHistoryCut(messages, latest + 1)).toMatchObject({ ok: true, count: 2 });
		expect(planHistoryCut(messages, estimateHistoryTokens(messages))).toEqual({ ok: false, code: "insufficient_history" });
		expect(historyDigest(messages)).toEqual(digest);
	});
	it("retains an unfinished suffix and refuses malformed or incomplete prefixes", () => {
		const messages = history();
		messages.push({ role: "user", content: "pending", timestamp: 20 });
		expect(planHistoryCut(messages, 1)).toMatchObject({ ok: true, count: 4 });
		expect(planHistoryCut(messages, 1, 1)).toMatchObject({ ok: false, code: "incomplete_history" });
		messages[1] = answer("", { content: [{ type: "toolCall", id: "call", name: "read", arguments: { path: "a" } }], stopReason: "toolUse" });
		expect(planHistoryCut(messages, 1)).toMatchObject({ ok: false, code: "incomplete_history" });
		expect(planHistoryCut([answer(), ...history()], 1)).toMatchObject({ ok: false, code: "incomplete_history" });
	});
	it("rejects duplicate and out-of-order tool results but accepts complete batches", () => {
		const result: Message = { role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "result" }], isError: false, timestamp: 1 };
		const call = answer("", { content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }], stopReason: "toolUse" });
		const messages = history(); messages.splice(1, 0, call, result);
		expect(planHistoryCut(messages, 1)).toMatchObject({ ok: true, count: 6 });
		messages.splice(2, 0, result);
		expect(planHistoryCut(messages, 1)).toMatchObject({ ok: false });
		const reversed = history(); reversed.splice(1, 0, result, call);
		expect(planHistoryCut(reversed, 1)).toMatchObject({ ok: false });
	});
	it("corrects retention only for a finite ratio above one", () => {
		expect(adjustedRetainTokens(100, 400, 200)).toBe(50);
		for (const value of [0, 100, 200, NaN, Infinity]) expect(adjustedRetainTokens(100, value, 200)).toBe(100);
		const messages = history(); const latest = estimateHistoryTokens(messages.slice(4));
		expect(planHistoryCut(messages, latest + 1, 0, estimateHistoryTokens(messages) * 2)).toMatchObject({ ok: true, count: 4 });
	});
	it("takes both occupancy floors and preserves valid explicit small-window reserve", () => {
		expect(compactionContextTokens(300, 900)).toBe(900); expect(compactionContextTokens(900, 300)).toBe(900);
		expect(compactionContextTokens(NaN, 300)).toBe(300);
		expect(effectiveReserveTokens(16_000, {})).toBe(16_384);
		expect(resolveBudgetReserveTokens(16_000, {})).toBe(2400);
		expect(resolveBudgetReserveTokens(16_000, { reserveTokens: 15_000 })).toBe(15_000);
		expect(resolveBudgetReserveTokens(16_000, { reserveTokens: 16_384 })).toBe(2400);
		expect(resolveThresholdTokens(16_000, {})).toBe(13_600);
		expect(resolveThresholdTokens(16_000, { reserveTokens: 15_000 })).toBe(1000);
		expect(resolveThresholdTokens(16_000, { threshold: 0.5 })).toBe(8000);
		expect(resolveThresholdTokens(16_000, { thresholdTokens: 99_000 })).toBe(15_999);
	});
	it("rebuilds calibration from a matching durable usage and rejects stale generations or models", () => {
		const messages = history(); const last = answer();
		last.usage = { ...last.usage, input: 1800, cacheRead: 20, output: 100 };
		messages[5] = last;
		const sample = observeCompactionBudget(messages, { provider: "fixture", id: "fixture" });
		expect(sample.promptTokens).toBe(1820); expect(sample.contextTokens).toBe(1920);
		expect(sample.estimator.estimate("x".repeat(1000))).toBeGreaterThan(342);
		const restored = observeCompactionBudget(JSON.parse(JSON.stringify(messages)) as Message[], { provider: "fixture", id: "fixture" });
		expect(restored.estimator.estimate("same request")).toBe(sample.estimator.estimate("same request"));
		expect(observeCompactionBudget(messages, { provider: "other", id: "fixture" }).promptTokens).toBe(0);
		expect(observeCompactionBudget(messages, { provider: "fixture", id: "fixture" }, messages.length).promptTokens).toBe(0);
	});
	it("requires explicit token settings and rejects the removed turn-count setting", () => {
		expect(parseCompactionSettings(undefined).retainRecentTokens).toBe(20_000);
		expect(parseCompactionSettings(undefined).nativeMode).toBe("standalone");
		expect(parseCompactionSettings({ nativeMode: "streaming" }).nativeMode).toBe("streaming");
		expect(() => parseCompactionSettings({ nativeMode: "unknown" })).toThrow();
		expect(parseCompactionSettings({ retainRecentTokens: 123 }).retainRecentTokens).toBe(123);
		expect(() => parseCompactionSettings({ retainRecentTurns: 1 })).toThrow(/replaced/);
		for (const value of [0, -1, NaN, 0.5]) expect(() => parseCompactionSettings({ retainRecentTokens: value })).toThrow();
	});
});
