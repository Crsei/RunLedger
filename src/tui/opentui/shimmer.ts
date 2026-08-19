export const SHIMMER_SPEED_CELLS_PER_S = 30;
export const CLASSIC_PADDING = 10;
export const CLASSIC_BAND_HALF_WIDTH = 6;
export const KITT_HEAD_HALF = 0.6;
export const KITT_TRAIL_LEN = 7;
export const TIER_HIGH = 0.65;
export const TIER_MID = 0.22;
export const SHIMMER_BRACKET_LEFT = "⸢";
export const SHIMMER_BRACKET_RIGHT = "⸣";

const FG_RESET = "\x1b[39m";
const BOLD_OPEN = "\x1b[1m";
const BOLD_CLOSE = "\x1b[22m";

export type ShimmerMode = "classic" | "kitt" | "disabled";
export type ShimmerTier = "low" | "mid" | "high";

export interface ShimmerPaletteTier {
	readonly ansi: string;
}

export interface ShimmerPalette {
	readonly low: ShimmerPaletteTier;
	readonly mid: ShimmerPaletteTier;
	readonly high: ShimmerPaletteTier;
	readonly bold?: boolean;
}

export interface ShimmerSegment {
	readonly text: string;
	readonly palette: ShimmerPalette;
}

interface TierSequence {
	readonly open: string;
	readonly close: string;
}

interface CompiledPalette {
	readonly low: TierSequence;
	readonly mid: TierSequence;
	readonly high: TierSequence;
}

const compiledPalette = Symbol("runledger.shimmer.compiled");

interface PaletteCache {
	[compiledPalette]?: CompiledPalette;
}

function compile(palette: ShimmerPalette): CompiledPalette {
	const cachedPalette = palette as ShimmerPalette & PaletteCache;
	const cached = cachedPalette[compiledPalette];
	if (cached !== undefined) return cached;
	const highOpen = palette.bold ? `${BOLD_OPEN}${palette.high.ansi}` : palette.high.ansi;
	const next: CompiledPalette = {
		low: { open: palette.low.ansi, close: FG_RESET },
		mid: { open: palette.mid.ansi, close: FG_RESET },
		high: { open: highOpen, close: palette.bold ? `${BOLD_CLOSE}${FG_RESET}` : FG_RESET },
	};
	cachedPalette[compiledPalette] = next;
	return next;
}

/** 平滑余弦波从左向右扫过，并在文本两侧保留固定 padding。 */
export function classicIntensity(nowMs: number, index: number, length: number): number {
	const period = length + CLASSIC_PADDING * 2;
	const position = ((nowMs / 1000) * SHIMMER_SPEED_CELLS_PER_S) % period;
	const distance = Math.abs(index + CLASSIC_PADDING - position);
	if (distance >= CLASSIC_BAND_HALF_WIDTH) return 0;
	return 0.5 * (1 + Math.cos((Math.PI * distance) / CLASSIC_BAND_HALF_WIDTH));
}

/** KITT 往返亮点；只有运动方向后方存在二次衰减尾迹。 */
export function kittIntensity(nowMs: number, index: number, length: number): number {
	const range = length - 1;
	if (range <= 0) return 1;
	const cycleCells = 2 * range;
	const sweep = ((nowMs / 1000) * SHIMMER_SPEED_CELLS_PER_S) % cycleCells;
	const goingRight = sweep < range;
	const head = goingRight ? sweep : cycleCells - sweep;
	const delta = index - head;
	const absoluteDelta = delta < 0 ? -delta : delta;
	if (absoluteDelta <= KITT_HEAD_HALF) return 1;
	const behind = goingRight ? -delta : delta;
	if (behind <= KITT_HEAD_HALF) return 0;
	const trailPosition = (behind - KITT_HEAD_HALF) / KITT_TRAIL_LEN;
	if (trailPosition >= 1) return 0;
	const remaining = 1 - trailPosition;
	return remaining * remaining;
}

