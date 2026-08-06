/**
 * Timeline selectors：TimelineState -> 现有 PresentationBlock[]。
 *
 * 纯转换（§4.1 compatibility bridge）：row id 直接映射为稳定 block id，
 * 供 ChatContainer keyed render cache 与 OpenTUI renderable map 消费。
 */

import type { PresentationBlock } from "../presentation.ts";
import type { TimelineRow, TimelineState } from "./types.ts";

export interface TimelineToBlocksOptions {
	readonly includeActive?: boolean;
}

/** 按 committed + active（activeOrder 顺序）产出稳定 id 的 blocks。 */
export function timelineToBlocks(state: TimelineState, options: TimelineToBlocksOptions = {}): PresentationBlock[] {
	const blocks: PresentationBlock[] = [];
	const includeActive = options.includeActive ?? true;
	for (const row of state.committedRows) {
		blocks.push(...rowToBlocks(row));
	}
	if (includeActive) {
		for (const id of state.activeOrder) {
			const row = state.activeRowsByCorrelationId[id];
			if (row !== undefined) blocks.push(...rowToBlocks(row));
		}
	}
	return blocks;
}

/** 单行 -> blocks；assistant 行拆 thinking + text 两个 markdown block。 */
export function rowToBlocks(row: TimelineRow): PresentationBlock[] {
	const baseId = `timeline-${row.id}`;
	switch (row.kind) {
		case "user":
			return [{ id: baseId, kind: "text", content: row.text.text }];
		case "assistant": {
			const blocks: PresentationBlock[] = [];
			if (row.thinking !== undefined && row.thinking.text.length > 0) {
				blocks.push({ id: `${baseId}/thinking`, kind: "markdown", content: row.thinking.text, streaming: row.streaming });
			}
			blocks.push({ id: `${baseId}/text`, kind: "markdown", content: row.text.text, streaming: row.streaming });
			return blocks;
		}
		case "tool": {
			const lines = toolLines(row);
			return [{ id: baseId, kind: "text", content: lines.join("\n") }];
		}
		case "notice": {
			const prefix = row.severity === "error" ? "error: " : row.severity === "warning" ? "warning: " : "note: ";
			return [{ id: baseId, kind: "text", content: `${prefix}${row.message.text}` }];
		}
		case "goal":
			return [{ id: baseId, kind: "text", content: `goal ${row.label.text}: ${row.phase.text}` }];
		case "queue":
			return [{ id: baseId, kind: "text", content: `queue ${row.label.text}: ${row.state}` }];
		case "agent":
			return [{ id: baseId, kind: "text", content: `agent ${row.label.text}: ${row.phase.text}` }];
	}
}

function toolLines(row: Extract<TimelineRow, { readonly kind: "tool" }>): string[] {
	const lines: string[] = [];
	const presentation = row.presentation.state === "known" ? row.presentation.value : undefined;
	const title = presentation?.title.text ?? row.toolName.text;
	const status = row.status;
	lines.push(`${title} · ${status}`);
	if (presentation !== undefined) {
		const chips = presentation.chips.map((chip) => chip.label.text).filter((text) => text.length > 0);
		if (chips.length > 0) lines.push(`  ${chips.join("  ")}`);
		for (const block of presentation.body) {
			if (block.kind === "text" && block.content.text.length > 0) lines.push(`  ${block.content.text}`);
		}
		if (presentation.error !== undefined) lines.push(`  error: ${presentation.error.text}`);
	}
	return lines;
}
