/** MemoryStore 的 exact snapshot codec 与注入式持久化 port。 */

import { runtimeDigest, type RuntimeDigest } from "../../protocol/foundation.ts";
import { parseRuntimeId } from "../../protocol/ids.ts";
import { isRuntimeDigest } from "../../protocol/foundation-schemas.ts";
import { isMemoryProposal, isMemoryRecord } from "./schema.ts";
import type { MemoryProposal, MemoryRecord } from "./types.ts";
import type { MemoryStore, MemoryStoreError, MemoryStoreResult } from "./store.ts";

export interface MemoryStoreContentSnapshot {
	readonly memoryId: MemoryRecord["memoryId"];
	readonly content: string;
	readonly contentDigest: RuntimeDigest;
}

export interface MemoryStoreSnapshot {
	readonly version: 1;
	readonly generation: number;
	readonly records: readonly MemoryRecord[];
	readonly proposals: readonly MemoryProposal[];
	readonly contents: readonly MemoryStoreContentSnapshot[];
}

function invalid(message: string): MemoryStoreResult<never> {
	const error: MemoryStoreError = { code: "invalid_snapshot", message, retryable: false };
	return { ok: false, error };
}

function sameDigest(left: RuntimeDigest, right: RuntimeDigest): boolean {
	return left.algorithm === right.algorithm && left.digest === right.digest;
}

function initialRecordDigest(record: MemoryRecord): RuntimeDigest {
	const { approvedAt: _approvedAt, ...withoutApprovalTimestamp } = record;
	return runtimeDigest({
		...withoutApprovalTimestamp,
		revision: 0,
		trust: "proposed",
		revocationRevision: 0,
	});
}

function proposalBindingMatches(record: MemoryRecord, proposal: MemoryProposal): boolean {
	if (proposal.scope !== record.scope) return false;
	if (proposal.status === "approved") return sameDigest(initialRecordDigest(record), proposal.recordDigest);
	return sameDigest(runtimeDigest(record), proposal.recordDigest) || sameDigest(initialRecordDigest(record), proposal.recordDigest);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unique(values: readonly string[]): boolean {
	return new Set(values).size === values.length;
}

function isMemoryRecordArray(value: unknown): value is MemoryRecord[] {
	return Array.isArray(value) && value.every(isMemoryRecord);
}

function isMemoryProposalArray(value: unknown): value is MemoryProposal[] {
	return Array.isArray(value) && value.every(isMemoryProposal);
}

function isMemoryContentSnapshot(value: unknown): value is MemoryStoreContentSnapshot {
	if (!isObject(value) || typeof value.content !== "string" || !isRuntimeDigest(value.contentDigest) || typeof value.memoryId !== "string") return false;
	return parseRuntimeId("memory", value.memoryId) !== undefined;
}

/** 仅接受当前 snapshot 格式；不猜测旧版本或跳过坏记录。 */
export function isMemoryStoreSnapshot(value: unknown): value is MemoryStoreSnapshot {
	if (!isObject(value) || value.version !== 1 || typeof value.generation !== "number" || !Number.isSafeInteger(value.generation) || value.generation < 0) return false;
	if (!isMemoryRecordArray(value.records) || !isMemoryProposalArray(value.proposals) || !Array.isArray(value.contents) || !value.contents.every(isMemoryContentSnapshot)) return false;
	if (!unique(value.records.map((record) => record.memoryId)) || !unique(value.proposals.map((proposal) => proposal.proposalId)) || !unique(value.contents.map((content) => content.memoryId))) return false;
	const records = new Map(value.records.map((record) => [record.memoryId, record]));
	for (const content of value.contents) {
		if (!sameDigest(runtimeDigest(content.content), content.contentDigest)) return false;
		const record = records.get(content.memoryId);
		if (record === undefined || !sameDigest(record.contentDigest, content.contentDigest)) return false;
	}
	if (records.size !== value.contents.length) return false;
	for (const proposal of value.proposals) {
		const record = records.get(proposal.memoryId);
		if (record === undefined) return false;
		if (!proposalBindingMatches(record, proposal)) return false;
		if (proposal.status === "approved" && (record.trust !== "approved" || proposal.approvalRef === undefined)) return false;
	}
	return true;
}

export interface MemorySnapshotPersistence {
	load(): Promise<string | undefined>;
	save(serialized: string): Promise<void>;
}

export class InMemoryMemorySnapshotPersistence implements MemorySnapshotPersistence {
	#serialized: string | undefined;

	public async load(): Promise<string | undefined> {
		return this.#serialized;
	}

	public async save(serialized: string): Promise<void> {
		this.#serialized = serialized;
	}
}

export class MemoryStoreSnapshotCodec {
	public static encode(snapshot: MemoryStoreSnapshot): string {
		if (!isMemoryStoreSnapshot(snapshot)) throw new Error("memory snapshot failed exact validation");
		return JSON.stringify(snapshot);
	}

	public static decode(serialized: string): MemoryStoreResult<MemoryStoreSnapshot> {
		try {
			const parsed: unknown = JSON.parse(serialized);
			return isMemoryStoreSnapshot(parsed) ? { ok: true, value: parsed } : invalid("memory snapshot failed exact validation");
		} catch (error) {
			return invalid(error instanceof Error ? `memory snapshot JSON is invalid: ${error.message}` : "memory snapshot JSON is invalid");
		}
	}
}

export class MemoryStoreRepository {
	readonly #store: MemoryStore;
	readonly #persistence: MemorySnapshotPersistence;

	public constructor(store: MemoryStore, persistence: MemorySnapshotPersistence) {
		this.#store = store;
		this.#persistence = persistence;
	}

	public async hydrate(): Promise<MemoryStoreResult<void>> {
		try {
			const serialized = await this.#persistence.load();
			if (serialized === undefined) return { ok: true, value: undefined };
			const decoded = MemoryStoreSnapshotCodec.decode(serialized);
			if (!decoded.ok) return decoded;
			return this.#store.restore(decoded.value);
		} catch (error) {
			return { ok: false, error: { code: "persistence_failed", message: error instanceof Error ? error.message : "memory snapshot load failed", retryable: true } };
		}
	}

	public async flush(): Promise<MemoryStoreResult<void>> {
		try {
			await this.#persistence.save(MemoryStoreSnapshotCodec.encode(this.#store.snapshot()));
			return { ok: true, value: undefined };
		} catch (error) {
			return { ok: false, error: { code: "persistence_failed", message: error instanceof Error ? error.message : "memory snapshot save failed", retryable: true } };
		}
	}
}
