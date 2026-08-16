import { RGBA, StyledText, TextAttributes, TextRenderable, type RenderContext, type TextChunk, type TextOptions } from "@opentui/core";
import { DIFF_TAB_REPLACEMENT, diffLineNumberWidth } from "./block-layout.ts";
import type { HighlightColor, HighlightLine } from "../highlight/contracts.ts";
import type { HighlightResult } from "../highlight/contracts.ts";
import type { SyntaxHighlightService } from "../highlight/service.ts";
import type { SyntaxThemeController, SyntaxThemeSnapshot } from "../highlight/theme-controller.ts";
import type { PresentationBlock } from "../presentation.ts";
import type { SafeDiffDocument, SafeDiffLine } from "../presentation/tools/types.ts";
import type { HighlightAdmission } from "./syntect-code-block-renderable.ts";
import { displayWidth, graphemes, wrapDisplayWidth } from "../mermaid/display-width.ts";
import { admitStreamingDiff, type StreamingDiffLineRef } from "./streaming-diff-admission.ts";

const MAX_DIFF_MANUAL_WRAP_BYTES = 64 * 1024;

export type DiffBlock = Extract<PresentationBlock, { readonly kind: "diff" }>;

export type DiffRenderableOptions = Omit<TextOptions, "content"> & {
	readonly block: DiffBlock;
	readonly highlightService: SyntaxHighlightService;
	readonly themeController: SyntaxThemeController;
};

/** bounded SafeDiffDocument -> selectable StyledText；不重新读取文件或解析 raw diff。 */
export class DiffRenderable extends TextRenderable {
	private block: DiffBlock;
	private readonly highlightService: SyntaxHighlightService;
	private readonly themeController: SyntaxThemeController;
	private readonly unsubscribeTheme: () => void;
	private pendingTheme: SyntaxThemeSnapshot;
	private admission: HighlightAdmission = "offscreen";
	private requestGeneration = 0;
	private scheduledSignature: string | undefined;
	private highlightKeys: string[] = [];
	private highlightedHunks: readonly (readonly (HighlightLine | undefined)[] | undefined)[] = [];
	private renderWidth: number | undefined;

	constructor(ctx: RenderContext, options: DiffRenderableOptions) {
		const { block, highlightService, themeController, ...renderableOptions } = options;
		super(ctx, {
			...renderableOptions,
			content: diffStyledText(block, fallbackBackgrounds(themeController.snapshot()), []),
			selectable: true,
			wrapMode: "none",
		});
		this.block = block;
		this.highlightService = highlightService;
		this.themeController = themeController;
		this.pendingTheme = themeController.snapshot();
		this.unsubscribeTheme = themeController.subscribe((snapshot) => {
			this.pendingTheme = snapshot;
			this.highlightedHunks = [];
			this.scheduledSignature = undefined;
			this.applyTheme(snapshot);
			this.scheduleIfAdmitted();
		});
		this.applyTheme(themeController.snapshot());
	}

	get plainText(): string {
		return diffPlainText(this.block);
	}

	updateBlock(block: DiffBlock): void {
		this.invalidateHighlightRequests();
		this.block = block;
		this.highlightedHunks = [];
		this.scheduledSignature = undefined;
		this.applyTheme(this.themeController.snapshot());
		this.scheduleIfAdmitted();
		this.requestRender();
	}

	/** 保留 document-only 更新接缝，供旧调用方在 block 字段不变时使用。 */
	updateDocument(document: SafeDiffDocument): void {
		this.updateBlock({ ...this.block, document });
	}

	setHighlightAdmission(admission: HighlightAdmission): void {
		if (this.isDestroyed || admission === this.admission) return;
		this.admission = admission;
		if (admission === "offscreen") {
			this.invalidateHighlightRequests();
			return;
		}
		this.scheduleIfAdmitted();
	}

	override destroy(): void {
		if (this.isDestroyed) return;
		this.invalidateHighlightRequests();
		this.unsubscribeTheme();
		super.destroy();
	}

	protected override onResize(width: number, height: number): void {
		super.onResize(width, height);
		const nextWidth = Math.max(1, Math.floor(width));
		if (this.renderWidth === nextWidth) return;
		this.renderWidth = nextWidth;
		if (this.themeController !== undefined) this.applyTheme(this.themeController.snapshot());
	}