export function tierFor(intensity: number): ShimmerTier {
	if (intensity >= TIER_HIGH) return "high";
	if (intensity >= TIER_MID) return "mid";
	return "low";
}

/** 带外 intensity 保证为 0；渲染热路径可直接判定 low。 */
export function activeBand(mode: Exclude<ShimmerMode, "disabled">, nowMs: number, total: number): { readonly lo: number; readonly hi: number } {
	if (mode === "classic") {
		const period = total + CLASSIC_PADDING * 2;
		const position = ((nowMs / 1000) * SHIMMER_SPEED_CELLS_PER_S) % period;
		return {
			lo: position - CLASSIC_PADDING - CLASSIC_BAND_HALF_WIDTH,
			hi: position - CLASSIC_PADDING + CLASSIC_BAND_HALF_WIDTH,
		};
	}
	const range = total - 1;
	if (range <= 0) return { lo: 0, hi: total };
	const cycleCells = 2 * range;
	const sweep = ((nowMs / 1000) * SHIMMER_SPEED_CELLS_PER_S) % cycleCells;
	const goingRight = sweep < range;
	const head = goingRight ? sweep : cycleCells - sweep;
	return goingRight
		? { lo: head - KITT_HEAD_HALF - KITT_TRAIL_LEN, hi: head + KITT_HEAD_HALF }
		: { lo: head - KITT_HEAD_HALF, hi: head + KITT_HEAD_HALF + KITT_TRAIL_LEN };
}

function countCodePoints(text: string): number {
	let count = 0;
	let offset = 0;
	while (offset < text.length) {
		const first = text.charCodeAt(offset);
		if (first >= 0xd800 && first <= 0xdbff && offset + 1 < text.length) {
			const second = text.charCodeAt(offset + 1);
			if (second >= 0xdc00 && second <= 0xdfff) offset++;
		}
		offset++;
		count++;
	}
	return count;
}

/** 多段文本共享一个相位，但每段可使用不同三档调色板。 */
export function shimmerSegments(segments: readonly ShimmerSegment[], mode: ShimmerMode, nowMs: number): string {
	let total = 0;
	for (const segment of segments) total += countCodePoints(segment.text);
	if (total === 0) return "";

	if (mode === "disabled") {
		let output = "";
		for (const segment of segments) {
			const sequence = compile(segment.palette).mid;
			output += `${sequence.open}${segment.text}${sequence.close}`;
		}
		return output;
	}

	const intensity = mode === "kitt" ? kittIntensity : classicIntensity;
	const band = activeBand(mode, nowMs, total);
	let output = "";
	let globalIndex = 0;

	for (const segment of segments) {
		const compiled = compile(segment.palette);
		let runTier: ShimmerTier | undefined;
		let runStart = 0;
		let runEnd = 0;
		let offset = 0;
		while (offset < segment.text.length) {
			const first = segment.text.charCodeAt(offset);
			let step = 1;
			if (first >= 0xd800 && first <= 0xdbff && offset + 1 < segment.text.length) {
				const second = segment.text.charCodeAt(offset + 1);
				if (second >= 0xdc00 && second <= 0xdfff) step = 2;
			}
			const nextTier = globalIndex < band.lo || globalIndex > band.hi
				? "low"
				: tierFor(intensity(nowMs, globalIndex, total));
			if (nextTier !== runTier) {
				if (runTier !== undefined && runEnd > runStart) {
					const sequence = compiled[runTier];
					output += `${sequence.open}${segment.text.slice(runStart, runEnd)}${sequence.close}`;
				}
				runTier = nextTier;
				runStart = offset;
			}
			runEnd = offset + step;
			globalIndex++;
			offset += step;
		}
		if (runTier !== undefined && runEnd > runStart) {
			const sequence = compiled[runTier];
			output += `${sequence.open}${segment.text.slice(runStart, runEnd)}${sequence.close}`;
		}
	}
	return output;
}

export function shimmerText(text: string, palette: ShimmerPalette, mode: ShimmerMode, nowMs: number): string {
	return shimmerSegments([{ text, palette }], mode, nowMs);
}
