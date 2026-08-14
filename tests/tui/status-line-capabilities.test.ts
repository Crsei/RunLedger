import { describe, expect, it } from "vitest";
import { Footer } from "../../src/tui/components/footer.ts";
import { loadTheme } from "../../src/tui/theme/theme.ts";
import type { FooterSnapshotProvider } from "../../src/tui/types.ts";

function provider(extra: Record<string, unknown> = {}): FooterSnapshotProvider {
	return {
		isStreaming: () => false,
		getStopReason: () => undefined,
		getSessionId: () => "session-1",
		getProviderId: () => "deepseek",
		getModelId: () => "deepseek-v4-pro",
		...extra,
	} as FooterSnapshotProvider;
}

function segments(extra: Record<string, unknown> = {}) {
	const footer = new Footer({ theme: loadTheme("dark"), provider: provider(extra) });
	const block = footer.present(240)[0];
	if (block?.kind !== "status-line") throw new Error("status line missing");
	return block.segments;
}

describe("S4 capability-gated status line segments", () => {
	it("emits progress, usage, limit, and thread only when their facts are available", () => {
		const result = segments({
			getPlanProgress: () => ({ completed: 2, total: 5 }),
			getContextUsage: () => ({ totalTokens: 12_345, contextWindow: 202_752 }),
			getThreadLabel: () => "thread-17",
		});

		expect(result).toEqual(expect.arrayContaining([
			{ accent: "progress", text: "plan (2/5)" },
			{ accent: "usage", text: "usage 12.3k" },
			{ accent: "limit", text: "limit 6%" },
			{ accent: "thread", text: "thread-17" },
		]));
	});

	it("does not invent zero usage, limit, or progress when capabilities are absent", () => {
		const result = segments({
			getPlanProgress: () => undefined,
			getContextUsage: () => undefined,
			getThreadLabel: () => undefined,
		});

		expect(result.some((segment) => ["progress", "usage", "limit", "thread"].includes(segment.accent))).toBe(false);
		expect(result.map((segment) => segment.text).join(" · ")).not.toMatch(/\b(?:0|unknown|unavailable)\b/u);
	});

	it("emits each context segment independently when only one bounded fact is known", () => {
		const result = segments({ getContextUsage: () => ({ totalTokens: 1_024 }) });

		expect(result).toContainEqual({ accent: "usage", text: "usage 1.0k" });
		expect(result.some((segment) => segment.accent === "limit")).toBe(false);
	});
});
