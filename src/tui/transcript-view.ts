import type { NoticeBlock, PresentationBlock } from "./presentation.ts";
import type { TimelineRow, TimelineState } from "./timeline/types.ts";
import { rowToBlocks } from "./timeline/selectors.ts";
import { diffDisplayLines, type DiffBlock } from "./opentui/diff-renderable.ts";
import { execDisplayLines, type ExecDisplayBlock } from "./opentui/exec-renderable.ts";
import { noticeDisplayLines } from "./opentui/notice-renderable.ts";
import { formatSeparatorLabel } from "./opentui/block-layout.ts";
import { displayWidth, graphemes, truncateDisplayWidth, wrapDisplayWidth } from "./mermaid/display-width.ts";
import { matchesKey, type Component } from "./primitives.ts";

/** 转写视图最多投影的块数量；超出只影响 overlay，不改变 Timeline。 */
export const TRANSCRIPT_MAX_BLOCKS = 10_000;
/** shell projector 按 stdout/stderr 各保留 100 行；转写视图最多展开两路保留量。 */
export const TRANSCRIPT_OUTPUT_MAX_LINES = 200;

export interface TranscriptOverlayView {
	/** 已提交 rows 的安全 transcript 投影。 */
	readonly rows: readonly PresentationBlock[];
	/** 活跃 cell 的尾部投影，保持与 committed rows 分离以便缓存失效。 */
	readonly liveTail?: readonly PresentationBlock[];
	readonly timelineGeneration: number;
	readonly committedRevision: string;
	readonly activeRevision: string;
}

export interface TranscriptOverlayOptions {
	readonly onClose?: () => void;
	readonly getViewportHeight?: () => number;
	readonly maxBlocks?: number;
}

/** Timeline -> 只读转写 view；不读取 session/ledger，也不改变主 ScrollBox。 */
export function projectTranscriptOverlay(state: TimelineState): TranscriptOverlayView {
	const rows = state.committedRows.flatMap((row) => rowToBlocks(row));
	const activeRows = state.activeOrder
		.map((id) => state.activeRowsByCorrelationId[id])
		.filter((row): row is TimelineRow => row !== undefined);
	const liveTail = activeRows.flatMap((row) => rowToBlocks(row));
	return {
		rows,
		...(liveTail.length > 0 ? { liveTail } : {}),
		timelineGeneration: state.generation,
		committedRevision: rowsRevision(state.committedRows),
		activeRevision: rowsRevision(activeRows),
	};
}

/** 把一个安全 PresentationBlock 投影成转写视图中的原始可复制行。 */
export function transcriptBlockLines(block: PresentationBlock, width = 80): readonly string[] {
	if (block.kind === "exec" || block.kind === "command") {
		const transcriptBlock = block.kind === "exec"
			? { ...block, outputMaxLines: Math.max(block.outputMaxLines ?? 0, TRANSCRIPT_OUTPUT_MAX_LINES) }
			: block;
		return execDisplayLines(transcriptBlock as ExecDisplayBlock, width);
	}
	if (block.kind === "plan-update") {
		return [
			"Updated Plan",
			...(block.explanation?.text.length ? [`Explanation: ${block.explanation.text}`] : []),
			...block.steps.map((step) => `${planStatusLabel(step.status)}: ${step.text.text}`),
		];
	}
	if (block.kind === "diff") return diffDisplayLines(block as DiffBlock);
	if (block.kind === "notice") return noticeDisplayLines((block as NoticeBlock).message, width);
	if (block.kind === "separator") return [block.content ?? formatSeparatorLabel(block.label, block.metrics)];
	if (block.kind === "status-line") return [block.segments.map((segment) => segment.text).join(" · ")];
	if (block.kind === "select") return [block.title, ...block.options.map((option) => option.label)];
	if (block.kind === "input") return [block.title, block.message, block.value];
	if (block.kind === "text" || block.kind === "markdown") return block.content.split("\n");
	return [];
}

/** 只读 pager：只消费键盘，不把任何输入写回 composer。 */
export class TranscriptOverlayComponent implements Component {
	private view: TranscriptOverlayView;
	private readonly onClose?: () => void;
	private readonly getViewportHeight: () => number;
	private readonly maxBlocks: number;
	private offset = 0;
	private version = 0;
	private cachedKey: string | undefined;
	private cachedLines: readonly string[] | undefined;

