/** 压缩仅选择完成的对话前缀；原消息仍由 ledger 持有。 */
import type { Message } from "../../../types.ts";
import { runtimeDigest, type RuntimeDigest } from "../../protocol/foundation.ts";
import { isCompleteToolBatch } from "./cut-planner.ts";

export function historyDigest(messages: readonly Message[]): RuntimeDigest {
	return runtimeDigest(JSON.parse(JSON.stringify(messages.map((message) => {
		const { timestamp: _timestamp, ...body } = message;
		return body;
	}))));
}

export type HistoryCut = { readonly ok: true; readonly count: number; readonly units: readonly string[] }
	| { readonly ok: false; readonly code: "insufficient_history" | "incomplete_history" };

export function planHistoryCut(messages: readonly Message[], retainRecentTurns: number, previousCount = 0): HistoryCut {
	if (!Number.isSafeInteger(retainRecentTurns) || retainRecentTurns < 1 || !Number.isSafeInteger(previousCount) || previousCount < 0) return { ok: false, code: "incomplete_history" };
	const ends: number[] = [];
	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index]!;
		if (message.role === "assistant" && message.stopReason === "stop" && !message.content.some((part) => part.type === "toolCall")) ends.push(index + 1);
	}
	const eligible = ends.slice(0, Math.max(0, ends.length - retainRecentTurns)).filter((end) => end > previousCount);
	if (eligible.length === 0) return { ok: false, code: "insufficient_history" };
	const units: string[] = [];
	let start = previousCount;
	for (const end of eligible) {
		const members = messages.slice(start, end);
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
	return { role: body.role, content, ...(message.role === "toolResult" ? { toolCallId: message.toolCallId, toolName: message.toolName, isError: message.isError } : {}) };
}

const SECRET_PATTERN = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+\/-]{8,}|\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}))/gu;
export function redactSummaryInput(text: string): string {
	return text.replace(SECRET_PATTERN, "[REDACTED]")
		.replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)["']?\s*[=:]\s*["']?)(\[REDACTED\]|[^\s,;"'}\]]+)/giu,
			(_match, prefix: string, value: string) => `${prefix}${value === "[REDACTED]" ? value : "[REDACTED]"}`);
}
export function hasSummarySecret(text: string): boolean { return redactSummaryInput(text) !== text; }
