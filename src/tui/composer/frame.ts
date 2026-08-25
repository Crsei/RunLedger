import { displayWidth, graphemes, truncateDisplayWidth } from "../mermaid/display-width.ts";
import {
	DEFAULT_COMPOSER_GLYPHS,
	type ComposerChromeContext,
	type ComposerChromeRow,
	type ComposerGlyphs,
	type ComposerInputRow,
	type ComposerMeasureContext,
	type ComposerStatusContent,
	type ComposerStyle,
} from "./types.ts";

export interface ComposerFrameInput {
	readonly terminalWidth: number;
	readonly input: {
		readonly text: string;
		readonly placeholder: string;
		readonly cursorOffset: number;
		readonly maxLines?: number;
	};
	readonly status: ComposerStatusContent;
	readonly scrollbar: {
		readonly visible: boolean;
		readonly position?: number;
	};
	readonly theme?: {
		readonly borderColor: string;
		readonly accentColor: string;
		readonly surfaceColor: string;
	};
	readonly glyphs?: Partial<ComposerGlyphs>;
}

export interface ComposerRect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

export interface ComposerScrollbarRect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
	readonly thumbY: number;
	readonly thumbHeight: number;
}

export interface ComposerChromeFrame {
	readonly styleId: string;
	readonly terminalWidth: number;
	readonly rows: readonly ComposerChromeRow[];
	readonly topRows: readonly ComposerChromeRow[];
	readonly inputRows: readonly ComposerChromeRow[];
	readonly bottomRows: readonly ComposerChromeRow[];
	readonly bottomBarRows: readonly ComposerChromeRow[];
	readonly inputRect: ComposerRect;
	readonly cursorRect: ComposerRect;
	readonly scrollbarRect?: ComposerScrollbarRect;
	readonly promptGutter: number;
	readonly leftChromeWidth: number;
	readonly rightChromeWidth: number;
	readonly cursorOverflow: boolean;
	readonly statusAttachment: ComposerStyle["statusAttachment"];
	readonly bottomBar: ComposerStyle["bottomBar"];
	readonly bottomBarGap: number;
	readonly theme: {
		readonly borderColor: string;
		readonly accentColor: string;
		readonly surfaceColor: string;
	};
	readonly totalHeight: number;
}

export interface ComposerStatusConsumption {
	readonly identity: boolean;
	readonly usage: boolean;
}

interface WrappedInputRow {
	readonly text: string;
	readonly logicalLine: number;
	readonly visualRow: number;
}

const CONTROL_CHARS = /[\u0000-\u0009\u000b-\u001f\u007f]/gu;

