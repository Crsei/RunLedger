/**
 * S1 拆分:SQLite row -> typed record 纯映射(无事务、无 fence)。
 *
 * 只接收 row 与窄 database 查询结果;调用方(各 repository / projection)
 * 负责 admission、owner fence 与事务边界。
 */

import type { CommandAttemptReceipt } from "../../runtime/session-owner/types.ts";
import { normalizeSessionTitle } from "../../runtime/session-owner/title.ts";
import type { RuntimeDigest } from "../../runtime/protocol/foundation.ts";
import type { SessionCatalogRecord, SessionEventRecord } from "./session-store.ts";

export function rowToEvent(row: Record<string, unknown>): SessionEventRecord {
	return {
		sessionId: String(row.session_id),
		sequence: Number(row.sequence),
		eventId: String(row.event_id),
		ownerGeneration: Number(row.owner_generation),
		eventType: String(row.event_type),
		payloadJson: String(row.payload_json),
		previousEventHash: row.previous_event_hash === null ? null : String(row.previous_event_hash),
		currentEventHash: String(row.current_event_hash),
		createdAtMs: Number(row.created_at_ms),
	};
}

export function rowToAttemptReceipt(row: Record<string, unknown>): CommandAttemptReceipt {
	return {
		receiptId: String(row.receipt_id) as CommandAttemptReceipt["receiptId"],
		sessionId: String(row.session_id) as CommandAttemptReceipt["sessionId"],
		commandId: String(row.command_id) as CommandAttemptReceipt["commandId"],
		attemptId: String(row.attempt_id) as CommandAttemptReceipt["attemptId"],
		originGeneration: Number(row.origin_generation),
		settledGeneration: row.settled_generation === null ? undefined : Number(row.settled_generation),
		effectClass: String(row.effect_class) as CommandAttemptReceipt["effectClass"],
		outcome: String(row.outcome) as CommandAttemptReceipt["outcome"],
		resultDigest: row.result_digest === null ? undefined : { algorithm: "sha256", digest: String(row.result_digest) as RuntimeDigest["digest"] },
		evidenceDigest: row.evidence_digest === null ? undefined : { algorithm: "sha256", digest: String(row.evidence_digest) as RuntimeDigest["digest"] },
		createdAtMs: Number(row.created_at_ms),
	};
}

export function rowToCatalog(row: Record<string, unknown>): SessionCatalogRecord {
	return {
		sessionId: String(row.session_id),
		workspaceId: String(row.workspace_id),
		repositoryId: String(row.repository_id),
		status: String(row.status),
		createdAtMs: Number(row.created_at_ms),
		updatedAtMs: Number(row.updated_at_ms),
		headSequence: Number(row.head_sequence),
		currentCheckpointId: row.current_checkpoint_id === null ? undefined : String(row.current_checkpoint_id),
		lastDriverClientId: row.last_driver_client_id === null ? undefined : String(row.last_driver_client_id),
		driverRevision: Number(row.driver_revision),
		worktreeLocator: row.worktree_locator_json === null ? undefined : String(row.worktree_locator_json),
		settingsDigest: String(row.settings_digest),
		title: row.title === null || row.title === undefined ? undefined : String(row.title),
		titleSource: row.title_source === "auto" || row.title_source === "user" ? row.title_source : undefined,
		titleUpdatedAtMs: row.title_updated_at_ms === null || row.title_updated_at_ms === undefined ? undefined : Number(row.title_updated_at_ms),
		firstUserMessagePreview: row.first_user_message_preview === null || row.first_user_message_preview === undefined
			? undefined
			: normalizeSessionTitle(String(row.first_user_message_preview)) ?? undefined,
	};
}

/** Catalog projection owns the bounded first-user-message fallback; TUI never reads events directly. */
export function catalogSelectSql(): string {
	return `SELECT sessions.*,
		(SELECT COALESCE(
			json_extract(event.payload_json, '$.payload.message.content[0].text'),
			json_extract(event.payload_json, '$.payload.content[0].text')
		)
		 FROM session_events AS event
		 WHERE event.session_id = sessions.session_id
		   AND event.event_type = 'ledger.message'
		   AND (json_extract(event.payload_json, '$.payload.message.role') = 'user'
		     OR json_extract(event.payload_json, '$.payload.role') = 'user')
		 ORDER BY event.sequence
		 LIMIT 1) AS first_user_message_preview
	FROM sessions`;
}

export function boundedTitleRef(value: string): boolean {
	return value.length > 0 && value.length <= 160 && !/[\u0000-\u001F\u007F-\u009F]/u.test(value);
}
