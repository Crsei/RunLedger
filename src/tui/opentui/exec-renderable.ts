import { RGBA, StyledText, TextAttributes, TextRenderable, type RenderContext, type TextChunk, type TextOptions } from "@opentui/core";
import { displayWidth, graphemes, truncateDisplayWidth, wrapDisplayWidth } from "../mermaid/display-width.ts";
import { formatExecTruncationHint, EXEC_CONTINUATION_MAX_LINES, EXEC_CONTINUATION_PREFIX, EXEC_OUTPUT_CONTINUATION_INDENT, EXEC_OUTPUT_MAX_LINES, EXEC_OUTPUT_PREFIX } from "./block-layout.ts";
import { highlightResultToStyledText } from "../highlight/contracts.ts";
import type { SyntaxHighlightService } from "../highlight/service.ts";
import type { SyntaxThemeController, SyntaxThemeSnapshot } from "../highlight/theme-controller.ts";
import type { PresentationBlock } from "../presentation.ts";
import { ansiToStyledText } from "./ansi-styled-text.ts";
import type { HighlightAdmission } from "./syntect-code-block-renderable.ts";

type ExecBlock = Extract<PresentationBlock, { readonly kind: "exec" }>;
type CommandBlock = Extract<PresentationBlock, { readonly kind: "command" }>;
export type ExecDisplayBlock = ExecBlock | CommandBlock;

export type ExecRenderableOptions = Omit<TextOptions, "content"> & {
	readonly block: ExecDisplayBlock;
	readonly highlightService: SyntaxHighlightService;
	readonly themeController: SyntaxThemeController;
};

interface StyledLine {
	readonly chunks: TextChunk[];
	readonly plain: string;
}

export class ExecRenderable extends TextRenderable {
	private block: ExecDisplayBlock;
	private readonly highlightService: SyntaxHighlightService;
	private readonly themeController: SyntaxThemeController;
	private readonly unsubscribeTheme: () => void;
	private requestGeneration = 0;
	private admission: HighlightAdmission = "offscreen";
	private pendingTheme: SyntaxThemeSnapshot;
	private scheduledSignature: string | undefined;
	private highlightedCommand: StyledText | undefined;
	private projectedWidth = 0;

	constructor(ctx: RenderContext, options: ExecRenderableOptions) {
		const { block, highlightService, themeController, ...renderableOptions } = options;
		super(ctx, { ...renderableOptions, content: plainExecText(block), selectable: true, wrapMode: "none" });
		this.block = block;
		this.highlightService = highlightService;
		this.themeController = themeController;
		this.pendingTheme = themeController.snapshot();
		this.unsubscribeTheme = themeController.subscribe((snapshot) => {
			this.pendingTheme = snapshot;
			this.scheduleIfAdmitted();
		});
		this.applyContent();
	}

	override onResize(width: number, height: number): void {
		super.onResize(width, height);
		this.applyContent();
	}

	updateBlock(block: ExecDisplayBlock): void {
		this.block = block;
		this.highlightedCommand = undefined;
		this.scheduledSignature = undefined;
		this.projectedWidth = 0;
		this.applyContent();
		this.scheduleIfAdmitted();
		this.requestRender();
	}

	setHighlightAdmission(admission: HighlightAdmission): void {
		if (this.isDestroyed || admission === this.admission) return;
		this.admission = admission;
		if (admission === "offscreen") {
			this.requestGeneration += 1;
			this.scheduledSignature = undefined;
			this.highlightService.cancel(this.id);
			return;
		}
		this.scheduleIfAdmitted();
	}

	override destroy(): void {
		if (this.isDestroyed) return;
		this.requestGeneration += 1;
		this.unsubscribeTheme();
		super.destroy();
	}

	private measuredWidth(): number {
		return Math.max(1, Math.floor(this.width || 80));
	}

	private applyContent(): void {
		const width = this.measuredWidth();
		if (width === this.projectedWidth && this.content.chunks.length > 0) return;
		this.projectedWidth = width;
		const command = stripShellLoginWrapper(this.block.command);
		this.content = styledExecText(this.block, command, this.highlightedCommand, width);
	}

