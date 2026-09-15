import { normalizeSessionTitle } from "../../runtime/session-owner/title.ts";
import { decodeCompactionRecord, decodeInheritedCompaction } from "../../runtime/context/compaction/record.ts";
/**
 * Fork 的 typed ledger projector。
 *
 * fork 继承完整 canonical ledger（message、tool_call、tool_result、custom
 * 及其余当前 LedgerEntry 类型），但不复制 source owner/driver/approval/
 * process/workspace/recovery authority。每个 ledger payload 重新绑定 target
 * sessionId，并在 target 内重新串接 parentId；裸旧 event 或未知 ledger 类型
 * 不被静默当作 conversation history。
 */

import { canonicalDigest } from "../../runtime/protocol/canonical-json.ts";
import { createRuntimeId } from "../../runtime/protocol/ids.ts";
import { isCurrentLedgerEntry, type LedgerEntry } from "../../runtime/ledger/types.ts";
import { SessionStoreError } from "./session-store-error.ts";

export interface ForkSourceEvent {
	readonly eventId: string;
	readonly eventType: string;
	readonly payloadJson: string;
	readonly createdAtMs: number;
}

export interface ProjectedForkEvent {
	readonly eventId: string;
	readonly eventType: string;
	readonly payloadJson: string;
	readonly createdAtMs: number;
}

export class ForkLedgerProjector {
	private readonly sourceSessionId: string;
	private readonly targetSessionId: string;
	private previousLedgerEntryId: string;
	private readonly inheritCompaction: boolean;

	public constructor(sourceSessionId: string, targetSessionId: string, inheritCompaction = true) {
		this.sourceSessionId = sourceSessionId;
		this.inheritCompaction = inheritCompaction;
		this.targetSessionId = targetSessionId;
		this.previousLedgerEntryId = targetSessionId;
	}

	/** 非 ledger durable events 是 source runtime authority，不进入 fork history。 */
	public project(event: ForkSourceEvent): ProjectedForkEvent | undefined {
		if (this.inheritCompaction && (event.eventType === "compaction.completed" || event.eventType === "compaction.inherited")) {
			const record = event.eventType === "compaction.completed"
				? decodeCompactionRecord({ ...event, sessionId: this.sourceSessionId }) : decodeInheritedCompaction(event.payloadJson).record;
			return { eventId: createRuntimeId("event", canonicalDigest({ type: "fork.compaction", source: event.eventId, target: this.targetSessionId }).slice(0, 64)),
				eventType: "compaction.inherited", payloadJson: JSON.stringify({ schema: "runledger.compaction-inheritance", parentSessionId: this.sourceSessionId, parentEventId: event.eventId, record }), createdAtMs: event.createdAtMs };
		}
		if (event.eventType === "session.title_changed") return this.projectTitle(event);
		if (!event.eventType.startsWith("ledger.")) return undefined;
		const entry = parseCanonicalLedgerEntry(event, this.sourceSessionId);
		const entryId = createRuntimeId(
			"event",
			canonicalDigest({ type: "fork.ledger.entry", source: event.eventId, target: this.targetSessionId }).slice(0, 64),
		);
		const projected: LedgerEntry = {
			...entry,
			id: entryId,
			sessionId: this.targetSessionId,
			parentId: this.previousLedgerEntryId,
		};
		this.previousLedgerEntryId = entryId;
		return {
			eventId: createRuntimeId(
				"event",
				canonicalDigest({ type: "fork.ledger.event", source: event.eventId, target: this.targetSessionId }).slice(0, 64),
			),
			eventType: event.eventType,
			payloadJson: JSON.stringify(projected),
			createdAtMs: event.createdAtMs,
		};
	}

