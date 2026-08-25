import type { ComposerChromeContext, ComposerInputRow, ComposerStyle } from "../types.ts";
import { bordered, fullStatusText, inputRuns, row, run } from "./shared.ts";

export const fieldComposerStyle: ComposerStyle = Object.freeze({
	id: "field",
	label: "Compact Field",
	description: "Filled one-row field with accent end caps",
	sideBorders: true,
	verticalChrome: 0,
	statusAttachment: "none",
	bottomBar: "full",
	bottomBarGap: 1,
	defaultPromptGutter: 0,
	defaultPaddingX: () => 1,
	sideChromeWidth: () => 1,
	renderTop: () => undefined,
	renderRow: (context: ComposerChromeContext, input: ComposerInputRow) => bordered(
		"input",
		context.availableWidth,
		run(context, "chrome", "▐", { foregroundColor: context.accentColor }),
		input.scrollbar === "thumb"
			? run(context, "scrollbar", "█")
			: input.scrollbar === "track" ? run(context, "scrollbar", "░") : run(context, "chrome", "▌", { foregroundColor: context.accentColor }),
		inputRuns(context, ""),
		context,
	),
	renderBottom: () => undefined,
	renderBottomBar: (context: ComposerChromeContext) => {
		const status = fullStatusText(context);
		return status.length === 0 ? undefined : row("bottom-bar", [run(context, "status", ` ${status} `)], context.availableWidth, "status");
	},
});