	private scheduleIfAdmitted(): void {
		if (this.isDestroyed || this.admission === "offscreen") return;
		const theme = this.pendingTheme;
		const signature = `${theme.activeName}\u0000${theme.revision}\u0000${this.block.command}`;
		if (signature === this.scheduledSignature) return;
		this.scheduledSignature = signature;
		const generation = ++this.requestGeneration;
		const command = stripShellLoginWrapper(this.block.command);
		void this.highlightService.highlight({
			key: this.id,
			source: command,
			language: "bash",
			themeName: theme.activeName,
			themeRevision: theme.revision,
			priority: this.admission,
		}).then((result) => {
			if (this.isDestroyed || generation !== this.requestGeneration) return;
			this.highlightedCommand = result.ok && result.themeRevision === this.themeController.snapshot().revision
				? highlightResultToStyledText(result)
				: undefined;
			this.projectedWidth = 0;
			this.applyContent();
			this.requestRender();
		});
	}
}

/** 把 exec/command 块投影为可复制、宽度有界的终端行。 */
export function execDisplayLines(block: ExecDisplayBlock, width = 80): readonly string[] {
	const boundedWidth = boundedWidthValue(width);
	const lines = commandDisplayLines(block.command, boundedWidth, block.kind === "exec" ? block.continuationPrefix : undefined, block.kind === "exec" ? block.continuationMaxLines : undefined);
	if (block.kind === "command") return lines;
	appendStatusLine(lines, execStatusText(block), boundedWidth);
	const outputLines = outputDisplayLines(block, boundedWidth);
	return [...lines, ...outputLines];
}

export function plainExecText(block: ExecDisplayBlock, width = 80): string {
	return execDisplayLines(block, width).join("\n");
}

function commandDisplayLines(command: string, width: number, continuationPrefix = EXEC_CONTINUATION_PREFIX, continuationMaxLines = EXEC_CONTINUATION_MAX_LINES): string[] {
	const normalized = stripShellLoginWrapper(command).replace(/\r\n?/gu, "\n");
	const logicalLines = normalized.split("\n");
	const first = wrapPlainLine(logicalLines.shift() ?? "", Math.max(1, width - displayWidth("$ ")));
	const lines = [`$ ${first[0] ?? ""}`];
	const continuationWidth = Math.max(1, width - displayWidth(continuationPrefix));
	const continuation: string[] = [...first.slice(1).map((line) => `${continuationPrefix}${line}`)];
	for (const logicalLine of logicalLines) {
		for (const line of wrapPlainLine(logicalLine, continuationWidth)) continuation.push(`${continuationPrefix}${line}`);
	}
	return lines.concat(continuation.slice(0, Math.max(0, Math.floor(continuationMaxLines))));
}

function outputDisplayLines(block: ExecBlock, width: number): string[] {
	const prefix = block.outputPrefix ?? EXEC_OUTPUT_PREFIX;
	const continuation = EXEC_OUTPUT_CONTINUATION_INDENT;
	const outputWidth = Math.max(1, width - displayWidth(continuation));
	const fullLines: string[] = [];
	for (const output of block.output) {
		const plain = ansiToStyledText(output.text).chunks.map((chunk) => chunk.text).join("").replace(/\r\n?/gu, "\n");
		for (const logicalLine of plain.split("\n")) fullLines.push(...wrapPlainLine(logicalLine, outputWidth));
	}
	if (fullLines.length === 0) fullLines.push("(no output)");
	const selected = truncateMiddlePlainLines(fullLines, block.outputMaxLines ?? EXEC_OUTPUT_MAX_LINES, outputWidth);
	return selected.map((line, index) => `${index === 0 ? prefix : continuation}${line}`);
}

function truncateMiddlePlainLines(lines: readonly string[], maxLines: number, width: number): string[] {
	const limit = Math.max(1, Math.floor(maxLines));
	if (lines.length <= limit) return [...lines];
	if (limit === 1) return [truncateDisplayWidth(formatExecTruncationHint(lines.length), width, true)];
	const headCount = Math.floor((limit - 1) / 2);
	const tailCount = limit - 1 - headCount;
	const omitted = lines.length - headCount - tailCount;
	return [
		...lines.slice(0, headCount),
		truncateDisplayWidth(formatExecTruncationHint(omitted), width, true),
		...lines.slice(-tailCount),
	];
}

function appendStatusLine(lines: string[], status: string, width: number): void {
	const last = lines.at(-1) ?? "";
	if (displayWidth(last) + displayWidth(status) <= width) {
		lines[lines.length - 1] = `${last}${status}`;
		return;
	}
	lines.push(truncateDisplayWidth(status, width, true));
}

