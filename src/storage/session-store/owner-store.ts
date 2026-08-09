/**
 * R3:Session Owner 的 SQLite CAS 存储(06 §3/§4.5/§5)。
 *
 * - 唯一并发仲裁收敛为 session_owners 行 + generation 条件写;
 * - claim/takeover/release 的 owner row 迁移与 owner.* audit event 在同一
 *   BEGIN IMMEDIATE 事务内提交,禁止“row 已迁移但事件缺失”的半写;
 * - authToken 是 BLOB 列,只在此存储层进出,绝不进入 record/event/DTO;
 * - release 只清空 runtime/port/token 并置 unowned,generation 永久不回退;
 * - takeover 只接受把 probe 前读取的 exact (runtime_id, generation,
 *   heartbeat_at_ms, state) CAS 到 generation + 1。
 */

import { SessionStoreDatabaseError, type SessionDatabase } from "./database.ts";
import type {
	OwnerClaimAttempt,
	OwnerClaimTarget,
	OwnerEndpoint,
	OwnerFence,
	OwnerReleaseReason,
	SessionOwnerRecord,
} from "../../runtime/session-owner/types.ts";
import { createRuntimeId, type RuntimeInstanceId, type SessionId } from "../../runtime/protocol/ids.ts";
import { appendEventInTransaction, SessionStoreError } from "./session-store.ts";

export const OWNER_STORE_ERROR_CODES = [
	"owner_fenced",
	"owner_claim_lost",
	"owner_takeover_conditions_unmet",
	"admission_blocked",
	"session_not_found",
	"invalid_input",
] as const;
export type OwnerStoreErrorCode = (typeof OWNER_STORE_ERROR_CODES)[number];

export class OwnerStoreError extends Error {
	public readonly code: OwnerStoreErrorCode;
	public constructor(code: OwnerStoreErrorCode, message: string) {
		super(message);
		this.name = "OwnerStoreError";
		this.code = code;
	}
}

export interface OwnerClaimCandidate {
	readonly runtimeId: RuntimeInstanceId;
	readonly endpoint: OwnerEndpoint;
	readonly authTokenHex: string;
	readonly ownerStartedAtMs: number;
}

export type OwnerClaimOutcome =
	| { readonly ok: true; readonly outcome: "claimed"; readonly fence: OwnerFence; readonly endpoint: OwnerEndpoint }
	| { readonly ok: true; readonly outcome: "attached"; readonly record: SessionOwnerRecord }
	| { readonly ok: false; readonly code: "owner_claim_lost" | "owner_store_busy" | "admission_blocked" | "session_not_found"; readonly retryable: boolean };

/** 当前进程持有的 candidate 信息;authToken 只存在于 OwnerStore 调用方内存。 */
export interface OwnerRowState {
	readonly runtimeId: string | null;
	readonly generation: number;
	readonly state: string;
	readonly port: number | null;
	readonly heartbeatAtMs: number | null;
	readonly ownerStartedAtMs: number | null;
}

function rowToOwnerRecord(row: Record<string, unknown>): SessionOwnerRecord {
	return {
		sessionId: String(row.session_id) as SessionId,
		runtimeId: String(row.runtime_id) as RuntimeInstanceId,
		generation: Number(row.generation),
		state: String(row.state) as SessionOwnerRecord["state"],
		endpoint:
			row.port === null
				? undefined
				: { host: "127.0.0.1", port: Number(row.port) },
		heartbeatAtMs: row.heartbeat_at_ms === null ? undefined : Number(row.heartbeat_at_ms),
		ownerStartedAtMs: Number(row.owner_started_at_ms),
		updatedAtMs: Number(row.updated_at_ms),
	};
}

function assertAdmissionReady(db: SessionDatabase): void {
	const row = db.querySingle("SELECT admission FROM store_control WHERE singleton_id = 1");
	if (row?.admission !== "ready") {
		throw new OwnerStoreError("admission_blocked", "store admission is not ready (migration in progress)");
	}
}

function assertFence(db: SessionDatabase, fence: OwnerFence): void {
	const row = db.querySingle(
		`SELECT 1 AS ok FROM session_owners
		 WHERE session_id = ? AND runtime_id = ? AND generation = ?
		   AND state IN ('starting', 'recovery_required', 'running', 'stopping')`,
		[fence.sessionId, fence.runtimeId, fence.generation],
	);
	if (!row) throw new OwnerStoreError("owner_fenced", `owner fenced: ${fence.runtimeId} generation ${fence.generation}`);
}

/** 读取 owner row 的 wire projection(不含 authToken)。 */
export function readOwnerRecord(db: SessionDatabase, sessionId: string): SessionOwnerRecord | undefined {
	const row = db.querySingle("SELECT * FROM session_owners WHERE session_id = ?", [sessionId]);
	return row === undefined ? undefined : rowToOwnerRecord(row);
}

