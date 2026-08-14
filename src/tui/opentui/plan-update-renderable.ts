import { RGBA, StyledText, TextAttributes, TextRenderable, type RenderContext, type TextChunk, type TextOptions } from "@opentui/core";
import { displayWidth, graphemes, wrapDisplayWidth } from "../mermaid/display-width.ts";
import {
	PLAN_STEP_CONTINUATION_INDENT,
	PLAN_STEP_PREFIX,
	planWrapWidth,
} from "./block-layout.ts";
import type { PlanStepStatus, PlanUpdateBlock } from "../presentation.ts";

export type PlanUpdateRenderableOptions = Omit<TextOptions, "content"> & {
	readonly block: PlanUpdateBlock;
};

export class PlanUpdateRenderable extends TextRenderable {
	private block: PlanUpdateBlock;
	private projectedWidth = 0;

	constructor(ctx: RenderContext, options: PlanUpdateRenderableOptions) {
		const { block, ...renderableOptions } = options;
		const externalOnSizeChange = renderableOptions.onSizeChange;
		super(ctx, {
			...renderableOptions,
			onSizeChange: undefined,
			content: new StyledText([]),
			selectable: true,
			wrapMode: "none",
		});
		this.block = block;
		this.onSizeChange = () => {
			this.updateForMeasuredWidth();
			externalOnSizeChange?.call(this);
		};
		this.updateForMeasuredWidth();
	}

	protected override onResize(width: number, height: number): void {
		super.onResize(width, height);
		this.onSizeChange?.();
	}

	updateBlock(block: PlanUpdateBlock): void {
		this.block = block;
		this.projectedWidth = 0;
		this.updateForMeasuredWidth();
		this.requestRender();
	}

	private updateForMeasuredWidth(): void {
		const width = Math.max(1, Math.floor(this.width || 80));
		if (width === this.projectedWidth && this.content.chunks.length > 0) return;
		this.projectedWidth = width;
		this.content = styledPlanText(this.block, width);
		this.height = Math.max(1, this.plainText.split("\n").length);
	}
}

export function planUpdatePlainText(block: PlanUpdateBlock): string {
	const lines = ["• Updated Plan"];
	if (block.explanation?.text.length) lines.push(`${PLAN_STEP_PREFIX}${block.explanation.text}`);
	for (const step of block.steps) lines.push(`${PLAN_STEP_PREFIX}${statusGlyph(step.status)} ${step.text.text}`);
	return lines.join("\n");
}

function styledPlanText(block: PlanUpdateBlock, width: number): StyledText {
	const chunks: TextChunk[] = [];
	appendChunk(chunks, "• Updated Plan", undefined, TextAttributes.BOLD);
	if (block.explanation?.text.length) {
		appendWrapped(chunks, block.explanation.text, width, (line, first) => ({
			prefix: first ? PLAN_STEP_PREFIX : PLAN_STEP_CONTINUATION_INDENT,
			text: line,
			attributes: TextAttributes.DIM | TextAttributes.ITALIC,
		}));
	}
	for (const step of block.steps) {
		const style = stepStyle(step.status);
		appendWrapped(chunks, `${statusGlyph(step.status)} ${step.text.text}`, width, (line, first) => ({
			prefix: first ? PLAN_STEP_PREFIX : PLAN_STEP_CONTINUATION_INDENT,
			text: line,
			fg: style.fg,
			attributes: style.attributes,
		}));
	}
	return new StyledText(chunks);
}

function appendWrapped(
	chunks: TextChunk[],
	text: string,
	width: number,
	style: (line: string, first: boolean) => { readonly prefix: string; readonly text: string; readonly fg?: RGBA; readonly attributes?: number },
): void {
	const lines = wrapDisplayWidth(text, planWrapWidth(width), Math.max(1, graphemes(text).length + 1));
	for (const [index, line] of lines.entries()) {
		chunks.push({ __isChunk: true, text: "\n" });
		const styled = style(line, index === 0);
		appendChunk(chunks, `${styled.prefix}${styled.text}`, styled.fg, styled.attributes);
	}
}

function appendChunk(chunks: TextChunk[], text: string, fg?: RGBA, attributes?: number): void {
	chunks.push({
		__isChunk: true,
		text,
		...(fg === undefined ? {} : { fg }),
		...(attributes === undefined ? {} : { attributes }),
	});
}

function statusGlyph(status: PlanStepStatus): string {
	return status === "completed" ? "✔" : "□";
}

function stepStyle(status: PlanStepStatus): { readonly fg?: RGBA; readonly attributes: number } {
	if (status === "completed") return { fg: RGBA.fromIndex(2), attributes: TextAttributes.DIM | TextAttributes.STRIKETHROUGH };
	if (status === "in-progress") return { fg: RGBA.fromIndex(6), attributes: TextAttributes.BOLD };
	return { attributes: TextAttributes.DIM };
}

export function planLineWidth(value: string): number {
	return displayWidth(value);
}
