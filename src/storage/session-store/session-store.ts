/**
 * R2:SessionStore —— SQLite 中 Session 的唯一 durable truth API(06 §4)。
 *
 * S1 拆分后本文件是 facade:唯一对外写入口、事务编排与公共类型。
 * 实现协作者:
 * - `event-append.ts`      hash input/计算、owner fence、append 事务、status 投影;
 * - `catalog-repository.ts`  catalog 行 create/fork/title/reclaim/worktree locator;
 * - `attempt-repository.ts`  command intent / attempt receipt;
 * - `checkpoint-repository.ts` checkpoint cache put/get/clear;
 * - `session-projection.ts`   event replay、投影重建与一致性检查;
 * - `row-mappers.ts`          SQLite row -> typed record 纯映射。
 *
 * 协作者只接收已打开的窄 database port,不打开第二连接、不绕过 owner fence;
 * SessionStore 仍是唯一对外写入口,公共 export 与 import 路径不变。
 */

import type { SessionDatabase } from "./database.ts";
import { CatalogRepository } from "./catalog-repository.ts";
import { readEventRange, type EventRangeRequest } from "./event-range.ts";
import { AttemptRepository, appendAttemptReceiptInTransaction } from "./attempt-repository.ts";
import { rowToAttemptReceipt } from "./row-mappers.ts";
import { SessionStoreError } from "./session-store-error.ts";
import { createRuntimeId, type AttemptId } from "../../runtime/protocol/ids.ts";
import type { RuntimeDigest } from "../../runtime/protocol/foundation.ts";
import { CheckpointRepository } from "./checkpoint-repository.ts";
import { appendEventInTransaction, appendDriverEventInTransaction } from "./event-append.ts";
import { latestSessionEventHead, replaySessionEvents, rebuildFromEvents, projectSession } from "./session-projection.ts";
import type {
	CommandAttemptBeginInput,
	CommandAttemptBeginResult,
	CommandAttemptReceipt,
	CommandIntent,
	OwnerFence,
	SessionCheckpointDescriptor,
} from "../../runtime/session-owner/types.ts";
import type { SessionId } from "../../runtime/protocol/ids.ts";
import type { SessionTitleModelRef, SessionTitleSource, SessionTitleState } from "../../runtime/session-owner/title.ts";
import type { HarnessProfileRef } from "../../runtime/harness-profiles/index.ts";

export {
	SESSION_STORE_ERROR_CODES,
	SessionStoreError,
	type SessionStoreErrorCode,
} from "./session-store-error.ts";
export {
	sessionEventHashInput,
	sessionEventHash,
	verifyOwnerFence,
	appendEventInTransaction,
	projectSessionStatus,
} from "./event-append.ts";

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
	/** 正常 source workspace 的私有 canonical locator；缺失的 legacy row 不可自动 resume。 */
	readonly sourceWorkspaceLocator?: string;
	readonly settingsDigest: string;
	readonly harnessProfile: HarnessProfileRef;
	readonly title?: string;
	readonly titleSource?: SessionTitleSource;
	readonly titleUpdatedAtMs?: number;
	readonly firstUserMessagePreview?: string;
}

export interface SetSessionTitleInput {
	readonly title: string;
	readonly source: SessionTitleSource;
	readonly trigger?: "first-user-message" | "manual-rename" | "retry";
	/** null means the caller requires an unnamed session; omitted disables the CAS for user rename. */
	readonly expectedTitle?: string | null;
	/** Catalog CAS captured by the Session Domain before this mutation began. */
	readonly expectedCatalogRevision?: number;
	readonly modelRef?: SessionTitleModelRef;
}

export interface CreateSessionInput {
	readonly sessionId: SessionId;
	readonly workspaceId: string;
	readonly repositoryId: string;
	readonly settingsDigest: string;
	readonly harnessProfile: HarnessProfileRef;
	readonly worktreeLocator?: string;
	readonly sourceWorkspaceLocator?: string;
	readonly status?: string;
	readonly expectedCatalogRevision?: number;
}

