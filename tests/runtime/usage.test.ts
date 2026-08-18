import { describe, expect, it } from "vitest";
import {
	applyUsageObservation,
	calculateCacheHitPercent,
	calculateOutputTokensPerSecond,
	createUsageAccumulator,
	formatUsageSegments,
	usageSnapshot,
	} from "../../src/runtime/usage/index.ts";
import type { AssistantMessage } from "../../src/types.ts";

function reportedUsage(input: number, output: number, cacheRead: number, cacheWrite: number, cost: number): AssistantMessage["usage"] {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
		reported: { input: true, output: true, cacheRead: true, cacheWrite: true, cost: true },
	};
}

describe("usage reducer and display contract", () => {
	it("aggregates fields independently, excludes cacheRead from token total, and replaces duplicate request ids", () => {
		let state = createUsageAccumulator();
		state = applyUsageObservation(state, {
			id: "request-1",
			usage: reportedUsage(100, 20, 500, 10, 0.01),
			durationMs: 200,
			timingSource: "provider",
			status: "completed",
		});
		state = applyUsageObservation(state, {
			id: "request-2",
			usage: reportedUsage(50, 10, 100, 0, 0.02),
			status: "completed",
		});
		state = applyUsageObservation(state, {
			id: "request-2",
			usage: reportedUsage(60, 12, 110, 2, 0.03),
			status: "completed",
		});

		const snapshot = usageSnapshot(state, {
			usedTokens: 180,
			contextWindow: 1_000,
		}, "idle");
		expect(snapshot.cumulative.input).toMatchObject({ state: "exact", value: 160 });
		expect(snapshot.cumulative.output).toMatchObject({ state: "exact", value: 32 });
		expect(snapshot.cumulative.cacheRead).toMatchObject({ state: "exact", value: 610 });
		expect(snapshot.cumulative.cacheWrite).toMatchObject({ state: "exact", value: 12 });
		expect(snapshot.cumulative.tokenTotal).toMatchObject({ state: "exact", value: 204 });
		expect(snapshot.cumulative.cost).toMatchObject({ state: "exact", value: 0.04 });
		expect(snapshot.context?.percent).toMatchObject({ state: "exact", value: 18 });
	});

	it("uses the provider duration first, enforces the 100ms floor, and supports streaming fallback", () => {
		expect(calculateOutputTokensPerSecond({ outputTokens: 20, providerDurationMs: 200, measuredDurationMs: 900 })).toBe(100);
		expect(calculateOutputTokensPerSecond({ outputTokens: 20, providerDurationMs: 99 })).toBeNull();
		expect(calculateOutputTokensPerSecond({ outputTokens: 20, streamStartedAtMs: 500, nowMs: 750, isStreaming: true })).toBe(80);
		expect(calculateOutputTokensPerSecond({ outputTokens: 0, providerDurationMs: 200 })).toBeNull();
		expect(calculateOutputTokensPerSecond({ outputTokens: Number.NaN, providerDurationMs: 200 })).toBeNull();
	});

	it("returns cache hit only when all cache-hit operands are known, including exact zero", () => {
		expect(calculateCacheHitPercent({ input: 100, cacheRead: 900, cacheWrite: 0 })).toBeCloseTo(90);
		expect(calculateCacheHitPercent({ input: 0, cacheRead: 0, cacheWrite: 0 })).toBeNull();
		expect(calculateCacheHitPercent({ input: 100, cacheRead: undefined, cacheWrite: 0 })).toBeNull();
		expect(calculateCacheHitPercent({ input: -1, cacheRead: 1, cacheWrite: 0 })).toBeNull();
	});

	it("formats available values with stable labels and omits unavailable zero defaults", () => {
		let state = createUsageAccumulator();
		state = applyUsageObservation(state, {
			id: "known",
			usage: reportedUsage(12_300, 1_400, 8_000, 512, 0.03),
			durationMs: 2_000,
			timingSource: "provider",
			status: "completed",
		});
		const complete = usageSnapshot(state, { usedTokens: 18_200, contextWindow: 128_000 }, "idle");
		expect(formatUsageSegments(complete).map((segment) => segment.text)).toEqual([
			"in 12.3k",
			"out 1.4k",
			"cache-read 8.0k",
			"cache-write 512",
			"hit 38.4%",
			"700.0 tok/s",
			"$0.03",
			"ctx 18.2k/128.0k (14.2%)",
		]);

		state = applyUsageObservation(createUsageAccumulator(), {
			id: "partial",
			usage: {
				...reportedUsage(12, 0, 0, 0, 0),
				reported: { input: true, output: true },
			},
			status: "completed",
		});
		const partial = usageSnapshot(state, undefined, "idle");
		const partialText = formatUsageSegments(partial).map((segment) => segment.text).join(" · ");
		expect(partialText).toContain("in 12");
		expect(partialText).toContain("out 0");
		expect(partialText).not.toContain("cache-read");
		expect(partialText).not.toContain("cache-write");
		expect(partialText).not.toContain("$");
	});
});
