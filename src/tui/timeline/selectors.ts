/**
 * Timeline selectors：TimelineState -> 现有 PresentationBlock[]。
 *
 * 纯转换（§4.1 compatibility bridge）：row id 直接映射为稳定 block id，
 * 供 ChatContainer keyed render cache 与 OpenTUI renderable map 消费。
 */

import type { PresentationBlock } from "../presentation.ts";
import type { TimelineRow, TimelineState } from "./types.ts";
import { diffLineNumberWidth } from "../opentui/block-layout.ts";

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
			const presentation = row.presentation.state === "known" ? row.presentation.value : undefined;
			if (presentation?.renderer === "plan") {
				const plan = presentation.plan;
				if (plan === undefined || (plan.steps.length === 0 && plan.explanation === undefined)) return [];
				return [{
					id: baseId,
					kind: "plan-update",
					explanation: plan.explanation,
					steps: plan.steps,
				}];
			}
			if (presentation?.renderer === "shell" && presentation.input?.kind === "shell") {
				const result = presentation.result?.kind === "shell" ? presentation.result : undefined;
				return [{
					id: baseId,
					kind: "exec",
					command: presentation.input.commandLabel.text,
					status: row.status,
					output: result?.chunks.map((chunk) => ({ channel: chunk.channel, text: chunk.safeSgrText?.text ?? chunk.text.text })) ?? [],
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
					kind: "diff",
					document: block.document,
					showLineNumbers: true,
					lineNumberWidth: diffDocumentLineNumberWidth(block.document),
					syntaxHighlight: true,
				}]
				: []) ?? [];
			return [{ id: baseId, kind: "text", content: lines.join("\n") }, ...diffBlocks];
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
		case "run-boundary":
			return [{ id: baseId, kind: "separator", label: `${row.stopReason} · ${row.activeDurationMs === undefined ? "time unavailable" : `Worked for ${formatActiveDuration(row.activeDurationMs)}`}` }];
	}
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
	return input.path.text;
}

function knownCount(count: import("../presentation/tools/types.ts").SafeCount): string {
	return count.state === "known" ? String(count.value) : "?";
}
