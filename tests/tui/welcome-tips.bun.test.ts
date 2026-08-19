import { describe, expect, test } from "bun:test";
import { loadTips, pickTip, renderWelcomeTip, TIPS } from "../../src/tui/components/welcome-tips.ts";
import { loadTheme } from "../../src/tui/theme/theme.ts";
import { visibleWidth } from "../../src/tui/primitives.ts";

const theme = loadTheme("dark");

describe("welcome tips", () => {
	test("loadTips drops blank lines and the maintenance meta line", () => {
		const tips = loadTips("alpha\n\n  beta  \ntips.txt 这是写给编辑者的维护说明\n");
		expect(tips).toEqual(["alpha", "beta"]);
	});

	test("TIPS is non-empty, single-line, and free of meta lines", () => {
		expect(TIPS.length).toBeGreaterThan(10);
		for (const tip of TIPS) {
			expect(tip.includes("\n")).toBe(false);
			expect(tip.startsWith("tips.txt")).toBe(false);
		}
	});

	test("pickTip stays in bounds and is deterministic per sample", () => {
		const tips = ["a", "b", "c"];
		expect(pickTip(tips, 0)).toBe("a");
		expect(pickTip(tips, 0.99)).toBe("c");
		expect(pickTip([], 0.5)).toBe("");
	});

	test("renderWelcomeTip wraps within boxWidth and prefixes a Tip label", () => {
		const lines = renderWelcomeTip("按 /resume 打开历史会话选择器，按 Ctrl+D 安全退出。", theme, 60);
		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
		expect(lines[0] ?? "").toContain("Tip:");
	});

	test("renderWelcomeTip returns [] when the box is too narrow or tip is empty", () => {
		expect(renderWelcomeTip("任何内容", theme, 10)).toEqual([]);
		expect(renderWelcomeTip("", theme, 100)).toEqual([]);
	});
});
