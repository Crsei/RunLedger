import { describe, expect, it } from "vitest";
import { Footer } from "../../src/tui/components/footer.ts";
import { loadTheme } from "../../src/tui/theme/theme.ts";
import type { FooterSnapshotProvider } from "../../src/tui/types.ts";
import { createDefaultFooterFieldRegistry, type FooterSnapshot } from "../../src/tui/footer/field-registry.ts";

function provider(extra: Partial<FooterSnapshot> = {}): FooterSnapshotProvider {
	return {
		getFooterSnapshot: () => ({
			nowMs: 1_000,
			isStreaming: false,
			providerId: "deepseek",
			modelId: "deepseek-v4-pro",
			queue: { steering: 0, followUp: 0 },
			...extra,
		}),
	};
}

function segments(extra: Partial<FooterSnapshot> = {}) {
	const footer = new Footer({
		theme: loadTheme("dark"),
		provider: provider(extra),
		registry: createDefaultFooterFieldRegistry(),
	});
	const block = footer.present(240)[0];
	if (block?.kind !== "status-line") throw new Error("status line missing");
	return block.segments;
}

describe("S4 capability-gated status line segments", () => {
	it("emits progress, usage, limit, and thread only when their facts are available", () => {
		const result = segments({
			planProgress: { completed: 2, total: 5 },
			contextUsage: { totalTokens: 12_345, contextWindow: 202_752 },
			threadLabel: "thread-17",
		});

		expect(result).toEqual(expect.arrayContaining([
			{ accent: "progress", text: "plan (2/5)" },
			{ accent: "usage", text: "usage 12.3k" },
			{ accent: "limit", text: "limit 6%" },
			{ accent: "thread", text: "thread-17" },
		]));
	});

	it("does not invent zero usage, limit, or progress when capabilities are absent", () => {
		const result = segments();

		expect(result.some((segment) => ["progress", "usage", "limit", "thread"].includes(segment.accent))).toBe(false);
		expect(result.map((segment) => segment.text).join(" · ")).not.toMatch(/\b(?:0|unknown|unavailable)\b/u);
	});

	it("emits each context segment independently when only one bounded fact is known", () => {
		const result = segments({ contextUsage: { totalTokens: 1_024 } });

		expect(result).toContainEqual({ accent: "usage", text: "usage 1.0k" });
		expect(result.some((segment) => segment.accent === "limit")).toBe(false);
	});
});