export function projectComposerFrame(style: ComposerStyle, input: ComposerFrameInput): ComposerChromeFrame {
	const terminalWidth = safeDimension(input.terminalWidth);
	const text = sanitizeText(input.input.text);
	const placeholder = sanitizeText(input.input.placeholder);
	const measureBase: ComposerMeasureContext = {
		terminalWidth,
		inputText: text,
		placeholder,
		cursorOffset: clampOffset(input.input.cursorOffset, text.length),
		scrollbarVisible: input.scrollbar.visible,
	};
	const paddingX = safeNonNegative(style.defaultPaddingX(measureBase));
	const requestedSide = safeNonNegative(style.sideChromeWidth(measureBase));
	const sideChromeWidth = style.sideBorders ? Math.min(terminalWidth, requestedSide) : 0;
	const inputLeadingWidth = safeNonNegative(style.inputLeadingWidth ?? 0);
	const promptGutter = style.sideBorders
		? 0
		: Math.min(
			style.defaultPromptGutter,
			Math.max(0, terminalWidth - sideChromeWidth * 2 - paddingX * 2),
		);
	// 有 side chrome 时 scrollbar 会替换右边界；无边框 style 必须显式保留
	// 一列，否则独立 scrollbar 会覆盖输入内容的最后一个 cell。
	const scrollbarColumnWidth = input.scrollbar.visible && !style.sideBorders ? 1 : 0;
	const inputWidth = Math.max(
		0,
		terminalWidth - sideChromeWidth * 2 - paddingX * 2 - promptGutter - inputLeadingWidth - scrollbarColumnWidth,
	);
	const wrapWidth = Math.max(1, inputWidth);
	const source = text.length > 0 ? text : placeholder;
	const wrapped = wrapInput(source, wrapWidth, input.input.maxLines);
	const measure: ComposerMeasureContext = measureBase;
	const status: ComposerStatusContent = {
		identity: sanitizeText(input.status.identity),
		usage: sanitizeText(input.status.usage),
	};
	const glyphs: ComposerGlyphs = { ...DEFAULT_COMPOSER_GLYPHS, ...input.glyphs };
	const theme = Object.freeze({
		borderColor: input.theme?.borderColor ?? "",
		accentColor: input.theme?.accentColor ?? "",
		surfaceColor: input.theme?.surfaceColor ?? "",
	});
	const baseContext = (inputRow?: ComposerInputRow, rowIndex?: number, rowCount?: number): ComposerChromeContext => ({
		measure,
		availableWidth: terminalWidth,
		status,
		glyphs,
		paddingX,
		promptGutter,
		sideChromeWidth,
		...theme,
		inputRow,
		rowIndex,
		rowCount,
	});

	const top = style.renderTop(baseContext());
	const topRows = top === undefined ? [] : [fitRow(top, terminalWidth)];
	const scrollbar = createScrollbar(input.scrollbar.visible, input.scrollbar.position ?? 0.5, wrapped.length, terminalWidth);
	const inputRows: ComposerChromeRow[] = [];
	for (const [index, item] of wrapped.entries()) {
		const rowInput: ComposerInputRow = {
			text: item.text,
			logicalLine: item.logicalLine,
			visualRow: item.visualRow,
			isFirst: index === 0,
			isLast: index === wrapped.length - 1,
			cursorOffset: cursorForRow(text, input.input.cursorOffset, item, wrapWidth),
			scrollbar: scrollbar === undefined
				? "none"
				: index >= scrollbar.thumbY && index < scrollbar.thumbY + scrollbar.thumbHeight ? "thumb" : "track",
		};
		inputRows.push(fitRow(style.renderRow(baseContext(rowInput, index, wrapped.length), rowInput), terminalWidth));
	}
	const bottom = style.renderBottom(baseContext());
	const bottomRows = bottom === undefined ? [] : [fitRow(bottom, terminalWidth)];
	const bottomBar = style.renderBottomBar(baseContext());
	const bottomBarRows = bottomBar === undefined ? [] : [fitRow(bottomBar, terminalWidth)];
	const gapRows = bottomBarRows.length === 0
		? []
		: Array.from({ length: safeNonNegative(style.bottomBarGap) }, () => blankRow("gap", terminalWidth, theme.surfaceColor));
	const rows = Object.freeze([...topRows, ...inputRows, ...bottomRows, ...gapRows, ...bottomBarRows]);
	const inputY = topRows.length;
	const inputRect: ComposerRect = Object.freeze({
		x: Math.min(terminalWidth, sideChromeWidth + paddingX + promptGutter + inputLeadingWidth),
		y: inputY,
		width: inputWidth,
		height: inputRows.length,
	});
	const cursor = calculateCursor(text, input.input.cursorOffset, wrapWidth, inputRect, inputRows.length);
	const cursorRect: ComposerRect = Object.freeze({ x: cursor.x, y: cursor.y, width: 1, height: 1 });
	const scrollbarRect = scrollbar === undefined
		? undefined
		: Object.freeze({
			x: Math.max(0, terminalWidth - 1),
			y: inputY,
			width: 1,
			height: Math.max(1, inputRows.length),
			thumbY: inputY + scrollbar.thumbY,
			thumbHeight: scrollbar.thumbHeight,
		});
	return Object.freeze({
		styleId: style.id,
		terminalWidth,
		rows,
		topRows: Object.freeze(topRows),
		inputRows: Object.freeze(inputRows),
		bottomRows: Object.freeze(bottomRows),
		bottomBarRows: Object.freeze(bottomBarRows),
		inputRect,
		cursorRect,
		scrollbarRect,
		promptGutter,
		leftChromeWidth: sideChromeWidth,
		rightChromeWidth: sideChromeWidth,
		cursorOverflow: cursor.overflow,
		statusAttachment: style.statusAttachment,
		bottomBar: style.bottomBar,
		bottomBarGap: safeNonNegative(style.bottomBarGap),
		theme,
		totalHeight: rows.length,
	});
}

