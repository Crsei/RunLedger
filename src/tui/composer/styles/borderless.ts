import type { ComposerChromeContext, ComposerInputRow, ComposerStyle } from "../types.ts";
import { fullStatusText, inputRuns, row, run } from "./shared.ts";

export const borderlessComposerStyle: ComposerStyle = Object.freeze({
	id: "borderless",
	label: "Borderless",
	description: "Clean prompt glyph with status line at bottom, no box borders",
	sideBorders: false,
	verticalChrome: 0,
	statusAttachment: "none",
	bottomBar: "full",
	bottomBarGap: 0,
	defaultPromptGutter: 2,
	defaultPaddingX: () => 0,
	sideChromeWidth: () => 0,
	renderTop: () => undefined,
	renderRow: (context: ComposerChromeContext, _input: ComposerInputRow) => row("input", inputRuns(context, "❯ "), context.availableWidth, "input"),
	renderBottom: () => undefined,
	renderBottomBar: (context: ComposerChromeContext) => {
		const status = fullStatusText(context);
		return status.length === 0 ? undefined : row("bottom-bar", [run(context, "status", ` ${status} `)], context.availableWidth, "status");
	},
});
