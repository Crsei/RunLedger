/**
 * R1:Session Store schema compatibility 与 offline-only migration admission gate
 * (06 §4.2)。
 *
 * - 每个 binary 编译时固定 STORE_SCHEMA_MIN/MAX/CURRENT(见 session-owner/types);
 * - Client 在 owner discovery 前只能读取冻结的 schema header/store_control;
 *   高于 MAX → store_schema_too_new,低于 MIN 且无对应 migration →
 *   store_schema_too_old;protocol negotiation 不能覆盖 storage incompatibility;
 * - 影响既有读写语义的 structural migration 必须 offline-only:先 BEGIN
 *   IMMEDIATE 置 admission=migration_blocked 并证明零 active owner,再 BEGIN
 *   EXCLUSIVE 重验后应用一个事务性 DDL migration;migrator crash 后 persisted
 *   migration_blocked 保持 fail closed,只能显式 resume/abort；只追加 nullable
 *   column 的兼容迁移可在短事务内与旧 owner 共存。
 * - 崩溃的 owner 会永久停在 active state,让 offline gate 永远无法满足。gate 因此
 *   接受调用方提供的 `DeadOwnerEvidence`(必须由 heartbeat 过期 + 端点拒绝连接
 *   独立证明),并按 runtime_id + generation 精确排除;没有证据的 owner 照旧阻塞。
 */

import { SESSION_STORE_SCHEMA_MAX, SESSION_STORE_SCHEMA_MIN } from "../../runtime/session-owner/types.ts";
import type { SessionDatabase } from "./database.ts";
import {
	SESSION_STORE_SCHEMA_V1_SQL,
	SESSION_STORE_SCHEMA_V1_TO_V2_SQL,
	SESSION_STORE_SCHEMA_V2_SQL,
	SESSION_STORE_SCHEMA_V2_TO_V3_SQL,
	SESSION_STORE_SCHEMA_V3_SQL,
	SESSION_STORE_SCHEMA_V3_TO_V4_SQL,
	SESSION_STORE_SCHEMA_V4_SQL,
	SESSION_STORE_SCHEMA_V4_TO_V5_SQL,
	SESSION_STORE_SCHEMA_V5_SQL,
	SESSION_STORE_SCHEMA_V5_TO_V6_SQL,
	SESSION_STORE_SCHEMA_V6_SQL,
	SESSION_STORE_SCHEMA_V6_TO_V7_SQL,
	SESSION_STORE_SCHEMA_V7_SQL,
	SESSION_STORE_SCHEMA_VERSION,
	sessionStoreSchemaFormatDigest,
} from "./schema.ts";

export const ACTIVE_OWNER_STATES = ["starting", "recovery_required", "running", "stopping"] as const;

/** ACTIVE_OWNER_STATES 是冻结字面量元组,插值不引入外部输入。 */
const ACTIVE_OWNER_STATE_SQL = ACTIVE_OWNER_STATES.map((state) => `'${state}'`).join(", ");

export interface SessionStoreHeader {
	readonly storeVersion: number;
	readonly formatDigest: string;
	readonly admission: "ready" | "migration_blocked";
	readonly migrationEpoch: number;
}

export type StoreSchemaCompatibility =
	| {
			readonly ok: true;
			readonly header: SessionStoreHeader;
	  }
	| {
			readonly ok: false;
			readonly code: "missing_header" | "store_schema_too_new" | "store_schema_too_old" | "format_digest_mismatch";
			readonly detail: string;
	  };

