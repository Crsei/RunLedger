/**
 * S1 拆分:event replay、投影重建与一致性检查(title/status projection)。
 *
 * 只接收已打开的 database port 与窄 repository port;不打开第二连接、
 * 不绕过 owner fence(本模块全部为只读投影,无 mutation)。
 */

import type { SessionDatabase } from "./database.ts";
import { sessionEventHash, projectSessionStatus } from "./event-append.ts";
import { rowToEvent } from "./row-mappers.ts";
import { isSessionTitleSource, isValidSessionTitleState, normalizeSessionTitle } from "../../runtime/session-owner/title.ts";
import type { SessionTitleState } from "../../runtime/session-owner/title.ts";
import type { SessionCatalogRecord, SessionEventRecord, SessionProjection } from "./session-store.ts";
import { SessionStoreError } from "./session-store-error.ts";
import type { CatalogRepository } from "./catalog-repository.ts";
import { boundedTitleRef } from "./row-mappers.ts";

/** §4.4 authority replay:按 sequence 返回全部事件(genesis 起),校验 hash 链完整。 */
export function replaySessionEvents(db: SessionDatabase, sessionId: string): SessionEventRecord[] {
	const rows = db.queryAll("SELECT * FROM session_events WHERE session_id = ? ORDER BY sequence", [sessionId]);
	const events: SessionEventRecord[] = rows.map((row) => rowToEvent(row));
	let previous: string | null = null;
	for (const event of events) {
		if (event.previousEventHash !== previous) {
			throw new SessionStoreError("sequence_conflict", `hash chain broken at sequence ${event.sequence}`);
		}
		const expected = sessionEventHash(
			event.sessionId,
			event.sequence,
			event.eventId,
			event.eventType,
			event.payloadJson,
			previous,
		);
		if (expected !== event.currentEventHash) {
			throw new SessionStoreError("sequence_conflict", `event hash mismatch at sequence ${event.sequence}`);
		}
		previous = event.currentEventHash;
	}
	return events;
}

/**
 * §4.5 写路径只需要链尾:单次倒序索引查询,不重放全部事件。
 * 返回 `{ sequence, hash }`；空流返回 `{ sequence: 0, hash: null }`。
 */
export function latestSessionEventHead(db: SessionDatabase, sessionId: string): { readonly sequence: number; readonly hash: string | null } {
	const row = db.querySingle("SELECT sequence, current_event_hash FROM session_events WHERE session_id = ? ORDER BY sequence DESC LIMIT 1", [sessionId]);
	if (row === undefined) return { sequence: 0, hash: null };
	return { sequence: Number(row.sequence), hash: String(row.current_event_hash) };
}

/** 删除全部 checkpoint 后从 genesis 重建,结果必须与缓存投影一致(测试证据用)。 */
export function rebuildFromEvents(db: SessionDatabase, sessionId: string): SessionProjection {
	const events = replaySessionEvents(db, sessionId);
	let status = "active";
	let driverRevision = 0;
	let titleState: SessionTitleState = {};
	for (const event of events) {
		status = projectSessionStatus(status, event.eventType, event.payloadJson);
		if (event.eventType === "driver.claimed") driverRevision += 1;
		if (event.eventType === "driver.released" || event.eventType === "driver.reset_on_takeover") driverRevision += 1;
		if (event.eventType === "session.title_changed") titleState = projectSessionTitle(titleState, event);
	}
	return {
		sessionId,
		status,
		headSequence: events.length,
		driverRevision,
		...titleState,
	};
}

/**
 * §4.4 重建投影:只凭 Event + Receipt 从 genesis 计算 projection。
 * checkpoint 删除/损坏不影响结果;cache 不能反向授权 mutation。
 * catalog 是窄 port:只读 getSession,不持有 catalog 写能力。
 */
