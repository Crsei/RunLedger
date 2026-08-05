/** P5 只读 locator 审计：旧记录分类为 current / migration_required / invalid，绝不改写。 */

/**
 * 本模块只读：输入序列化记录，输出分类结论；不产生任何写入、不猜测转换。
 * migration 是否执行由显式 migration plan（03-locator-migration-plan.md）在
 * digest/TOCTOU/rollback 方案批准后另行决定。
 */

import { decodePrivateLocator, parsePath } from "./path-adapter.ts";
import type { PrivateLocatorV1 } from "./types.ts";

export type LocatorAuditVerdict =
	| { readonly status: "current"; readonly record: PrivateLocatorV1 }
	| { readonly status: "migration_required"; readonly reason: string }
	| { readonly status: "invalid"; readonly reason: string };

export interface LocatorAuditEntry {
	readonly name: string;
	readonly verdict: LocatorAuditVerdict;
}

export interface LocatorAuditReport {
	readonly entries: readonly LocatorAuditEntry[];
	readonly current: number;
	readonly migrationRequired: number;
	readonly invalid: number;
	/** 只读声明：审计不产生任何 locator 写入。 */
	readonly readOnly: true;
}

export function auditLocatorRecord(name: string, serialized: string): LocatorAuditEntry {
	const decoded = decodePrivateLocator(serialized);
	if (!decoded.ok) return { name, verdict: { status: "migration_required", reason: decoded.error.message } };
	// 结构上是 current（版本/平台/kind 合法），但路径本身不可用（如相对路径）→ invalid，绝不猜测修复。
	const parsed = parsePath(decoded.value.path, decoded.value.platform);
	if (!parsed.ok) return { name, verdict: { status: "invalid", reason: parsed.error.message } };
	return { name, verdict: { status: "current", record: decoded.value } };
}

export function auditLocatorCollection(records: readonly { readonly name: string; readonly content: string }[]): LocatorAuditReport {
	const entries = records.map((record) => auditLocatorRecord(record.name, record.content));
	return {
		entries,
		current: entries.filter((entry) => entry.verdict.status === "current").length,
		migrationRequired: entries.filter((entry) => entry.verdict.status === "migration_required").length,
		invalid: entries.filter((entry) => entry.verdict.status === "invalid").length,
		readOnly: true,
	};
}
