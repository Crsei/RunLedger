import { RGBA, StyledText, TextAttributes, TextRenderable, type RenderContext, type TextChunk, type TextOptions } from "@opentui/core";
import type { HighlightColor } from "../highlight/contracts.ts";
import type { SyntaxHighlightService } from "../highlight/service.ts";
import type { SyntaxThemeController, SyntaxThemeSnapshot } from "../highlight/theme-controller.ts";
import type { SafeDiffDocument } from "../presentation/tools/types.ts";

export type DiffRenderableOptions = Omit<TextOptions, "content"> & {
	readonly document: SafeDiffDocument;
	readonly highlightService: SyntaxHighlightService;
	readonly themeController: SyntaxThemeController;
};

/** bounded SafeDiffDocument -> selectable StyledText；不重新读取文件或解析 raw diff。 */
export class DiffRenderable extends TextRenderable {
	private document: SafeDiffDocument;
	private readonly highlightService: SyntaxHighlightService;
	private readonly themeController: SyntaxThemeController;
	private readonly unsubscribeTheme: () => void;

	constructor(ctx: RenderContext, options: DiffRenderableOptions) {
		const { document, highlightService, themeController, ...renderableOptions } = options;
		super(ctx, {
			...renderableOptions,
			content: diffStyledText(document, fallbackBackgrounds(themeController.snapshot())),
			selectable: true,
			wrapMode: "none",
		});
		this.document = document;
		this.highlightService = highlightService;
		this.themeController = themeController;
		this.unsubscribeTheme = themeController.subscribe((snapshot) => this.applyTheme(snapshot));
		this.applyTheme(themeController.snapshot());
	}

	get plainText(): string {
		return diffPlainText(this.document);
	}

	updateDocument(document: SafeDiffDocument): void {
		this.document = document;
		this.applyTheme(this.themeController.snapshot());
	}

	override destroy(): void {
		if (this.isDestroyed) return;
		this.unsubscribeTheme();
		super.destroy();
	}

	private applyTheme(snapshot: SyntaxThemeSnapshot): void {
		if (this.isDestroyed) return;
		const scoped = this.highlightService.diffScopeBackgrounds(snapshot.activeName);
		const fallback = fallbackBackgrounds(snapshot);
		this.content = diffStyledText(this.document, {
			inserted: scoped?.inserted ?? fallback.inserted,
			deleted: scoped?.deleted ?? fallback.deleted,
		});
		this.requestRender();
	}
}

interface DiffBackgrounds {
	readonly inserted: HighlightColor;
	readonly deleted: HighlightColor;
}

function diffStyledText(document: SafeDiffDocument, backgrounds: DiffBackgrounds): StyledText {
	const chunks: TextChunk[] = [{
		__isChunk: true,
		text: diffHeader(document),
		attributes: TextAttributes.BOLD,
	}];
	for (const hunk of document.hunks) {
		for (const line of hunk.lines) {
			chunks.push({ __isChunk: true, text: "\n" });
			const text = `${line.kind === "add" ? "+" : line.kind === "delete" ? "-" : " "} ${line.text.text}`;
			if (line.kind === "add") chunks.push({ __isChunk: true, text, fg: RGBA.fromIndex(2), bg: colorToRgba(backgrounds.inserted) });
			else if (line.kind === "delete") chunks.push({ __isChunk: true, text, fg: RGBA.fromIndex(1), bg: colorToRgba(backgrounds.deleted) });
			else chunks.push({ __isChunk: true, text });
		}
	}
	if (document.diagnostic !== undefined) {
		chunks.push({ __isChunk: true, text: `\n  diff ${document.diagnostic}`, attributes: TextAttributes.DIM });
	}
	return new StyledText(chunks);
}

function diffPlainText(document: SafeDiffDocument): string {
	const lines = [diffHeader(document)];
	for (const hunk of document.hunks) {
		for (const line of hunk.lines) {
			const prefix = line.kind === "add" ? "+" : line.kind === "delete" ? "-" : " ";
			lines.push(`${prefix} ${line.text.text}`);
		}
	}
	if (document.diagnostic !== undefined) lines.push(`  diff ${document.diagnostic}`);
	return lines.join("\n");
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
