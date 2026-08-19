import type { StatusIndicatorView } from "../presentation.ts";
import { wrapFg, wrapFgTruecolor } from "../theme/ansi.ts";
import type { Theme } from "../theme/theme.ts";
import { shimmerText, type ShimmerMode, type ShimmerPalette } from "./shimmer.ts";

export interface ShimmerStatusLineOptions {
	readonly mode: ShimmerMode;
	readonly nowMs: number;
	readonly theme: Theme;
	readonly truecolor: boolean;
}

const FG_RESET = "\x1b[39m";
const paletteCache = new WeakMap<Theme, Map<boolean, ShimmerPalette>>();

function foregroundOpen(hex: string, truecolor: boolean): string {
	const wrapped = (truecolor ? wrapFgTruecolor(hex) : wrapFg(hex, false))("");
	return wrapped.endsWith(FG_RESET) ? wrapped.slice(0, -FG_RESET.length) : wrapped;
}

function workingPalette(theme: Theme, truecolor: boolean): ShimmerPalette {
	let byCapability = paletteCache.get(theme);
	if (byCapability === undefined) {
		byCapability = new Map<boolean, ShimmerPalette>();
		paletteCache.set(theme, byCapability);
	}
	const cached = byCapability.get(truecolor);
	if (cached !== undefined) return cached;
	const palette: ShimmerPalette = {
		low: { ansi: foregroundOpen(theme.muted, truecolor) },
		mid: { ansi: foregroundOpen(theme.secondary, truecolor) },
		high: { ansi: foregroundOpen(theme.accent, truecolor) },
		bold: true,
	};
	byCapability.set(truecolor, palette);
	return palette;
}

interface ColoredSpan {
	readonly start: number;
	readonly end: number;
	readonly text: string;
}

export function shimmerStatusLine(
	plain: string,
	view: StatusIndicatorView,
	options: ShimmerStatusLineOptions,
): string {
	if (plain.length === 0 || view.header !== "Working") return plain;
	const newlineOffset = plain.indexOf("\n");
	const firstLine = newlineOffset < 0 ? plain : plain.slice(0, newlineOffset);
	const headerStart = firstLine.indexOf(view.header, view.indicator.length);
	if (headerStart < 0) return plain;

	const spans: ColoredSpan[] = [{
		start: headerStart,
		end: headerStart + view.header.length,
		text: view.header,
	}];
	if (view.inlineMessage !== undefined) {
		const inlineStart = firstLine.indexOf(view.inlineMessage, headerStart + view.header.length);
		if (inlineStart >= 0) {
			spans.push({
				start: inlineStart,
				end: inlineStart + view.inlineMessage.length,
				text: view.inlineMessage,
			});
		}
	}

	const palette = workingPalette(options.theme, options.truecolor);
	let renderedFirstLine = "";
	let offset = 0;
	for (const span of spans) {
		renderedFirstLine += firstLine.slice(offset, span.start);
		renderedFirstLine += shimmerText(span.text, palette, options.mode, options.nowMs);
		offset = span.end;
	}
	renderedFirstLine += firstLine.slice(offset);
	return newlineOffset < 0 ? renderedFirstLine : `${renderedFirstLine}${plain.slice(newlineOffset)}`;
}