export function composerFrameSignature(frame: ComposerChromeFrame): string {
	const scrollbar = frame.scrollbarRect === undefined
		? "none"
		: `${frame.scrollbarRect.x},${frame.scrollbarRect.y},${frame.scrollbarRect.width},${frame.scrollbarRect.height},${frame.scrollbarRect.thumbY},${frame.scrollbarRect.thumbHeight}`;
	return [
		`shape=${frame.styleId}`,
		`width=${frame.terminalWidth}`,
		`rows=${frame.totalHeight}:${JSON.stringify(frame.rows.map((row) => [row.kind, row.width, row.text]))}`,
		`chrome=${frame.topRows.length},${frame.bottomRows.length}`,
		`input=${rectSignature(frame.inputRect)}`,
		`gutter=${frame.promptGutter}`,
		`side=${frame.leftChromeWidth},${frame.rightChromeWidth}`,
		`cursor=${rectSignature(frame.cursorRect)}`,
		`cursorOverflow=${frame.cursorOverflow}`,
		`scrollbar=${scrollbar}`,
		`status=${frame.statusAttachment}`,
		`bar=${frame.bottomBar}`,
		`gap=${frame.bottomBarGap}`,
		`total=${frame.totalHeight}`,
	].join("|");
}

export function composerStatusConsumption(frame: ComposerChromeFrame | undefined): ComposerStatusConsumption {
	if (frame === undefined) return { identity: false, usage: false };
	return {
		identity: frame.statusAttachment === "top-border" || frame.bottomBar === "left" || frame.bottomBar === "full",
		usage: frame.statusAttachment === "top-border" || frame.statusAttachment === "top-rule-chip" || frame.bottomBar === "full",
	};
}

function sanitizeText(value: string): string {
	return value.replace(CONTROL_CHARS, " ");
}

function safeDimension(value: number): number {
	return Math.max(1, Math.floor(Number.isFinite(value) ? value : 1));
}

function safeNonNegative(value: number): number {
	return Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
}

function clampOffset(value: number, length: number): number {
	return Math.max(0, Math.min(length, Math.floor(Number.isFinite(value) ? value : length)));
}

function wrapInput(value: string, width: number, maxLines?: number): WrappedInputRow[] {
	const lineLimit = maxLines === undefined ? 8 : Math.max(1, Math.floor(maxLines));
	const output: WrappedInputRow[] = [];
	let visualRow = 0;
	for (const [logicalLine, sourceLine] of value.split("\n").entries()) {
		const pieces = wrapLine(sourceLine, width);
		for (const piece of pieces) {
			if (output.length >= lineLimit) return output.length === 0 ? [{ text: "", logicalLine: 0, visualRow: 0 }] : output;
			output.push({ text: piece, logicalLine, visualRow });
			visualRow += 1;
		}
	}
	return output.length === 0 ? [{ text: "", logicalLine: 0, visualRow: 0 }] : output;
}

function wrapLine(value: string, width: number): string[] {
	const output: string[] = [];
	let current = "";
	let currentWidth = 0;
	for (const grapheme of graphemes(value)) {
		const widthOfGrapheme = displayWidth(grapheme);
		if (widthOfGrapheme > width) {
			if (current.length > 0) output.push(current);
			current = "";
			currentWidth = 0;
			continue;
		}
		if (widthOfGrapheme > 0 && currentWidth > 0 && currentWidth + widthOfGrapheme > width) {
			output.push(current);
			current = "";
			currentWidth = 0;
		}
		current += grapheme;
		currentWidth += widthOfGrapheme;
	}
	if (current.length > 0 || output.length === 0) output.push(current);
	return output;
}

