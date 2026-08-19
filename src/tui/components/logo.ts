import { visibleWidth } from "../primitives.ts";
import type { Theme } from "../theme/theme.ts";
import { wrapBold, wrapDim, wrapFg } from "../theme/ansi.ts";

/** opencode 风格双段 LOGO：RUN 弱化，LEDGER 强调。 */
export const logo = {
	left: [
		"█▀▀█ █▀▀█ █▀▀█",
		"█▀▀▀ █__█ █^^█",
		"▀▀▀▀ ▀▀▀▀ ▀▀▀▀",
	],
	right: [
		"█▀▀█ █▀▀▀ █▀▀▄ █▀▀▄ █▀▀▀ █▀▀█",
		"█▀▀▀ █▀▀▀ █__█ █▀▀█ █▀▀▀ █▀▀▀",
		"▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀",
	],
} as const;

export const LOGO_GAP = 1;

export function logoLineWidth(): number {
	return visibleWidth(logo.left[0] ?? "") + LOGO_GAP + visibleWidth(logo.right[0] ?? "");
}

function paint(line: string, style: (text: string) => string): string {
	let output = "";
	for (const character of line) output += character === " " ? character : style(character);
	return output;
}

/** 逐字符着色，保留未着色数据的可见列宽。 */
export function renderLogo(theme: Theme): string[] {
	const dim = (text: string) => wrapDim(wrapFg(theme.muted)(text));
	const bright = (text: string) => wrapBold(wrapFg(theme.primary)(text));
	return logo.left.map((line, index) =>
		`${paint(line, dim)}${" ".repeat(LOGO_GAP)}${paint(logo.right[index] ?? "", bright)}`,
	);
}