/** 读取冻结的 schema header;任何读取失败都以 typed error fail closed。 */
export function readStoreHeader(db: SessionDatabase): StoreSchemaCompatibility {
	let meta: Record<string, unknown> | undefined;
	let control: Record<string, unknown> | undefined;
	try {
		meta = db.querySingle("SELECT schema_version, format_digest, applied_at_ms FROM schema_meta LIMIT 1");
		control = db.querySingle("SELECT admission, migration_epoch FROM store_control WHERE singleton_id = 1");
	} catch {
		return { ok: false, code: "missing_header", detail: "schema_meta/store_control tables are missing" };
	}
	if (!meta || !control) {
		return { ok: false, code: "missing_header", detail: "schema_meta/store_control is missing or corrupt" };
	}
	const storeVersion = Number(meta.schema_version);
	if (!Number.isSafeInteger(storeVersion) || storeVersion < 0) {
		return { ok: false, code: "missing_header", detail: "schema_version is not a non-negative integer" };
	}
	if (typeof meta.format_digest !== "string" || !/^[a-f0-9]{64}$/u.test(meta.format_digest)) {
		return { ok: false, code: "missing_header", detail: "format_digest is not a sha256 hex digest" };
	}
	const admission = control.admission;
	if (admission !== "ready" && admission !== "migration_blocked") {
		return { ok: false, code: "missing_header", detail: "store_control.admission is invalid" };
	}
	return {
		ok: true,
		header: {
			storeVersion,
			formatDigest: meta.format_digest,
			admission,
			migrationEpoch: Number(control.migration_epoch),
		},
	};
}

/** §4.2 binary 兼容窗口判断:admission=migration_blocked 同样 fail closed。 */
export function checkStoreCompatibility(db: SessionDatabase): StoreSchemaCompatibility {
	const result = readStoreHeader(db);
	if (!result.ok) return result;
	const { storeVersion, formatDigest } = result.header;
	if (storeVersion > SESSION_STORE_SCHEMA_MAX) {
		return { ok: false, code: "store_schema_too_new", detail: `store schema ${storeVersion} exceeds binary max ${SESSION_STORE_SCHEMA_MAX}` };
	}
	if (storeVersion < SESSION_STORE_SCHEMA_MIN) {
		return { ok: false, code: "store_schema_too_old", detail: `store schema ${storeVersion} is below binary min ${SESSION_STORE_SCHEMA_MIN}` };
	}
	// 每个已知版本必须匹配其 exact DDL digest;未来版本由 MIN/MAX 窗口覆盖。
	const expectedDigest = storeVersion === 1
		? sessionStoreSchemaFormatDigest(SESSION_STORE_SCHEMA_V1_SQL)
		: storeVersion === 2
			? sessionStoreSchemaFormatDigest(SESSION_STORE_SCHEMA_V2_SQL)
			: storeVersion === 3
				? sessionStoreSchemaFormatDigest(SESSION_STORE_SCHEMA_V3_SQL)
				: storeVersion === 4
					? sessionStoreSchemaFormatDigest(SESSION_STORE_SCHEMA_V4_SQL)
					: storeVersion === 5
						? sessionStoreSchemaFormatDigest(SESSION_STORE_SCHEMA_V5_SQL)
						: storeVersion === 6
							? sessionStoreSchemaFormatDigest(SESSION_STORE_SCHEMA_V6_SQL)
							: storeVersion === SESSION_STORE_SCHEMA_VERSION
								? sessionStoreSchemaFormatDigest(SESSION_STORE_SCHEMA_V7_SQL)
								: undefined;
	if (expectedDigest !== undefined && formatDigest !== expectedDigest) {
		return { ok: false, code: "format_digest_mismatch", detail: "schema format digest does not match the binary expectation" };
	}
	return { ok: true, header: result.header };
}

/** 一个 active owner 的 exact identity,外加判定存活所需的端点与 heartbeat。 */
export interface ActiveOwnerRow {
	readonly sessionId: string;
	readonly runtimeId: string;
	readonly generation: number;
	readonly endpoint?: { readonly host: "127.0.0.1"; readonly port: number };
	readonly heartbeatAtMs?: number;
}

/**
 * 已被证明死亡的 owner 的 exact identity。必须绑定 runtimeId + generation:
 * 同一 Session 若被新 runtime 重新 claim,行 identity 会变,旧证据自然失效。
 */
export interface DeadOwnerEvidence {
	readonly sessionId: string;
	readonly runtimeId: string;
	readonly generation: number;
}

/** 列出所有 active owner 的 identity 与存活判据(不含 authToken)。 */
export function listActiveOwners(db: SessionDatabase): readonly ActiveOwnerRow[] {
	return db
		.queryAll(
			`SELECT session_id, runtime_id, generation, port, heartbeat_at_ms
			   FROM session_owners
			  WHERE state IN (${ACTIVE_OWNER_STATE_SQL}) AND runtime_id IS NOT NULL`,
		)
		.map((row) => ({
			sessionId: String(row.session_id),
			runtimeId: String(row.runtime_id),
			generation: Number(row.generation),
			...(row.port === null ? {} : { endpoint: { host: "127.0.0.1" as const, port: Number(row.port) } }),
			...(row.heartbeat_at_ms === null ? {} : { heartbeatAtMs: Number(row.heartbeat_at_ms) }),
		}));
}

