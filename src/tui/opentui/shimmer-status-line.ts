import type { StatusIndicatorView } from "../presentation.ts";
import { wrapFg, wrapFgTruecolor } from "../theme/ansi.ts";
import type { Theme } from "../theme/theme.ts";
import {
	SHIMMER_BRACKET_LEFT,
	SHIMMER_BRACKET_RIGHT,
	shimmerText,
	type ShimmerMode,
	type ShimmerPalette,
} from "./shimmer.ts";

export interface ShimmerStatusLineOptions {
	readonly mode: ShimmerMode;
	readonly nowMs: number;
	readonly theme: Theme;
	readonly truecolor: boolean;
}

const FG_RESET = "\x1b[39m";
interface StatusPalettes {
	readonly main: ShimmerPalette;
	readonly hint: ShimmerPalette;
}

const paletteCache = new WeakMap<Theme, Map<boolean, StatusPalettes>>();

function foregroundOpen(hex: string, truecolor: boolean): string {
	const wrapped = (truecolor ? wrapFgTruecolor(hex) : wrapFg(hex, false))("");
	return wrapped.endsWith(FG_RESET) ? wrapped.slice(0, -FG_RESET.length) : wrapped;
}

function statusPalettes(theme: Theme, truecolor: boolean): StatusPalettes {
	let byCapability = paletteCache.get(theme);
	if (byCapability === undefined) {
		byCapability = new Map<boolean, StatusPalettes>();
		paletteCache.set(theme, byCapability);
	}
	const cached = byCapability.get(truecolor);
	if (cached !== undefined) return cached;
	const muted = foregroundOpen(theme.muted, truecolor);
	const palettes: StatusPalettes = {
		main: {
			low: { ansi: muted },
			mid: { ansi: foregroundOpen(theme.secondary, truecolor) },
			high: { ansi: foregroundOpen(theme.accent, truecolor) },
			bold: true,
		},
		hint: {
			low: { ansi: muted },
			mid: { ansi: muted },
			high: { ansi: foregroundOpen(theme.hint, truecolor) },
		},
	};
	byCapability.set(truecolor, palettes);
	return palettes;
}

interface ColoredSpan {
	readonly start: number;
	readonly end: number;
	readonly text: string;
	readonly palette: ShimmerPalette;
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

	const palettes = statusPalettes(options.theme, options.truecolor);
	const spans: ColoredSpan[] = [{
		start: headerStart,
		end: headerStart + view.header.length,
		text: view.header,
		palette: palettes.main,
	}];
	if (view.interruptKey !== undefined) {
		const interruptPrefix = "• ";
		const interruptText = `${view.interruptKey} to interrupt`;
		const interruptStart = firstLine.indexOf(`${interruptPrefix}${interruptText}`, headerStart + view.header.length);
		if (interruptStart >= 0) {
			spans.push({
				start: interruptStart + interruptPrefix.length,
				end: interruptStart + interruptPrefix.length + interruptText.length,
				text: `${SHIMMER_BRACKET_LEFT}${view.interruptKey}${SHIMMER_BRACKET_RIGHT}`,
				palette: palettes.hint,
			});
		}
	}
	if (view.inlineMessage !== undefined) {
		const inlineStart = firstLine.indexOf(view.inlineMessage, headerStart + view.header.length);
		if (inlineStart >= 0) {
			spans.push({
				start: inlineStart,
				end: inlineStart + view.inlineMessage.length,
				text: view.inlineMessage,
				palette: palettes.main,
			});
		}
	}
	spans.sort((left, right) => left.start - right.start);

	let renderedFirstLine = "";
	let offset = 0;
	for (const span of spans) {
		renderedFirstLine += firstLine.slice(offset, span.start);
		renderedFirstLine += shimmerText(span.text, span.palette, options.mode, options.nowMs);
		offset = span.end;
	}
	renderedFirstLine += firstLine.slice(offset);
	return newlineOffset < 0 ? renderedFirstLine : `${renderedFirstLine}${plain.slice(newlineOffset)}`;
}
