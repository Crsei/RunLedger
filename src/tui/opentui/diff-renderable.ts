import { RGBA, StyledText, TextAttributes, TextRenderable, type RenderContext, type TextChunk, type TextOptions } from "@opentui/core";
import { DIFF_TAB_REPLACEMENT, diffLineNumberWidth } from "./block-layout.ts";
import type { HighlightColor, HighlightLine } from "../highlight/contracts.ts";
import type { SyntaxHighlightService } from "../highlight/service.ts";
import type { SyntaxThemeController, SyntaxThemeSnapshot } from "../highlight/theme-controller.ts";
import type { PresentationBlock } from "../presentation.ts";
import type { SafeDiffDocument, SafeDiffHunk, SafeDiffLine } from "../presentation/tools/types.ts";
import type { HighlightAdmission } from "./syntect-code-block-renderable.ts";

const MAX_DIFF_HIGHLIGHT_BYTES = 512 * 1024;
const MAX_DIFF_HIGHLIGHT_LINES = 10_000;

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
	private highlightedHunks: readonly (readonly HighlightLine[] | undefined)[] = [];

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

	private applyTheme(snapshot: SyntaxThemeSnapshot): void {
		if (this.isDestroyed) return;
		const scoped = this.highlightService.diffScopeBackgrounds(snapshot.activeName);
		const fallback = fallbackBackgrounds(snapshot);
		this.content = diffStyledText(this.block, {
			inserted: scoped?.inserted ?? fallback.inserted,
			deleted: scoped?.deleted ?? fallback.deleted,
		}, this.highlightedHunks);
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
		if (!withinDiffHighlightLimits(this.block.document)) return;
		const generation = this.requestGeneration;
		const language = languageForDiffPath(this.block.document.path.text);
		const priority = this.admission === "visible" ? "visible" : "overscan";
		const requests = this.block.document.hunks.map((hunk, index) => {
			const key = `${this.id}:diff-hunk:${index}`;
			this.highlightKeys.push(key);
			return this.highlightService.highlight({
				key,
				source: diffHunkSource(hunk),
				language,
				themeName: theme.activeName,
				themeRevision: theme.revision,
				priority,
			});
		});
		void Promise.all(requests).then((results) => {
			if (this.isDestroyed || generation !== this.requestGeneration) return;
			this.highlightKeys = [];
			this.highlightedHunks = results.map((result, index) => {
				const hunk = this.block.document.hunks[index];
				return result.ok && hunk !== undefined && validHighlightLines(result.lines, hunk)
					? result.lines
					: undefined;
			});
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
export function diffDisplayLines(block: DiffBlock): readonly string[] {
	const lines = [diffHeader(block.document)];
	const showLineNumbers = block.showLineNumbers !== false;
	const width = normalizedLineNumberWidth(block);
	for (const hunk of block.document.hunks) {
		for (const line of hunk.lines) lines.push(diffLineText(line, showLineNumbers, width));
	}
	if (block.document.diagnostic !== undefined) lines.push(`  diff ${block.document.diagnostic}`);
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
	highlightedHunks: readonly (readonly HighlightLine[] | undefined)[],
): StyledText {
	const chunks: TextChunk[] = [{
		__isChunk: true,
		text: diffHeader(block.document),
		attributes: TextAttributes.BOLD,
	}];
	for (const [hunkIndex, hunk] of block.document.hunks.entries()) {
		const highlighted = highlightedHunks[hunkIndex];
		for (const [lineIndex, line] of hunk.lines.entries()) {
			chunks.push({ __isChunk: true, text: "\n" });
			chunks.push(...diffLineChunks(
				block,
				line,
				backgrounds,
				highlighted?.[lineIndex],
			));
		}
	}
	if (block.document.diagnostic !== undefined) {
		chunks.push({ __isChunk: true, text: `\n  diff ${block.document.diagnostic}`, attributes: TextAttributes.DIM });
	}
	return new StyledText(chunks);
}

function diffLineChunks(
	block: DiffBlock,
	line: SafeDiffLine,
	backgrounds: DiffBackgrounds,
	highlighted: HighlightLine | undefined,
): TextChunk[] {
	const showLineNumbers = block.showLineNumbers !== false;
	const lineNumberWidth = normalizedLineNumberWidth(block);
	const lineNumber = lineNumberFor(line);
	const sign = signFor(line);
	const prefix = showLineNumbers
		? `${String(lineNumber).padStart(lineNumberWidth)} ${sign}`
		: `${sign} `;
	const lineStyle = diffLineStyle(line.kind, backgrounds);
	const chunks: TextChunk[] = [{
		__isChunk: true,
		text: prefix,
		...lineStyle,
		...(line.kind === "delete" ? { attributes: TextAttributes.DIM } : {}),
	}];
	const text = normalizeDiffText(line.text.text);
	if (highlighted !== undefined) {
		for (const span of highlighted.spans) {
			chunks.push({
				__isChunk: true,
				text: span.text,
				fg: colorToRgba(span.foreground),
				...(lineStyle.bg === undefined ? {} : { bg: lineStyle.bg }),
				...(span.bold || line.kind === "delete"
					? { attributes: (span.bold ? TextAttributes.BOLD : TextAttributes.NONE) | (line.kind === "delete" ? TextAttributes.DIM : TextAttributes.NONE) }
					: {}),
			});
		}
		return chunks;
	}
	chunks.push({
		__isChunk: true,
		text,
		...lineStyle,
		...(line.kind === "delete" ? { attributes: TextAttributes.DIM } : {}),
	});
	return chunks;
}

function diffLineText(line: SafeDiffLine, showLineNumbers: boolean, lineNumberWidth: number): string {
	const text = normalizeDiffText(line.text.text);
	if (!showLineNumbers) return `${signFor(line)} ${text}`;
	return `${String(lineNumberFor(line)).padStart(lineNumberWidth)} ${signFor(line)}${text}`;
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

function diffHunkSource(hunk: SafeDiffHunk): string {
	return hunk.lines.map((line) => normalizeDiffText(line.text.text)).join("\n");
}

function withinDiffHighlightLimits(document: SafeDiffDocument): boolean {
	let bytes = 0;
	let lines = 0;
	for (const hunk of document.hunks) {
		const source = diffHunkSource(hunk);
		bytes += Buffer.byteLength(source, "utf8");
		lines += hunk.lines.length;
		if (bytes > MAX_DIFF_HIGHLIGHT_BYTES || lines > MAX_DIFF_HIGHLIGHT_LINES) return false;
	}
	return true;
}

function validHighlightLines(lines: readonly HighlightLine[], hunk: SafeDiffHunk): boolean {
	return lines.length === hunk.lines.length && lines.every((line, index) => {
		const source = line.spans.map((span) => span.text).join("");
		return source === normalizeDiffText(hunk.lines[index]!.text.text);
	});
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