function execStatusText(block: ExecBlock): string {
	const duration = block.durationMs === undefined ? "" : ` • ${formatExecDuration(block.durationMs)}`;
	const background = block.background === true ? " (bg)" : "";
	if (block.status === "succeeded") return `  ✓${duration}${background}`;
	if (["failed", "cancelled", "aborted"].includes(block.status)) {
		const exit = block.exitCode === undefined ? "exit" : String(block.exitCode);
		return `  ✗ (${exit})${duration}${background}`;
	}
	if (block.status === "running") return `  • running${background}`;
	return `  ○ pending${background}`;
}

function formatExecDuration(durationMs: number): string {
	const milliseconds = Math.max(0, Math.round(Number.isFinite(durationMs) ? durationMs : 0));
	if (milliseconds < 1_000) return `${milliseconds}ms`;
	const seconds = milliseconds / 1_000;
	return `${Number(seconds.toFixed(1))}s`;
}

function boundedWidthValue(width: number): number {
	return Math.max(1, Math.floor(Number.isFinite(width) ? width : 80));
}

function wrapPlainLine(value: string, width: number): readonly string[] {
	const lines = wrapDisplayWidth(value, Math.max(1, Math.floor(width)), Math.max(1, graphemes(value).length + 1));
	return lines.length === 0 ? [""] : lines;
}

function styledExecText(block: ExecDisplayBlock, command: string, highlighted: StyledText | undefined, width: number): StyledText {
	const commandLines = styledCommandLines(command, highlighted ?? ansiToStyledText(command), width, block.kind === "exec" ? block.continuationPrefix : undefined, block.kind === "exec" ? block.continuationMaxLines : undefined);
	if (block.kind === "command") return flattenStyledLines(commandLines);
	appendStyledStatusLine(commandLines, block, width);
	const outputLines = styledOutputLines(block, width);
	return flattenStyledLines([...commandLines, ...outputLines]);
}

function styledCommandLines(command: string, source: StyledText, width: number, continuationPrefix = EXEC_CONTINUATION_PREFIX, continuationMaxLines = EXEC_CONTINUATION_MAX_LINES): StyledLine[] {
	const sourceLines = splitStyledLines(source.chunks);
	const firstSource = sourceLines.shift() ?? [];
	const first = wrapStyledLine(firstSource, Math.max(1, width - displayWidth("$ ")));
	const lines: StyledLine[] = [withPrefix("$ ", first[0]?.chunks ?? [], false)];
	const continuationWidth = Math.max(1, width - displayWidth(continuationPrefix));
	const continuation: StyledLine[] = first.slice(1).map((line) => withPrefix(continuationPrefix, line.chunks, true));
	for (const sourceLine of sourceLines) {
		for (const line of wrapStyledLine(sourceLine, continuationWidth)) continuation.push(withPrefix(continuationPrefix, line.chunks, true));
	}
	return lines.concat(continuation.slice(0, Math.max(0, Math.floor(continuationMaxLines))));
}

function styledOutputLines(block: ExecBlock, width: number): StyledLine[] {
	const prefix = block.outputPrefix ?? EXEC_OUTPUT_PREFIX;
	const outputWidth = Math.max(1, width - displayWidth(EXEC_OUTPUT_CONTINUATION_INDENT));
	const fullLines: StyledLine[] = [];
	for (const output of block.output) {
		const source = ansiToStyledText(output.text);
		for (const line of splitStyledLines(source.chunks)) {
			for (const wrapped of wrapStyledLine(line, outputWidth)) fullLines.push(dimLine(wrapped.chunks));
		}
	}
	if (fullLines.length === 0) fullLines.push(dimLine([{ __isChunk: true, text: "(no output)" }]));
	const selected = truncateMiddleStyledLines(fullLines, block.outputMaxLines ?? EXEC_OUTPUT_MAX_LINES, outputWidth);
	return selected.map((line, index) => withPrefix(index === 0 ? prefix : EXEC_OUTPUT_CONTINUATION_INDENT, line.chunks, true));
}

function truncateMiddleStyledLines(lines: readonly StyledLine[], maxLines: number, width: number): StyledLine[] {
	const limit = Math.max(1, Math.floor(maxLines));
	if (lines.length <= limit) return [...lines];
	if (limit === 1) return [dimLine([{ __isChunk: true, text: truncateDisplayWidth(formatExecTruncationHint(lines.length), width, true) }])];
	const headCount = Math.floor((limit - 1) / 2);
	const tailCount = limit - 1 - headCount;
	const omitted = lines.length - headCount - tailCount;
	return [
		...lines.slice(0, headCount),
		dimLine([{ __isChunk: true, text: truncateDisplayWidth(formatExecTruncationHint(omitted), width, true) }]),
		...lines.slice(-tailCount),
	];
}

