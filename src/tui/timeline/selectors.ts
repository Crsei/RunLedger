/**
 * Timeline selectors：TimelineState -> 现有 PresentationBlock[]。
 *
 * 纯转换（§4.1 compatibility bridge）：row id 直接映射为稳定 block id，
 * 供 ChatContainer keyed render cache 与 OpenTUI renderable map 消费。
 */

import type { PresentationBlock, PresentationBlockMetadata } from "../presentation.ts";
import type { SafeToolUsageView } from "../presentation/tools/types.ts";
import type { TimelineRow, TimelineState } from "./types.ts";
import { diffLineNumberWidth } from "../opentui/block-layout.ts";
import {
	explorationBlockForRows,
	explorationDetailForRow,
	isExplorationRow,
} from "../presentation/tools/exploration.ts";

export type TimelineProjectionSurface = "main" | "transcript";

export interface TimelineToBlocksOptions {
	readonly includeActive?: boolean;
	/** 仅跳过 thinking block 的展示投影；TimelineRow 原始数据保持不变。 */
	readonly hideThinking?: boolean;
	/** main 仅显示探索摘要；transcript 按原始 tool call 显示有界详情。 */
	readonly surface?: TimelineProjectionSurface;
}

/** 按 committed + active（activeOrder 顺序）产出稳定 id 的 blocks。 */
export function timelineToBlocks(state: TimelineState, options: TimelineToBlocksOptions = {}): PresentationBlock[] {
	const blocks: PresentationBlock[] = [];
	const includeActive = options.includeActive ?? true;
	const surface = options.surface ?? "main";
	let rowsSinceBoundary: TimelineRow[] = [];
	let explorationRows: TimelineRow[] = [];
	let hasLoopTools = false;
	const flushExploration = (finalized: boolean): void => {
		const block = explorationBlockForRows(explorationRows, finalized);
		if (block !== undefined) blocks.push(block);
		explorationRows = [];
	};
	const appendRow = (row: TimelineRow): void => {
		// 工具观察后的下一条 assistant 消息开启新一轮；实时与回放使用相同边界。
		if (row.kind === "assistant" && hasLoopTools) {
			flushExploration(true);
			blocks.push({ id: `timeline-${row.id}/loop`, kind: "separator", label: "" });
			hasLoopTools = false;
		}
		if (row.kind === "tool") hasLoopTools = true;
		if (row.kind === "user") hasLoopTools = false;
		if (surface === "main" && isExplorationRow(row)) {
			if (explorationRows.length >= 32) flushExploration(true);
			explorationRows.push(row);
			return;
		}
		flushExploration(true);
		blocks.push(...rowToBlocks(row, options));
	};
	for (const row of state.committedRows) {
		if (row.kind === "run-boundary") {
			flushExploration(true);
			if (hasWorkActivity(rowsSinceBoundary)) {
				for (const block of rowToBlocks(row, options)) {
					blocks.push(block.kind === "separator"
						? { ...block, metrics: runtimeMetrics(rowsSinceBoundary) }
						: block);
				}
			}
			rowsSinceBoundary = [];
			hasLoopTools = false;
			continue;
		}
		rowsSinceBoundary.push(row);
		appendRow(row);
	}
	if (includeActive) {
		for (const id of state.activeOrder) {
			const row = state.activeRowsByCorrelationId[id];
			if (row !== undefined) {
				rowsSinceBoundary.push(row);
				appendRow(row);
			}
		}
	}
	// 末尾组仍可能在同一 turn 中追加新的探索动作，不能进入 settled cache。
	flushExploration(false);
	return blocks;
}

