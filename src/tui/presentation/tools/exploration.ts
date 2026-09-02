import type { ExplorationActionView, ExplorationBlock } from "../../presentation.ts";
import type {
	SafeBoundedText,
	SafeExplorationResult,
	SafeToolInputMetadata,
	SafeToolPresentation,
} from "./types.ts";
import type { TimelineRow, TimelineStatus } from "../../timeline/types.ts";

/** 第一方只读发现工具的精确分类；不对 MCP/plugin 名称做猜测。 */
export type ExplorationKind = "read" | "search" | "list";

export function explorationKindForTool(toolName: string): ExplorationKind | undefined {
	switch (toolName) {
		case "read": return "read";
		case "grep":
		case "find": return "search";
		case "glob":
		case "ls": return "list";
		default: return undefined;
	}
}

const labelForKind: Readonly<Record<ExplorationKind, string>> = {
	read: "Read",
	search: "Search",
	list: "List",
};

/** 只有精确工具名与对应的安全输入 metadata 同时存在时才可进入探索展示。 */
export function explorationActionForRow(row: TimelineRow): ExplorationActionView | undefined {
	if (row.kind !== "tool" || row.presentation.state !== "known") return undefined;
	const kind = explorationKindForTool(row.toolName.text);
	if (kind === undefined) return undefined;
	const input = row.presentation.value.input;
	if (input === undefined || !matchesToolInput(row.toolName.text, input)) return undefined;
	const target = targetForInput(input);
	if (target === undefined) return undefined;
	const errorSummary = failedStatus(row.status) ? firstErrorSummary(row.presentation.value.error) : undefined;
	return {
		id: row.toolCallId,
		kind,
		label: plainBounded(labelForKind[kind]),
		target,
		...(queryForInput(input) === undefined ? {} : { query: queryForInput(input) }),
		status: row.status,
		...(explorationResultFor(row.presentation.value) === undefined ? {} : { result: explorationResultFor(row.presentation.value) }),
		...(errorSummary === undefined ? {} : { errorSummary }),
	};
}

export function isExplorationRow(row: TimelineRow): boolean {
	return explorationActionForRow(row) !== undefined;
}

/** 保持原始 rows/action id；只派生 main surface 的稳定 group block。 */
export function explorationBlockForRows(rows: readonly TimelineRow[], finalized: boolean): ExplorationBlock | undefined {
	const first = rows[0];
	if (first === undefined) return undefined;
	const actions = rows.flatMap((row) => {
		const action = explorationActionForRow(row);
		return action === undefined ? [] : [action];
	});
	if (actions.length === 0) return undefined;
	const hasError = actions.some((action) => failedStatus(action.status));
	const hasActive = actions.some((action) => action.status === "pending" || action.status === "running");
	const last = rows.at(-1) ?? first;
	return {
		id: `exploration-${first.id}`,
		entryId: first.id,
		partId: `${first.id}/exploration`,
		contentGeneration: last.generation ?? 0,
		finalized,
		kind: "exploration",
		state: hasError ? "completed-with-errors" : hasActive ? "active" : "completed",
		actions,
	};
}

export function explorationDetailForRow(row: TimelineRow, finalized: boolean): {
	readonly action: ExplorationActionView;
	readonly body: SafeToolPresentation["body"];
} | undefined {
	const action = explorationActionForRow(row);
	if (action === undefined || row.kind !== "tool" || row.presentation.state !== "known") return undefined;
	return {
		action,
		body: row.presentation.value.body,
	};
}

function matchesToolInput(toolName: string, input: SafeToolInputMetadata): boolean {
	if (toolName === "read") return input.kind === "read";
	if (toolName === "grep") return input.kind === "grep";
	if (toolName === "find") return input.kind === "find";
	if (toolName === "glob") return input.kind === "glob";
	if (toolName === "ls") return input.kind === "ls";
	return false;
}

function targetForInput(input: SafeToolInputMetadata): SafeBoundedText | undefined {
	if (input.kind === "read" || input.kind === "grep" || input.kind === "find" || input.kind === "glob" || input.kind === "ls") return input.path;
	return undefined;
}

function queryForInput(input: SafeToolInputMetadata): SafeBoundedText | undefined {
	if (input.kind === "grep") return input.query;
	if (input.kind === "find" || input.kind === "glob") return input.pattern;
	return undefined;
}

function explorationResultFor(presentation: SafeToolPresentation): SafeExplorationResult | undefined {
	const result = presentation.result;
	if (result?.kind === "read" || result?.kind === "grep" || result?.kind === "find" || result?.kind === "glob" || result?.kind === "ls") return result.exploration;
	return undefined;
}

function failedStatus(status: TimelineStatus): boolean {
	return status === "failed" || status === "cancelled" || status === "aborted";
}

function firstErrorSummary(error: SafeBoundedText | undefined): SafeBoundedText | undefined {
	if (error === undefined) return undefined;
	const first = error.text.split(/\r?\n/gu).find((line) => line.trim().length > 0)?.trim();
	return first === undefined ? undefined : boundedText(first, 120);
}

function plainBounded(text: string): SafeBoundedText {
	return { text, truncated: false, byteLength: new TextEncoder().encode(text).byteLength };
}

function boundedText(text: string, maxBytes: number): SafeBoundedText {
	const encoder = new TextEncoder();
	if (encoder.encode(text).byteLength <= maxBytes) return plainBounded(text);
	let result = "";
	for (const grapheme of text) {
		if (encoder.encode(`${result}${grapheme}…`).byteLength > maxBytes) break;
		result += grapheme;
	}
	const bounded = `${result}…`;
	return { text: bounded, truncated: true, byteLength: encoder.encode(bounded).byteLength };
}
