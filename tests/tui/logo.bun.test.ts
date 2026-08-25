import { describe, expect, test } from "bun:test";
import {
	DEFAULT_LOGO_LETTERS,
	LOGO_GAP,
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

describe("RunLedger logo (opencode-style)", () => {
	test("defaults to runledger and normalizes the configured letters", () => {
		expect(DEFAULT_LOGO_LETTERS).toBe("runledger");
		expect(normalizeLogoLetters("RUNLEDGER")).toBe("runledger");
		expect(normalizeLogoLetters(" ")).toBe(DEFAULT_LOGO_LETTERS);
		expect(normalizeLogoLetters("run ledger")).toBe(DEFAULT_LOGO_LETTERS);
	});

	test("maps every configured letter to its corresponding glyph form", () => {
		const mapped = mapLogoLetters(DEFAULT_LOGO_LETTERS);
		expect(mapped.map((item) => item.letter).join("")).toBe(DEFAULT_LOGO_LETTERS);
		expect(mapped[0]?.rows).toBe(LOGO_LETTER_FORMS.r);
		expect(mapped[1]?.rows).toBe(LOGO_LETTER_FORMS.u);
		expect(mapped[2]?.rows).toBe(LOGO_LETTER_FORMS.n);
		expect(mapped[3]?.rows).toBe(LOGO_LETTER_FORMS.l);
		expect(mapped[4]?.rows).toBe(LOGO_LETTER_FORMS.e);
		expect(mapped[5]?.rows).toBe(LOGO_LETTER_FORMS.d);
		expect(mapped[6]?.rows).toBe(LOGO_LETTER_FORMS.g);
		expect(mapped[7]?.rows).toBe(LOGO_LETTER_FORMS.e);
		expect(mapped[8]?.rows).toBe(LOGO_LETTER_FORMS.r);
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

	test("renderLogo accepts configured letters and calculates their width", () => {
		const lines = renderLogo(theme, "rue");
		expect(lines.length).toBe(LOGO_LETTER_FORMS.r.length);
		expect(lines.every((line) => visibleWidth(line) === logoLineWidth("rue"))).toBe(true);
	});
});
