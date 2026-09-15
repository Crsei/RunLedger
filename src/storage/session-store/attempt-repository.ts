/**
 * S1 拆分:command intent / attempt / receipt 域 repository。
 *
 * intent 不可变、receipt append-only;settledGeneration >= originGeneration
 * 由 guard 保证。只接收已打开的 SessionDatabase 端口。
 */

import type { SessionDatabase } from "./database.ts";
import { verifyOwnerFence } from "./event-append.ts";
import { rowToAttemptReceipt } from "./row-mappers.ts";
import { createRuntimeId } from "../../runtime/protocol/ids.ts";
import { canonicalDigest } from "../../runtime/protocol/canonical-json.ts";
import type { CommandAttemptBeginInput, CommandAttemptBeginResult, CommandAttemptReceipt, CommandIntent, OwnerFence } from "../../runtime/session-owner/types.ts";
import { SessionStoreError } from "./session-store-error.ts";

function isReplayableAttemptOutcome(outcome: CommandAttemptReceipt["outcome"]): boolean {
	return outcome === "committed" || outcome === "rejected" || outcome === "verified";
}

export class AttemptRepository {
	private readonly db: SessionDatabase;

	public constructor(db: SessionDatabase) {
		this.db = db;
	}

	/** §4.3:不可变 command intent。同 ID 重复且 digest 一致视为幂等成功。 */
	public beginCommandAttempt(fence: OwnerFence, input: CommandAttemptBeginInput): CommandAttemptBeginResult {
		let result: CommandAttemptBeginResult | undefined;
		this.db.withImmediateTransactionSync((tx) => {
			tx.querySingle("SELECT 1 FROM store_control WHERE singleton_id = 1 AND admission = 'ready'");
			if (!verifyOwnerFence(tx, fence)) throw new SessionStoreError("owner_fenced", "owner fenced");
			if (input.sessionId !== fence.sessionId || input.originGeneration !== fence.generation) {
				throw new SessionStoreError("invalid_input", "attempt identity does not match the current owner fence");
			}
			if (!input.commandId.startsWith("command_") || !input.attemptId.startsWith("attempt_")) {
				throw new SessionStoreError("invalid_input", "attempt identity has an invalid runtime id");
			}

			const existing = tx.querySingle(
				"SELECT request_digest FROM commands WHERE session_id = ? AND command_id = ?",
				[input.sessionId, input.commandId],
			);
			if (existing !== undefined) {
				if (String(existing.request_digest) !== input.requestDigest.digest) {
					result = { status: "conflict", commandId: input.commandId, attemptId: input.attemptId };
					return;
				}
				const receipts = tx
					.queryAll(
						"SELECT * FROM command_attempt_receipts WHERE session_id = ? AND command_id = ? ORDER BY created_at_ms, receipt_id",
						[input.sessionId, input.commandId],
					)
					.map((row) => rowToAttemptReceipt(row));
				const latest = receipts.at(-1);
				if (latest !== undefined && isReplayableAttemptOutcome(latest.outcome)) {
					result = {
						status: "replay_committed",
						commandId: input.commandId,
						attemptId: latest.attemptId,
						receipt: latest,
					};
					return;
				}
				result = {
					status: "recovery_required",
					commandId: input.commandId,
					attemptId: latest?.attemptId ?? input.attemptId,
					existingReceipts: receipts,
				};
				return;
			}

			tx.runSync(
				"INSERT INTO commands (session_id, command_id, request_digest, origin_generation, created_at_ms) VALUES (?, ?, ?, ?, ?)",
				[input.sessionId, input.commandId, input.requestDigest.digest, input.originGeneration, input.createdAtMs],
			);
			const receiptId = createRuntimeId(
				"receipt",
				`start-${canonicalDigest({ sessionId: input.sessionId, commandId: input.commandId, attemptId: input.attemptId }).slice(0, 32)}`,
			);
			tx.runSync(
				`INSERT INTO command_attempt_receipts
				 (receipt_id, session_id, command_id, attempt_id, origin_generation, settled_generation,
				  effect_class, outcome, result_json, result_digest, evidence_digest, created_at_ms)
				 VALUES (?, ?, ?, ?, ?, NULL, ?, 'started', NULL, NULL, NULL, ?)`,
				[receiptId, input.sessionId, input.commandId, input.attemptId, input.originGeneration, input.effectClass, input.createdAtMs],
			);
			result = { status: "started", commandId: input.commandId, attemptId: input.attemptId };
		});
		return result!;
	}