	private applyTheme(snapshot: SyntaxThemeSnapshot): void {
		if (this.isDestroyed) return;
		const scoped = this.highlightService.diffScopeBackgrounds(snapshot.activeName);
		const fallback = fallbackBackgrounds(snapshot);
		this.content = diffStyledText(this.block, {
			inserted: scoped?.inserted ?? fallback.inserted,
			deleted: scoped?.deleted ?? fallback.deleted,
		}, this.highlightedHunks, this.renderWidth);
		this.requestRender();
	}

	private scheduleIfAdmitted(): void {
		if (this.isDestroyed || this.admission === "offscreen" || this.block.syntaxHighlight === false) return;
		const theme = this.pendingTheme;
		const signature = `${theme.activeName}\u0000${theme.revision}\u0000${diffPlainText(this.block)}`;
		if (signature === this.scheduledSignature) return;
		this.invalidateHighlightRequests();
		this.scheduledSignature = signature;
		this.highlightedHunks = [];
		this.applyTheme(theme);
		const admission = admitStreamingDiff(this.block.document, { streaming: this.block.streaming === true });
		if (admission.fallback === "budget" || admission.admitted.length === 0) return;
		const generation = this.requestGeneration;
		const language = languageForDiffPath(this.block.document.path.text);
		const priority = this.admission === "visible" ? "visible" : "overscan";
		const admittedByHunk = admittedLinesByHunk(admission.admitted);
		const requests = [...admittedByHunk.entries()].map(([hunkIndex, refs]) => {
			const key = `${this.id}:diff-hunk:${hunkIndex}`;
			this.highlightKeys.push(key);
			return this.highlightService.highlight({
				key,
				source: refs.map((ref) => normalizeDiffText(ref.line.text.text)).join("\n"),
				language,
				themeName: theme.activeName,
				themeRevision: theme.revision,
				priority,
			});
		});
		void Promise.all(requests).then((results) => {
			if (this.isDestroyed || generation !== this.requestGeneration) return;
			this.highlightKeys = [];
			this.highlightedHunks = mergeAdmittedHighlights(this.block.document, [...admittedByHunk.values()], results);
			this.applyTheme(this.themeController.snapshot());
		}, () => {
			if (this.isDestroyed || generation !== this.requestGeneration) return;
			this.highlightKeys = [];
			this.highlightedHunks = [];
			this.applyTheme(this.themeController.snapshot());
		});
	}

	private invalidateHighlightRequests(): void {
		this.requestGeneration += 1;
		for (const key of this.highlightKeys) this.highlightService.cancel(key);
		this.highlightKeys = [];
		this.scheduledSignature = undefined;
	}
}

/** 把 diff block 投影为可复制的终端行；样式不改变这些文本。 */
export function diffDisplayLines(block: DiffBlock, requestedWidth?: number): readonly string[] {
	const widthLimit = requestedWidth === undefined ? undefined : Math.max(1, Math.floor(requestedWidth));
	const lines = widthLimit === undefined ? [diffHeader(block.document)] : [...wrapPlainText(diffHeader(block.document), widthLimit)];
	const showLineNumbers = block.showLineNumbers !== false;
	const width = normalizedLineNumberWidth(block);
	for (const hunk of block.document.hunks) {
		for (const line of hunk.lines) {
			if (widthLimit === undefined) lines.push(diffLineText(line, showLineNumbers, width));
			else lines.push(...diffLineDisplayLines(line, showLineNumbers, width, widthLimit));
		}
	}
	if (block.document.diagnostic !== undefined) {
		const diagnostic = `  diff ${block.document.diagnostic}`;
		lines.push(...(widthLimit === undefined ? [diagnostic] : wrapPlainText(diagnostic, widthLimit)));
	}
	return lines;
}

export function diffPlainText(block: DiffBlock): string {
	return diffDisplayLines(block).join("\n");
}

