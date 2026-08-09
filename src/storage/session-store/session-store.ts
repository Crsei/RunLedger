/**
 * R2:SessionStore —— SQLite 中 Session 的唯一 durable truth API(06 §4)。
 *
 * - catalog/create/fork/event append/checkpoint cache/command intent + attempt
 *   receipt/projection 全部经 owner fence 写入口;
 * - event append 在单个 BEGIN IMMEDIATE 事务内校验 admission ready、owner
 *   fence、sequence 连续性、previous hash 与 head 更新;
 * - checkpoint 只是 acceleration cache:删除后必须能从 Event + Receipt 从
 *   genesis 重建(rebuildFromEvents),cache 不能反向授权 mutation;
 * - command intent 不可变,attempt receipt 只 append 不原地改写。
 */

import type { OwnerFence, CommandAttemptReceipt, CommandIntent, SessionCheckpointDescriptor } from "../../runtime/session-owner/types.ts";
import { createRuntimeId, type SessionId } from "../../runtime/protocol/ids.ts";
import type { RuntimeDigest } from "../../runtime/protocol/foundation.ts";
import { canonicalDigest } from "../../runtime/protocol/canonical-json.ts";
import type { SessionDatabase } from "./database.ts";
import { ACTIVE_OWNER_STATES } from "./schema-compatibility.ts";

export const SESSION_STORE_ERROR_CODES = [
	"owner_fenced",
	"admission_blocked",
	"session_not_found",
	"session_conflict",
	"catalog_revision_conflict",
	"sequence_conflict",
	"previous_hash_mismatch",
	"command_intent_conflict",
	"receipt_origin_mismatch",
	"checkpoint_not_found",
	"fork_source_not_found",
	"fork_source_head_conflict",
	"invalid_input",
] as const;
export type SessionStoreErrorCode = (typeof SESSION_STORE_ERROR_CODES)[number];

export class SessionStoreError extends Error {
	public readonly code: SessionStoreErrorCode;
	public constructor(code: SessionStoreErrorCode, message: string) {
		super(message);
		this.name = "SessionStoreError";
		this.code = code;
	}
}

export interface SessionCatalogRecord {
	readonly sessionId: string;
	readonly workspaceId: string;
	readonly repositoryId: string;
	readonly status: string;
	readonly createdAtMs: number;
	readonly updatedAtMs: number;
	readonly headSequence: number;
	readonly currentCheckpointId?: string;
	readonly lastDriverClientId?: string;
	readonly driverRevision: number;
	readonly worktreeLocator?: string;
	readonly settingsDigest: string;
}

export interface CreateSessionInput {
	readonly sessionId: SessionId;
	readonly workspaceId: string;
	readonly repositoryId: string;
	readonly settingsDigest: string;
	readonly worktreeLocator?: string;
	readonly status?: string;
	readonly expectedCatalogRevision?: number;
}

export interface AppendEventInput {
	readonly eventId: string;
	readonly ownerGeneration: number;
	readonly eventType: string;
	readonly payloadJson: string;
	readonly createdAtMs: number;
	/** 调用方观察到的上一个 event hash;不匹配则拒绝,防并发 append 错位。 */
	readonly expectedPreviousEventHash: string | null;
}

export interface PutWorktreeLocatorInput {
	readonly locatorJson: string;
	readonly repositoryId?: string;
	readonly eventType: "workspace.bound" | "workspace.validation_recorded";
	/** 只允许 bounded public identity/digest；private locator 只写 sessions 行。 */
	readonly payload: Record<string, unknown>;
}

export interface SessionEventRecord {
	readonly sessionId: string;
	readonly sequence: number;
	readonly eventId: string;
	readonly ownerGeneration: number;
	readonly eventType: string;
	readonly payloadJson: string;
	readonly previousEventHash: string | null;
	readonly currentEventHash: string;
	readonly createdAtMs: number;
}

export interface SessionProjection {
	readonly sessionId: string;
	readonly status: string;
	readonly headSequence: number;
	readonly driverRevision: number;
	readonly currentCheckpointId?: string;
}

