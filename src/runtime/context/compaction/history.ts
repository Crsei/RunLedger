/** 压缩仅选择完成的对话前缀；原消息仍由 ledger 持有。 */
import type { Message } from "../../../types.ts";
import { runtimeDigest, type RuntimeDigest } from "../../protocol/foundation.ts";
import { adjustedRetainTokens, estimateHistoryTokens } from "./budget.ts";
import { truncateToolResultForSummary } from "./summary-context.ts";
import { isCompleteToolBatch } from "./cut-planner.ts";

export function historyDigest(messages: readonly Message[]): RuntimeDigest {
	return runtimeDigest(JSON.parse(JSON.stringify(messages.map((message) => {
		const { timestamp: _timestamp, ...body } = message;
		return body;
	}))));
}

export type HistoryCut = { readonly ok: true; readonly count: number; readonly units: readonly string[] }
	| { readonly ok: false; readonly code: "insufficient_history" | "incomplete_history" };

export function planHistoryCut(messages: readonly Message[], retainRecentTokens: number, previousCount = 0, providerPromptTokens = 0): HistoryCut {
	if (!Number.isSafeInteger(retainRecentTokens) || retainRecentTokens < 1 || !Number.isSafeInteger(previousCount) || previousCount < 0) return { ok: false, code: "incomplete_history" };
	const ends: number[] = [];
	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index]!;
		if (message.role === "assistant" && message.stopReason === "stop" && !message.content.some((part) => part.type === "toolCall")) ends.push(index + 1);
	}
	if (previousCount > messages.length || (previousCount > 0 && !ends.includes(previousCount))) return { ok: false, code: "incomplete_history" };
	const retain = adjustedRetainTokens(retainRecentTokens, providerPromptTokens, estimateHistoryTokens(messages.slice(previousCount)));
	let tailTokens = 0;
	let firstKept = messages.length;
	// 从新到旧跨完整 turn 累计；至少保留最新完整 turn，未完成尾部一并保留。
	for (let index = ends.length - 2; index >= -1; index -= 1) {
		const start = ends[index] ?? 0;
		tailTokens += estimateHistoryTokens(messages.slice(start, firstKept));
		firstKept = start;
		if (tailTokens >= retain) break;
	}
	const eligible = ends.filter((end) => end > previousCount && end <= firstKept);
	if (eligible.length === 0) return { ok: false, code: "insufficient_history" };
	const units: string[] = [];
	let start = previousCount;
	for (const end of eligible) {
		const members = messages.slice(start, end);
		if (members[0]?.role !== "user") return { ok: false, code: "incomplete_history" };
		if (!isCompleteToolBatch({
			toolCallIds: members.flatMap((message) => message.role === "assistant" ? message.content.flatMap((part) => part.type === "toolCall" ? [part.id] : []) : []),
			toolResultIds: members.flatMap((message) => message.role === "toolResult" ? [message.toolCallId] : []),
		})) return { ok: false, code: "incomplete_history" };
		const pending = new Set<string>();
		for (const member of members) {
			if (member.role === "assistant") for (const part of member.content) if (part.type === "toolCall") pending.add(part.id);
			if (member.role === "toolResult" && !pending.delete(member.toolCallId)) return { ok: false, code: "incomplete_history" };
		}
		if (pending.size > 0) return { ok: false, code: "incomplete_history" };
		units.push(JSON.stringify({ source: { startMessage: start, endMessageExclusive: end }, messages: members.map(summaryMessage) }));
		start = end;
	}
	return { ok: true, count: start, units };
}

/** 私有推理与图片字节不发给摘要模型；明确留下不可从摘要还原图片的标记。 */
function summaryMessage(message: Message): unknown {
	const { timestamp: _timestamp, ...body } = message;
	if (typeof body.content === "string") return { role: body.role, content: redactSummaryInput(body.content) };
	const content = body.content.flatMap((part) => {
		if (part.type === "thinking") return [];
		if (part.type === "image") return [{ type: "text", text: "[Image omitted; consult the original history for image contents.]" }];
		// 签名与 provider-private 字段不参与摘要输入。
		if (part.type === "text") return [{ type: "text", text: redactSummaryInput(part.text) }];
		return [JSON.parse(redactSummaryInput(JSON.stringify(part))) as unknown];
	});
	if (message.role === "toolResult") {
		const text = message.content.map((part) => part.type === "text" ? part.text : "[Image omitted; consult the original history for image contents.]").join("\n");
		return { role: message.role, toolCallId: message.toolCallId, toolName: message.toolName, isError: message.isError,
			content: [{ type: "text", text: truncateToolResultForSummary(redactSummaryInput(text)) }] };
	}
	return { role: body.role, content };
}

const SECRET_PATTERN = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+\/-]{8,}|\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}))/gu;
export function redactSummaryInput(text: string): string {
	return text.replace(SECRET_PATTERN, "[REDACTED]")
		.replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)["']?\s*[=:]\s*["']?)(\[REDACTED\]|[^\s,;"'}\]]+)/giu,
			(_match, prefix: string, value: string) => `${prefix}${value === "[REDACTED]" ? value : "[REDACTED]"}`);
}
export function hasSummarySecret(text: string): boolean { return redactSummaryInput(text) !== text; }