/**
 * active owner 计数。`deadOwners` 只排除 identity 完全一致的行——迁移方必须先用
 * 独立证据(heartbeat 过期 + 端点拒绝连接)证明这些 owner 已死;没有证据时缺省
 * 计入,保持 fail closed。
 */
export function countActiveOwners(db: SessionDatabase, deadOwners: readonly DeadOwnerEvidence[] = []): number {
	if (deadOwners.length === 0) {
		const row = db.querySingle(`SELECT COUNT(*) AS n FROM session_owners WHERE state IN (${ACTIVE_OWNER_STATE_SQL})`);
		return Number(row?.n ?? 0);
	}
	return listActiveOwners(db).filter((owner) => !matchesDeadOwner(owner, deadOwners)).length;
}

function matchesDeadOwner(owner: ActiveOwnerRow, deadOwners: readonly DeadOwnerEvidence[]): boolean {
	return deadOwners.some(
		(dead) => dead.sessionId === owner.sessionId && dead.runtimeId === owner.runtimeId && dead.generation === owner.generation,
	);
}

/** 离线迁移 gate 的可选输入。缺省不排除任何 owner,行为与旧实现一致。 */
export interface OfflineMigrationGateOptions {
	readonly deadOwners?: readonly DeadOwnerEvidence[];
}

export interface MigrationGateHandle {
	readonly migrationEpoch: number;
	release(): void;
}

export type BeginOfflineMigrationResult =
	| { readonly ok: true; readonly gate: MigrationGateHandle }
	| {
			readonly ok: false;
			readonly code: "admission_not_ready" | "active_owners_present" | "store_schema_incompatible" | "owner_store_busy";
			readonly detail: string;
	  };

/**
 * §4.2 offline admission gate:BEGIN IMMEDIATE → admission=migration_blocked →
 * 证明零 active owner → COMMIT gate。发现 active owner 时恢复 ready 并退出,
 * 不能 kill/takeover owner。
 *
 * `options.deadOwners` 只接受调用方已用独立证据证明死亡的 owner identity
 * (见 `DeadOwnerEvidence`);gate 仍在本事务内重数 active owner,任何 identity
 * 不匹配的新 owner 都会让 gate 失败,因此该参数不会削弱并发写保护。
 */
export function beginOfflineMigration(db: SessionDatabase, options: OfflineMigrationGateOptions = {}): BeginOfflineMigrationResult {
	const deadOwners = options.deadOwners ?? [];
	const compatibility = checkStoreCompatibility(db);
	if (!compatibility.ok) {
		return { ok: false, code: "store_schema_incompatible", detail: compatibility.detail };
	}
	if (compatibility.header.admission !== "ready") {
		return { ok: false, code: "admission_not_ready", detail: "store is already migration_blocked; explicit resume/abort required" };
	}
	const epoch = compatibility.header.migrationEpoch;
	let nextEpoch = epoch;
	try {
		db.withImmediateTransactionSync((tx) => {
			const owners = countActiveOwners(tx, deadOwners);
			if (owners > 0) {
				throw new ActiveOwnersError(owners);
			}
			nextEpoch = epoch + 1;
			tx.runSync("UPDATE store_control SET admission = 'migration_blocked', migration_epoch = ?, updated_at_ms = ? WHERE singleton_id = 1", [
				nextEpoch,
				Date.now(),
			]);
		});
	} catch (error) {
		if (error instanceof ActiveOwnersError) {
			// 事务已回滚,admission 保持 ready。
			return { ok: false, code: "active_owners_present", detail: `cannot migrate while ${error.owners} owners are active` };
		}
		throw error;
	}
	return {
		ok: true,
		gate: {
			migrationEpoch: nextEpoch,
			release: () => {
				db.runSync("UPDATE store_control SET admission = 'ready', updated_at_ms = ? WHERE singleton_id = 1", [Date.now()]);
			},
		},
	};
}

