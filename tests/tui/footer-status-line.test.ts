import { describe, expect, it } from "vitest";
import { Footer, fitStatusLineSegments } from "../../src/tui/components/footer.ts";
import { loadTheme } from "../../src/tui/theme/theme.ts";
import type { FooterSnapshotProvider } from "../../src/tui/types.ts";
import { visibleWidth } from "../../src/tui/primitives.ts";

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
});
