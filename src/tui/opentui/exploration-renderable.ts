import { StyledText, TextAttributes, TextRenderable, type RenderContext, type TextChunk, type TextOptions } from "@opentui/core";
import { displayWidth, graphemes, wrapDisplayWidth } from "../mermaid/display-width.ts";
import type { ExplorationActionView, ExplorationBlock } from "../presentation.ts";

export type ExplorationRenderableOptions = Omit<TextOptions, "content"> & {
	readonly block: ExplorationBlock;
};

/** 只渲染 main surface 摘要，绝不接收或创建工具正文 child。 */
export class ExplorationRenderable extends TextRenderable {
	private block: ExplorationBlock;
	private projectedWidth = 0;

	constructor(ctx: RenderContext, options: ExplorationRenderableOptions) {
		const { block, ...renderableOptions } = options;
		super(ctx, {
			...renderableOptions,
			content: new StyledText([]),
			selectable: true,
			wrapMode: "none",
		});
		this.block = block;
		this.updateForMeasuredWidth();
	}

	protected override onResize(width: number, height: number): void {
		super.onResize(width, height);
		this.updateForMeasuredWidth();
	}

	updateBlock(block: ExplorationBlock): void {
		this.block = block;
		this.projectedWidth = 0;
		this.updateForMeasuredWidth();
		this.requestRender();
	}

	private updateForMeasuredWidth(): void {
		const width = Math.max(1, Math.floor(this.width || 80));
		if (width === this.projectedWidth && this.content.chunks.length > 0) return;
		this.projectedWidth = width;
		this.content = styledExplorationText(this.block, width);
		this.height = Math.max(1, this.plainText.split("\n").length);
	}
}

export function explorationPlainText(block: ExplorationBlock, width = 80): string {
	return explorationDisplayLines(block, width).join("\n");
}

export function explorationDisplayLines(block: ExplorationBlock, width = 80): readonly string[] {
	const safeWidth = Math.max(1, Math.floor(Number.isFinite(width) ? width : 80));
	const actionLines = coalescedActionLines(block.actions).flatMap((line) => wrapActionLine(line, safeWidth));
	const budgeted = budgetActionLines(actionLines, block.actions.length);
	return [headerForState(block.state), ...budgeted];
}

function styledExplorationText(block: ExplorationBlock, width: number): StyledText {
	const lines = explorationDisplayLines(block, width);
	const chunks: TextChunk[] = [];
	for (const [index, line] of lines.entries()) {
		if (index > 0) chunks.push({ __isChunk: true, text: "\n" });
		const header = index === 0;
		const error = block.state === "completed-with-errors" && line.includes("failed");
		chunks.push({
			__isChunk: true,
			text: line,
			...(header ? { attributes: TextAttributes.BOLD } : error ? { attributes: TextAttributes.DIM } : {}),
		});
	}
	return new StyledText(chunks);
}

interface ActionLine {
	readonly text: string;
	readonly actionCount: number;
	/** 同一逻辑动作的所有换行片段共享 key，省略数按动作而非屏幕行计算。 */
	readonly actionKey: number;
}

function coalescedActionLines(actions: readonly ExplorationActionView[]): readonly ActionLine[] {
	const lines: ActionLine[] = [];
	for (let index = 0, actionKey = 0; index < actions.length; actionKey += 1) {
		const action = actions[index]!;
		if (action.kind !== "read") {
			lines.push({ text: actionLine(action), actionCount: 1, actionKey });
			index += 1;
			continue;
		}
		const reads: ExplorationActionView[] = [];
		while (index < actions.length && actions[index]!.kind === "read") {
			reads.push(actions[index]!);
			index += 1;
		}
		lines.push({ text: readLine(reads), actionCount: reads.length, actionKey });
	}
	return lines;
}

function readLine(actions: readonly ExplorationActionView[]): string {
	const counts = new Map<string, number>();
	for (const action of actions) counts.set(action.target.text, (counts.get(action.target.text) ?? 0) + 1);
	const paths = [...counts.entries()].map(([path, count]) => count > 1 ? `${path} ×${count}` : path);
	const suffix = actions.some((action) => action.status !== "succeeded") ? " · failed" : "";
	return `Read ${paths.join(", ")}${suffix}`;
}

function actionLine(action: ExplorationActionView): string {
	const status = action.status === "succeeded" || action.status === "pending" || action.status === "running" ? "" : " · failed";
	const count = action.result?.resultCount.state === "known"
		? ` · ${action.result.resultCount.value} ${action.result.resultUnit}`
		: "";
	if (action.kind === "search") return `Search "${action.query?.text ?? ""}" in ${action.target.text}${count}${status}`;
	return `List ${action.query?.text ?? action.target.text}${action.query === undefined ? "" : ` in ${action.target.text}`}${count}${status}`;
}

function wrapActionLine(line: ActionLine, width: number): readonly ActionLine[] {
	const prefix = "  └ ";
	const continuation = "    ";
	const contentWidth = Math.max(1, width - displayWidth(prefix));
	const wrapped = wrapDisplayWidth(line.text, contentWidth, Math.max(1, graphemes(line.text).length + 1));
	return wrapped.map((part, index) => ({
		text: `${index === 0 ? prefix : continuation}${part}`,
		actionCount: line.actionCount,
		actionKey: line.actionKey,
	}));
}

function budgetActionLines(lines: readonly ActionLine[], actionCount: number): readonly string[] {
	const maxLines = 5;
	if (lines.length <= maxLines) return lines.map((line) => line.text);
	const head = lines.slice(0, 2);
	const tail = lines.slice(-2);
	const visibleByAction = new Map<number, number>();
	for (const line of [...head, ...tail]) visibleByAction.set(line.actionKey, line.actionCount);
	const omitted = actionCount - [...visibleByAction.values()].reduce((total, count) => total + count, 0);
	const marker = omitted > 0
		? `  └ … +${omitted} actions (Ctrl+T for transcript)`
		: "  └ … action text truncated (Ctrl+T for transcript)";
	return [...head.map((line) => line.text), marker, ...tail.map((line) => line.text)];
}

function headerForState(state: ExplorationBlock["state"]): string {
	if (state === "active") return "• Exploring";
	if (state === "completed-with-errors") return "• Explored with errors";
	return "• Explored";
}