class ActiveOwnersError extends Error {
	public readonly owners: number;
	public constructor(owners: number) {
		super(`active owners: ${owners}`);
		this.name = "ActiveOwnersError";
		this.owners = owners;
	}
}

export type ApplyStructuralMigrationResult =
	| { readonly ok: true; readonly storeVersion: number }
	| {
			readonly ok: false;
			readonly code: "gate_not_held" | "active_owners_present" | "epoch_changed" | "migration_failed";
			readonly detail: string;
	  };

/**
 * §4.2 应用一个事务性 structural migration:BEGIN EXCLUSIVE → 重验 gate 持有者
 * 与零 active owner → DDL + schema_meta/format digest + admission=ready → COMMIT。
 * 失败时 DDL 事务回滚并保持 admission=migration_blocked(fail closed)。
 *
 * 这里的重验必须与 `beginOfflineMigration` 使用同一份 `deadOwners` 证据,否则
 * 已证明死亡的 owner 会在第二次计数时重新阻塞,gate 形同虚设。
 */
export function applyStructuralMigration(
	db: SessionDatabase,
	options: {
		gate: MigrationGateHandle;
		nextVersion: number;
		nextSql: string;
		nextFormatDigest: string;
	} & OfflineMigrationGateOptions,
): ApplyStructuralMigrationResult {
	const deadOwners = options.deadOwners ?? [];
	const before = readStoreHeader(db);
	if (!before.ok) return { ok: false, code: "migration_failed", detail: before.detail };
	if (options.nextVersion <= before.header.storeVersion) {
		return { ok: false, code: "migration_failed", detail: "next version must exceed current store version" };
	}
	if (before.header.admission !== "migration_blocked") {
		return { ok: false, code: "gate_not_held", detail: "admission is not migration_blocked" };
	}
	if (before.header.migrationEpoch !== options.gate.migrationEpoch) {
		return { ok: false, code: "epoch_changed", detail: "migration epoch changed; the gate is no longer authoritative" };
	}
	try {
		db.withImmediateTransactionSync((tx) => {
			const owners = countActiveOwners(tx, deadOwners);
			if (owners > 0) {
				throw new ActiveOwnersError(owners);
			}
			tx.execSync(options.nextSql);
			if (options.nextVersion === 2) {
				// Legacy stores had no durable catalog counter; seed it from the existing
				// session rows while the offline migration transaction still owns the gate.
				tx.runSync("UPDATE store_control SET catalog_revision = (SELECT COUNT(*) FROM sessions) WHERE singleton_id = 1");
			}
			tx.runSync("UPDATE schema_meta SET schema_version = ?, format_digest = ?, applied_at_ms = ? WHERE schema_version = ?", [
				options.nextVersion,
				options.nextFormatDigest,
				Date.now(),
				before.header.storeVersion,
			]);
			tx.runSync("UPDATE store_control SET admission = 'ready', updated_at_ms = ? WHERE singleton_id = 1", [Date.now()]);
		});
	} catch (error) {
		if (error instanceof ActiveOwnersError) {
			return { ok: false, code: "active_owners_present", detail: `cannot migrate while ${error.owners} owners are active` };
		}
		return { ok: false, code: "migration_failed", detail: error instanceof Error ? error.message : String(error) };
	}
	return { ok: true, storeVersion: options.nextVersion };
}

/** Built-in legacy -> current migration used by the CLI before owner discovery. */
export function migrateSessionStoreV1ToV2(db: SessionDatabase, options: OfflineMigrationGateOptions = {}): ApplyStructuralMigrationResult | { readonly ok: true; readonly storeVersion: 2; readonly alreadyCurrent: true } {
	const compatibility = checkStoreCompatibility(db);
	if (!compatibility.ok) return { ok: false, code: "migration_failed", detail: compatibility.detail };
	if (compatibility.header.storeVersion === 2) {
		return { ok: true, storeVersion: 2, alreadyCurrent: true };
	}
	if (compatibility.header.storeVersion !== 1) {
		return { ok: false, code: "migration_failed", detail: `unsupported migration source version ${compatibility.header.storeVersion}` };
	}
	const gateResult = beginOfflineMigration(db, options);
	if (!gateResult.ok) return { ok: false, code: "active_owners_present", detail: gateResult.detail };
	const applied = applyStructuralMigration(db, {
		gate: gateResult.gate,
		deadOwners: options.deadOwners,
		nextVersion: 2,
		nextSql: SESSION_STORE_SCHEMA_V1_TO_V2_SQL,
		nextFormatDigest: sessionStoreSchemaFormatDigest(SESSION_STORE_SCHEMA_V2_SQL),
	});
	return applied;
}

