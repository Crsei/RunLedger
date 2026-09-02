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

	public constructor(sourceSessionId: string, targetSessionId: string) {
		this.sourceSessionId = sourceSessionId;
		this.targetSessionId = targetSessionId;
		this.previousLedgerEntryId = targetSessionId;
	}

	/** 非 ledger durable events 是 source runtime authority，不进入 fork history。 */
	public project(event: ForkSourceEvent): ProjectedForkEvent | undefined {
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