/** 单行 -> blocks；assistant 行拆 thinking + text 两个 markdown block。 */
export function rowToBlocks(row: TimelineRow, options: TimelineToBlocksOptions = {}): PresentationBlock[] {
	const baseId = `timeline-${row.id}`;
	switch (row.kind) {
		case "user":
			// runtime-origin 行不是用户输入：用独立 role 让 transcript 折叠呈现。
			return [{ id: baseId, ...partMetadata(row, `${row.id}/text`), kind: "text", role: row.origin === "runtime" ? "runtime" : "user", content: row.text.text }];
		case "assistant": {
			const blocks: PresentationBlock[] = [];
			if (options.hideThinking !== true && row.thinking !== undefined && row.thinking.text.length > 0) {
				blocks.push({
					id: `${baseId}/thinking`,
					...partMetadata(row, `${row.id}/thinking`),
					kind: "markdown",
					content: row.thinking.text,
					variant: "thinking",
					streaming: row.streaming,
				});
			}
			blocks.push({
				id: `${baseId}/text`,
				...partMetadata(row, `${row.id}/text`),
				kind: "markdown",
				content: row.text.text,
				streaming: row.streaming,
			});
			return blocks;
		}
		case "tool": {
			const presentation = row.presentation.state === "known" ? row.presentation.value : undefined;
			if (options.surface === "transcript") {
				const detail = explorationDetailForRow(row, rowFinalized(row));
				if (detail !== undefined) {
					return [{
						id: `tool-detail-${row.id}`,
						...partMetadata(row, `${row.id}/tool-detail`),
						kind: "tool-detail",
						action: detail.action,
						body: detail.body,
					}];
				}
			}
			if (options.surface !== "transcript") {
				const exploration = explorationBlockForRows([row], rowFinalized(row));
				if (exploration !== undefined) return [exploration];
			}
			if (presentation?.renderer === "plan") {
				const plan = presentation.plan;
				if (plan === undefined || (plan.steps.length === 0 && plan.explanation === undefined)) return [];
				return [{
					id: baseId,
					...partMetadata(row, `${row.id}/plan`),
					kind: "plan-update",
					explanation: plan.explanation,
					steps: plan.steps,
				}];
			}
			if (presentation?.renderer === "shell" && presentation.input?.kind === "shell") {
				const result = presentation.result?.kind === "shell" ? presentation.result : undefined;
				const output: Array<{ channel: "stdout" | "stderr"; text: string }> = result?.chunks.map((chunk) => ({
					channel: chunk.channel,
					text: chunk.safeSgrText?.text ?? chunk.text.text,
				})) ?? [];
				if (output.length === 0 && presentation.error?.text) {
					output.push({ channel: "stderr", text: presentation.error.text });
				}
				return [{
					id: baseId,
					...partMetadata(row, `${row.id}/exec`),
					kind: "exec",
					command: presentation.input.commandLabel.text,
					status: row.status,
					output,
					...(result?.exitCode.state === "known" ? { exitCode: result.exitCode.value } : {}),
					...(result?.durationMs.state === "known" ? { durationMs: result.durationMs.value } : {}),
					...(result?.background === true || presentation.input.background === true ? { background: true } : {}),
					...(presentation.exec === undefined ? {} : {
						continuationPrefix: presentation.exec.continuationPrefix,
						continuationMaxLines: presentation.exec.continuationMaxLines,
						outputPrefix: presentation.exec.outputPrefix,
						outputMaxLines: presentation.exec.outputMaxLines,
						transcriptForm: presentation.exec.transcriptForm,
					}),
				}];
			}
			const lines = toolLines(row);
			const diffBlocks = presentation?.body.flatMap((block, index): PresentationBlock[] => block.kind === "diff"
				? [{
					id: `${baseId}/diff-${index}`,
					...partMetadata(row, `${row.id}/diff-${index}`),
					kind: "diff",
					document: block.document,
					showLineNumbers: true,
					lineNumberWidth: diffDocumentLineNumberWidth(block.document),
					syntaxHighlight: true,
					...(row.status === "running" ? { streaming: true } : {}),
				}]
				: []) ?? [];
			return [{ id: baseId, ...partMetadata(row, `${row.id}/text`), kind: "text", content: lines.join("\n") }, ...diffBlocks];
		}
		case "notice": {
			const prefix = row.severity === "error" ? "error: " : row.severity === "warning" ? "warning: " : "note: ";
			return [{ id: baseId, ...partMetadata(row, `${row.id}/notice`), kind: "notice", severity: row.severity, message: `${prefix}${row.message.text}` }];
		}
		case "goal":
			return [{ id: baseId, ...partMetadata(row, `${row.id}/goal`), kind: "text", content: `goal ${row.label.text}: ${row.phase.text}` }];
		case "queue":
			return [{ id: baseId, ...partMetadata(row, `${row.id}/queue`), kind: "text", content: `queue ${row.label.text}: ${row.state}` }];
		case "agent":
			return [{ id: baseId, ...partMetadata(row, `${row.id}/agent`), kind: "text", content: `agent ${row.label.text}: ${row.phase.text}` }];
		case "run-boundary":
			return [{ id: baseId, ...partMetadata(row, `${row.id}/boundary`), kind: "separator", label: `${row.stopReason} · ${row.activeDurationMs === undefined ? "time unavailable" : `Worked for ${formatActiveDuration(row.activeDurationMs)}`}` }];
	}
}

function partMetadata(row: TimelineRow, partId: string): PresentationBlockMetadata {
	return {
		entryId: row.id,
		partId,
		contentGeneration: row.generation ?? 0,
		finalized: rowFinalized(row),
	};
}

function rowFinalized(row: TimelineRow): boolean {
	if (row.kind === "assistant") return !row.streaming;
	return row.status !== "pending" && row.status !== "running";
}

