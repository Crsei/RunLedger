/**
 * S1 拆分:catalog 域 repository —— session 行的 create/fork/title/reclaim、
 * worktree locator 与 catalog revision 事务。
 *
 * 只接收已打开的 SessionDatabase 端口;admission 门禁与 owner fence 语义与
 * 拆分前逐条保持一致。本 repository 非公共出口,仅 SessionStore facade 使用。
 */

import type { SessionDatabase } from "./database.ts";
import { appendEventInTransaction, sessionEventHash, verifyOwnerFence } from "./event-append.ts";
import { catalogSelectSql, rowToCatalog, rowToHarnessProfile, boundedTitleRef } from "./row-mappers.ts";
import { createRuntimeId } from "../../runtime/protocol/ids.ts";
import { canonicalDigest } from "../../runtime/protocol/canonical-json.ts";
import { normalizeSessionTitle } from "../../runtime/session-owner/title.ts";
import type { OwnerFence } from "../../runtime/session-owner/types.ts";
import type {
	CreateSessionInput,
	ForkSessionInput,
	PutWorktreeLocatorInput,
	SessionCatalogRecord,
	SetSessionTitleInput,
} from "./session-store.ts";
import { SessionStoreError } from "./session-store-error.ts";
import { ForkLedgerProjector } from "./fork-projector.ts";
import { resolveHarnessProfile } from "../../runtime/harness-profiles/index.ts";

export function catalogRevisionInTransaction(db: Pick<SessionDatabase, "querySingle">): number {
	const row = db.querySingle("SELECT catalog_revision FROM store_control WHERE singleton_id = 1");
	return Number(row?.catalog_revision ?? 0);
}

export class CatalogRepository {
	private readonly db: SessionDatabase;

	public constructor(db: SessionDatabase) {
		this.db = db;
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
			.queryAll(`${catalogSelectSql()} ORDER BY created_at_ms DESC, session_id`)
			.map(rowToCatalog);
	}

	public getSession(sessionId: string): SessionCatalogRecord | undefined {
		this.assertAdmissionReady();
		const row = this.db.querySingle(`${catalogSelectSql()} WHERE session_id = ?`, [sessionId]);
		return row === undefined ? undefined : rowToCatalog(row);
	}

	/**
	 * Durable catalog revision for session create/fork/title/reclaim mutations.
	 * It lives beside the admission gate so copied event history and deleted
	 * draft rows cannot make a stale revision repeat or move backwards.
	 */
	public catalogRevision(): number {
		this.assertAdmissionReady();
		return catalogRevisionInTransaction(this.db);
	}

	/**
	 * Owner-fenced title mutation. The projection update and title event share one
	 * BEGIN IMMEDIATE transaction, so a late auto completion cannot appear to win.
	 */
	public setTitle(fence: OwnerFence, input: SetSessionTitleInput): SessionCatalogRecord {
		const title = normalizeSessionTitle(input.title);
		if (title === null) throw new SessionStoreError("invalid_title", "session title is empty, unsafe, or exceeds 160 UTF-8 bytes");
		if (input.source === "auto" && input.expectedTitle !== null) {
			throw new SessionStoreError("invalid_title", "auto title writes must use an unnamed-session CAS");
		}
		if (input.modelRef !== undefined && (!boundedTitleRef(input.modelRef.providerId) || !boundedTitleRef(input.modelRef.modelId))) {
			throw new SessionStoreError("invalid_title", "title model reference is invalid");
		}
		this.db.withImmediateTransactionSync((tx) => {
			tx.querySingle("SELECT 1 FROM store_control WHERE singleton_id = 1 AND admission = 'ready'");
			if (!verifyOwnerFence(tx, fence)) throw new SessionStoreError("owner_fenced", "owner fenced");
			if (input.expectedCatalogRevision !== undefined && catalogRevisionInTransaction(tx) !== input.expectedCatalogRevision) {
				throw new SessionStoreError("catalog_revision_conflict", "catalog revision changed before the title transaction");
			}
			const current = tx.querySingle("SELECT title, title_source, title_updated_at_ms, head_sequence FROM sessions WHERE session_id = ?", [fence.sessionId]);
			if (current === undefined) throw new SessionStoreError("session_not_found", `session not found: ${fence.sessionId}`);
			const currentTitle = current.title === null ? undefined : String(current.title);
			if (input.expectedTitle !== undefined && (input.expectedTitle ?? undefined) !== currentTitle) {
				throw new SessionStoreError("title_conflict", "session title changed before this mutation committed");
			}
			if (input.source === "auto" && currentTitle !== undefined) {
				throw new SessionStoreError("title_conflict", "an existing title wins the auto-title race");
			}
			const now = Date.now();
			const previous = tx.querySingle(
				"SELECT current_event_hash FROM session_events WHERE session_id = ? AND sequence = ?",
				[fence.sessionId, Number(current.head_sequence)],
			);
			const payload: Record<string, unknown> = {
				title,
				source: input.source,
				...(currentTitle === undefined ? {} : { previousTitle: currentTitle }),
				...(input.trigger === undefined ? {} : { trigger: input.trigger }),
				...(input.modelRef === undefined ? {} : { modelRef: { providerId: input.modelRef.providerId, modelId: input.modelRef.modelId } }),
				...(input.source === "auto" ? { expectedTitle: null } : {}),
			};
			tx.runSync("UPDATE sessions SET title = ?, title_source = ?, title_updated_at_ms = ?, updated_at_ms = ? WHERE session_id = ?", [
				title,
				input.source,
				now,
				now,
				fence.sessionId,
			]);
			appendEventInTransaction(tx, fence, {
				eventId: createRuntimeId("event", `title-${fence.sessionId.slice(-12)}-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`),
				ownerGeneration: fence.generation,
				eventType: "session.title_changed",
				payloadJson: JSON.stringify(payload),
				createdAtMs: now,
				expectedPreviousEventHash: previous === undefined ? null : String(previous.current_event_hash),
			});
			tx.runSync("UPDATE store_control SET catalog_revision = catalog_revision + 1 WHERE singleton_id = 1");
		});
		return this.getSession(fence.sessionId)!;
	}