export function languageForDiffPath(path: string): string {
	const fileName = path.split(/[\\/]/u).at(-1) ?? path;
	const dot = fileName.lastIndexOf(".");
	const extension = dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : "";
	const languages: Readonly<Record<string, string>> = {
		c: "c",
		cc: "cpp",
		cpp: "cpp",
		css: "css",
		go: "go",
		h: "c",
		hpp: "cpp",
		html: "html",
		java: "java",
		js: "javascript",
		jsx: "javascript",
		json: "json",
		md: "markdown",
		py: "python",
		rs: "rust",
		sh: "bash",
		sql: "sql",
		ts: "typescript",
		tsx: "typescript",
		toml: "toml",
		xml: "xml",
		yaml: "yaml",
		yml: "yaml",
	};
	return languages[extension] ?? (extension || "text");
}

interface DiffBackgrounds {
	readonly inserted: HighlightColor;
	readonly deleted: HighlightColor;
}

function diffStyledText(
	block: DiffBlock,
	backgrounds: DiffBackgrounds,
	highlightedHunks: readonly (readonly (HighlightLine | undefined)[] | undefined)[],
	width?: number,
): StyledText {
	const lines: TextChunk[][] = wrapStyledChunks([{
		__isChunk: true,
		text: diffHeader(block.document),
		attributes: TextAttributes.BOLD,
	}], width);
	for (const [hunkIndex, hunk] of block.document.hunks.entries()) {
		const highlighted = highlightedHunks[hunkIndex];
		for (const [lineIndex, line] of hunk.lines.entries()) {
			lines.push(...diffLineChunks(
				block,
				line,
				backgrounds,
				highlighted?.[lineIndex],
				width,
			));
		}
	}
	if (block.document.diagnostic !== undefined) {
		lines.push(...wrapStyledChunks([{
			__isChunk: true,
			text: `  diff ${block.document.diagnostic}`,
			attributes: TextAttributes.DIM,
		}], width));
	}
	return styledLinesText(lines);
}

function diffLineChunks(
	block: DiffBlock,
	line: SafeDiffLine,
	backgrounds: DiffBackgrounds,
	highlighted: HighlightLine | undefined,
	width?: number,
): TextChunk[][] {
	const showLineNumbers = block.showLineNumbers !== false;
	const lineNumberWidth = normalizedLineNumberWidth(block);
	const lineNumber = lineNumberFor(line);
	const sign = signFor(line);
	const prefix = showLineNumbers
		? `${String(lineNumber).padStart(lineNumberWidth)} ${sign}`
		: `${sign} `;
	const lineStyle = diffLineStyle(line.kind, backgrounds);
	const attributes = line.kind === "delete" ? TextAttributes.DIM : undefined;
	const contentChunks: TextChunk[] = [];
	const text = normalizeDiffText(line.text.text);
	if (highlighted !== undefined) {
		for (const span of highlighted.spans) {
			contentChunks.push({
				__isChunk: true,
				text: span.text,
				fg: colorToRgba(span.foreground),
				...(lineStyle.bg === undefined ? {} : { bg: lineStyle.bg }),
				...(span.bold || line.kind === "delete"
					? { attributes: (span.bold ? TextAttributes.BOLD : TextAttributes.NONE) | (line.kind === "delete" ? TextAttributes.DIM : TextAttributes.NONE) }
					: {}),
			});
		}
	} else {
		contentChunks.push({
			__isChunk: true,
			text,
			...lineStyle,
			...(attributes === undefined ? {} : { attributes }),
		});
	}
	const prefixWidth = displayWidth(prefix);
	// canonical projector 已把单行限制在 4 KiB；超大 direct fixture 保持单块，避免绕过边界时制造数千 native chunks。
	const contentWidth = width === undefined || Buffer.byteLength(text, "utf8") > MAX_DIFF_MANUAL_WRAP_BYTES
		? undefined
		: Math.max(1, width - prefixWidth);
	const wrapped = wrapStyledChunks(contentChunks, contentWidth);
	return wrapped.map((chunks, index) => [{
		__isChunk: true,
		text: index === 0 ? prefix : " ".repeat(prefixWidth),
		...lineStyle,
		...(attributes === undefined ? {} : { attributes }),
	}, ...chunks]);
}

