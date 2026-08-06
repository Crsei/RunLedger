/**
 * R1:Session Store schema compatibility 与 offline-only migration admission gate
 * (06 §4.2)。
 *
 * - 每个 binary 编译时固定 STORE_SCHEMA_MIN/MAX/CURRENT(见 session-owner/types);
 * - Client 在 owner discovery 前只能读取冻结的 schema header/store_control;
 *   高于 MAX → store_schema_too_new,低于 MIN 且无对应 migration →
 *   store_schema_too_old;protocol negotiation 不能覆盖 storage incompatibility;
 * - 所有 structural migration 必须 offline-only:先 BEGIN IMMEDIATE 置
 *   admission=migration_blocked 并证明零 active owner,再 BEGIN EXCLUSIVE
 *   重验后应用一个事务性 DDL migration;migrator crash 后 persisted
 *   migration_blocked 保持 fail closed,只能显式 resume/abort。
 */

import { SESSION_STORE_SCHEMA_MAX, SESSION_STORE_SCHEMA_MIN } from "../../runtime/session-owner/types.ts";
import type { SessionDatabase } from "./database.ts";
import { SESSION_STORE_SCHEMA_VERSION, sessionStoreSchemaFormatDigest } from "./schema.ts";

export const ACTIVE_OWNER_STATES = ["starting", "recovery_required", "running", "stopping"] as const;

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
	// 当前版本必须匹配 binary 的 exact DDL digest;未来版本由 MIN/MAX 窗口覆盖。
	if (storeVersion === SESSION_STORE_SCHEMA_VERSION && formatDigest !== sessionStoreSchemaFormatDigest()) {
		return { ok: false, code: "format_digest_mismatch", detail: "schema format digest does not match the binary expectation" };
	}
	return { ok: true, header: result.header };
}

export function countActiveOwners(db: SessionDatabase): number {
	const row = db.querySingle(
		"SELECT COUNT(*) AS n FROM session_owners WHERE state IN ('starting', 'recovery_required', 'running', 'stopping')",
	);
	return Number(row?.n ?? 0);
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
 */
export function beginOfflineMigration(db: SessionDatabase): BeginOfflineMigrationResult {
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
			const owners = countActiveOwners(tx);
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
 */
export function applyStructuralMigration(
	db: SessionDatabase,
	options: {
		gate: MigrationGateHandle;
		nextVersion: number;
		nextSql: string;
		nextFormatDigest: string;
	},
): ApplyStructuralMigrationResult {
	if (options.nextVersion <= SESSION_STORE_SCHEMA_VERSION) {
		return { ok: false, code: "migration_failed", detail: "next version must exceed current" };
	}
	const before = readStoreHeader(db);
	if (!before.ok) return { ok: false, code: "migration_failed", detail: before.detail };
	if (before.header.admission !== "migration_blocked") {
		return { ok: false, code: "gate_not_held", detail: "admission is not migration_blocked" };
	}
	if (before.header.migrationEpoch !== options.gate.migrationEpoch) {
		return { ok: false, code: "epoch_changed", detail: "migration epoch changed; the gate is no longer authoritative" };
	}
	try {
		db.withImmediateTransactionSync((tx) => {
			const owners = countActiveOwners(tx);
			if (owners > 0) {
				throw new ActiveOwnersError(owners);
			}
			tx.execSync(options.nextSql);
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

/** 显式 abort:gate 持有者(epoch 匹配)恢复 ready。migrator crash 后唯一合法出口之一。 */
export function abortOfflineMigration(db: SessionDatabase, gate: MigrationGateHandle): boolean {
	const header = readStoreHeader(db);
	if (!header.ok || header.header.admission !== "migration_blocked") return false;
	if (header.header.migrationEpoch !== gate.migrationEpoch) return false;
	db.runSync("UPDATE store_control SET admission = 'ready', updated_at_ms = ? WHERE singleton_id = 1", [Date.now()]);
	return true;
}

/** 崩溃后 resume:同版本 migration tool 显式重新持有 gate(epoch 递增)。 */
export function resumeOfflineMigration(db: SessionDatabase): BeginOfflineMigrationResult {
	const header = readStoreHeader(db);
	if (!header.ok) {
		return { ok: false, code: "store_schema_incompatible", detail: header.detail };
	}
	if (header.header.admission !== "migration_blocked") {
		return beginOfflineMigration(db);
	}
	const epoch = header.header.migrationEpoch;
	let nextEpoch = epoch;
	try {
		db.withImmediateTransactionSync((tx) => {
			const owners = countActiveOwners(tx);
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
