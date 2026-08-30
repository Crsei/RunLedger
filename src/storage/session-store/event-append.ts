/**
 * S1 拆分:event hash 输入/计算、owner fence、append 事务与 status 投影。
 *
 * 事务边界说明(S1 实施记录):status projection(`projectSessionStatus`/
 * `releaseReason`)归置在本模块,因为 append 事务内需要计算 catalog status,
 * 而 session-projection 的 replay 校验需要 `sessionEventHash`;该归置避免
 * event-append ↔ session-projection 双向环。projection 模块从这里 import。
 *
 * 本模块所有函数只接收已打开的窄 database/tx port,不自行打开第二连接;
 * owner fence 校验与 head 更新必须与 event INSERT 同属一个事务。
 */

import type { SessionDatabase } from "./database.ts";
import { ACTIVE_OWNER_STATES } from "./schema-compatibility.ts";
import { canonicalDigest } from "../../runtime/protocol/canonical-json.ts";
import { createRuntimeId } from "../../runtime/protocol/ids.ts";
import type { OwnerFence } from "../../runtime/session-owner/types.ts";
import type { AppendEventInput, SessionEventRecord } from "./session-store.ts";
import { SessionStoreError } from "./session-store-error.ts";

/** event hash 的 canonical 输入;与 payload 解耦,只绑定身份/序号/链。 */
export function sessionEventHashInput(
	sessionId: string,
	sequence: number,
	eventId: string,
	eventType: string,
	payloadJson: string,
	previousEventHash: string | null,
): Record<string, unknown> {
	return {
		sessionId,
		sequence,
		eventId,
		eventType,
		payloadJson,
		previousEventHash,
	};
}

export function sessionEventHash(
	sessionId: string,
	sequence: number,
	eventId: string,
	eventType: string,
	payloadJson: string,
	previousEventHash: string | null,
): string {
	return canonicalDigest(sessionEventHashInput(sessionId, sequence, eventId, eventType, payloadJson, previousEventHash));
}

/**
 * §4.5 写 fence:同一事务内验证 owner row 仍属于当前 generation。
 */
export function verifyOwnerFence(db: SessionDatabase, fence: OwnerFence): boolean {
	const row = db.querySingle(
		`SELECT 1 AS ok FROM session_owners
		 WHERE session_id = ? AND runtime_id = ? AND generation = ?
		   AND state IN (${ACTIVE_OWNER_STATES.map(() => "?").join(", ")})`,
		[fence.sessionId, fence.runtimeId, fence.generation, ...ACTIVE_OWNER_STATES],
	);
	return row !== undefined;
}

/**
 * R3:在既有事务(tx)内执行 owner-fenced event append。owner 状态迁移与 audit
 * event 必须同属一个 DB transaction(06 §R3),claim/publish/release 在 CAS 写入
 * owner row 后复用本函数追加 owner.* 事件;owner-store 与 SessionStore 共享同一
 * hash 链与 head 更新逻辑,禁止出现“owner row 已迁移但事件缺失”的半写。
 */
