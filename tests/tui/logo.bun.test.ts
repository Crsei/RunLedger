import { describe, expect, test } from "bun:test";
import {
	DEFAULT_LOGO_LETTERS,
	LOGO_LETTER_FORMS,
	logo,
	logoLineWidth,
	mapLogoLetters,
	normalizeLogoLetters,
	renderLogo,
} from "../../src/tui/components/logo.ts";
import { loadTheme } from "../../src/tui/theme/theme.ts";
import { visibleWidth } from "../../src/tui/primitives.ts";

const theme = loadTheme("dark");

describe("RunLedger logo", () => {
	test("exposes RunLedger as the default logo text", () => {
		expect(DEFAULT_LOGO_LETTERS).toBe("runledger");
		expect(logo.letters).toBe(DEFAULT_LOGO_LETTERS);
	});

	test("renders only the default wordmark as visible RunLedger text", () => {
		const plain = renderLogo(theme).join("\n").replace(/\x1b\[[0-9;]*m/gu, "");
		expect(plain).toBe(DEFAULT_LOGO_LETTERS);
		expect(plain).not.toContain("█");
	});

	test("maps every default letter to its corresponding glyph form", () => {
		const mapped = mapLogoLetters();
		expect(mapped.map((item) => item.letter).join("")).toBe(DEFAULT_LOGO_LETTERS);
		expect(mapped.map((item) => item.rows)).toEqual([
			LOGO_LETTER_FORMS.r,
			LOGO_LETTER_FORMS.u,
			LOGO_LETTER_FORMS.n,
			LOGO_LETTER_FORMS.l,
			LOGO_LETTER_FORMS.e,
			LOGO_LETTER_FORMS.d,
			LOGO_LETTER_FORMS.g,
			LOGO_LETTER_FORMS.e,
			LOGO_LETTER_FORMS.r,
		]);
	});

	test("normalizes case and falls back for unsupported logo text", () => {
		expect(normalizeLogoLetters("RUNLEDGER")).toBe(DEFAULT_LOGO_LETTERS);
		expect(normalizeLogoLetters("run ledger")).toBe(DEFAULT_LOGO_LETTERS);
		expect(normalizeLogoLetters("abc")).toBe(DEFAULT_LOGO_LETTERS);
	});

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

	test("logoLineWidth matches the visible wordmark width", () => {
		expect(logoLineWidth()).toBe(visibleWidth(DEFAULT_LOGO_LETTERS));
	});

	test("renderLogo paints per-char colors and preserves row widths", () => {
		const lines = renderLogo(theme);
		expect(lines.length).toBe(1);
		for (const line of lines) {
			expect(visibleWidth(line)).toBe(visibleWidth(DEFAULT_LOGO_LETTERS));
			expect(line).toContain("\x1b[");
		}
	});

	test("renderLogo accepts configured logo text and recalculates its width", () => {
		const lines = renderLogo(theme, "rue");
		expect(logoLineWidth("rue")).toBe(3);
		expect(lines.every((line) => visibleWidth(line) === logoLineWidth("rue"))).toBe(true);
	});
});
