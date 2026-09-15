/** 来源 oh-my-pi 3b3a6dc9bbd85102ce19d0b1c11bf6870915f6ec packages/agent/src/compaction/utils.ts；MIT 许可全文见同目录 budget.ts。 */
import type { Message } from "../../../types.ts";

export interface FileOperations {
	readonly read: Set<string>;
	readonly written: Set<string>;
	readonly edited: Set<string>;
}
export function createFileOps(): FileOperations { return { read: new Set(), written: new Set(), edited: new Set() }; }
const RANGE = String.raw`L?\d+(?:(?:[-+]|\.\.)L?\d+|-|\.\.)?`;
const RANGE_LIST = `${RANGE}(?:,${RANGE})*`;
const SELECTOR = new RegExp(`^(?:${RANGE_LIST}|raw|conflicts)$`, "i");
const RANGE_ONLY = new RegExp(`^${RANGE_LIST}$`, "i");

/** 上游 selector 的纯解析；RunLedger read 自身使用 offset/limit，不能把合法文件名的冒号后缀当成行号。 */
export function splitReadSelector(path: string): { readonly path: string; readonly sel?: string } {
	const colon = path.lastIndexOf(":");
	if (colon <= 0) return { path };
	const candidate = path.slice(colon + 1);
	if (!SELECTOR.test(candidate)) return { path };
	let base = path.slice(0, colon);
	let sel = candidate;
	const inner = base.lastIndexOf(":");
	if (inner > 0) {
		const first = base.slice(inner + 1);
		if ((/^raw$/iu.test(first) && RANGE_ONLY.test(candidate)) || (RANGE_ONLY.test(first) && /^raw$/iu.test(candidate))) {
			sel = `${first}:${candidate}`; base = base.slice(0, inner);
		}
	}
	return { path: base, sel };
}
export function stripReadSelector(path: string): string { return splitReadSelector(path).path; }
export function isUrlSchemePath(path: string): boolean { return /[a-z][a-z0-9+.-]*:\/\//iu.test(path); }
function validPath(path: string): boolean { return path.length > 0 && path.length <= 512 && !path.includes("\0") && !isUrlSchemePath(path); }

/** 只追踪显式工具参数；清单记录请求过的操作，成功与否仍以对应 tool result 为准。 */
export function extractFileOpsFromMessage(message: Message, files: FileOperations): void {
	if (message.role !== "assistant") return;
	for (const part of message.content) {
		if (part.type !== "toolCall") continue;
		const path = part.arguments.path;
		if (typeof path !== "string" || !validPath(path)) continue;
		if (part.name === "read") files.read.add(path);
		else if (part.name === "write") files.written.add(path);
		else if (part.name === "edit") files.edited.add(path);
	}
}
export function computeFileLists(files: FileOperations): { readonly readFiles: string[]; readonly modifiedFiles: string[] } {
	const modified = new Set([...files.written, ...files.edited].filter(validPath));
	return { readFiles: [...files.read].filter((path) => validPath(path) && !modified.has(path)).sort(), modifiedFiles: [...modified].sort() };
}
export const FILE_OPERATION_SUMMARY_LIMIT = 20;
export const FILE_OPERATION_SUMMARY_BYTES = 4096;

export function formatFileOperations(readFiles: readonly string[], modifiedFiles: readonly string[], readSet?: ReadonlySet<string>): string {
	const modes = new Map<string, "Read" | "Write" | "RW">();
	for (const path of readFiles) if (validPath(path)) modes.set(path, "Read");
	for (const path of modifiedFiles) if (validPath(path)) modes.set(path, readSet?.has(path) ? "RW" : "Write");
	const paths = [...modes.keys()].sort();
	if (paths.length === 0) return "";
	const lines = ["<files>", "Tool-call paths (requested operations; consult tool results for outcomes):"];
	let shown = 0;
	for (const path of paths) {
		// JSON 引号保留换行等路径字符；尖括号不能伪造清单的边界。
		const escaped = JSON.stringify(path).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
		const line = `- (${modes.get(path)}) ${escaped}`;
		if (shown >= FILE_OPERATION_SUMMARY_LIMIT || Buffer.byteLength([...lines, line].join("\n")) > FILE_OPERATION_SUMMARY_BYTES - 100) break;
		lines.push(line); shown += 1;
	}
	if (shown < paths.length) lines.push(`[${paths.length - shown} file paths omitted]`);
	return [...lines, "</files>"].join("\n");
}
export function upsertFileOperations(summary: string, readFiles: readonly string[], modifiedFiles: readonly string[], readSet?: ReadonlySet<string>): string {
	const base = summary.replace(/<(files|read-files|modified-files)>[\s\S]*?<\/\1>\s*/giu, "")
		.replace(/<\/?(?:files|read-files|modified-files)(?:\s[^>]*)?>/giu, (tag) => `&lt;${tag.slice(1)}`).trimEnd();
	const files = formatFileOperations(readFiles, modifiedFiles, readSet);
	return files.length === 0 ? base : `${base}\n\n${files}`;
}
export const TOOL_RESULT_MAX_CHARS = 2000;
export function truncateToolResultForSummary(text: string): string {
	return text.length <= TOOL_RESULT_MAX_CHARS ? text : `${text.slice(0, TOOL_RESULT_MAX_CHARS)}\n[... ${text.length - TOOL_RESULT_MAX_CHARS} more characters truncated]`;
}
export function escapeSummaryBoundaryTags(text: string): string {
	return text.replace(/<\s*\/?\s*(?:conversation|previous-summary|focus)\s*>/giu, (tag) => `&lt;${tag.slice(1)}`);
}
