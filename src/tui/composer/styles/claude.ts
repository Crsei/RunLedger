import type { ComposerChromeContext, ComposerInputRow, ComposerStyle } from "../types.ts";
import { fill, inputRuns, row, run, safeWidth, statusText, usageText } from "./shared.ts";

export const claudeComposerStyle: ComposerStyle = Object.freeze({
	id: "claude",
	label: "Claude Code",
	description: "Full-width horizontal rules above and below, status line at bottom",
	sideBorders: false,
	verticalChrome: 2,
	statusAttachment: "top-rule-chip",
	bottomBar: "left",
	bottomBarGap: 0,
	defaultPromptGutter: 2,
	defaultPaddingX: () => 0,
	sideChromeWidth: () => 0,
	renderTop: (context: ComposerChromeContext) => {
		const width = safeWidth(context.availableWidth);
		const status = usageText(context);
		const chip = status.length > 0 ? ` ${status} ` : "";
		return row("top", [
			run(context, "chrome", fill(Math.max(0, width - chip.length - 1), context.glyphs.horizontal)),
			...(chip.length === 0 ? [] : [run(context, "status", chip)]),
			run(context, "chrome", context.glyphs.horizontal),
		], width);
	},
	renderRow: (context: ComposerChromeContext, _input: ComposerInputRow) => row("input", inputRuns(context, "❯ "), context.availableWidth, "input"),
	renderBottom: (context: ComposerChromeContext) => row("bottom", [run(context, "chrome", fill(context.availableWidth, context.glyphs.horizontal))], context.availableWidth),
	renderBottomBar: (context: ComposerChromeContext) => {
		const status = statusText(context);
		return status.length === 0 ? undefined : row("bottom-bar", [run(context, "status", ` ${status} `)], context.availableWidth, "status");
	},
});