function cursorForRow(text: string, offset: number, row: WrappedInputRow, width: number): number | undefined {
	const boundedOffset = clampOffset(offset, text.length);
	const before = text.slice(0, boundedOffset);
	const logicalLine = before.split("\n").length - 1;
	if (row.logicalLine !== logicalLine) return undefined;
	const current = before.split("\n").at(-1) ?? "";
	const visualRow = Math.floor(displayWidth(current) / width);
	return visualRow === row.visualRow - rowsBeforeLogicalLine(text, logicalLine, width)
		? current.length
		: undefined;
}

function rowsBeforeLogicalLine(text: string, logicalLine: number, width: number): number {
	return text.split("\n").slice(0, logicalLine).reduce((total, line) => total + wrapLine(line, width).length, 0);
}

function calculateCursor(
	text: string,
	offset: number,
	width: number,
	inputRect: ComposerRect,
	rowCount: number,
): { x: number; y: number; overflow: boolean } {
	const boundedOffset = clampOffset(offset, text.length);
	const before = text.slice(0, boundedOffset);
	const lines = before.split("\n");
	const logicalLine = lines.length - 1;
	const current = lines.at(-1) ?? "";
	const row = rowsBeforeLogicalLine(text, logicalLine, width) + Math.floor(displayWidth(current) / width);
	const x = inputRect.x + Math.min(inputRect.width, displayWidth(current) % width);
	const y = inputRect.y + Math.min(Math.max(0, rowCount - 1), row);
	return {
		x: Math.max(0, Math.min(inputRect.x + inputRect.width, x)),
		y: Math.max(0, y),
		overflow: row >= rowCount || displayWidth(current) > inputRect.width,
	};
}

function createScrollbar(
	visible: boolean,
	position: number,
	rowCount: number,
	_terminalWidth: number,
): { thumbY: number; thumbHeight: number } | undefined {
	if (!visible) return undefined;
	const height = Math.max(1, rowCount);
	const thumbHeight = Math.max(1, Math.min(height, Math.ceil(height / 3)));
	const travel = Math.max(0, height - thumbHeight);
	const boundedPosition = Math.max(0, Math.min(1, Number.isFinite(position) ? position : 0.5));
	return { thumbY: Math.round(travel * boundedPosition), thumbHeight };
}

function fitRow(value: ComposerChromeRow, width: number): ComposerChromeRow {
	const runs = fitRuns(value.runs, width);
	return Object.freeze({ ...value, text: runs.map((run) => run.text).join(""), width, runs });
}

function fitRuns(runs: readonly ComposerChromeRow["runs"][number][], width: number): readonly ComposerChromeRow["runs"][number][] {
	const fitted: ComposerChromeRow["runs"][number][] = [];
	let remaining = Math.max(0, width);
	for (const run of runs) {
		if (remaining <= 0) break;
		const text = truncateDisplayWidth(run.text, remaining);
		if (text.length > 0) fitted.push(Object.freeze({ ...run, text }));
		remaining -= displayWidth(text);
	}
	if (remaining > 0) {
		const previous = fitted.at(-1);
		fitted.push(Object.freeze({
			text: " ".repeat(remaining),
			role: previous?.role ?? "chrome",
			...(previous?.backgroundColor === undefined ? {} : { backgroundColor: previous.backgroundColor }),
		}));
	}
	return Object.freeze(fitted);
}

function blankRow(kind: ComposerChromeRow["kind"], width: number, surfaceColor: string): ComposerChromeRow {
	const run = Object.freeze({
		text: " ".repeat(width),
		role: "chrome" as const,
		...(surfaceColor.length === 0 ? {} : { backgroundColor: surfaceColor }),
	});
	return Object.freeze({ kind, text: run.text, width, runs: Object.freeze([run]) });
}

function rectSignature(rect: ComposerRect): string {
	return `${rect.x},${rect.y},${rect.width},${rect.height}`;
}
