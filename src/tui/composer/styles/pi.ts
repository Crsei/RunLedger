import type { ComposerChromeContext, ComposerInputRow, ComposerStyle } from "../types.ts";
import { fill, fullStatusText, inputRuns, row, run } from "./shared.ts";

export const piComposerStyle: ComposerStyle = Object.freeze({
	id: "pi",
	label: "Pi",
	description: "Framed horizontal rules with status line at bottom",
	sideBorders: false,
	verticalChrome: 2,
	statusAttachment: "none",
	bottomBar: "full",
	bottomBarGap: 0,
	defaultPromptGutter: 0,
	defaultPaddingX: () => 1,
	sideChromeWidth: () => 0,
	renderTop: (context: ComposerChromeContext) => row("top", [run(context, "chrome", fill(context.availableWidth, context.glyphs.horizontal))], context.availableWidth),
	renderRow: (context: ComposerChromeContext, _input: ComposerInputRow) => row("input", inputRuns(context, ""), context.availableWidth, "input"),
	renderBottom: (context: ComposerChromeContext) => row("bottom", [run(context, "chrome", fill(context.availableWidth, context.glyphs.horizontal))], context.availableWidth),
	renderBottomBar: (context: ComposerChromeContext) => {
		const status = fullStatusText(context);
		return status.length === 0 ? undefined : row("bottom-bar", [run(context, "status", ` ${status} `)], context.availableWidth, "status");
	},
});