	/** 正常退出后的 Session 回收入口；用户消息或 Plan 工件所在会话必须保留。 */
	public reclaimSessionWithoutUserMessages(fence: OwnerFence): boolean {
		this.assertAdmissionReady();
		let reclaimed = false;
		this.db.withImmediateTransactionSync((tx) => {
			reclaimed = tx.runSync(
			`DELETE FROM sessions
			 WHERE session_id = ?
			   AND harness_profile_id <> 'plan'
			   AND EXISTS (
			     SELECT 1
			       FROM session_owners
			      WHERE session_owners.session_id = sessions.session_id
			        AND session_owners.generation = ?
			        AND session_owners.state = 'unowned'
			   )
			   AND (
			     SELECT CASE
			              WHEN json_valid(release_event.payload_json)
			              THEN json_extract(release_event.payload_json, '$.reason')
			              ELSE NULL
			            END
			       FROM session_events AS release_event
			      WHERE release_event.session_id = sessions.session_id
			        AND release_event.event_type = 'owner.released'
			        AND release_event.owner_generation = ?
			      ORDER BY release_event.sequence DESC
			      LIMIT 1
			   ) IN ('paused', 'detached')
			   AND NOT EXISTS (
			     SELECT 1
			       FROM session_events
			      WHERE session_events.session_id = sessions.session_id
			        AND session_events.event_type = 'ledger.message'
			        AND (
			          json_extract(session_events.payload_json, '$.payload.role') = 'user'
			          OR json_extract(session_events.payload_json, '$.payload.message.role') = 'user'
			        )
			   )`,
			[fence.sessionId, fence.generation, fence.generation],
			).changes === 1;
			if (reclaimed) tx.runSync("UPDATE store_control SET catalog_revision = catalog_revision + 1 WHERE singleton_id = 1");
		});
		return reclaimed;
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
		const harnessProfile = resolveHarnessProfile(input.harnessProfile);
		if (!harnessProfile.ok) {
			throw new SessionStoreError("invalid_input", harnessProfile.error.message);
		}
		const now = Date.now();
		try {
			this.db.withImmediateTransactionSync((tx) => {
				if (input.expectedCatalogRevision !== undefined) {
					if (catalogRevisionInTransaction(tx) !== input.expectedCatalogRevision) {
						throw new SessionStoreError("catalog_revision_conflict", "catalog revision changed before session creation");
					}
				}
				tx.runSync(
					`INSERT INTO sessions
					 (session_id, workspace_id, repository_id, status, created_at_ms, updated_at_ms,
				  head_sequence, current_checkpoint_id, last_driver_client_id, driver_revision,
				  worktree_locator_json, source_workspace_locator_json, settings_digest,
				  harness_profile_id, harness_profile_version, harness_profile_digest,
				  title, title_source, title_updated_at_ms)
				 VALUES (?, ?, ?, ?, ?, ?, 0, NULL, NULL, 0, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
					[
						input.sessionId,
						input.workspaceId,
						input.repositoryId,
						input.status ?? "active",
						now,
						now,
						input.worktreeLocator ?? null,
						input.sourceWorkspaceLocator ?? null,
						input.settingsDigest,
						harnessProfile.ref.id,
						harnessProfile.ref.version,
						harnessProfile.ref.descriptorDigest.digest,
					],
				);
				tx.runSync("UPDATE store_control SET catalog_revision = catalog_revision + 1 WHERE singleton_id = 1");
			});
		} catch (error) {
			if (error instanceof Error && /UNIQUE|PRIMARY/i.test(error.message)) {
				throw new SessionStoreError("session_conflict", `session already exists: ${input.sessionId}`);
			}
			throw error;
		}
		return this.getSession(input.sessionId)!;
	}

	/** fork:冻结 source head，typed 投影 canonical ledger，并写入目标自己的 lineage event。 */
	public forkSession(input: ForkSessionInput): SessionCatalogRecord {
		this.assertAdmissionReady();
		let forked: SessionCatalogRecord | undefined;
		this.db.withImmediateTransactionSync((tx) => {
			if (input.expectedCatalogRevision !== undefined) {
				if (catalogRevisionInTransaction(tx) !== input.expectedCatalogRevision) {
					throw new SessionStoreError("catalog_revision_conflict", "catalog revision changed before the fork transaction");
				}
			}
			// source catalog/profile/event head 必须从同一 BEGIN IMMEDIATE snapshot 复制。
			const source = tx.querySingle(
				`SELECT head_sequence, workspace_id, repository_id, settings_digest, source_workspace_locator_json,
				        harness_profile_id, harness_profile_version, harness_profile_digest, title, title_source, title_updated_at_ms
				   FROM sessions WHERE session_id = ?`,
				[input.sourceSessionId],
			);
			if (source === undefined) throw new SessionStoreError("fork_source_not_found", `source session not found: ${input.sourceSessionId}`);
			if (input.expectedSourceHeadSequence !== undefined && Number(source.head_sequence) !== input.expectedSourceHeadSequence) {
				throw new SessionStoreError("fork_source_head_conflict", "fork source head advanced before the fork transaction");
			}
			const harnessProfile = rowToHarnessProfile(source);
			tx.runSync(
				`INSERT INTO sessions
					 (session_id, workspace_id, repository_id, status, created_at_ms, updated_at_ms,
				  head_sequence, current_checkpoint_id, last_driver_client_id, driver_revision,
				  worktree_locator_json, source_workspace_locator_json, settings_digest,
				  harness_profile_id, harness_profile_version, harness_profile_digest,
				  title, title_source, title_updated_at_ms)
				 VALUES (?, ?, ?, ?, ?, ?, 0, NULL, NULL, 0, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					input.sessionId,
					String(source.workspace_id),
					String(source.repository_id),
					"active",
					Date.now(),
					Date.now(),
					source.source_workspace_locator_json === null ? null : String(source.source_workspace_locator_json),
					String(source.settings_digest),
					harnessProfile.id,
					harnessProfile.version,
					harnessProfile.descriptorDigest.digest,
					source.title === null ? null : String(source.title),
					source.title_source === null ? null : String(source.title_source),
					source.title_updated_at_ms === null ? null : Number(source.title_updated_at_ms),
				],
			);
			const sourceEvents = tx.queryAll(
				"SELECT sequence, event_id, event_type, payload_json, current_event_hash, created_at_ms FROM session_events WHERE session_id = ? ORDER BY sequence",
				[input.sourceSessionId],
			);
			if (sourceEvents.length !== Number(source.head_sequence)) {
				throw new SessionStoreError("fork_source_head_conflict", "fork source event count does not match its frozen head");
			}
			let previous: string | null = null;
			let sequence = 0;
			const projector = new ForkLedgerProjector(input.sourceSessionId, input.sessionId);
			for (const event of sourceEvents) {
				const projected = projector.project({
					eventId: String(event.event_id),
					eventType: String(event.event_type),
					payloadJson: String(event.payload_json),
					createdAtMs: Number(event.created_at_ms),
				});
				if (projected === undefined) continue;
				sequence += 1;
				const current = sessionEventHash(
					input.sessionId,
					sequence,
					projected.eventId,
					projected.eventType,
					projected.payloadJson,
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
						projected.eventId,
						0,
						projected.eventType,
						projected.payloadJson,
						previous,
						current,
						projected.createdAtMs,
					],
				);
				previous = current;
			}
			sequence += 1;
			const now = Date.now();
			const sourceHeadHash = sourceEvents.length === 0 ? null : String(sourceEvents.at(-1)!.current_event_hash);
			const lineageEventId = createRuntimeId(
				"event",
				canonicalDigest({
					type: "session.forked",
					sourceSessionId: input.sourceSessionId,
					sourceHeadSequence: Number(source.head_sequence),
					targetSessionId: input.sessionId,
				}).slice(0, 32),
			);
			const lineagePayload = JSON.stringify({
				sourceSessionId: input.sourceSessionId,
				sourceHeadSequence: Number(source.head_sequence),
				sourceHeadHash,
			});
			const lineageHash = sessionEventHash(input.sessionId, sequence, lineageEventId, "session.forked", lineagePayload, previous);
			tx.runSync(
				"INSERT INTO session_events " +
				"(session_id, sequence, event_id, owner_generation, event_type, payload_json, previous_event_hash, current_event_hash, created_at_ms) " +
				"VALUES (?, ?, ?, 0, 'session.forked', ?, ?, ?, ?)",
				[input.sessionId, sequence, lineageEventId, lineagePayload, previous, lineageHash, now],
			);
			tx.runSync("UPDATE sessions SET head_sequence = ?, updated_at_ms = ? WHERE session_id = ?", [sequence, now, input.sessionId]);
			tx.runSync("UPDATE store_control SET catalog_revision = catalog_revision + 1 WHERE singleton_id = 1");
		});
		forked = this.getSession(input.sessionId);
		return forked!;
	}
}