function diffLineText(line: SafeDiffLine, showLineNumbers: boolean, lineNumberWidth: number): string {
	const text = normalizeDiffText(line.text.text);
	if (!showLineNumbers) return `${signFor(line)} ${text}`;
	return `${String(lineNumberFor(line)).padStart(lineNumberWidth)} ${signFor(line)}${text}`;
}

function diffLineDisplayLines(line: SafeDiffLine, showLineNumbers: boolean, lineNumberWidth: number, width: number): readonly string[] {
	const prefix = diffLinePrefix(line, showLineNumbers, lineNumberWidth);
	const contentWidth = Math.max(1, width - displayWidth(prefix));
	return wrapPlainText(normalizeDiffText(line.text.text), contentWidth).map((text, index) => `${index === 0 ? prefix : " ".repeat(displayWidth(prefix))}${text}`);
}

function diffLinePrefix(line: SafeDiffLine, showLineNumbers: boolean, lineNumberWidth: number): string {
	if (!showLineNumbers) return `${signFor(line)} `;
	return `${String(lineNumberFor(line)).padStart(lineNumberWidth)} ${signFor(line)}`;
}

function wrapPlainText(text: string, width: number): readonly string[] {
	if (displayWidth(text) <= width) return [text];
	return wrapDisplayWidth(text, Math.max(1, width), Math.max(1, graphemes(text).length + 1));
}

function wrapStyledChunks(chunks: readonly TextChunk[], width?: number): TextChunk[][] {
	if (width === undefined) return [[...chunks]];
	const ascii = chunks.every((chunk) => /^[\x20-\x7E]*$/u.test(chunk.text));
	const totalWidth = ascii
		? chunks.reduce((total, chunk) => total + chunk.text.length, 0)
		: chunks.reduce((total, chunk) => total + displayWidth(chunk.text), 0);
	if (totalWidth <= width) return [[...chunks]];
	if (ascii) return wrapAsciiStyledChunks(chunks, width);
	const lines: TextChunk[][] = [];
	let current: TextChunk[] = [];
	let currentWidth = 0;
	const flush = (): void => {
		lines.push(current);
		current = [];
		currentWidth = 0;
	};
	for (const chunk of chunks) {
		for (const grapheme of graphemes(chunk.text)) {
			const graphemeWidth = displayWidth(grapheme);
			if (graphemeWidth > 0 && currentWidth > 0 && currentWidth + graphemeWidth > width) flush();
			const previous = current.at(-1);
			if (previous !== undefined && sameChunkStyle(previous, chunk)) current[current.length - 1] = { ...previous, text: `${previous.text}${grapheme}` };
			else current.push({ ...chunk, text: grapheme });
			currentWidth += graphemeWidth;
		}
	}
	flush();
	return lines;
}

function wrapAsciiStyledChunks(chunks: readonly TextChunk[], width: number): TextChunk[][] {
	const lines: TextChunk[][] = [];
	let current: TextChunk[] = [];
	let currentWidth = 0;
	const flush = (): void => {
		lines.push(current);
		current = [];
		currentWidth = 0;
	};
	for (const chunk of chunks) {
		let offset = 0;
		while (offset < chunk.text.length) {
			const take = Math.min(width - currentWidth, chunk.text.length - offset);
			const text = chunk.text.slice(offset, offset + take);
			const previous = current.at(-1);
			if (previous !== undefined && sameChunkStyle(previous, chunk)) current[current.length - 1] = { ...previous, text: `${previous.text}${text}` };
			else current.push({ ...chunk, text });
			offset += take;
			currentWidth += take;
			if (currentWidth >= width) flush();
		}
	}
	if (current.length > 0 || lines.length === 0) flush();
	return lines;
}

function sameChunkStyle(left: TextChunk, right: TextChunk): boolean {
	return left.fg === right.fg && left.bg === right.bg && left.attributes === right.attributes;
}

function styledLinesText(lines: readonly (readonly TextChunk[])[]): StyledText {
	const chunks: TextChunk[] = [];
	for (const [index, line] of lines.entries()) {
		if (index > 0) chunks.push({ __isChunk: true, text: "\n" });
		chunks.push(...line);
	}
	return new StyledText(chunks);
}

