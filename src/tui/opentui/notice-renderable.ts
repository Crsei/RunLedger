import { StyledText, TextAttributes, TextRenderable, type RGBA, type RenderContext, type TextChunk, type TextOptions } from "@opentui/core";
import { displayWidth, graphemes, wrapDisplayWidth } from "../mermaid/display-width.ts";
import type { HighlightColor } from "../highlight/contracts.ts";
import type { SyntaxHighlightService } from "../highlight/service.ts";
import { highlightColorToRgba } from "../highlight/status-style.ts";
import type { SyntaxThemeController } from "../highlight/theme-controller.ts";
import type { NoticeBlock, NoticeSeverity } from "../presentation.ts";
import { NOTICE_CONTINUATION_INDENT, NOTICE_WARN_PREFIX } from "./block-layout.ts";

export type NoticeRenderableOptions = Omit<TextOptions, "content"> & {
	readonly block: NoticeBlock;
	readonly highlightService: SyntaxHighlightService;
	readonly themeController: SyntaxThemeController;
};

export class NoticeRenderable extends TextRenderable {
	private block: NoticeBlock;
	private readonly highlightService: SyntaxHighlightService;
	private readonly themeController: SyntaxThemeController;
	private projectedWidth = 0;
	private readonly unsubscribeTheme: () => void;

	constructor(ctx: RenderContext, options: NoticeRenderableOptions) {
		const { block, highlightService, themeController, ...renderableOptions } = options;
		super(ctx, {
			...renderableOptions,
			content: new StyledText([]),
			selectable: true,
			wrapMode: "none",
		});
		this.block = block;
		this.highlightService = highlightService;
		this.themeController = themeController;
		this.unsubscribeTheme = themeController.subscribe(() => this.updateForMeasuredWidth());
		this.updateForMeasuredWidth();
	}

	protected override onResize(width: number, height: number): void {
		super.onResize(width, height);
		this.updateForMeasuredWidth();
	}

	updateBlock(block: NoticeBlock): void {
		this.block = block;
		this.projectedWidth = 0;
		this.updateForMeasuredWidth();
		this.requestRender();
	}

	override destroy(): void {
		if (this.isDestroyed) return;
		this.unsubscribeTheme();
		super.destroy();
	}

	private updateForMeasuredWidth(): void {
		const width = Math.max(1, Math.floor(this.width || 80));
		if (width === this.projectedWidth && this.content.chunks.length > 0) return;
		this.projectedWidth = width;
		this.content = styledNoticeText(this.block, width, this.highlightService, this.themeController);
		this.height = Math.max(1, this.plainText.split("\n").length);
	}
}

export function noticePlainText(block: NoticeBlock, width = 80): string {
	return noticeDisplayLines(block.message, width).join("\n");
}

export function noticeDisplayLines(message: string, width = 80): readonly string[] {
	const safeWidth = Math.max(1, Math.floor(Number.isFinite(width) ? width : 80));
	const contentWidth = Math.max(1, safeWidth - displayWidth(NOTICE_WARN_PREFIX));
	const lines: string[] = [];
	for (const logicalLine of message.replace(/\r\n?/gu, "\n").split("\n")) {
		const wrapped = wrapDisplayWidth(logicalLine, contentWidth, Math.max(1, graphemes(logicalLine).length + 1));
		for (const line of wrapped.length === 0 ? [""] : wrapped) {
			lines.push(`${lines.length === 0 ? NOTICE_WARN_PREFIX : NOTICE_CONTINUATION_INDENT}${line}`);
		}
	}
	return lines.length === 0 ? [NOTICE_WARN_PREFIX] : lines;
}

function styledNoticeText(
	block: NoticeBlock,
	width: number,
	service: SyntaxHighlightService,
	themeController: SyntaxThemeController,
): StyledText {
	const chunks: TextChunk[] = [];
	const messageColor = highlightColorToRgba(service.foregroundForScopes(
		themeController.snapshot().activeName,
		noticeScopes(block.severity),
	) ?? fallbackColor(block.severity));
	const contentWidth = Math.max(1, Math.floor(width) - displayWidth(NOTICE_WARN_PREFIX));
	let first = true;
	for (const logicalLine of block.message.replace(/\r\n?/gu, "\n").split("\n")) {
		const wrapped = wrapDisplayWidth(logicalLine, contentWidth, Math.max(1, graphemes(logicalLine).length + 1));
		for (const line of wrapped.length === 0 ? [""] : wrapped) {
			if (chunks.length > 0) chunks.push({ __isChunk: true, text: "\n" });
			appendChunk(chunks, first ? NOTICE_WARN_PREFIX : NOTICE_CONTINUATION_INDENT, first ? highlightColorToRgba({ kind: "indexed", index: 3 }) : undefined, TextAttributes.DIM);
			appendChunk(chunks, line, messageColor);
			first = false;
		}
	}
	if (chunks.length === 0) appendChunk(chunks, NOTICE_WARN_PREFIX, highlightColorToRgba({ kind: "indexed", index: 3 }), TextAttributes.DIM);
	return new StyledText(chunks);
}

function noticeScopes(severity: NoticeSeverity): readonly string[] {
	if (severity === "error") return ["invalid", "markup.deleted", "error"];
	if (severity === "warning") return ["markup.warning", "warning", "keyword.warning"];
	return ["comment", "markup.heading", "info"];
}

function fallbackColor(severity: NoticeSeverity): HighlightColor {
	if (severity === "error") return { kind: "indexed", index: 1 };
	if (severity === "warning") return { kind: "indexed", index: 3 };
	return { kind: "indexed", index: 6 };
}

function appendChunk(chunks: TextChunk[], text: string, fg?: RGBA, attributes?: number): void {
	chunks.push({
		__isChunk: true,
		text,
		...(fg === undefined ? {} : { fg }),
		...(attributes === undefined ? {} : { attributes }),
	});
}