export function appendEventInTransaction(tx: SessionDatabase, fence: OwnerFence, input: AppendEventInput): SessionEventRecord {
	if (!fence.sessionId.startsWith("session_") || !input.eventId.startsWith("event_")) {
		throw new SessionStoreError("invalid_input", "invalid session or event id");
	}
	tx.querySingle("SELECT 1 FROM store_control WHERE singleton_id = 1 AND admission = 'ready'");
	if (!verifyOwnerFence(tx, fence)) {
		throw new SessionStoreError("owner_fenced", `owner fenced: ${fence.runtimeId} generation ${fence.generation}`);
	}
	const headRow = tx.querySingle("SELECT head_sequence, status FROM sessions WHERE session_id = ?", [fence.sessionId]);
	if (!headRow) throw new SessionStoreError("session_not_found", `session not found: ${fence.sessionId}`);
	const headSequence = Number(headRow.head_sequence);
	const previousRow = tx.querySingle(
		"SELECT current_event_hash FROM session_events WHERE session_id = ? AND sequence = ?",
		[fence.sessionId, headSequence],
	);
	const actualPrevious = previousRow === undefined ? null : String(previousRow.current_event_hash);
	if (actualPrevious !== input.expectedPreviousEventHash) {
		throw new SessionStoreError("previous_hash_mismatch", "expected previous event hash does not match the durable head");
	}
	const sequence = headSequence + 1;
	const currentHash = sessionEventHash(
		fence.sessionId,
		sequence,
		input.eventId,
		input.eventType,
		input.payloadJson,
		actualPrevious,
	);
	try {
		tx.runSync(
			`INSERT INTO session_events
			 (session_id, sequence, event_id, owner_generation, event_type, payload_json,
			  previous_event_hash, current_event_hash, created_at_ms)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				fence.sessionId,
				sequence,
				input.eventId,
				input.ownerGeneration,
				input.eventType,
				input.payloadJson,
				actualPrevious,
				currentHash,
				input.createdAtMs,
			],
		);
	} catch (error) {
		if (error instanceof Error && /UNIQUE|PRIMARY/i.test(error.message)) {
			throw new SessionStoreError("sequence_conflict", `event ${input.eventId} conflicts with the durable stream`);
		}
		throw error;
	}
	const status = projectSessionStatus(String(headRow.status), input.eventType, input.payloadJson);
	const driverRevisionUpdate = input.eventType === "driver.claimed"
		|| input.eventType === "driver.released"
		|| input.eventType === "driver.reset_on_takeover"
		? ", driver_revision = driver_revision + 1"
		: "";
	tx.runSync(`UPDATE sessions SET head_sequence = ?, status = ?, updated_at_ms = ?${driverRevisionUpdate} WHERE session_id = ?`, [
		sequence,
		status,
		Date.now(),
		fence.sessionId,
	]);
	return {
		sessionId: fence.sessionId,
		sequence,
		eventId: input.eventId,
		ownerGeneration: input.ownerGeneration,
		eventType: input.eventType,
		payloadJson: input.payloadJson,
		previousEventHash: actualPrevious,
		currentEventHash: currentHash,
		createdAtMs: input.createdAtMs,
	};
}

/**
 * §6.4/§R4:durable driver 事件与 driver_revision 递增在同一事务内提交。
 * driver 是 connection-scoped:disconnect/takeover 强制 NONE + revision 事件;
 * sessions.driver_revision 只是该投影的缓存列,rebuildFromEvents 可从事件重建。
 * payload 按 R0 契约(additionalProperties:false),eventId 由本函数注入。
 */
export function appendDriverEventInTransaction(
	tx: SessionDatabase,
	fence: OwnerFence,
	eventType: "driver.claimed" | "driver.released" | "driver.reset_on_takeover",
	payload: Record<string, unknown>,
): SessionEventRecord {
	tx.querySingle("SELECT 1 FROM store_control WHERE singleton_id = 1 AND admission = 'ready'");
	if (!verifyOwnerFence(tx, fence)) {
		throw new SessionStoreError("owner_fenced", "owner fenced");
	}
	const row = tx.querySingle("SELECT driver_revision FROM sessions WHERE session_id = ?", [fence.sessionId]);
	if (!row) throw new SessionStoreError("session_not_found", `session not found: ${fence.sessionId}`);
	const revision = Number(row.driver_revision) + 1;
	const eventId = createRuntimeId("event", `driver-${fence.sessionId.slice(-12)}-${revision}`);
	const headRow = tx.querySingle("SELECT head_sequence FROM sessions WHERE session_id = ?", [fence.sessionId]);
	const headSequence = Number(headRow?.head_sequence ?? 0);
	const previousRow = tx.querySingle(
		"SELECT current_event_hash FROM session_events WHERE session_id = ? AND sequence = ?",
		[fence.sessionId, headSequence],
	);
	return appendEventInTransaction(tx, fence, {
		eventId,
		ownerGeneration: fence.generation,
		eventType,
		payloadJson: JSON.stringify({ ...payload, eventId }),
		createdAtMs: Date.now(),
		expectedPreviousEventHash: previousRow === undefined ? null : String(previousRow.current_event_hash),
	});
}

/** Event 是 authority；catalog status 只是同事务更新的可重建投影。 */
export function projectSessionStatus(current: string, eventType: string, payloadJson: string): string {
	if (eventType === "owner.claimed") return "active";
	if (eventType === "owner.fenced" || eventType === "owner.taken_over") return "recovery_required";
	if (eventType === "recovery.verified_clean" || eventType === "recovery.resume_despite_uncertainty") return "active";
	if (eventType === "session.closed") return "completed";
	if (eventType === "session.stopped" || eventType === "session.handoff_committed") return "paused";
	if (eventType === "session.corrupted") return "failed";
	if (eventType !== "owner.released") return current;
	const reason = releaseReason(payloadJson);
	return reason === "error" ? "failed" : reason === "paused" || reason === "detached" ? "paused" : current;
}

function releaseReason(payloadJson: string): string | undefined {
	try {
		const value = JSON.parse(payloadJson) as unknown;
		if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
		const reason = (value as Readonly<Record<string, unknown>>).reason;
		return typeof reason === "string" ? reason : undefined;
	} catch {
		return undefined;
	}
}