	/** §4.3:不可变 command intent。同 ID 重复且 digest 一致视为幂等成功。 */
	public recordCommandIntent(fence: OwnerFence, intent: CommandIntent): void {
		this.db.withImmediateTransactionSync((tx) => {
			tx.querySingle("SELECT 1 FROM store_control WHERE singleton_id = 1 AND admission = 'ready'");
			if (!verifyOwnerFence(tx, fence)) {
				throw new SessionStoreError("owner_fenced", "owner fenced");
			}
			const existing = tx.querySingle("SELECT request_digest FROM commands WHERE session_id = ? AND command_id = ?", [
				intent.sessionId,
				intent.commandId,
			]);
			if (existing) {
				if (String(existing.request_digest) !== intent.requestDigest.digest) {
					throw new SessionStoreError("command_intent_conflict", "command intent exists with a different request digest");
				}
				return;
			}
			tx.runSync(
				"INSERT INTO commands (session_id, command_id, request_digest, origin_generation, created_at_ms) VALUES (?, ?, ?, ?, ?)",
				[intent.sessionId, intent.commandId, intent.requestDigest.digest, intent.originGeneration, intent.createdAtMs],
			);
		});
	}

	/** §4.3:append-only attempt receipt;settledGeneration >= originGeneration 由 guard 保证。 */
	public appendAttemptReceipt(fence: OwnerFence, receipt: CommandAttemptReceipt): void {
		this.db.withImmediateTransactionSync((tx) => appendAttemptReceiptInTransaction(tx, fence, receipt));
	}

	public listAttemptReceipts(sessionId: string, commandId: string): readonly CommandAttemptReceipt[] {
		return this.db
			.queryAll("SELECT * FROM command_attempt_receipts WHERE session_id = ? AND command_id = ? ORDER BY created_at_ms, receipt_id", [
				sessionId,
				commandId,
			])
			.map((row) => rowToAttemptReceipt(row));
	}

	/** §7.3:某 Session 全部 attempt receipt(恢复评估用,只读 projection)。 */
	public listAllAttemptReceipts(sessionId: string): readonly CommandAttemptReceipt[] {
		return this.db
			.queryAll("SELECT * FROM command_attempt_receipts WHERE session_id = ? ORDER BY created_at_ms, receipt_id", [sessionId])
			.map((row) => rowToAttemptReceipt(row));
	}
}

/** 只供 SessionStore 已持有的事务使用，避免领域事件和收口 receipt 分离。 */
export function appendAttemptReceiptInTransaction(tx: SessionDatabase, fence: OwnerFence, receipt: CommandAttemptReceipt): void {
	tx.querySingle("SELECT 1 FROM store_control WHERE singleton_id = 1 AND admission = 'ready'");
	if (!verifyOwnerFence(tx, fence)) {
		throw new SessionStoreError("owner_fenced", "owner fenced");
	}
	const intent = tx.querySingle("SELECT origin_generation FROM commands WHERE session_id = ? AND command_id = ?", [
		receipt.sessionId,
		receipt.commandId,
	]);
	if (!intent) throw new SessionStoreError("command_intent_conflict", "attempt receipt requires a recorded command intent");
	if (Number(intent.origin_generation) !== receipt.originGeneration) {
		throw new SessionStoreError("receipt_origin_mismatch", "receipt origin generation does not match the intent");
	}
	tx.runSync(
		`INSERT INTO command_attempt_receipts
		 (receipt_id, session_id, command_id, attempt_id, origin_generation, settled_generation,
		  effect_class, outcome, result_json, result_digest, evidence_digest, created_at_ms)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
		[
			receipt.receiptId,
			receipt.sessionId,
			receipt.commandId,
			receipt.attemptId,
			receipt.originGeneration,
			receipt.settledGeneration ?? null,
			receipt.effectClass,
			receipt.outcome,
			receipt.resultDigest?.digest ?? null,
			receipt.evidenceDigest?.digest ?? null,
			receipt.createdAtMs,
		],
	);
}