/** probe 用:读取 row 的 exact 值(不含 token),供 takeover CAS 期望值比对。 */
export function readOwnerRowState(db: SessionDatabase, sessionId: string): OwnerRowState | undefined {
	const row = db.querySingle("SELECT * FROM session_owners WHERE session_id = ?", [sessionId]);
	if (!row) return undefined;
	return {
		runtimeId: row.runtime_id === null ? null : String(row.runtime_id),
		generation: Number(row.generation),
		state: String(row.state),
		port: row.port === null ? null : Number(row.port),
		heartbeatAtMs: row.heartbeat_at_ms === null ? null : Number(row.heartbeat_at_ms),
		ownerStartedAtMs: row.owner_started_at_ms === null ? null : Number(row.owner_started_at_ms),
	};
}

/** 同事务内追加 owner.* audit event:自动读取当前 head hash 并更新 head。 */
function appendAuditEvent(
	db: SessionDatabase,
	fence: OwnerFence,
	eventType: string,
	payload: Record<string, unknown>,
): void {
	// eventId 全局 UNIQUE:seed 必须绑定 session + generation,保证同一 Session
	// 多次 claim/release 不冲突,同时同一事务内可重复执行(幂等)。
	const eventId = createRuntimeId("event", `owner-${String(payload.eventId ?? "unknown")}-${fence.sessionId.slice(-12)}-${fence.generation}`);
	const headRow = db.querySingle("SELECT head_sequence FROM sessions WHERE session_id = ?", [fence.sessionId]);
	if (!headRow) throw new OwnerStoreError("session_not_found", `session not found: ${fence.sessionId}`);
	const headSequence = Number(headRow.head_sequence);
	const previousRow = db.querySingle(
		"SELECT current_event_hash FROM session_events WHERE session_id = ? AND sequence = ?",
		[fence.sessionId, headSequence],
	);
	const previousHash = previousRow === undefined ? null : String(previousRow.current_event_hash);
	// R0 契约 payload(additionalProperties: false)不包含 createdAtMs;时间戳只进 event row。
	const { createdAtMs: _createdAtMs, ...wirePayload } = payload;
	appendEventInTransaction(db, fence, {
		eventId,
		ownerGeneration: fence.generation,
		eventType,
		payloadJson: JSON.stringify({ ...wirePayload, eventId }),
		createdAtMs: Number(payload.createdAtMs ?? Date.now()),
		expectedPreviousEventHash: previousHash,
	});
}

export class OwnerStore {
	private readonly db: SessionDatabase;

	public constructor(db: SessionDatabase) {
		this.db = db;
	}

	public database(): SessionDatabase {
		return this.db;
	}

	/** 只读读取 owner row 的 wire projection(不含 token)。 */
	public readOwner(sessionId: string): SessionOwnerRecord | undefined {
		return readOwnerRecord(this.db, sessionId);
	}

	/**
	 * §5.3 takeover probe 专用:返回 row 的 exact identity + auth token,
	 * 供 contender 对 exact 127.0.0.1:port 执行 authenticated health probe。
	 * token 只在本存储层与 probe 调用方内存之间流转,不进 record/DTO/event。
	 */
	public readProbeSecret(sessionId: string): { readonly runtimeId: string; readonly generation: number; readonly authTokenHex: string } | undefined {
		const row = this.db.querySingle("SELECT runtime_id, generation, auth_token FROM session_owners WHERE session_id = ?", [sessionId]);
		if (!row || row.runtime_id === null) return undefined;
		const token = row.auth_token;
		return {
			runtimeId: String(row.runtime_id),
			generation: Number(row.generation),
			authTokenHex: token instanceof Uint8Array ? Buffer.from(token).toString("hex") : String(token),
		};
	}