export interface ForkSessionInput {
	/** 显式 raw fork 保留原历史，放弃继承 provider-private 投影。 */
	readonly inheritCompaction?: boolean;
	/** 可选的历史完成轮次边界；源 Session 不变。 */
	readonly throughSequence?: number;
	readonly sessionId: SessionId;
	readonly sourceSessionId: string;
	readonly expectedSourceHeadSequence?: number;
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

export interface SessionProjection extends SessionTitleState {
	readonly sessionId: string;
	readonly status: string;
	readonly headSequence: number;
	readonly driverRevision: number;
	readonly currentCheckpointId?: string;
}

export interface CheckpointCacheEntry extends SessionCheckpointDescriptor {
	readonly snapshotJson: string;
}

export class SessionStore {
	private readonly db: SessionDatabase;
	private readonly catalog: CatalogRepository;
	private readonly attempts: AttemptRepository;
	private readonly checkpoints: CheckpointRepository;

	public constructor(db: SessionDatabase) {
		this.db = db;
		this.catalog = new CatalogRepository(db);
		this.attempts = new AttemptRepository(db);
		this.checkpoints = new CheckpointRepository(db);
	}

	public database(): SessionDatabase {
		return this.db;
	}

	public listSessions(): SessionCatalogRecord[] {
		return this.catalog.listSessions();
	}

	public getSession(sessionId: string): SessionCatalogRecord | undefined {
		return this.catalog.getSession(sessionId);
	}

	public catalogRevision(): number {
		return this.catalog.catalogRevision();
	}

	public setTitle(fence: OwnerFence, input: SetSessionTitleInput): SessionCatalogRecord {
		return this.catalog.setTitle(fence, input);
	}

	public reclaimSessionWithoutUserMessages(fence: OwnerFence): boolean {
		return this.catalog.reclaimSessionWithoutUserMessages(fence);
	}

	public putWorktreeLocator(fence: OwnerFence, input: PutWorktreeLocatorInput): void {
		this.catalog.putWorktreeLocator(fence, input);
	}

	public createSession(input: CreateSessionInput): SessionCatalogRecord {
		return this.catalog.createSession(input);
	}

	public forkSession(input: ForkSessionInput): SessionCatalogRecord {
		return this.catalog.forkSession(input);
	}

	/** §4.5/R2:owner-fenced event append,事务内校验 admission/fence/sequence/previous hash。 */
	public appendEvent(fence: OwnerFence, input: AppendEventInput): SessionEventRecord {
		let appended: SessionEventRecord | undefined;
		this.db.withImmediateTransactionSync((tx) => {
			appended = appendEventInTransaction(tx, fence, input);
		});
		return appended!;
	}

	/** compact 的完成事件（含 projection 引用）与 attempt 收口必须同事务。 */
	public appendEventAndSettleAttempt(
		fence: OwnerFence, input: (receipt: CommandAttemptReceipt) => AppendEventInput, attemptId: AttemptId,
		outcome: "committed" | "rejected", resultDigest: RuntimeDigest,
	): SessionEventRecord {
		return this.db.withImmediateTransactionSync((tx) => {
			const row = tx.querySingle("SELECT * FROM command_attempt_receipts WHERE session_id = ? AND attempt_id = ? ORDER BY created_at_ms DESC, receipt_id DESC LIMIT 1", [fence.sessionId, attemptId]);
			if (row === undefined) throw new SessionStoreError("invalid_input", "attempt missing");
			const started = rowToAttemptReceipt(row);
			if (started.outcome !== "started" || started.originGeneration !== fence.generation) throw new SessionStoreError("invalid_input", "attempt is not active in this owner generation");
			const receipt: CommandAttemptReceipt = {
				...started, receiptId: createRuntimeId("receipt", `compact-${attemptId.slice(-48)}`),
				outcome, settledGeneration: fence.generation, resultDigest,
				createdAtMs: Math.max(Date.now(), started.createdAtMs + 1),
			};
			const event = appendEventInTransaction(tx, fence, input(receipt));
			appendAttemptReceiptInTransaction(tx, fence, receipt);
			return event;
		});
	}

