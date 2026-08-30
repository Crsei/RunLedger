/**
 * S1 拆分:checkpoint cache 域 repository(可整体删除的重建加速层)。
 *
 * checkpoint 只是 acceleration cache:删除后必须能从 Event + Receipt 从
 * genesis 重建(rebuildFromEvents),cache 不能反向授权 mutation。
 */

import type { SessionDatabase } from "./database.ts";
import { verifyOwnerFence } from "./event-append.ts";
import type { OwnerFence, SessionCheckpointDescriptor } from "../../runtime/session-owner/types.ts";
import type { RuntimeDigest } from "../../runtime/protocol/foundation.ts";
import type { CheckpointCacheEntry } from "./session-store.ts";
import { SessionStoreError } from "./session-store-error.ts";

export class CheckpointRepository {
	private readonly db: SessionDatabase;

	public constructor(db: SessionDatabase) {
		this.db = db;
	}

	public putCheckpoint(fence: OwnerFence, checkpoint: SessionCheckpointDescriptor, snapshotJson: string): void {
		this.db.withImmediateTransactionSync((tx) => {
			tx.querySingle("SELECT 1 FROM store_control WHERE singleton_id = 1 AND admission = 'ready'");
			if (!verifyOwnerFence(tx, fence)) {
				throw new SessionStoreError("owner_fenced", "owner fenced");
			}
			tx.runSync("DELETE FROM session_checkpoints WHERE checkpoint_id = ?", [checkpoint.checkpointId]);
			tx.runSync(
				`INSERT INTO session_checkpoints
				 (checkpoint_id, session_id, owner_generation, boundary, source_sequence,
				  snapshot_json, snapshot_digest, created_at_ms)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					checkpoint.checkpointId,
					checkpoint.sessionId,
					checkpoint.ownerGeneration,
					checkpoint.boundary,
					checkpoint.sourceSequence,
					snapshotJson,
					checkpoint.snapshotDigest.digest,
					checkpoint.createdAtMs,
				],
			);
			tx.runSync("UPDATE sessions SET current_checkpoint_id = ?, updated_at_ms = ? WHERE session_id = ?", [
				checkpoint.checkpointId,
				Date.now(),
				checkpoint.sessionId,
			]);
		});
	}

	public getCheckpoint(checkpointId: string): CheckpointCacheEntry | undefined {
		const row = this.db.querySingle("SELECT * FROM session_checkpoints WHERE checkpoint_id = ?", [checkpointId]);
		if (!row) return undefined;
		return {
			checkpointId: String(row.checkpoint_id) as CheckpointCacheEntry["checkpointId"],
			sessionId: String(row.session_id) as CheckpointCacheEntry["sessionId"],
			ownerGeneration: Number(row.owner_generation),
			boundary: String(row.boundary) as CheckpointCacheEntry["boundary"],
			sourceSequence: Number(row.source_sequence),
			snapshotDigest: { algorithm: "sha256", digest: String(row.snapshot_digest) as RuntimeDigest["digest"] },
			createdAtMs: Number(row.created_at_ms),
			snapshotJson: String(row.snapshot_json),
		};
	}

	/** cache 可整体删除:删除后必须能从 genesis replay 重建相同 projection。 */
	public clearCheckpoints(sessionId: string): void {
		this.db.withImmediateTransactionSync((tx) => {
			tx.runSync("DELETE FROM session_checkpoints WHERE session_id = ?", [sessionId]);
			tx.runSync("UPDATE sessions SET current_checkpoint_id = NULL, updated_at_ms = ? WHERE session_id = ?", [Date.now(), sessionId]);
		});
	}
}
