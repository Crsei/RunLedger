/**
 * Memory schema guard。
 *
 * TODO(runtime-phase-6): 增加 approved-only injection、digest drift、scope 越界、
 * index rebuild 和 proposal 状态机的 contract fixtures。
 */

import type { MemoryRecord, MemorySearchReceipt } from "./types.ts";

export function isMemoryRecord(value: unknown): value is MemoryRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.memoryId === "string" &&
		(candidate.scope === "user" || candidate.scope === "workspace" || candidate.scope === "session") &&
		typeof candidate.title === "string" &&
		typeof candidate.body === "string" &&
		typeof candidate.digest === "string" &&
		(candidate.trust === "untrusted" ||
			candidate.trust === "proposed" ||
			candidate.trust === "approved" ||
			candidate.trust === "revoked" ||
			candidate.trust === "changed_unreviewed") &&
		typeof candidate.provenance === "object" &&
		typeof candidate.revocationRevision === "number" &&
		Number.isInteger(candidate.revocationRevision) &&
		candidate.revocationRevision >= 0
	);
}

export function isMemorySearchReceipt(value: unknown): value is MemorySearchReceipt {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.queryDigest === "string" &&
		(candidate.scope === "user" || candidate.scope === "workspace" || candidate.scope === "session") &&
		(candidate.mode === "lexical" || candidate.mode === "vector" || candidate.mode === "none") &&
		Array.isArray(candidate.resultIds) &&
		typeof candidate.indexDigest === "string" &&
		typeof candidate.createdAt === "string"
	);
}