function hasWorkActivity(rows: readonly TimelineRow[]): boolean {
	return rows.some((row) => row.kind === "tool");
}

function runtimeMetrics(rows: readonly TimelineRow[]): readonly string[] {
	const toolCount = rows.filter((row) => row.kind === "tool").length;
	const totalTokens = rows.reduce((total, row) => {
		if (row.kind !== "assistant" || row.usage === undefined) return total;
		const input = quantityValue(row.usage.input);
		const output = quantityValue(row.usage.output);
		return input === undefined || output === undefined ? total : total + input + output;
	}, 0);
	const metrics: string[] = [];
	if (toolCount > 0) metrics.push(`${toolCount} tools`);
	if (totalTokens > 0) metrics.push(`${formatCompactCount(totalTokens)} tokens`);
	return metrics;
}

function quantityValue(quantity: SafeToolUsageView["input"]): number | undefined {
	return quantity.state === "exact" || quantity.state === "estimated" ? quantity.value : undefined;
}

function formatCompactCount(value: number): string {
	if (value < 1_000) return String(value);
	if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}k`;
	return `${(value / 1_000_000).toFixed(1)}m`;
}

function diffDocumentLineNumberWidth(document: import("../presentation/tools/types.ts").SafeDiffDocument): number {
	let maxLineNumber = 0;
	for (const hunk of document.hunks) {
		for (const line of hunk.lines) {
			if (line.kind !== "add") maxLineNumber = Math.max(maxLineNumber, line.oldLine);
			if (line.kind !== "delete") maxLineNumber = Math.max(maxLineNumber, line.newLine);
		}
	}
	return diffLineNumberWidth(maxLineNumber);
}

export function formatActiveDuration(durationMs: number): string {
	const seconds = Math.max(0, Math.floor(durationMs / 1_000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	if (minutes < 60) return `${minutes}m ${String(remainingSeconds).padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${String(minutes % 60).padStart(2, "0")}m ${String(remainingSeconds).padStart(2, "0")}s`;
}

function toolLines(row: Extract<TimelineRow, { readonly kind: "tool" }>): string[] {
	const lines: string[] = [];
	const presentation = row.presentation.state === "known" ? row.presentation.value : undefined;
	const title = presentation?.title.text ?? row.toolName.text;
	lines.push(`${statusIcon(row.status)} ${title}`);
	if (presentation !== undefined) {
		const input = inputLine(presentation.input);
		if (input !== undefined) lines.push(`  ${input}`);
		const chips = presentation.chips.map((chip) => chip.label.text).filter((text) => text.length > 0 && !["pending", "running", "ok", "error", "shell"].includes(text));
		if (chips.length > 0) lines.push(`  ${chips.join("  ")}`);
		if (presentation.body.some((block) => block.kind === "text" && block.content.text.length > 0)
			|| presentation.result?.kind === "shell" || presentation.error !== undefined) lines.push("");
		for (const block of presentation.body) {
			if (block.kind === "text" && block.content.text.length > 0) lines.push(`  ${block.content.text}`);
		}
		if (presentation.result?.kind === "shell") {
			for (const channel of ["stdout", "stderr"] as const) {
				const chunks = presentation.result.chunks.filter((chunk) => chunk.channel === channel);
				if (chunks.length === 0) continue;
				lines.push(`  ${channel}:`);
				for (const chunk of chunks) lines.push(`    ${chunk.text.text}`);
			}
			if (presentation.result.truncated) lines.push("  … output tail truncated");
		}
		if (presentation.error !== undefined) lines.push(`  error: ${presentation.error.text}`);
	}
	return lines;
}

function statusIcon(status: Extract<TimelineRow, { readonly kind: "tool" }>["status"]): string {
	switch (status) {
		case "unknown": return "? Outcome unknown ·";
		case "pending": return "⏳";
		case "running": return "…";
		case "succeeded": return "✓";
		case "failed":
		case "cancelled":
		case "aborted": return "✗";
	}
}

function inputLine(input: import("../presentation/tools/types.ts").SafeToolInputMetadata | undefined): string | undefined {
	if (input === undefined || input.kind === "generic") return undefined;
	if (input.kind === "shell") return `$ ${input.background === true ? "(bg) " : ""}${input.commandLabel.text}`;
	if (input.kind === "edit") return `${input.path.text} · ${knownCount(input.editCount)} edit`;
	if (input.kind === "write") return `${input.path.text} · ${knownCount(input.lineCount)} lines · ${knownCount(input.byteCount)} bytes`;
	if (input.kind === "read") return input.path.text;
	if (input.kind === "websearch") return input.query.text;
	return input.path.text;
}

function knownCount(count: import("../presentation/tools/types.ts").SafeCount): string {
	return count.state === "known" ? String(count.value) : "?";
}