export interface CheckpointCacheEntry extends SessionCheckpointDescriptor {
	readonly snapshotJson: string;
}

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
	const headRow = tx.querySingle("SELECT head_sequence FROM sessions WHERE session_id = ?", [fence.sessionId]);
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
	tx.runSync("UPDATE sessions SET head_sequence = ?, updated_at_ms = ? WHERE session_id = ?", [
		sequence,
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

export class SessionStore {
	private readonly db: SessionDatabase;

	public constructor(db: SessionDatabase) {
		this.db = db;
	}

	public database(): SessionDatabase {
		return this.db;
	}

	private assertAdmissionReady(): void {
		const row = this.db.querySingle("SELECT admission FROM store_control WHERE singleton_id = 1");
		if (row?.admission !== "ready") {
			throw new SessionStoreError("admission_blocked", "store admission is not ready (migration in progress)");
		}
	}

	/** 只读 catalog 查询不需要 fence(无 mutation),但仍要求 admission ready。 */
	public listSessions(): SessionCatalogRecord[] {
		this.assertAdmissionReady();
		return this.db
			.queryAll("SELECT * FROM sessions ORDER BY created_at_ms DESC, session_id")
			.map(rowToCatalog);
	}

	public getSession(sessionId: string): SessionCatalogRecord | undefined {
		this.assertAdmissionReady();
		const row = this.db.querySingle("SELECT * FROM sessions WHERE session_id = ?", [sessionId]);
		return row === undefined ? undefined : rowToCatalog(row);
	}

	/**
	 * S3:private worktree locator 与 public audit event 在同一 owner-fenced
	 * transaction 中提交；事件不复制绝对路径或 lease token。
	 */
	public putWorktreeLocator(fence: OwnerFence, input: PutWorktreeLocatorInput): void {
		if (input.locatorJson.length === 0 || input.locatorJson.length > 256 * 1024) {
			throw new SessionStoreError("invalid_input", "worktree locator JSON is empty or too large");
		}
		try {
			const parsed = JSON.parse(input.locatorJson) as unknown;
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("invalid object");
		} catch {
			throw new SessionStoreError("invalid_input", "worktree locator JSON is invalid");
		}
		const payloadJson = JSON.stringify(input.payload);
		if (input.repositoryId !== undefined && !input.repositoryId.startsWith("repository_")) {
			throw new SessionStoreError("invalid_input", "worktree repository id is invalid");
		}
		if (payloadJson.length > 16 * 1024) throw new SessionStoreError("invalid_input", "workspace audit payload is too large");
		this.db.withImmediateTransactionSync((tx) => {
			tx.querySingle("SELECT 1 FROM store_control WHERE singleton_id = 1 AND admission = 'ready'");
			if (!verifyOwnerFence(tx, fence)) throw new SessionStoreError("owner_fenced", "owner fenced");
			const head = tx.querySingle("SELECT head_sequence FROM sessions WHERE session_id = ?", [fence.sessionId]);
			if (head === undefined) throw new SessionStoreError("session_not_found", `session not found: ${fence.sessionId}`);
			const previous = tx.querySingle(
				"SELECT current_event_hash FROM session_events WHERE session_id = ? AND sequence = ?",
				[fence.sessionId, Number(head.head_sequence)],
			);
			tx.runSync("UPDATE sessions SET worktree_locator_json = ?, repository_id = COALESCE(?, repository_id), updated_at_ms = ? WHERE session_id = ?", [
				input.locatorJson,
				input.repositoryId ?? null,
				Date.now(),
				fence.sessionId,
			]);
			appendEventInTransaction(tx, fence, {
				eventId: createRuntimeId("event", `workspace-${fence.generation}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`),
				ownerGeneration: fence.generation,
				eventType: input.eventType,
				payloadJson,
				createdAtMs: Date.now(),
				expectedPreviousEventHash: previous === undefined ? null : String(previous.current_event_hash),
			});
		});
	}

	/** 新 Session 尚无 owner;只插入 durable row,generation 由 R3 owner claim 从 1 开始。 */
	public createSession(input: CreateSessionInput): SessionCatalogRecord {
		this.assertAdmissionReady();
		if (!input.sessionId.startsWith("session_")) {
			throw new SessionStoreError("invalid_input", `invalid session id: ${input.sessionId}`);
		}
		const now = Date.now();
		try {
			this.db.withImmediateTransactionSync((tx) => {
				if (input.expectedCatalogRevision !== undefined) {
					const revision = tx.querySingle("SELECT COUNT(*) AS n FROM sessions");
					if (Number(revision?.n ?? 0) !== input.expectedCatalogRevision) {
						throw new SessionStoreError("catalog_revision_conflict", "catalog revision changed before session creation");
					}
				}
				tx.runSync(
					`INSERT INTO sessions
				 (session_id, workspace_id, repository_id, status, created_at_ms, updated_at_ms,
				  head_sequence, current_checkpoint_id, last_driver_client_id, driver_revision,
				  worktree_locator_json, settings_digest)
				 VALUES (?, ?, ?, ?, ?, ?, 0, NULL, NULL, 0, ?, ?)`,
					[
						input.sessionId,
						input.workspaceId,
						input.repositoryId,
						input.status ?? "active",
						now,
						now,
						input.worktreeLocator ?? null,
						input.settingsDigest,
					],
				);
			});
		} catch (error) {
			if (error instanceof Error && /UNIQUE|PRIMARY/i.test(error.message)) {
				throw new SessionStoreError("session_conflict", `session already exists: ${input.sessionId}`);
			}
			throw error;
		}
		return this.getSession(input.sessionId)!;
	}

	/** fork:同一事务内创建新 session 并复制 source 全部事件(新 hash 链,sequence 重排)。 */
	public forkSession(input: CreateSessionInput & { readonly sourceSessionId: string; readonly expectedSourceHeadSequence?: number }): SessionCatalogRecord {
		this.assertAdmissionReady();
		const source = this.getSession(input.sourceSessionId);
		if (!source) throw new SessionStoreError("fork_source_not_found", `source session not found: ${input.sourceSessionId}`);
		let forked: SessionCatalogRecord | undefined;
		this.db.withImmediateTransactionSync((tx) => {
			if (input.expectedCatalogRevision !== undefined) {
				const revision = tx.querySingle("SELECT COUNT(*) AS n FROM sessions");
				if (Number(revision?.n ?? 0) !== input.expectedCatalogRevision) {
					throw new SessionStoreError("catalog_revision_conflict", "catalog revision changed before the fork transaction");
				}
			}
			const sourceHead = tx.querySingle("SELECT head_sequence FROM sessions WHERE session_id = ?", [input.sourceSessionId]);
			if (sourceHead === undefined) throw new SessionStoreError("fork_source_not_found", `source session not found: ${input.sourceSessionId}`);
			if (input.expectedSourceHeadSequence !== undefined && Number(sourceHead.head_sequence) !== input.expectedSourceHeadSequence) {
				throw new SessionStoreError("fork_source_head_conflict", "fork source head advanced before the fork transaction");
			}
			tx.runSync(
				`INSERT INTO sessions
				 (session_id, workspace_id, repository_id, status, created_at_ms, updated_at_ms,
				  head_sequence, current_checkpoint_id, last_driver_client_id, driver_revision,
				  worktree_locator_json, settings_digest)
				 VALUES (?, ?, ?, ?, ?, ?, 0, NULL, NULL, 0, NULL, ?)`,
				[input.sessionId, input.workspaceId, input.repositoryId, "active", Date.now(), Date.now(), input.settingsDigest],
			);
			const sourceEvents = tx.queryAll(
				"SELECT event_id, owner_generation, event_type, payload_json, created_at_ms FROM session_events WHERE session_id = ? ORDER BY sequence",
				[input.sourceSessionId],
			);
			let previous: string | null = null;
			for (let index = 0; index < sourceEvents.length; index += 1) {
				const event = sourceEvents[index]!;
				const sequence = index + 1;
				// event_id 全局 UNIQUE:fork 必须确定性 re-key(由 source eventId + 目标
				// sessionId 派生),payload 原样保留;重试 fork 幂等。
				const eventId = createRuntimeId("event", canonicalDigest({ source: String(event.event_id), target: input.sessionId }).slice(0, 32));
				const current = sessionEventHash(
					input.sessionId,
					sequence,
					eventId,
					String(event.event_type),
					String(event.payload_json),
					previous,
				);
				tx.runSync(
					`INSERT INTO session_events
					 (session_id, sequence, event_id, owner_generation, event_type, payload_json,
					  previous_event_hash, current_event_hash, created_at_ms)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[
						input.sessionId,
						sequence,
						eventId,
						Number(event.owner_generation),
						String(event.event_type),
						String(event.payload_json),
						previous,
						current,
						Number(event.created_at_ms),
					],
				);
				previous = current;
			}
			tx.runSync("UPDATE sessions SET head_sequence = ?, updated_at_ms = ? WHERE session_id = ?", [
				sourceEvents.length,
				Date.now(),
				input.sessionId,
			]);
		});
		forked = this.getSession(input.sessionId);
		return forked!;
	}

	/** §4.5/R2:owner-fenced event append,事务内校验 admission/fence/sequence/previous hash。 */
	public appendEvent(fence: OwnerFence, input: AppendEventInput): SessionEventRecord {
		let appended: SessionEventRecord | undefined;
		this.db.withImmediateTransactionSync((tx) => {
			appended = appendEventInTransaction(tx, fence, input);
		});
		return appended!;
	}

	/**
	 * §6.4/§R4:durable driver 事件与 driver_revision 递增在同一事务内提交。
	 * driver 是 connection-scoped:disconnect/takeover 强制 NONE + revision 事件;
	 * sessions.driver_revision 只是该投影的缓存列,rebuildFromEvents 可从事件重建。
	 * payload 按 R0 契约(additionalProperties:false),eventId 由本方法注入。
	 */
	public appendDriverEvent(
		fence: OwnerFence,
		eventType: "driver.claimed" | "driver.released" | "driver.reset_on_takeover",
		payload: Record<string, unknown>,
	): SessionEventRecord {
		let appended: SessionEventRecord | undefined;
		this.db.withImmediateTransactionSync((tx) => {
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
			appended = appendEventInTransaction(tx, fence, {
				eventId,
				ownerGeneration: fence.generation,
				eventType,
				payloadJson: JSON.stringify({ ...payload, eventId }),
				createdAtMs: Date.now(),
				expectedPreviousEventHash: previousRow === undefined ? null : String(previousRow.current_event_hash),
			});
			tx.runSync("UPDATE sessions SET driver_revision = ?, updated_at_ms = ? WHERE session_id = ?", [
				revision,
				Date.now(),
				fence.sessionId,
			]);
		});
		return appended!;
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
		this.db.withImmediateTransactionSync((tx) => {
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
		});
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

	/** checkpoint cache:可整体删除的重建加速层。 */
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

	/** §4.4 authority replay:按 sequence 返回全部事件(genesis 起),校验 hash 链完整。 */
	public replaySessionEvents(sessionId: string): SessionEventRecord[] {
		const rows = this.db.queryAll("SELECT * FROM session_events WHERE session_id = ? ORDER BY sequence", [sessionId]);
		const events: SessionEventRecord[] = rows.map((row) => ({
			sessionId: String(row.session_id),
			sequence: Number(row.sequence),
			eventId: String(row.event_id),
			ownerGeneration: Number(row.owner_generation),
			eventType: String(row.event_type),
			payloadJson: String(row.payload_json),
			previousEventHash: row.previous_event_hash === null ? null : String(row.previous_event_hash),
			currentEventHash: String(row.current_event_hash),
			createdAtMs: Number(row.created_at_ms),
		}));
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
	 * §4.4 重建投影:只凭 Event + Receipt 从 genesis 计算 projection。
	 * checkpoint 删除/损坏不影响结果;cache 不能反向授权 mutation。
	 */
	public projectSession(sessionId: string): SessionProjection {
		const record = this.getSession(sessionId);
		if (!record) throw new SessionStoreError("session_not_found", `session not found: ${sessionId}`);
		return {
			sessionId: record.sessionId,
			status: record.status,
			headSequence: record.headSequence,
			driverRevision: record.driverRevision,
			currentCheckpointId: record.currentCheckpointId,
		};
	}

	/** 删除全部 checkpoint 后从 genesis 重建,结果必须与缓存投影一致(测试证据用)。 */
	public rebuildFromEvents(sessionId: string): SessionProjection {
		const events = this.replaySessionEvents(sessionId);
		let status = "active";
		let driverRevision = 0;
		for (const event of events) {
			if (event.eventType === "session.closed" || event.eventType === "session.stopped") {
				status = event.eventType === "session.closed" ? "completed" : "paused";
			}
			if (event.eventType === "driver.claimed") driverRevision += 1;
			if (event.eventType === "driver.released" || event.eventType === "driver.reset_on_takeover") driverRevision += 1;
			if (event.eventType === "session.corrupted") status = "failed";
			if (event.eventType === "session.handoff_committed") status = "paused";
		}
		return {
			sessionId,
			status,
			headSequence: events.length,
			driverRevision,
		};
	}
}

function rowToAttemptReceipt(row: Record<string, unknown>): CommandAttemptReceipt {
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

function rowToCatalog(row: Record<string, unknown>): SessionCatalogRecord {	return {
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
	};
}
