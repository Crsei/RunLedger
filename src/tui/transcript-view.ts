import type { NoticeBlock, PresentationBlock } from "./presentation.ts";
import type { TimelineRow, TimelineState } from "./timeline/types.ts";
import { rowToBlocks, timelineToBlocks } from "./timeline/selectors.ts";
import { diffDisplayLines, type DiffBlock } from "./opentui/diff-renderable.ts";
import { execTranscriptLines, type ExecDisplayBlock } from "./opentui/exec-renderable.ts";
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

interface CommittedTranscriptProjection {
	readonly blocks: readonly PresentationBlock[];
	readonly revision: string;
}

const committedProjectionCache = new WeakMap<readonly TimelineRow[], CommittedTranscriptProjection>();
const rowRevisionIds = new WeakMap<TimelineRow, number>();
let nextProjectionRevision = 1;

/** Timeline -> 只读转写 view；不读取 session/ledger，也不改变主 ScrollBox。 */
export function projectTranscriptOverlay(state: TimelineState): TranscriptOverlayView {
	let committed = committedProjectionCache.get(state.committedRows);
	if (committed === undefined) {
		committed = {
			blocks: timelineToBlocks(state, { includeActive: false }),
			revision: `committed-${nextProjectionRevision}`,
		};
		nextProjectionRevision += 1;
		committedProjectionCache.set(state.committedRows, committed);
	}
	const activeRows = state.activeOrder
		.map((id) => state.activeRowsByCorrelationId[id])
		.filter((row): row is TimelineRow => row !== undefined);
	const liveTail = activeRows.flatMap((row) => rowToBlocks(row));
	return {
		rows: committed.blocks,
		...(liveTail.length > 0 ? { liveTail } : {}),
		timelineGeneration: state.generation,
		committedRevision: committed.revision,
		activeRevision: activeRows.map(rowRevisionId).join(","),
	};
}

/** 把一个安全 PresentationBlock 投影成转写视图中的原始可复制行。 */
export function transcriptBlockLines(block: PresentationBlock, width = 80): readonly string[] {
	if (block.kind === "exec" || block.kind === "command") {
		const transcriptBlock = block.kind === "exec"
			? { ...block, outputMaxLines: Math.max(block.outputMaxLines ?? 0, TRANSCRIPT_OUTPUT_MAX_LINES) }
			: block;
		return execTranscriptLines(transcriptBlock as ExecDisplayBlock, width);
	}
	if (block.kind === "plan-update") {
		return [
			"Updated Plan",
			...(block.explanation?.text.length ? [`Explanation: ${block.explanation.text}`] : []),
			...block.steps.map((step) => `${planStatusLabel(step.status)}: ${step.text.text}`),
		];
	}
	if (block.kind === "diff") return diffDisplayLines(block as DiffBlock, width);
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
	private readonly committedLineCache = new Map<string, readonly string[]>();
	private readonly activeLineCache = new Map<string, readonly string[]>();

	constructor(view: TranscriptOverlayView, options: TranscriptOverlayOptions = {}) {
		this.view = view;
		this.onClose = options.onClose;
		this.getViewportHeight = options.getViewportHeight ?? (() => 24);
		this.maxBlocks = Math.max(1, Math.floor(options.maxBlocks ?? TRANSCRIPT_MAX_BLOCKS));
	}

	update(view: TranscriptOverlayView): void {
		if (sameViewRevision(this.view, view)) return;
		if (this.view.committedRevision !== view.committedRevision) this.committedLineCache.clear();
		if (this.view.activeRevision !== view.activeRevision) this.activeLineCache.clear();
		this.view = view;
		this.version += 1;
	}

	getPresentationVersion(): number {
		return this.version;
	}

	invalidate(): void {
		this.committedLineCache.clear();
		this.activeLineCache.clear();
		this.version += 1;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "ctrl+t")) {
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
		const active = this.view.liveTail ?? [];
		return boundedBlockSegments(this.view.rows, active, this.maxBlocks).flatMap((segment) => {
			if (segment.source === "marker") return wrapTranscriptLine("… (truncated)", width);
			const cache = segment.source === "committed" ? this.committedLineCache : this.activeLineCache;
			const key = `${width}:${segment.start}:${segment.end}`;
			const cached = cache.get(key);
			if (cached !== undefined) return cached;
			const source = segment.source === "committed" ? this.view.rows : active;
			const lines = source.slice(segment.start, segment.end)
				.flatMap((block) => transcriptBlockLines(block, width))
				.flatMap((line) => wrapTranscriptLine(line, width));
			cache.set(key, lines);
			return lines;
		});
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

function rowRevisionId(row: TimelineRow): number {
	const existing = rowRevisionIds.get(row);
	if (existing !== undefined) return existing;
	const revision = nextProjectionRevision;
	nextProjectionRevision += 1;
	rowRevisionIds.set(row, revision);
	return revision;
}

function sameViewRevision(left: TranscriptOverlayView, right: TranscriptOverlayView): boolean {
	return left.committedRevision === right.committedRevision
		&& left.activeRevision === right.activeRevision;
}

interface TranscriptBlockSegment {
	readonly source: "committed" | "active" | "marker";
	readonly start: number;
	readonly end: number;
}

function boundedBlockSegments(committed: readonly PresentationBlock[], active: readonly PresentationBlock[], maxBlocks: number): readonly TranscriptBlockSegment[] {
	const total = committed.length + active.length;
	if (total <= maxBlocks) {
		return [
			...(committed.length === 0 ? [] : [{ source: "committed" as const, start: 0, end: committed.length }]),
			...(active.length === 0 ? [] : [{ source: "active" as const, start: 0, end: active.length }]),
		];
	}
	const head = Math.max(0, Math.floor((maxBlocks - 1) / 2));
	const tail = Math.max(0, maxBlocks - head - 1);
	return [
		...combinedRangeSegments(committed.length, active.length, 0, head),
		{ source: "marker", start: 0, end: 1 },
		...combinedRangeSegments(committed.length, active.length, total - tail, total),
	];
}

function combinedRangeSegments(committedCount: number, activeCount: number, start: number, end: number): TranscriptBlockSegment[] {
	const total = committedCount + activeCount;
	const boundedStart = Math.max(0, Math.min(total, start));
	const boundedEnd = Math.max(boundedStart, Math.min(total, end));
	const committedStart = Math.min(committedCount, boundedStart);
	const committedEnd = Math.min(committedCount, boundedEnd);
	const activeStart = Math.max(0, boundedStart - committedCount);
	const activeEnd = Math.max(0, boundedEnd - committedCount);
	return [
		...(committedEnd > committedStart ? [{ source: "committed" as const, start: committedStart, end: committedEnd }] : []),
		...(activeEnd > activeStart ? [{ source: "active" as const, start: activeStart, end: activeEnd }] : []),
	];
}

function wrapTranscriptLine(line: string, width: number): readonly string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	if (displayWidth(line) <= safeWidth) return [line];
	return wrapDisplayWidth(line, safeWidth, Math.max(1, graphemes(line).length + 1));
}
