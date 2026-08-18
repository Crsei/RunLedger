/** 显式 offline Session status cache 修复；不改写或补造 authority event。 */

import type { SessionDatabase } from "./database.ts";
import { countActiveOwners, readStoreHeader, type MigrationGateHandle } from "./schema-compatibility.ts";
import { projectSessionStatus, sessionEventHash, SessionStore } from "./session-store.ts";

export const SESSION_STATUS_PROJECTION_REPAIR_VERSION = 1 as const;

export type SessionStatusProjectionRepairResult =
	| { readonly ok: true; readonly repairVersion: 1; readonly scanned: number; readonly repaired: number }
	| { readonly ok: false; readonly code: "gate_not_held" | "active_owners_present" | "invalid_repair_version" | "projection_invalid"; readonly detail: string };

export function applySessionStatusProjectionRepair(
	db: SessionDatabase,
	options: { readonly gate: MigrationGateHandle; readonly repairVersion: number },
): SessionStatusProjectionRepairResult {
	if (options.repairVersion !== SESSION_STATUS_PROJECTION_REPAIR_VERSION) {
		return { ok: false, code: "invalid_repair_version", detail: `unsupported Session status projection repair ${options.repairVersion}` };
	}
	const header = readStoreHeader(db);
	if (!header.ok || header.header.admission !== "migration_blocked" || header.header.migrationEpoch !== options.gate.migrationEpoch) {
		return { ok: false, code: "gate_not_held", detail: "matching offline migration gate is required" };
	}
	let scanned = 0;
	let repaired = 0;
	try {
		db.withImmediateTransactionSync((tx) => {
			const current = readStoreHeader(tx);
			if (!current.ok || current.header.admission !== "migration_blocked" || current.header.migrationEpoch !== options.gate.migrationEpoch) {
				throw new ProjectionRepairError("gate_not_held", "offline migration gate changed before repair");
			}
			const activeOwners = countActiveOwners(tx);
			if (activeOwners > 0) throw new ProjectionRepairError("active_owners_present", `cannot repair while ${activeOwners} owners are active`);
			const sessions = tx.queryAll("SELECT session_id, status, head_sequence, title, title_source, title_updated_at_ms FROM sessions ORDER BY session_id");
			for (const session of sessions) {
				scanned += 1;
				const sessionId = String(session.session_id);
				const events = tx.queryAll("SELECT * FROM session_events WHERE session_id = ? ORDER BY sequence", [sessionId]);
				let previous: string | null = null;
				let projectedStatus = "active";
				for (let index = 0; index < events.length; index += 1) {
					const event = events[index]!;
					const sequence = Number(event.sequence);
					if (sequence !== index + 1 || (event.previous_event_hash === null ? null : String(event.previous_event_hash)) !== previous) {
						throw new ProjectionRepairError("projection_invalid", `Session ${sessionId} event sequence is invalid`);
					}
					const payloadJson = String(event.payload_json);
					const expected = sessionEventHash(sessionId, sequence, String(event.event_id), String(event.event_type), payloadJson, previous);
					if (expected !== String(event.current_event_hash)) {
						throw new ProjectionRepairError("projection_invalid", `Session ${sessionId} event hash is invalid`);
					}
					previous = expected;
					projectedStatus = projectSessionStatus(projectedStatus, String(event.event_type), payloadJson);
				}
				if (Number(session.head_sequence) !== events.length) {
					throw new ProjectionRepairError("projection_invalid", `Session ${sessionId} cached head does not match its event stream`);
				}
				let rebuilt: ReturnType<SessionStore["rebuildFromEvents"]>;
				try {
					rebuilt = new SessionStore(tx).rebuildFromEvents(sessionId);
				} catch (error) {
					throw new ProjectionRepairError("projection_invalid", error instanceof Error ? error.message : String(error));
				}
				const rowTitle = session.title === null || session.title === undefined ? undefined : String(session.title);
				const rowTitleSource = session.title_source === "auto" || session.title_source === "user" ? session.title_source : undefined;
				const rowTitleUpdatedAtMs = session.title_updated_at_ms === null || session.title_updated_at_ms === undefined
					? undefined
					: Number(session.title_updated_at_ms);
				if (
					rowTitle !== rebuilt.title
					|| rowTitleSource !== rebuilt.titleSource
					|| rowTitleUpdatedAtMs !== rebuilt.titleUpdatedAtMs
				) {
					throw new ProjectionRepairError("projection_invalid", `Session ${sessionId} title projection does not match its event stream`);
				}
				const owner = tx.querySingle("SELECT state FROM session_owners WHERE session_id = ?", [sessionId]);
				if (owner?.state === "unowned" && projectedStatus !== "paused" && projectedStatus !== "failed" && projectedStatus !== "completed") {
					throw new ProjectionRepairError("projection_invalid", `Session ${sessionId} unowned state has no terminal lifecycle event`);
				}
				if (String(session.status) !== projectedStatus) {
					tx.runSync("UPDATE sessions SET status = ?, updated_at_ms = ? WHERE session_id = ?", [projectedStatus, Date.now(), sessionId]);
					repaired += 1;
				}
			}
			tx.runSync("UPDATE store_control SET admission = 'ready', updated_at_ms = ? WHERE singleton_id = 1", [Date.now()]);
		});
	} catch (error) {
		if (error instanceof ProjectionRepairError) return { ok: false, code: error.code, detail: error.message };
		return { ok: false, code: "projection_invalid", detail: error instanceof Error ? error.message : String(error) };
	}
	return { ok: true, repairVersion: SESSION_STATUS_PROJECTION_REPAIR_VERSION, scanned, repaired };
}

class ProjectionRepairError extends Error {
	public readonly code: "gate_not_held" | "active_owners_present" | "projection_invalid";
	public constructor(code: "gate_not_held" | "active_owners_present" | "projection_invalid", message: string) {
		super(message);
		this.name = "ProjectionRepairError";
		this.code = code;
	}
}
