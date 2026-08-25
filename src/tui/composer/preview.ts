import { projectComposerFrame, type ComposerFrameInput, type ComposerChromeFrame } from "./frame.ts";
import type { ComposerStyle } from "./types.ts";

export interface ComposerShapePreview {
	readonly frame: ComposerChromeFrame;
	readonly input: ComposerFrameInput;
	readonly lines: readonly string[];
}

/** 预览只负责提供 sample state；布局与生产路径共用 projectComposerFrame。 */
export function renderComposerShapePreview(style: ComposerStyle, terminalWidth: number): ComposerShapePreview {
	const text = "你好 composer preview";
	const input: ComposerFrameInput = {
		terminalWidth,
		input: {
			text,
			placeholder: "Message RunLedger…",
			cursorOffset: text.length,
			maxLines: 4,
		},
		status: {
			identity: "Working · RunLedger",
			usage: "usage 1.2k · limit 10%",
		},
		scrollbar: { visible: false },
	};
	const frame = projectComposerFrame(style, input);
	return Object.freeze({
		frame,
		input,
		lines: Object.freeze(frame.rows.map((row) => row.text)),
	});
}
