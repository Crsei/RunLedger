import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";

import {
	CLASSIC_BAND_HALF_WIDTH,
	CLASSIC_PADDING,
	KITT_HEAD_HALF,
	KITT_TRAIL_LEN,
	SHIMMER_BRACKET_LEFT,
	SHIMMER_BRACKET_RIGHT,
	SHIMMER_SPEED_CELLS_PER_S,
	TIER_HIGH,
	TIER_MID,
	activeBand,
	classicIntensity,
	kittIntensity,
	shimmerSegments,
	shimmerText,
	tierFor,
	type ShimmerPalette,
} from "../../../src/tui/opentui/shimmer.ts";
import { visibleWidth } from "../../../src/tui/primitives.ts";
import { wrapFgTruecolor } from "../../../src/tui/theme/ansi.ts";

const palette: ShimmerPalette = {
	low: { ansi: "\x1b[31m" },
	mid: { ansi: "\x1b[32m" },
	high: { ansi: "\x1b[34m" },
	bold: true,
};

const secondPalette: ShimmerPalette = {
	low: { ansi: "\x1b[33m" },
	mid: { ansi: "\x1b[35m" },
	high: { ansi: "\x1b[36m" },
};

describe("working shimmer engine", () => {
	it("freezes the oh-my-pi motion and bracket constants", () => {
		expect({
			SHIMMER_SPEED_CELLS_PER_S,
			CLASSIC_PADDING,
			CLASSIC_BAND_HALF_WIDTH,
			KITT_HEAD_HALF,
			KITT_TRAIL_LEN,
			TIER_HIGH,
			TIER_MID,
			SHIMMER_BRACKET_LEFT,
			SHIMMER_BRACKET_RIGHT,
		}).toEqual({
			SHIMMER_SPEED_CELLS_PER_S: 30,
			CLASSIC_PADDING: 10,
			CLASSIC_BAND_HALF_WIDTH: 6,
			KITT_HEAD_HALF: 0.6,
			KITT_TRAIL_LEN: 7,
			TIER_HIGH: 0.65,
			TIER_MID: 0.22,
			SHIMMER_BRACKET_LEFT: "⸢",
			SHIMMER_BRACKET_RIGHT: "⸣",
		});
	});

	it("matches the classic cosine vectors from the fixed reference", () => {
		const centeredAtFirstCell = 1000 / 3;
		expect(classicIntensity(centeredAtFirstCell, 0, 10)).toBeCloseTo(1, 10);
		expect(classicIntensity(centeredAtFirstCell, 3, 10)).toBeCloseTo(0.5, 10);
		expect(classicIntensity(centeredAtFirstCell, 6, 10)).toBe(0);
		expect(classicIntensity(0, 0, 10)).toBe(0);
	});

	it("matches KITT direction-aware head and quadratic trail vectors", () => {
		const trailAtOneCell = (1 - (1 - KITT_HEAD_HALF) / KITT_TRAIL_LEN) ** 2;
		expect(kittIntensity(100, 3, 10)).toBe(1);
		expect(kittIntensity(100, 2, 10)).toBeCloseTo(trailAtOneCell, 10);
		expect(kittIntensity(100, 4, 10)).toBe(0);
		expect(kittIntensity(400, 6, 10)).toBe(1);
		expect(kittIntensity(400, 7, 10)).toBeCloseTo(trailAtOneCell, 10);
		expect(kittIntensity(400, 5, 10)).toBe(0);
		expect(kittIntensity(0, 0, 1)).toBe(1);
	});

	it("uses inclusive tier thresholds", () => {
		expect(tierFor(TIER_HIGH)).toBe("high");
		expect(tierFor(TIER_HIGH - Number.EPSILON)).toBe("mid");
		expect(tierFor(TIER_MID)).toBe("mid");
		expect(tierFor(TIER_MID - Number.EPSILON)).toBe("low");
	});

	it("keeps the active-band fast path equivalent to the intensity profiles", () => {
		for (const mode of ["classic", "kitt"] as const) {
			const nowMs = 411;
			const total = 18;
			const band = activeBand(mode, nowMs, total);
			const intensity = mode === "classic" ? classicIntensity : kittIntensity;
			for (let index = 0; index < total; index++) {
				if (index < band.lo || index > band.hi) expect(intensity(nowMs, index, total)).toBe(0);
			}
		}
	});

	it("preserves text and display width while keeping surrogate pairs atomic", () => {
		const plain = "😀 agent working";
		const rendered = shimmerText(plain, palette, "classic", 1000 / 3);
		expect(stripAnsi(rendered)).toBe(plain);
		expect(visibleWidth(rendered)).toBe(visibleWidth(plain));
		expect(rendered).toContain("😀");
	});

	it("coalesces adjacent characters that share a tier", () => {
		const plain = "abcdefghij";
		expect(shimmerText(plain, palette, "classic", 0)).toBe(`\x1b[31m${plain}\x1b[39m`);

		const moving = shimmerText("abcdefghijklmnopqrst", palette, "classic", 500);
		const sgrCount = moving.match(/\x1b\[/gu)?.length ?? 0;
		expect(sgrCount).toBeLessThan(20);
	});

	it("renders disabled mode as one mid-colored run per segment", () => {
		expect(shimmerSegments([
			{ text: "ab", palette },
			{ text: "cd", palette: secondPalette },
		], "disabled", 123)).toBe("\x1b[32mab\x1b[39m\x1b[35mcd\x1b[39m");
	});

	it("emits truecolor foreground SGR without changing content", () => {
		expect(wrapFgTruecolor("#7dcfff")("working")).toBe("\x1b[38;2;125;207;255mworking\x1b[39m");
	});
});
