import type { ComposerChromeContext, ComposerInputRow, ComposerStyle } from "../types.ts";
import { bordered, fullStatusText, inputRuns, run, safeWidth } from "./shared.ts";

export const boxComposerStyle: ComposerStyle = Object.freeze({
	id: "box",
	label: "Rounded Box (Default)",
	description: "Status line embedded in top border, compact 2-line prompt",
	sideBorders: true,
	inputLeadingWidth: 3,
	verticalChrome: 2,
	statusAttachment: "top-border",
	bottomBar: "none",
	bottomBarGap: 0,
	defaultPromptGutter: 0,
	defaultPaddingX: () => 1,
	sideChromeWidth: () => 1,
	renderTop: (context: ComposerChromeContext) => {
		const width = safeWidth(context.availableWidth);
		const status = fullStatusText(context);
		const inner = status.length > 0 ? [run(context, "status", ` ${status} `)] : [];
		return bordered(
			"top",
			width,
			run(context, "chrome", context.glyphs.topLeft),
			run(context, "chrome", context.glyphs.topRight),
			[run(context, "chrome", context.glyphs.horizontal), ...inner],
			context,
		);
	},
	renderRow: (context: ComposerChromeContext, input: ComposerInputRow) => {
		const right = input.scrollbar === "thumb"
			? run(context, "scrollbar", context.glyphs.scrollbarThumb)
			: input.scrollbar === "track"
				? run(context, "scrollbar", context.glyphs.scrollbarTrack)
				: run(context, "chrome", context.glyphs.vertical);
		if (input.isLast) {
			const bottomRight = input.scrollbar === "thumb"
				? run(context, "scrollbar", context.glyphs.scrollbarThumb)
				: input.scrollbar === "track"
					? run(context, "scrollbar", context.glyphs.scrollbarTrack)
					: run(context, "chrome", context.glyphs.bottomRight);
			return bordered(
				"input",
				context.availableWidth,
				run(context, "chrome", context.glyphs.bottomLeft),
				bottomRight,
				[run(context, "chrome", context.glyphs.horizontal), ...inputRuns(context, "› ")],
				context,
			);
		}
		// native 文本每个 visual row 都从同一列开始；非末行没有底部横线，补齐这一列。
		return bordered(
			"input",
			context.availableWidth,
			run(context, "chrome", context.glyphs.vertical),
			right,
			[run(context, "chrome", " "), ...inputRuns(context, "› ")],
			context,
		);
	},
	renderBottom: () => undefined,
	renderBottomBar: () => undefined,
});