	/**
	 * §5.2/§R3 claim 事务:
	 * - fresh(无 row 或 state=unowned)直接 claim,generation 单调 +1(新 Session 从 1 起);
	 * - takeover 只接受 exact row CAS 到 generation + 1,并把 owner.fenced(旧
	 *   generation)与 owner.taken_over 与 row 迁移放进同一事务;
	 * - 失败路径(claim lost)返回 attached 语义由调用方重新读取 winner。
	 */
	public tryClaim(attempt: OwnerClaimAttempt, candidate: OwnerClaimCandidate): OwnerClaimOutcome {
		let outcome: OwnerClaimOutcome | undefined;
		try {
			this.db.withImmediateTransactionSync((tx) => {
				assertAdmissionReady(tx);
				const row = tx.querySingle("SELECT * FROM session_owners WHERE session_id = ?", [attempt.sessionId]);				const now = Date.now();
				if (attempt.mode === "fresh") {
					if (row === undefined) {
						// 新 Session:generation 从 1 开始。claim 即 liveness 证据,
						// 初始 heartbeat 置 now,避免 startup grace 内被误判 stale。
						try {
							tx.runSync(
								`INSERT INTO session_owners
								 (session_id, runtime_id, generation, state, port, auth_token,
								  heartbeat_at_ms, owner_started_at_ms, updated_at_ms)
								 VALUES (?, ?, 1, 'starting', ?, ?, ?, ?, ?)`,
								[
									attempt.sessionId,
									candidate.runtimeId,
									candidate.endpoint.port,
									Buffer.from(candidate.authTokenHex, "hex"),
									now,
									candidate.ownerStartedAtMs,
									now,
								],
							);
						} catch (error) {
							if (error instanceof Error && /FOREIGN KEY|REFERENCES/i.test(error.message)) {
								throw new OwnerStoreError("session_not_found", `session not found: ${attempt.sessionId}`);
							}
							throw error;
						}
						const fence: OwnerFence = { sessionId: attempt.sessionId, runtimeId: candidate.runtimeId, generation: 1 };
						appendAuditEvent(tx, fence, "owner.claimed", {
							eventId: "claimed",
							sessionId: attempt.sessionId,
							runtimeId: candidate.runtimeId,
							generation: 1,
							port: candidate.endpoint.port,
							ownerStartedAtMs: candidate.ownerStartedAtMs,
							createdAtMs: now,
						});
						outcome = { ok: true, outcome: "claimed", fence, endpoint: candidate.endpoint };
						return;
					}
					if (String(row.state) === "unowned") {
						// 显式 unowned 可直接 claim,不需要 stale probe(§5.3);generation 不回退。
						const nextGeneration = Number(row.generation) + 1;
						tx.runSync(
							`UPDATE session_owners
							 SET runtime_id = ?, generation = ?, state = 'starting', port = ?, auth_token = ?,
							     heartbeat_at_ms = ?, owner_started_at_ms = ?, updated_at_ms = ?
							 WHERE session_id = ? AND state = 'unowned'`,
							[
								candidate.runtimeId,
								nextGeneration,
								candidate.endpoint.port,
								Buffer.from(candidate.authTokenHex, "hex"),
								now,
								candidate.ownerStartedAtMs,
								now,
								attempt.sessionId,
							],
						);
						const fence: OwnerFence = { sessionId: attempt.sessionId, runtimeId: candidate.runtimeId, generation: nextGeneration };
						appendAuditEvent(tx, fence, "owner.claimed", {
							eventId: "claimed",
							sessionId: attempt.sessionId,
							runtimeId: candidate.runtimeId,
							generation: nextGeneration,
							port: candidate.endpoint.port,
							ownerStartedAtMs: candidate.ownerStartedAtMs,
							createdAtMs: now,
						});
						outcome = { ok: true, outcome: "claimed", fence, endpoint: candidate.endpoint };
						return;
					}
					throw new OwnerClaimLostError();
				}
				// takeover mode:row 必须与 probe 前读取的 exact 值完全一致。
				if (row === undefined) throw new OwnerClaimLostError();
				const actual: OwnerClaimTarget = {
					runtimeId: String(row.runtime_id) as RuntimeInstanceId,
					generation: Number(row.generation),
					heartbeatAtMs: row.heartbeat_at_ms === null ? undefined : Number(row.heartbeat_at_ms),
					state: String(row.state) as OwnerClaimTarget["state"],
				};
				if (
					actual.runtimeId !== attempt.expected.runtimeId ||
					actual.generation !== attempt.expected.generation ||
					actual.heartbeatAtMs !== attempt.expected.heartbeatAtMs ||
					actual.state !== attempt.expected.state
				) {
					throw new OwnerClaimLostError();
				}
				const nextGeneration = actual.generation + 1;
				tx.runSync(
					`UPDATE session_owners
					 SET runtime_id = ?, generation = ?, state = 'starting', port = ?, auth_token = ?,
					     heartbeat_at_ms = ?, owner_started_at_ms = ?, updated_at_ms = ?
					 WHERE session_id = ? AND runtime_id = ? AND generation = ? AND state = ?`,
					[
						candidate.runtimeId,
						nextGeneration,
						candidate.endpoint.port,
						Buffer.from(candidate.authTokenHex, "hex"),
						now,
						candidate.ownerStartedAtMs,
						now,
						attempt.sessionId,
						actual.runtimeId,
						actual.generation,
						actual.state,
					],
				);
				const fence: OwnerFence = { sessionId: attempt.sessionId, runtimeId: candidate.runtimeId, generation: nextGeneration };
				// §R3:owner.fenced(旧 generation)+ owner.taken_over 与 row CAS 同事务;token 不进 payload。
				appendAuditEvent(tx, fence, "owner.fenced", {
					eventId: "fenced",
					sessionId: attempt.sessionId,
					runtimeId: actual.runtimeId,
					generation: actual.generation,
					createdAtMs: now,
				});
				appendAuditEvent(tx, fence, "owner.taken_over", {
					eventId: "taken-over",
					sessionId: attempt.sessionId,
					runtimeId: candidate.runtimeId,
					priorGeneration: actual.generation,
					generation: nextGeneration,
					port: candidate.endpoint.port,
					createdAtMs: now,
				});
				outcome = { ok: true, outcome: "claimed", fence, endpoint: candidate.endpoint };
			});
		} catch (error) {
			if (error instanceof OwnerClaimLostError) {
				return { ok: false, code: "owner_claim_lost", retryable: true };
			}
			if (error instanceof SessionStoreDatabaseError && error.code === "busy") {
				return { ok: false, code: "owner_store_busy", retryable: true };
			}
			if (error instanceof OwnerStoreError) {
				if (error.code === "admission_blocked") {
					return { ok: false, code: "admission_blocked", retryable: false };
				}
				if (error.code === "session_not_found") {
					return { ok: false, code: "session_not_found", retryable: false };
				}
			}
			throw error;
		}
		return outcome!;
	}