export function projectSession(
	db: SessionDatabase,
	sessionId: string,
	catalog: Pick<CatalogRepository, "getSession">,
): SessionProjection {
	const record = catalog.getSession(sessionId);
	if (!record) throw new SessionStoreError("session_not_found", `session not found: ${sessionId}`);
	const rebuilt = rebuildFromEvents(db, sessionId);
	assertProjectionMatches(record, rebuilt);
	return {
		...rebuilt,
		currentCheckpointId: record.currentCheckpointId,
	};
}

function projectSessionTitle(current: SessionTitleState, event: SessionEventRecord): SessionTitleState {
	let payload: unknown;
	try {
		payload = JSON.parse(event.payloadJson) as unknown;
	} catch {
		throw new SessionStoreError("projection_invalid", `invalid title event payload at sequence ${event.sequence}`);
	}
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
		throw new SessionStoreError("projection_invalid", `title event payload is not an object at sequence ${event.sequence}`);
	}
	const value = payload as Record<string, unknown>;
	const title = typeof value.title === "string" ? value.title : undefined;
	const source = isSessionTitleSource(value.source) ? value.source : undefined;
	if (title === undefined || source === undefined || normalizeSessionTitle(title) !== title) {
		throw new SessionStoreError("projection_invalid", `title event contains an invalid title state at sequence ${event.sequence}`);
	}
	if (source === "auto" && value.expectedTitle !== null) {
		throw new SessionStoreError(
			"projection_invalid",
			`auto title event expectedTitle must be null as the unnamed-session CAS marker at sequence ${event.sequence}`,
		);
	}
	if (value.expectedTitle !== undefined && value.expectedTitle !== null) {
		throw new SessionStoreError("projection_invalid", `title event expectedTitle is invalid at sequence ${event.sequence}`);
	}
	if (!Number.isSafeInteger(event.createdAtMs) || event.createdAtMs < 0) {
		throw new SessionStoreError("projection_invalid", `title event timestamp is invalid at sequence ${event.sequence}`);
	}
	const previousTitle = value.previousTitle;
	if (previousTitle !== undefined && (typeof previousTitle !== "string" || normalizeSessionTitle(previousTitle) !== previousTitle)) {
		throw new SessionStoreError("projection_invalid", `title event previousTitle is invalid at sequence ${event.sequence}`);
	}
	if (current.title === undefined && previousTitle !== undefined) {
		throw new SessionStoreError("projection_invalid", `title event has an unexpected previous title at sequence ${event.sequence}`);
	}
	if (current.title !== undefined && previousTitle !== current.title) {
		throw new SessionStoreError("projection_invalid", `title event previousTitle does not match the projected title at sequence ${event.sequence}`);
	}
	if (source === "auto" && current.title !== undefined) {
		throw new SessionStoreError("projection_invalid", `auto title event overwrites an existing title at sequence ${event.sequence}`);
	}
	const modelRef = value.modelRef;
	if (modelRef !== undefined && !isSafeTitleModelRef(modelRef)) {
		throw new SessionStoreError("projection_invalid", `title event model reference is invalid at sequence ${event.sequence}`);
	}
	return { title, titleSource: source, titleUpdatedAtMs: event.createdAtMs };
}

function isSafeTitleModelRef(value: unknown): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return typeof candidate.providerId === "string"
		&& typeof candidate.modelId === "string"
		&& boundedTitleRef(candidate.providerId)
		&& boundedTitleRef(candidate.modelId)
		&& Object.keys(candidate).every((key) => key === "providerId" || key === "modelId");
}

function assertProjectionMatches(record: SessionCatalogRecord, rebuilt: SessionProjection): void {
	if (
		record.status !== rebuilt.status
		|| record.headSequence !== rebuilt.headSequence
		|| record.driverRevision !== rebuilt.driverRevision
		|| record.title !== rebuilt.title
		|| record.titleSource !== rebuilt.titleSource
		|| record.titleUpdatedAtMs !== rebuilt.titleUpdatedAtMs
		|| !isValidSessionTitleState({ title: record.title, titleSource: record.titleSource, titleUpdatedAtMs: record.titleUpdatedAtMs })
	) {
		throw new SessionStoreError("projection_invalid", `session projection drift detected: ${record.sessionId}`);
	}
}