function appendStyledStatusLine(lines: StyledLine[], block: ExecBlock, width: number): void {
	const status = execStatusText(block);
	const last = lines.at(-1);
	if (last !== undefined && displayWidth(last.plain) + displayWidth(status) <= width) {
		lines[lines.length - 1] = { chunks: [...last.chunks, statusChunk(block, status)], plain: `${last.plain}${status}` };
		return;
	}
	lines.push({ chunks: [statusChunk(block, truncateDisplayWidth(status, width, true))], plain: truncateDisplayWidth(status, width, true) });
}

function statusChunk(block: ExecBlock, text: string): TextChunk {
	const attributes = ["failed", "cancelled", "aborted", "succeeded"].includes(block.status) ? TextAttributes.BOLD : TextAttributes.DIM;
	const fg = block.status === "succeeded" ? 2 : ["failed", "cancelled", "aborted"].includes(block.status) ? 1 : 3;
	return { __isChunk: true, text, fg: RGBA.fromIndex(fg), attributes };
}

function splitStyledLines(chunks: readonly TextChunk[]): TextChunk[][] {
	const lines: TextChunk[][] = [[]];
	for (const chunk of chunks) {
		const parts = chunk.text.split("\n");
		for (const [index, part] of parts.entries()) {
			if (part.length > 0) lines.at(-1)!.push({ ...chunk, text: part });
			if (index < parts.length - 1) lines.push([]);
		}
	}
	return lines;
}

function wrapStyledLine(chunks: readonly TextChunk[], width: number): StyledLine[] {
	const lines: StyledLine[] = [];
	let current: TextChunk[] = [];
	let currentWidth = 0;
	const flush = (): void => {
		lines.push({ chunks: current, plain: current.map((chunk) => chunk.text).join("") });
		current = [];
		currentWidth = 0;
	};
	for (const chunk of chunks) {
		for (const grapheme of graphemes(chunk.text)) {
			const nextWidth = displayWidth(grapheme);
			if (nextWidth > 0 && currentWidth > 0 && currentWidth + nextWidth > width) flush();
			current.push({ ...chunk, text: grapheme });
			currentWidth += nextWidth;
		}
	}
	flush();
	return lines;
}

function withPrefix(prefix: string, chunks: readonly TextChunk[], dim: boolean): StyledLine {
	const prefixChunk: TextChunk = {
		__isChunk: true,
		text: prefix,
		...(prefix === "$ " ? { fg: RGBA.fromIndex(5) } : {}),
		...(dim ? { attributes: TextAttributes.DIM } : {}),
	};
	return { chunks: [prefixChunk, ...chunks], plain: `${prefix}${chunks.map((chunk) => chunk.text).join("")}` };
}

function dimLine(chunks: readonly TextChunk[]): StyledLine {
	const dimmed = chunks.map((chunk) => ({ ...chunk, attributes: (chunk.attributes ?? TextAttributes.NONE) | TextAttributes.DIM }));
	return { chunks: dimmed, plain: dimmed.map((chunk) => chunk.text).join("") };
}

function flattenStyledLines(lines: readonly StyledLine[]): StyledText {
	const chunks: TextChunk[] = [];
	for (const [index, line] of lines.entries()) {
		if (index > 0) chunks.push({ __isChunk: true, text: "\n" });
		chunks.push(...line.chunks);
	}
	return new StyledText(chunks);
}

export function stripShellLoginWrapper(command: string): string {
	if (/^[A-Za-z]:\\/u.test(command)) return command;
	const match = /^(?:\/[^\s'"]+\/)?(?:bash|zsh)\s+-lc\s+([\s\S]+)$/u.exec(command.trim());
	if (!match) return command;
	const script = match[1]!;
	if (script.length < 2) return script;
	const quote = script[0];
	if ((quote !== "'" && quote !== '"') || script.at(-1) !== quote) return script;
	const inner = script.slice(1, -1);
	return quote === "'" ? inner.replace(/\\'/gu, "'") : inner.replace(/\\"/gu, '"').replace(/\\\\/gu, "\\");
}