function diffLineStyle(kind: SafeDiffLine["kind"], backgrounds: DiffBackgrounds): { readonly fg?: RGBA; readonly bg?: RGBA } {
	if (kind === "add") return { fg: RGBA.fromIndex(2), bg: colorToRgba(backgrounds.inserted) };
	if (kind === "delete") return { fg: RGBA.fromIndex(1), bg: colorToRgba(backgrounds.deleted) };
	return {};
}

function signFor(line: SafeDiffLine): string {
	return line.kind === "add" ? "+" : line.kind === "delete" ? "-" : " ";
}

function lineNumberFor(line: SafeDiffLine): number {
	return line.kind === "add" ? line.newLine : line.kind === "delete" ? line.oldLine : line.newLine;
}

function normalizedLineNumberWidth(block: DiffBlock): number {
	if (block.lineNumberWidth !== undefined && Number.isFinite(block.lineNumberWidth)) {
		return Math.max(1, Math.floor(block.lineNumberWidth));
	}
	let maxLineNumber = 0;
	for (const hunk of block.document.hunks) {
		for (const line of hunk.lines) maxLineNumber = Math.max(maxLineNumber, lineNumberFor(line));
	}
	return diffLineNumberWidth(maxLineNumber);
}

function admittedLinesByHunk(lines: readonly StreamingDiffLineRef[]): Map<number, StreamingDiffLineRef[]> {
	const grouped = new Map<number, StreamingDiffLineRef[]>();
	for (const line of lines) {
		const existing = grouped.get(line.hunkIndex);
		if (existing === undefined) grouped.set(line.hunkIndex, [line]);
		else existing.push(line);
	}
	return grouped;
}

function mergeAdmittedHighlights(
	document: SafeDiffDocument,
	groups: readonly (readonly StreamingDiffLineRef[])[],
	results: readonly HighlightResult[],
): readonly (readonly (HighlightLine | undefined)[] | undefined)[] {
	const merged = document.hunks.map((hunk) => new Array<HighlightLine | undefined>(hunk.lines.length));
	for (const [groupIndex, refs] of groups.entries()) {
		const result = results[groupIndex];
		if (result === undefined || !result.ok || result.lines.length !== refs.length) continue;
		for (const [lineIndex, ref] of refs.entries()) {
			const highlighted = result.lines[lineIndex];
			if (highlighted === undefined || !validHighlightLine(highlighted, ref.line)) continue;
			const target = merged[ref.hunkIndex];
			if (target !== undefined) target[ref.lineIndex] = highlighted;
		}
	}
	return merged.map((lines) => lines.some((line) => line !== undefined) ? lines : undefined);
}

function validHighlightLine(highlighted: HighlightLine, line: SafeDiffLine): boolean {
	return highlighted.spans.map((span) => span.text).join("") === normalizeDiffText(line.text.text);
}

function normalizeDiffText(text: string): string {
	return text.replace(/\t/gu, DIFF_TAB_REPLACEMENT);
}

function diffHeader(document: SafeDiffDocument): string {
	return `diff ${document.path.text} (+${knownCount(document.addedLines)} -${knownCount(document.removedLines)})`;
}

function knownCount(count: import("../presentation/tools/types.ts").SafeCount): string {
	return count.state === "known" ? String(count.value) : "?";
}

function fallbackBackgrounds(snapshot: SyntaxThemeSnapshot): DiffBackgrounds {
	const light = snapshot.activeName.includes("light") || snapshot.activeName === "catppuccin-latte" || snapshot.activeName === "github";
	return light
		? { inserted: { kind: "rgb", r: 218, g: 251, b: 225 }, deleted: { kind: "rgb", r: 255, g: 235, b: 233 } }
		: { inserted: { kind: "rgb", r: 33, g: 58, b: 43 }, deleted: { kind: "rgb", r: 74, g: 34, b: 29 } };
}

function colorToRgba(color: HighlightColor): RGBA {
	if (color.kind === "default") return RGBA.defaultBackground();
	if (color.kind === "indexed") return RGBA.fromIndex(color.index);
	return RGBA.fromInts(color.r, color.g, color.b);
}
