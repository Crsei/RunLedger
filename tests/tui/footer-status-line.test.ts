import { describe, expect, it } from "vitest";
import { Footer, fitStatusLineSegments, fitUsageStatusLineSegments } from "../../src/tui/components/footer.ts";
import { loadTheme } from "../../src/tui/theme/theme.ts";
import type { FooterSnapshotProvider } from "../../src/tui/types.ts";
import { visibleWidth } from "../../src/tui/primitives.ts";
import { applyUsageObservation, createUsageAccumulator, usageSnapshot } from "../../src/runtime/usage/index.ts";

function provider(threadLabel?: string): FooterSnapshotProvider {
	return {
		isStreaming: () => false,
		getStopReason: () => undefined,
		getSessionId: () => "session-0123456789abcdef",
		getThreadLabel: () => threadLabel,
		getProviderId: () => "deepseek",
		getModelId: () => "deepseek-v4-pro",
		getThinkingLevel: () => "high",
		getWorkspaceDisplayAbsolutePath: () => "/home/alice/work/RunLedger",
		getGitBranchLabel: () => "feature/highlight",
		getWorkspaceCapability: () => "ws:linux-verified",
	};
}

describe("structured Footer status line", () => {
	it.each([60, 80, 143])("hides idle while keeping the model visible without exceeding %i columns", (width) => {
		const footer = new Footer({ theme: loadTheme("dark"), provider: provider() });
		const block = footer.present(width)[0];
		expect(block?.kind).toBe("status-line");
		if (block?.kind !== "status-line") return;
		const text = block.segments.map((segment) => segment.text).join(" · ");
		expect(block.segments.some((segment) => segment.accent === "state")).toBe(false);
		expect(block.segments.some((segment) => segment.accent === "model")).toBe(true);
		expect(text).not.toContain("idle");
		expect(text).not.toContain("\u001b");
		expect(text).not.toContain("\u0007");
		expect(visibleWidth(text)).toBeLessThanOrEqual(width);
	});

	it("hides the session id until a durable title is available", () => {
		const unnamed = new Footer({ theme: loadTheme("dark"), provider: provider() });
		const unnamedText = unnamed.present(143)[0];
		if (unnamedText?.kind !== "status-line") throw new Error("status line missing");
		expect(unnamedText.segments.some((segment) => segment.text === "session-0123456789abcdef")).toBe(false);

		const titled = new Footer({ theme: loadTheme("dark"), provider: provider("Fix login flow") });
		const titledText = titled.present(143)[0];
		if (titledText?.kind !== "status-line") throw new Error("status line missing");
		expect(titledText.segments).toContainEqual({ accent: "thread", text: "Fix login flow" });
		expect(titledText.segments.some((segment) => segment.text === "session-0123456789abcdef")).toBe(false);
	});

	it("assigns the agent runtime absolute path and Git branch their own semantic accents", () => {
		const footer = new Footer({ theme: loadTheme("dark"), provider: provider() });
		const block = footer.present(143)[0];
		if (block?.kind !== "status-line") throw new Error("status line missing");
		expect(block.segments).toEqual(expect.arrayContaining([
			{ accent: "path", text: "/home/alice/work/RunLedger" },
			{ accent: "branch", text: "feature/highlight" },
		]));
	});

	it("keeps the durable session title while dropping lower-priority capability", () => {
		const fitted = fitStatusLineSegments([
			{ accent: "state", text: "Working 12s" },
			{ accent: "path", text: "~/work/RunLedger" },
			{ accent: "thread", text: "Implement durable session title display" },
			{ accent: "model", text: "deepseek/deepseek-v4-pro" },
			{ accent: "mode", text: "ws:linux-verified" },
		], 60);
		expect(fitted.map((segment) => segment.accent)).toEqual(["state", "path", "thread", "model"]);
		const title = fitted.find((segment) => segment.accent === "thread")?.text ?? "";
		expect(title).not.toContain("session-");
		expect(title.length).toBeGreaterThan(0);
	});

	it("renders usage as a separate structured row below identity status", () => {
		let accumulator = createUsageAccumulator();
		accumulator = applyUsageObservation(accumulator, {
			id: "assistant:1",
			usage: {
				input: 1_200,
				output: 300,
				cacheRead: 2_000,
				cacheWrite: 20,
				totalTokens: 3_520,
				cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
				reported: { input: true, output: true, cacheRead: true, cacheWrite: true, cost: true },
			},
			durationMs: 500,
			timingSource: "provider",
			status: "completed",
		});
		const snapshot = usageSnapshot(accumulator, { usedTokens: 2_000, contextWindow: 8_000 }, "idle");
		const footerProvider = {
			...provider(),
			getUsageSnapshot: () => snapshot,
		};
		const footer = new Footer({ theme: loadTheme("dark"), provider: footerProvider });
		const blocks = footer.present(240);

		expect(blocks).toHaveLength(2);
		expect(blocks[0]?.kind).toBe("status-line");
		expect(blocks[1]?.kind).toBe("status-line");
		if (blocks[1]?.kind !== "status-line") return;
		expect(blocks[1].segments.map((segment) => segment.text)).toEqual(expect.arrayContaining([
			"in 1.2k",
			"out 300",
			"cache-read 2.0k",
			"cache-write 20",
			"hit 62.1%",
			"600.0 tok/s",
			"$0.03",
			"ctx 2.0k/8.0k (25.0%)",
		]));
		expect(blocks[1].segments.find((segment) => segment.text.startsWith("ctx "))?.accent).toBe("limit");
	});

	it("keeps output, rate, and context before optional usage fields on narrow rows", () => {
		const fitted = fitUsageStatusLineSegments([
			{ accent: "usage", text: "in 12.3k" },
			{ accent: "usage", text: "out 1.4k" },
			{ accent: "usage", text: "cache-read 8.0k" },
			{ accent: "usage", text: "cache-write 512" },
			{ accent: "usage", text: "hit 38.4%" },
			{ accent: "usage", text: "700.0 tok/s" },
			{ accent: "usage", text: "$0.03" },
			{ accent: "usage", text: "ctx 18.2k/128.0k (14.2%)" },
		], 60);
		const text = fitted.map((segment) => segment.text);
		expect(text).toContain("out 1.4k");
		expect(text).toContain("700.0 tok/s");
		expect(text.some((segment) => segment.startsWith("ctx "))).toBe(true);
		expect(text).not.toContain("$0.03");
		expect(text).not.toContain("hit 38.4%");
		expect(text).not.toContain("cache-read 8.0k");
		expect(text).not.toContain("cache-write 512");
		expect(visibleWidth(text.join(" · "))).toBeLessThanOrEqual(60);
	});
});
