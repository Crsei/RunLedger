import { describe, expect, it } from "vitest";
import { Footer, fitStatusLineSegments } from "../../src/tui/components/footer.ts";
import { loadTheme } from "../../src/tui/theme/theme.ts";
import type { FooterSnapshotProvider } from "../../src/tui/types.ts";
import { visibleWidth } from "../../src/tui/primitives.ts";

function provider(): FooterSnapshotProvider {
	return {
		isStreaming: () => false,
		getStopReason: () => undefined,
		getSessionId: () => "session-0123456789abcdef",
		getProviderId: () => "deepseek",
		getModelId: () => "deepseek-v4-pro",
		getThinkingLevel: () => "high",
		getWorkspaceDisplayLabel: () => "~/work/RunLedger\u001b]0;owned\u0007",
		getProjectRootDisplayLabel: () => "RunLedger",
		getGitBranchLabel: () => "feature/highlight",
		getWorkspaceCapability: () => "ws:linux-verified",
	};
}

describe("structured Footer status line", () => {
	it.each([60, 80, 143])("keeps state and model visible without exceeding %i columns", (width) => {
		const footer = new Footer({ theme: loadTheme("dark"), provider: provider() });
		const block = footer.present(width)[0];
		expect(block?.kind).toBe("status-line");
		if (block?.kind !== "status-line") return;
		const text = block.segments.map((segment) => segment.text).join(" · ");
		expect(block.segments.some((segment) => segment.accent === "state")).toBe(true);
		expect(block.segments.some((segment) => segment.accent === "model")).toBe(true);
		expect(text).not.toContain("\u001b");
		expect(text).not.toContain("\u0007");
		expect(visibleWidth(text)).toBeLessThanOrEqual(width);
	});

	it("assigns project root and Git branch their own semantic accents", () => {
		const footer = new Footer({ theme: loadTheme("dark"), provider: provider() });
		const block = footer.present(143)[0];
		if (block?.kind !== "status-line") throw new Error("status line missing");
		expect(block.segments).toEqual(expect.arrayContaining([
			{ accent: "path", text: "RunLedger" },
			{ accent: "branch", text: "feature/highlight" },
		]));
	});

	it("keeps the canonical session metadata while dropping lower-priority capability", () => {
		const fitted = fitStatusLineSegments([
			{ accent: "state", text: "Working 12s" },
			{ accent: "path", text: "~/work/RunLedger" },
			{ accent: "metadata", text: "session-0123456789abcdef" },
			{ accent: "model", text: "deepseek/deepseek-v4-pro" },
			{ accent: "mode", text: "ws:linux-verified" },
		], 60);
		expect(fitted.map((segment) => segment.accent)).toEqual(["state", "path", "metadata", "model"]);
		const session = fitted.find((segment) => segment.accent === "metadata")?.text ?? "";
		expect(session.startsWith("session-")).toBe(true);
		expect(visibleWidth(session)).toBeGreaterThanOrEqual(16);
	});
});