	/** §5.1 publish:starting → running(clean create/release resume)或 recovery_required(crash takeover)。 */
	public publishState(fence: OwnerFence, state: "running" | "recovery_required"): void {
		this.db.withImmediateTransactionSync((tx) => {
			assertAdmissionReady(tx);
			assertFence(tx, fence);
			tx.runSync(
				`UPDATE session_owners
				 SET state = ?, updated_at_ms = ?
				 WHERE session_id = ? AND runtime_id = ? AND generation = ? AND state IN ('starting', 'recovery_required', 'running')`,
				[state, Date.now(), fence.sessionId, fence.runtimeId, fence.generation],
			);
		});
	}

	/** §5.4 heartbeat:changes = 0 等价于 owner 已被 fence。 */
	public touchHeartbeat(fence: OwnerFence, heartbeatAtMs: number): { readonly ok: true; readonly heartbeatAtMs: number } | { readonly ok: false; readonly code: "owner_fenced" } {
		const result = this.db.runSync(
			`UPDATE session_owners
			 SET heartbeat_at_ms = ?, updated_at_ms = ?
			 WHERE session_id = ? AND runtime_id = ? AND generation = ?
			   AND state IN ('starting', 'recovery_required', 'running')`,
			[heartbeatAtMs, Date.now(), fence.sessionId, fence.runtimeId, fence.generation],
		);
		if (result.changes === 0) return { ok: false, code: "owner_fenced" };
		return { ok: true, heartbeatAtMs };
	}

	/** §8.3/§5.2:release 清空 runtime/port/token 并置 unowned,保留 generation;audit 同事务。 */
	public releaseOwner(fence: OwnerFence, reason: OwnerReleaseReason): void {
		this.db.withImmediateTransactionSync((tx) => {
			assertAdmissionReady(tx);
			const row = tx.querySingle(
				"SELECT 1 AS ok FROM session_owners WHERE session_id = ? AND runtime_id = ? AND generation = ?",
				[fence.sessionId, fence.runtimeId, fence.generation],
			);
			if (!row) {
				// 已被新 owner 接管:不覆盖新 row,只留下 fenced 事实(由 takeover 事务记录)。
				return;
			}
			// 先追加 audit event(row 仍 active,fence 有效),再置 unowned;同一事务原子提交。
			appendAuditEvent(tx, fence, "owner.released", {
				eventId: "released",
				sessionId: fence.sessionId,
				runtimeId: fence.runtimeId,
				generation: fence.generation,
				reason,
				createdAtMs: Date.now(),
			});
			tx.runSync(
				`UPDATE session_owners
				 SET runtime_id = NULL, state = 'unowned', port = NULL, auth_token = NULL,
				     heartbeat_at_ms = NULL, updated_at_ms = ?
				 WHERE session_id = ? AND runtime_id = ? AND generation = ?`,
				[Date.now(), fence.sessionId, fence.runtimeId, fence.generation],
			);
		});
	}
}

class OwnerClaimLostError extends Error {
	public constructor() {
		super("owner claim lost");
		this.name = "OwnerClaimLostError";
	}
}

export function isOwnerStoreError(error: unknown): error is OwnerStoreError {
	return error instanceof OwnerStoreError;
}