	/** title 是 catalog projection 的 immutable history；复制它以保持 row/event 重放一致。 */
	private projectTitle(event: ForkSourceEvent): ProjectedForkEvent {
		return {
			eventId: createRuntimeId(
				"event",
				canonicalDigest({ type: "fork.title.event", source: event.eventId, target: this.targetSessionId }).slice(0, 64),
			),
			eventType: event.eventType,
			payloadJson: event.payloadJson,
			createdAtMs: event.createdAtMs,
		};
	}
}

function parseCanonicalLedgerEntry(event: ForkSourceEvent, sourceSessionId: string): LedgerEntry {
	let parsed: unknown;
	try {
		parsed = JSON.parse(event.payloadJson) as unknown;
	} catch {
		throw new SessionStoreError("invalid_input", `fork cannot project invalid ledger JSON: ${event.eventId}`);
	}
	if (!isCurrentLedgerEntry(parsed)) {
		throw new SessionStoreError("invalid_input", `fork cannot project an unsupported ledger payload: ${event.eventId}`);
	}
	if (parsed.sessionId !== sourceSessionId || event.eventType !== `ledger.${parsed.type}`) {
		throw new SessionStoreError("invalid_input", `fork ledger binding/type mismatch: ${event.eventId}`);
	}
	return parsed;
}

/** 回退 fork 只接受已完成 assistant 轮次边界，避免复制半个工具批次。 */
export function isStableForkBoundary(event: ForkSourceEvent, sourceSessionId: string): boolean {
	if (event.eventType !== "ledger.message") return false;
	const entry = parseCanonicalLedgerEntry(event, sourceSessionId);
	const message = entry.payload.message;
	if (typeof message !== "object" || message === null || Array.isArray(message)) return false;
	const value = message as Record<string, unknown>;
	return value.role === "assistant" && value.stopReason === "stop" && Array.isArray(value.content)
		&& !value.content.some((part: unknown) => typeof part === "object" && part !== null && "type" in part && part.type === "toolCall");
}

/** 从同一事务读出的源事件选择回退边界，并同步还原该边界的 title。 */
export function prepareForkHistory(events: readonly Record<string, unknown>[], sourceSessionId: string, currentHead: number, throughSequence?: number): {
	readonly events: readonly Record<string, unknown>[];
	readonly sourceHeadSequence: number;
	readonly title?: { readonly title: string; readonly source: "auto" | "user"; readonly updatedAtMs: number } | null;
} {
	if (events.length !== currentHead) throw new SessionStoreError("fork_source_head_conflict", "fork source event count does not match its frozen head");
	if (throughSequence === undefined) return { events, sourceHeadSequence: currentHead };
	if (!Number.isSafeInteger(throughSequence) || throughSequence < 1 || throughSequence > currentHead) throw new SessionStoreError("invalid_input", "invalid fork history boundary");
	const boundary = events.find((event) => Number(event.sequence) === throughSequence);
	if (boundary === undefined || !isStableForkBoundary({ eventId: String(boundary.event_id), eventType: String(boundary.event_type), payloadJson: String(boundary.payload_json), createdAtMs: Number(boundary.created_at_ms) }, sourceSessionId)) throw new SessionStoreError("invalid_input", "fork history boundary must finish an assistant turn");
	const selected = events.filter((event) => Number(event.sequence) <= throughSequence);
	const titleEvent = selected.filter((event) => event.event_type === "session.title_changed").at(-1);
	if (titleEvent === undefined) return { events: selected, sourceHeadSequence: throughSequence, title: null };
	const title: unknown = JSON.parse(String(titleEvent.payload_json));
	if (typeof title !== "object" || title === null || !("title" in title) || typeof title.title !== "string" || !("source" in title) || (title.source !== "auto" && title.source !== "user")) throw new SessionStoreError("invalid_input", "invalid fork title boundary");
	const normalizedTitle = normalizeSessionTitle(title.title);
	return { events: selected, sourceHeadSequence: throughSequence, title: normalizedTitle === null ? null : { title: normalizedTitle, source: title.source, updatedAtMs: Number(titleEvent.created_at_ms) } };
}
