import { describe, expect, it } from "vitest";
import { conservativeTokenEstimate, TokenEstimator } from "../../../src/runtime/context/token-estimator.ts";

describe("context token estimator", () => {
	it("keeps a bounded UTF-8 fallback and ignores malformed provider usage", () => {
		const estimator = new TokenEstimator();
		const content = "中文🙂abc";
		const baseline = estimator.estimate(content);

		estimator.observe({ inputChars: 10, inputBytes: 0, inputTokens: Number.MAX_SAFE_INTEGER });

		expect(estimator.estimate(content)).toBe(baseline);
		expect(conservativeTokenEstimate("x".repeat(20_000_000))).toBe(4_194_304);
	});

	it("only raises its safety margin when a valid provider receipt is observed", () => {
		const estimator = new TokenEstimator();
		const before = estimator.estimate("short");

		estimator.observe({ inputChars: 5, inputBytes: 5, inputTokens: 10 });

		expect(estimator.estimate("short")).toBeGreaterThanOrEqual(before);
	});
});
