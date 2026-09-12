import type { SessionStore } from "../../storage/session-store/session-store.ts";
import { createRuntimeId } from "../protocol/ids.ts";
import { runtimeDigest, type RuntimeDigest } from "../protocol/foundation.ts";
import type { OwnerFence } from "../session-owner/types.ts";

export interface PermissionUpdateRecord {
	readonly stage: "prepared" | "applied" | "rejected" | "recovered" | "abandoned";
	readonly updateId: string;
	readonly inputDigest: RuntimeDigest;
	readonly fromRevision: number;
	readonly toRevision: number;
	readonly previousPolicyDigest: RuntimeDigest;
	readonly policyDigest: RuntimeDigest;
	readonly configurationDigest: RuntimeDigest;
	readonly previousSourceDigest: RuntimeDigest;
	readonly sourceDigest: RuntimeDigest;
	readonly profile: string;
}

/** 只保存脱敏绑定信息；完整 snapshot/native path 不进入变更事件。 */
export interface PermissionUpdateJournal {
	records(): readonly PermissionUpdateRecord[];
	append(record: PermissionUpdateRecord): void;
	latestInitializedRevision?(): number;
	initialize?(revision: number, policyDigest: RuntimeDigest): void;
}

export function createPermissionUpdateJournal(store: SessionStore, fence: OwnerFence): PermissionUpdateJournal {
	return {
		latestInitializedRevision: () => store.replaySessionEvents(fence.sessionId)
			.filter((event) => event.eventType === "session.security.initialized")
			.reduce((maximum, event) => {
				const value = JSON.parse(event.payloadJson) as { securityRevision?: unknown };
				if (!Number.isSafeInteger(value.securityRevision) || Number(value.securityRevision) < 1) throw new Error("permission revision journal is invalid");
				return Math.max(maximum, Number(value.securityRevision));
			}, 0),
		initialize: (securityRevision, policyDigest) => {
			const tail = store.replaySessionEvents(fence.sessionId).at(-1);
			store.appendEvent(fence, {
				eventId: createRuntimeId("event", `permission-initial-${fence.sessionId}-${fence.generation}`),
				ownerGeneration: fence.generation, eventType: "session.security.initialized",
				payloadJson: JSON.stringify({ securityRevision, policyDigest }), createdAtMs: Date.now(),
				expectedPreviousEventHash: tail?.currentEventHash ?? null,
			});
		},
		records: () => store.replaySessionEvents(fence.sessionId)
			.filter((event) => event.eventType === "session.security.update")
			.map((event) => {
				const value: unknown = JSON.parse(event.payloadJson);
				if (!isPermissionUpdateRecord(value)) throw new Error("permission update journal is invalid");
				return value;
			}),
		append: (record) => {
			if (!isPermissionUpdateRecord(record)) throw new Error("permission update record is invalid");
			const tail = store.replaySessionEvents(fence.sessionId).at(-1);
			// updateId 仅在会话内幂等；全库唯一的事件 ID 必须绑定 Session，摘要避免超出 ID 长度上限。
			const eventKey = runtimeDigest({ sessionId: fence.sessionId, updateId: record.updateId }).digest;
			store.appendEvent(fence, {
				eventId: createRuntimeId("event", `permission-${eventKey}-${record.stage}`),
				ownerGeneration: fence.generation,
				eventType: "session.security.update",
				payloadJson: JSON.stringify(record),
				createdAtMs: Date.now(),
				expectedPreviousEventHash: tail?.currentEventHash ?? null,
			});
		},
	};
}

export function nextPermissionRevision(journal: PermissionUpdateJournal): number {
	return journal.records().reduce((maximum, record) => Math.max(maximum, record.toRevision), journal.latestInitializedRevision?.() ?? 0) + 1;
}

function isDigest(value: unknown): value is RuntimeDigest {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return record.algorithm === "sha256" && typeof record.digest === "string" && /^[a-f0-9]{64}$/u.test(record.digest);
}

function isPermissionUpdateRecord(value: unknown): value is PermissionUpdateRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return ["prepared", "applied", "rejected", "recovered", "abandoned"].includes(String(record.stage)) &&
		typeof record.updateId === "string" && /^[a-f0-9]{64}$/u.test(record.updateId) &&
		Number.isSafeInteger(record.fromRevision) && Number(record.fromRevision) >= 1 &&
		Number.isSafeInteger(record.toRevision) && Number(record.toRevision) === Number(record.fromRevision) + 1 &&
		typeof record.profile === "string" && record.profile.length > 0 && record.profile.length <= 128 &&
		[record.inputDigest, record.previousPolicyDigest, record.policyDigest, record.configurationDigest, record.previousSourceDigest, record.sourceDigest].every(isDigest);
}
