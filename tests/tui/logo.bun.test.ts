import { describe, expect, test } from "bun:test";
import { LOGO_GAP, logo, logoLineWidth, renderLogo } from "../../src/tui/components/logo.ts";
import { loadTheme } from "../../src/tui/theme/theme.ts";
import { visibleWidth } from "../../src/tui/primitives.ts";

const theme = loadTheme("dark");

describe("RunLedger logo (opencode-style)", () => {
	test("left and right halves have equal non-zero row counts", () => {
		expect(logo.left.length).toBe(logo.right.length);
		expect(logo.left.length).toBeGreaterThan(0);
	});

	test("each row is non-empty and rows are equal width within each half", () => {
		const leftWidth = visibleWidth(logo.left[0] ?? "");
		for (const line of logo.left) {
			expect(visibleWidth(line)).toBe(leftWidth);
			expect(line.length).toBeGreaterThan(0);
		}
		const rightWidth = visibleWidth(logo.right[0] ?? "");
		for (const line of logo.right) {
			expect(visibleWidth(line)).toBe(rightWidth);
			expect(line.length).toBeGreaterThan(0);
		}
	});

	test("logoLineWidth is left + gap + right", () => {
		expect(logoLineWidth()).toBe(
			visibleWidth(logo.left[0] ?? "") + LOGO_GAP + visibleWidth(logo.right[0] ?? ""),
		);
	});

	test("renderLogo paints per-char colors and preserves row widths", () => {
		const lines = renderLogo(theme);
		expect(lines.length).toBe(logo.left.length);
		for (const line of lines) {
			expect(visibleWidth(line)).toBe(logoLineWidth());
			expect(line).toContain("\x1b[");
		}
	});
});