	constructor(view: TranscriptOverlayView, options: TranscriptOverlayOptions = {}) {
		this.view = view;
		this.onClose = options.onClose;
		this.getViewportHeight = options.getViewportHeight ?? (() => 24);
		this.maxBlocks = Math.max(1, Math.floor(options.maxBlocks ?? TRANSCRIPT_MAX_BLOCKS));
	}

	update(view: TranscriptOverlayView): void {
		if (sameViewRevision(this.view, view)) return;
		this.view = view;
		this.cachedKey = undefined;
		this.cachedLines = undefined;
		this.version += 1;
	}

	getPresentationVersion(): number {
		return this.version;
	}

	invalidate(): void {
		this.cachedKey = undefined;
		this.cachedLines = undefined;
		this.version += 1;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose?.();
			return;
		}
		if (matchesKey(data, "j") || matchesKey(data, "down")) {
			this.moveBy(1);
			return;
		}
		if (matchesKey(data, "k") || matchesKey(data, "up")) {
			this.moveBy(-1);
			return;
		}
		if (matchesKey(data, "pageDown")) {
			this.moveBy(this.pageSize());
			return;
		}
		if (matchesKey(data, "pageUp")) {
			this.moveBy(-this.pageSize());
			return;
		}
		if (data === "g") {
			this.setOffset(0);
			return;
		}
		if (data === "G" || data === "shift+g") this.setOffset(Number.MAX_SAFE_INTEGER);
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		const contentWidth = Math.max(1, safeWidth);
		const allLines = this.linesForWidth(contentWidth);
		const pageSize = this.pageSize();
		const maxOffset = Math.max(0, allLines.length - pageSize);
		const start = Math.min(this.offset, maxOffset);
		this.offset = start;
		const end = Math.min(allLines.length, start + pageSize);
		const range = allLines.length === 0 ? "empty" : `${start + 1}-${end}/${allLines.length}`;
		const header = truncateDisplayWidth(`Transcript ${range} · j/k move · PgUp/PgDn page · Esc close`, safeWidth, true);
		const footer = truncateDisplayWidth("Read-only transcript · Ctrl+T close", safeWidth, true);
		return [header, ...allLines.slice(start, end), footer];
	}

	private linesForWidth(width: number): readonly string[] {
		const key = `${this.view.timelineGeneration}\u0000${this.view.committedRevision}\u0000${this.view.activeRevision}\u0000${width}`;
		if (this.cachedKey === key && this.cachedLines !== undefined) return this.cachedLines;
		const blocks = boundedBlocks([
			...this.view.rows,
			...(this.view.liveTail ?? []),
		], this.maxBlocks);
		const lines = blocks.flatMap((block) => transcriptBlockLines(block, width))
			.flatMap((line) => wrapTranscriptLine(line, width));
		this.cachedKey = key;
		this.cachedLines = lines;
		return lines;
	}

	private pageSize(): number {
		return Math.max(1, Math.floor(this.getViewportHeight()) - 2);
	}

	private moveBy(delta: number): void {
		this.setOffset(this.offset + delta);
	}

	private setOffset(offset: number): void {
		this.offset = Math.max(0, Number.isFinite(offset) ? Math.floor(offset) : 0);
		this.version += 1;
	}
}

function planStatusLabel(status: "pending" | "in-progress" | "completed"): string {
	if (status === "completed") return "Completed";
	if (status === "in-progress") return "InProgress";
	return "Pending";
}

function rowsRevision(rows: readonly TimelineRow[]): string {
	return rows.map((row) => `${row.id}\u0000${row.status}\u0000${JSON.stringify(row) ?? ""}`).join("\u0001");
}

function sameViewRevision(left: TranscriptOverlayView, right: TranscriptOverlayView): boolean {
	return left.timelineGeneration === right.timelineGeneration
		&& left.committedRevision === right.committedRevision
		&& left.activeRevision === right.activeRevision;
}

function boundedBlocks(blocks: readonly PresentationBlock[], maxBlocks: number): readonly PresentationBlock[] {
	if (blocks.length <= maxBlocks) return blocks;
	const marker: PresentationBlock = { kind: "text", content: "… (truncated)" };
	const head = Math.max(0, Math.floor((maxBlocks - 1) / 2));
	const tail = Math.max(0, maxBlocks - head - 1);
	return [...blocks.slice(0, head), marker, ...blocks.slice(blocks.length - tail)];
}

function wrapTranscriptLine(line: string, width: number): readonly string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	if (displayWidth(line) <= safeWidth) return [line];
	return wrapDisplayWidth(line, safeWidth, Math.max(1, graphemes(line).length + 1));
}