/**
 * title schema → current 只追加 nullable source workspace locator，旧二进制
 * 忽略该列仍可读写，因此不能用 offline gate 拒绝正在运行的 owner。DDL 与
 * header 在同一短写事务中提交；若同时已有另一个新 CLI 完成升级，则返回
 * alreadyCurrent。旧 row 保持 NULL，open/resume 继续 fail closed。
 */
export function migrateSessionStoreV2ToV3(db: SessionDatabase): ApplyStructuralMigrationResult | { readonly ok: true; readonly storeVersion: 3; readonly alreadyCurrent: true } {
	const compatibility = checkStoreCompatibility(db);
	if (!compatibility.ok) return { ok: false, code: "migration_failed", detail: compatibility.detail };
	if (compatibility.header.storeVersion === 3) {
		return { ok: true, storeVersion: 3, alreadyCurrent: true };
	}
	if (compatibility.header.storeVersion !== 2) {
		return { ok: false, code: "migration_failed", detail: `unsupported migration source version ${compatibility.header.storeVersion}` };
	}
	let alreadyCurrent = false;
	try {
		db.withImmediateTransactionSync((tx) => {
			const locked = checkStoreCompatibility(tx);
			if (!locked.ok) throw new Error(locked.detail);
			if (locked.header.storeVersion === 3) {
				alreadyCurrent = true;
				return;
			}
			if (locked.header.storeVersion !== 2) throw new Error(`unsupported migration source version ${locked.header.storeVersion}`);
			if (locked.header.admission !== "ready") throw new Error("cannot apply additive migration while offline migration is blocked");
			tx.execSync(SESSION_STORE_SCHEMA_V2_TO_V3_SQL);
			const updated = tx.runSync("UPDATE schema_meta SET schema_version = ?, format_digest = ?, applied_at_ms = ? WHERE schema_version = 2", [
				3,
				sessionStoreSchemaFormatDigest(SESSION_STORE_SCHEMA_V3_SQL),
				Date.now(),
			]);
			if (updated.changes !== 1) throw new Error("schema header changed during additive migration");
		});
	} catch (error) {
		const afterFailure = checkStoreCompatibility(db);
		if (afterFailure.ok && afterFailure.header.storeVersion === 3) {
			return { ok: true, storeVersion: 3, alreadyCurrent: true };
		}
		return { ok: false, code: "migration_failed", detail: error instanceof Error ? error.message : String(error) };
	}
	return alreadyCurrent
		? { ok: true, storeVersion: 3, alreadyCurrent: true }
		: { ok: true, storeVersion: 3 };
}

/** Profile identity 会改变所有新 row 的必填语义，只允许零 active owner 的 offline migration。 */
export function migrateSessionStoreV3ToV4(
	db: SessionDatabase,
	options: OfflineMigrationGateOptions = {},
): ApplyStructuralMigrationResult | { readonly ok: true; readonly storeVersion: 4; readonly alreadyCurrent: true } {
	const compatibility = checkStoreCompatibility(db);
	if (!compatibility.ok) return { ok: false, code: "migration_failed", detail: compatibility.detail };
	if (compatibility.header.storeVersion === 4) {
		return { ok: true, storeVersion: 4, alreadyCurrent: true };
	}
	if (compatibility.header.storeVersion !== 3) {
		return { ok: false, code: "migration_failed", detail: `unsupported migration source version ${compatibility.header.storeVersion}` };
	}
	const gateResult = beginOfflineMigration(db, options);
	if (!gateResult.ok) {
		return {
			ok: false,
			code: gateResult.code === "active_owners_present" ? "active_owners_present" : "migration_failed",
			detail: gateResult.detail,
		};
	}
	return applyStructuralMigration(db, {
		gate: gateResult.gate,
		deadOwners: options.deadOwners,
		nextVersion: 4,
		nextSql: SESSION_STORE_SCHEMA_V3_TO_V4_SQL,
		nextFormatDigest: sessionStoreSchemaFormatDigest(SESSION_STORE_SCHEMA_V4_SQL),
	});
}

