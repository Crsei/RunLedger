import type { ComposerChromeContext, ComposerInputRow, ComposerStyle } from "../types.ts";
import { fill, inputRuns, row, run, safeWidth, statusText, usageText } from "./shared.ts";

export const ruleComposerStyle: ComposerStyle = Object.freeze({
	id: "rule",
	label: "Top Rule Dock",
	description: "Single top rule with status docked onto it and below",
	sideBorders: false,
	verticalChrome: 1,
	statusAttachment: "top-rule-chip",
	bottomBar: "left",
	bottomBarGap: 1,
	defaultPromptGutter: 2,
	defaultPaddingX: () => 0,
	sideChromeWidth: () => 0,
	renderTop: (context: ComposerChromeContext) => {
		const width = safeWidth(context.availableWidth);
		const label = usageText(context);
		const content = label.length > 0 ? `─ ${label} ` : "";
		return row("top", [
			...(content.length === 0 ? [] : [run(context, "status", content)]),
			run(context, "chrome", fill(Math.max(0, width - content.length), context.glyphs.horizontal)),
		], width);
	},
	renderRow: (context: ComposerChromeContext, _input: ComposerInputRow) => row("input", inputRuns(context, "❯ "), context.availableWidth, "input"),
	renderBottom: () => undefined,
	renderBottomBar: (context: ComposerChromeContext) => {
		const status = statusText(context);
		return status.length === 0 ? undefined : row("bottom-bar", [run(context, "status", status)], context.availableWidth, "status");
	},
});