	/**
	 * §6.4/§R4:durable driver 事件与 driver_revision 递增在同一事务内提交。
	 * 实现见 `appendDriverEventInTransaction`(event-append.ts)。
	 */
	public appendDriverEvent(
		fence: OwnerFence,
		eventType: "driver.claimed" | "driver.released" | "driver.reset_on_takeover",
		payload: Record<string, unknown>,
	): SessionEventRecord {
		let appended: SessionEventRecord | undefined;
		this.db.withImmediateTransactionSync((tx) => {
			appended = appendDriverEventInTransaction(tx, fence, eventType, payload);
		});
		return appended!;
	}

	/** §4.3:不可变 command intent。同 ID 重复且 digest 一致视为幂等成功。 */
	public beginCommandAttempt(fence: OwnerFence, input: CommandAttemptBeginInput): CommandAttemptBeginResult {
		return this.attempts.beginCommandAttempt(fence, input);
	}

	/** §4.3:不可变 command intent。同 ID 重复且 digest 一致视为幂等成功。 */
	public recordCommandIntent(fence: OwnerFence, intent: CommandIntent): void {
		this.attempts.recordCommandIntent(fence, intent);
	}

	/** §4.3:append-only attempt receipt;settledGeneration >= originGeneration 由 guard 保证。 */
	public appendAttemptReceipt(fence: OwnerFence, receipt: CommandAttemptReceipt): void {
		this.attempts.appendAttemptReceipt(fence, receipt);
	}

	public listAttemptReceipts(sessionId: string, commandId: string): readonly CommandAttemptReceipt[] {
		return this.attempts.listAttemptReceipts(sessionId, commandId);
	}

	/** §7.3:某 Session 全部 attempt receipt(恢复评估用,只读 projection)。 */
	public listAllAttemptReceipts(sessionId: string): readonly CommandAttemptReceipt[] {
		return this.attempts.listAllAttemptReceipts(sessionId);
	}

	/** checkpoint cache:可整体删除的重建加速层。 */
	public putCheckpoint(fence: OwnerFence, checkpoint: SessionCheckpointDescriptor, snapshotJson: string): void {
		this.checkpoints.putCheckpoint(fence, checkpoint, snapshotJson);
	}

	public getCheckpoint(checkpointId: string): CheckpointCacheEntry | undefined {
		return this.checkpoints.getCheckpoint(checkpointId);
	}

	/** cache 可整体删除:删除后必须能从 genesis replay 重建相同 projection。 */
	public clearCheckpoints(sessionId: string): void {
		this.checkpoints.clearCheckpoints(sessionId);
	}

	/** §4.4 authority replay:按 sequence 返回全部事件(genesis 起),校验 hash 链完整。 */
	public replaySessionEvents(sessionId: string): SessionEventRecord[] {
		return replaySessionEvents(this.db, sessionId);
	}

	/** 有界订阅/历史查询，不执行全量 authority 重放。 */
	public readEventRange(sessionId: string, request: EventRangeRequest = {}): readonly SessionEventRecord[] {
		return this.db.withReadTransactionSync(() => readEventRange(this.db, sessionId, request));
	}

	/** §4.5 写路径的链尾读取：单次倒序查询，不重放事件流。 */
	public latestEventHead(sessionId: string): { readonly sequence: number; readonly hash: string | null } {
		return latestSessionEventHead(this.db, sessionId);
	}

	/**
	 * §4.4 重建投影:只凭 Event + Receipt 从 genesis 计算 projection。
	 * checkpoint 删除/损坏不影响结果;cache 不能反向授权 mutation。
	 */
	public projectSession(sessionId: string): SessionProjection {
		return projectSession(this.db, sessionId, this.catalog);
	}

	/** 删除全部 checkpoint 后从 genesis 重建,结果必须与缓存投影一致(测试证据用)。 */
	public rebuildFromEvents(sessionId: string): SessionProjection {
		return rebuildFromEvents(this.db, sessionId);
	}
}