/** 新 mode ref 不被旧 binary 支持，必须在零 active owner 时升级。 */
export function migrateSessionStoreV4ToV5(db: SessionDatabase, options: OfflineMigrationGateOptions = {}): ApplyStructuralMigrationResult {
	const compatibility = checkStoreCompatibility(db);
	if (!compatibility.ok) return { ok: false, code: "migration_failed", detail: compatibility.detail };
	if (compatibility.header.storeVersion === 5) return { ok: true, storeVersion: 5 };
	if (compatibility.header.storeVersion !== 4) return { ok: false, code: "migration_failed", detail: "expected schema 4" };
	const gate = beginOfflineMigration(db, options);
	if (!gate.ok) return { ok: false, code: gate.code === "active_owners_present" ? "active_owners_present" : "migration_failed", detail: gate.detail };
	return applyStructuralMigration(db, {
		gate: gate.gate,
		deadOwners: options.deadOwners,
		nextVersion: 5,
		nextSql: SESSION_STORE_SCHEMA_V4_TO_V5_SQL,
		nextFormatDigest: sessionStoreSchemaFormatDigest(SESSION_STORE_SCHEMA_V5_SQL),
	});
}

/** 新 standard ref 只经显式离线迁移开放；旧 binary 必须拒绝新版库。 */
export function migrateSessionStoreV5ToV6(db: SessionDatabase, options: OfflineMigrationGateOptions = {}): ApplyStructuralMigrationResult {
	const compatibility = checkStoreCompatibility(db);
	if (!compatibility.ok) return { ok: false, code: "migration_failed", detail: compatibility.detail };
	if (compatibility.header.storeVersion === 6) return { ok: true, storeVersion: 6 };
	if (compatibility.header.storeVersion !== 5) return { ok: false, code: "migration_failed", detail: "expected schema 5" };
	const gate = beginOfflineMigration(db, options);
	if (!gate.ok) return { ok: false, code: gate.code === "active_owners_present" ? "active_owners_present" : "migration_failed", detail: gate.detail };
	return applyStructuralMigration(db, {
		gate: gate.gate,
		deadOwners: options.deadOwners,
		nextVersion: 6,
		nextSql: SESSION_STORE_SCHEMA_V5_TO_V6_SQL,
		nextFormatDigest: sessionStoreSchemaFormatDigest(SESSION_STORE_SCHEMA_V6_SQL),
	});
}

/** 扩展 exact ref 白名单以开放 plan@2;旧 plan@1 Session 的 ref 保持原值。 */
export function migrateSessionStoreV6ToV7(db: SessionDatabase, options: OfflineMigrationGateOptions = {}): ApplyStructuralMigrationResult {
	const compatibility = checkStoreCompatibility(db);
	if (!compatibility.ok) return { ok: false, code: "migration_failed", detail: compatibility.detail };
	if (compatibility.header.storeVersion === 7) return { ok: true, storeVersion: 7 };
	if (compatibility.header.storeVersion !== 6) return { ok: false, code: "migration_failed", detail: "expected schema 6" };
	const gate = beginOfflineMigration(db, options);
	if (!gate.ok) return { ok: false, code: gate.code === "active_owners_present" ? "active_owners_present" : "migration_failed", detail: gate.detail };
	return applyStructuralMigration(db, {
		gate: gate.gate,
		deadOwners: options.deadOwners,
		nextVersion: 7,
		nextSql: SESSION_STORE_SCHEMA_V6_TO_V7_SQL,
		nextFormatDigest: sessionStoreSchemaFormatDigest(SESSION_STORE_SCHEMA_V7_SQL),
	});
}

