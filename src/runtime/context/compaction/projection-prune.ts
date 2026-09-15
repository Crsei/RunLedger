/** 来源 oh-my-pi 3b3a6dc9bbd85102ce19d0b1c11bf6870915f6ec packages/agent/src/compaction/pruning.ts；纯投影适配，MIT 许可见 budget.ts。 */
import type { Message, ToolCall, ToolResultMessage } from "../../../types.ts";
import type { AgentMessage } from "../../types.ts";
import { conservativeTokenEstimate } from "../token-estimator.ts";
import { isUrlSchemePath, stripReadSelector } from "./summary-context.ts";

export const SUPERSEDED_NOTICE = "[Superseded by a newer read of the same file range.]";
export const USELESS_NOTICE = "[Uneventful result elided.]";
const MINIMUM_SAVINGS_TOKENS = 50;
export interface ProjectionPruneConfig {
	readonly pruneSuperseded: boolean;
	readonly dropUseless: boolean;
	readonly protectedPrefixCount?: number;
	readonly protectedReferences?: readonly string[];
	readonly uselessToolCallIds?: readonly string[];
}
export interface ProjectionPruneReplacement {
	readonly index: number;
	readonly toolCallId: string;
	readonly reason: "superseded-read" | "useless";
	readonly estimatedTokensSaved: number;
}
export interface ProjectionPruneResult {
	readonly messages: readonly Message[];
	readonly replacements: readonly ProjectionPruneReplacement[];
	readonly estimatedTokensSaved: number;
}

/** RunLedger 的 read 范围由 offset/limit 表达；不同范围和不同展示参数均不互相替代。 */
export function readToolSupersedeKey(call: ToolCall): string | undefined {
	if (call.name !== "read") return undefined;
	const { path, offset, limit, lineNumbers } = call.arguments;
	if (typeof path !== "string" || path.length === 0 || path.length > 4096 || isUrlSchemePath(path)) return undefined;
	if ([offset, limit].some((value) => value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1))) return undefined;
	if (lineNumbers !== undefined && typeof lineNumbers !== "boolean") return undefined;
	return JSON.stringify({ path, offset: offset ?? 1, limit: limit ?? null, lineNumbers: lineNumbers ?? true });
}

/** details 留在 ledger；只把严格布尔 hint 作为派生剪枝参数，不向公共消息注入字段。 */
export function collectUselessToolCallIds(messages: readonly AgentMessage[]): readonly string[] {
	return messages.flatMap((message) => message.role !== "toolResult" ? [] : message.content.flatMap((result) => {
		const details = result.details;
		return result.isError !== true && typeof details === "object" && details !== null && "useless" in details && details.useless === true ? [result.toolCallId] : [];
	}));
}

function protectedResult(call: ToolCall, message: ToolResultMessage<unknown>, references: readonly string[]): boolean {
	if (/^(?:skill|plan(?:_|$)|memory_get)/iu.test(call.name) || (message.addedToolNames?.length ?? 0) > 0) return true;
	const path = call.arguments.path;
	if (typeof path !== "string") return false;
	const name = stripReadSelector(path).replaceAll("\\", "/").split("/").at(-1)?.toLowerCase();
	return name === "skill.md" || name === "agents.md" || references.some((text) => text.includes(path));
}

/** 无时钟、无 entry 改写；只替换正文，保留 call/result、顺序及所有原始前缀。 */
export function planProjectionPrune(messages: readonly Message[], config: ProjectionPruneConfig): ProjectionPruneResult {
	const unchanged = { messages, replacements: [], estimatedTokensSaved: 0 };
	const start = config.protectedPrefixCount ?? 0;
	if ((!config.pruneSuperseded && !config.dropUseless) || !Number.isSafeInteger(start) || start < 0 || start > messages.length) return unchanged;
	const calls = new Map<string, { readonly call: ToolCall; readonly index: number }>();
	const results = new Map<string, number>();
	const ambiguous = new Set<string>();
	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index]!;
		if (message.role === "assistant") for (const part of message.content) {
			if (part.type !== "toolCall") continue;
			if (calls.has(part.id)) ambiguous.add(part.id);
			calls.set(part.id, { call: part, index });
		}
		if (message.role === "toolResult") {
			if (results.has(message.toolCallId)) ambiguous.add(message.toolCallId);
			results.set(message.toolCallId, index);
		}
	}
	const references = config.protectedReferences ?? [];
	const useless = new Set(config.uselessToolCallIds ?? []);
	const seenReads = new Set<string>();
	const replacements: ProjectionPruneReplacement[] = [];
	const projected = [...messages];
	for (let index = messages.length - 1; index >= start; index -= 1) {
		const message = messages[index]!;
		if (message.role !== "toolResult" || message.isError || message.content.some((part) => part.type !== "text")) continue;
		const paired = calls.get(message.toolCallId);
		if (paired === undefined || paired.index < start || paired.index >= index || ambiguous.has(message.toolCallId) || paired.call.name !== message.toolName || protectedResult(paired.call, message, references)) continue;
		const key = readToolSupersedeKey(paired.call);
		const superseded = config.pruneSuperseded && key !== undefined && seenReads.has(key);
		if (key !== undefined) seenReads.add(key);
		const reason = superseded ? "superseded-read" : config.dropUseless && useless.has(message.toolCallId) ? "useless" : undefined;
		if (reason === undefined) continue;
		const content = [{ type: "text" as const, text: reason === "superseded-read" ? SUPERSEDED_NOTICE : USELESS_NOTICE }];
		const saved = conservativeTokenEstimate(JSON.stringify(message.content)) - conservativeTokenEstimate(JSON.stringify(content));
		if (saved < MINIMUM_SAVINGS_TOKENS) continue;
		projected[index] = { ...message, content };
		replacements.push({ index, toolCallId: message.toolCallId, reason, estimatedTokensSaved: saved });
	}
	if (replacements.length === 0) return unchanged;
	replacements.reverse();
	return { messages: projected, replacements, estimatedTokensSaved: replacements.reduce((total, item) => total + item.estimatedTokensSaved, 0) };
}