/** 显式 schema 迁移入口调用；普通启动不自动改写既有库。 */
export function migrateSessionStoreToCurrent(
	db: SessionDatabase,
	options: OfflineMigrationGateOptions = {},
): ApplyStructuralMigrationResult | { readonly ok: true; readonly storeVersion: 7; readonly alreadyCurrent: true } {
	const compatibility = checkStoreCompatibility(db);
	if (!compatibility.ok) return { ok: false, code: "migration_failed", detail: compatibility.detail };
	if (compatibility.header.storeVersion === 7) return { ok: true, storeVersion: 7, alreadyCurrent: true };
	if (compatibility.header.storeVersion === 1) {
		const titleSchemaMigration = migrateSessionStoreV1ToV2(db, options);
		if (!titleSchemaMigration.ok) return titleSchemaMigration;
	}
	const afterTitle = checkStoreCompatibility(db);
	if (!afterTitle.ok) return { ok: false, code: "migration_failed", detail: afterTitle.detail };
	if (afterTitle.header.storeVersion === 2) {
		const workspaceMigration = migrateSessionStoreV2ToV3(db);
		if (!workspaceMigration.ok) return workspaceMigration;
	}
	const afterWorkspace = checkStoreCompatibility(db);
	if (!afterWorkspace.ok) return { ok: false, code: "migration_failed", detail: afterWorkspace.detail };
	if (afterWorkspace.header.storeVersion === 3) {
		const profileMigration = migrateSessionStoreV3ToV4(db, options);
		if (!profileMigration.ok) return profileMigration;
	}
	const afterProfile = checkStoreCompatibility(db);
	if (!afterProfile.ok) return { ok: false, code: "migration_failed", detail: afterProfile.detail };
	if (afterProfile.header.storeVersion === 4) {
		const modeMigration = migrateSessionStoreV4ToV5(db, options);
		if (!modeMigration.ok) return modeMigration;
	}
	const afterMode = checkStoreCompatibility(db);
	if (!afterMode.ok) return { ok: false, code: "migration_failed", detail: afterMode.detail };
	if (afterMode.header.storeVersion === 5) {
		const shellMigration = migrateSessionStoreV5ToV6(db, options);
		if (!shellMigration.ok) return shellMigration;
	}
	return migrateSessionStoreV6ToV7(db, options);
}

/** 显式 abort:gate 持有者(epoch 匹配)恢复 ready。migrator crash 后唯一合法出口之一。 */
export function abortOfflineMigration(db: SessionDatabase, gate: MigrationGateHandle): boolean {
	const header = readStoreHeader(db);
	if (!header.ok || header.header.admission !== "migration_blocked") return false;
	if (header.header.migrationEpoch !== gate.migrationEpoch) return false;
	db.runSync("UPDATE store_control SET admission = 'ready', updated_at_ms = ? WHERE singleton_id = 1", [Date.now()]);
	return true;
}

/** 崩溃后 resume:同版本 migration tool 显式重新持有 gate(epoch 递增)。 */
export function resumeOfflineMigration(db: SessionDatabase, options: OfflineMigrationGateOptions = {}): BeginOfflineMigrationResult {
	const deadOwners = options.deadOwners ?? [];
	const header = readStoreHeader(db);
	if (!header.ok) {
		return { ok: false, code: "store_schema_incompatible", detail: header.detail };
	}
	if (header.header.admission !== "migration_blocked") {
		return beginOfflineMigration(db, options);
	}
	const epoch = header.header.migrationEpoch;
	let nextEpoch = epoch;
	try {
		db.withImmediateTransactionSync((tx) => {
			const owners = countActiveOwners(tx, deadOwners);
			if (owners > 0) throw new ActiveOwnersError(owners);
			nextEpoch = epoch + 1;
			tx.runSync("UPDATE store_control SET admission = 'migration_blocked', migration_epoch = ?, updated_at_ms = ? WHERE singleton_id = 1", [
				nextEpoch,
				Date.now(),
			]);
		});
	} catch (error) {
		if (error instanceof ActiveOwnersError) {
			return { ok: false, code: "active_owners_present", detail: `cannot resume while ${error.owners} owners are active` };
		}
		throw error;
	}
	return {
		ok: true,
		gate: {
			migrationEpoch: nextEpoch,
			release: () => {
				db.runSync("UPDATE store_control SET admission = 'ready', updated_at_ms = ? WHERE singleton_id = 1", [Date.now()]);
			},
		},
	};
}
