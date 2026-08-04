/**
 * Memory MVP 行为核心。
 *
 * 记录和 proposal 的状态机在这里保持独立；正文通过受控 content map 保存，
 * 以后可替换为 canonical home 下的 record/artifact adapter。未批准或 digest
 * 漂移的记录永远不会进入 search 结果。
 */

import { runtimeDigest, type RuntimeContentRef, type RuntimeDigest, type RuntimeStreamHead } from "../../protocol/foundation.ts";
import { isCanonicalUtcTimestamp, isRuntimeContentRef } from "../../protocol/foundation-schemas.ts";
import { createRuntimeId, type MemoryId, type ProposalId, type SessionId, type WorkspaceId } from "../../protocol/ids.ts";
import { isMemoryStoreSnapshot, type MemoryStoreSnapshot } from "./persistence.ts";
import { isMemoryProposal, isMemoryRecord, isMemorySearchReceipt } from "./schema.ts";
import type { MemoryProposal, MemoryProvenance, MemoryRecord, MemoryScope, MemorySearchReceipt } from "./types.ts";

export type MemoryScopeBinding =
	| { readonly scope: "user" }
	| { readonly scope: "workspace"; readonly workspaceId: WorkspaceId }
	| { readonly scope: "session"; readonly sessionId: SessionId };

export type MemoryProposalInput = MemoryScopeBinding & {
	readonly title: string;
	readonly content: string;
	readonly sourceKind: MemoryProvenance["sourceKind"];
	readonly sourceRef: RuntimeContentRef;
	readonly sourceDigest: RuntimeDigest;
	readonly expiresAt?: string;
};

export type MemorySearchOptions = MemoryScopeBinding & {
	readonly query: string;
	readonly maxResults?: number;
	readonly maxSnippetChars?: number;
	readonly maxTotalTokens?: number;
	readonly cursor?: string;
};

export interface MemorySearchResult {
	readonly memoryId: MemoryId;
	readonly title: string;
	readonly snippet: string;
	readonly score: number;
	readonly contentDigest: RuntimeDigest;
	readonly stale: boolean;
}

export interface MemorySearchValue {
	readonly results: readonly MemorySearchResult[];
	readonly receipt: MemorySearchReceipt;
	readonly nextCursor?: string;
}

export type MemoryStoreErrorCode = "invalid_request" | "not_found" | "invalid_state" | "scope_denied" | "invalid_snapshot" | "persistence_failed";

export interface MemoryStoreError {
	readonly code: MemoryStoreErrorCode;
	readonly message: string;
	readonly retryable: boolean;
}

export type MemoryStoreResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: MemoryStoreError };

export interface MemoryStoreOptions {
	readonly clock?: () => Date;
	readonly sourceHead?: RuntimeStreamHead;
}

export interface MemoryProposalValue {
	readonly record: MemoryRecord;
	readonly proposal: MemoryProposal;
}

export interface MemoryApprovalValue {
	readonly record: MemoryRecord;
	readonly proposal: MemoryProposal;
}

const DEFAULT_MAX_RESULTS = 16;
const DEFAULT_MAX_SNIPPET_CHARS = 512;
const DEFAULT_MAX_TOTAL_TOKENS = 2_048;

function failure<T>(code: MemoryStoreErrorCode, message: string, retryable = false): MemoryStoreResult<T> {
	return { ok: false, error: { code, message, retryable } };
}

function nowIso(clock: () => Date): string {
	const value = clock().toISOString();
	if (!isCanonicalUtcTimestamp(value)) throw new Error("memory clock must return a valid UTC timestamp");
	return value;
}

function sameDigest(left: RuntimeDigest, right: RuntimeDigest): boolean {
	return left.algorithm === right.algorithm && left.digest === right.digest;
}

function tokenCount(value: string): number {
	return Math.max(1, Math.ceil(Buffer.byteLength(value, "utf8") / 4));
}

function words(value: string): string[] {
	return value.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number, name: string): MemoryStoreResult<number> {
	const resolved = value ?? fallback;
	if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) return failure("invalid_request", `${name} must be an integer in [1, ${maximum}]`);
	return { ok: true, value: resolved };
}

function validScope(input: MemoryScopeBinding): boolean {
	if (input.scope === "user") return true;
	if (input.scope === "workspace") return input.workspaceId.length > 0;
	return input.sessionId.length > 0;
}

function recordMatchesScope(record: MemoryRecord, input: MemoryScopeBinding): boolean {
	if (input.scope === "user") return record.scope === "user";
	if (input.scope === "workspace") {
		return record.scope === "user" || (record.scope === "workspace" && record.workspaceId === input.workspaceId);
	}
	return record.scope === "user" || (record.scope === "session" && record.sessionId === input.sessionId);
}

function scopeFields(input: MemoryScopeBinding): { readonly scope: MemoryScope; readonly workspaceId?: WorkspaceId; readonly sessionId?: SessionId } {
	return input.scope === "workspace"
		? { scope: input.scope, workspaceId: input.workspaceId }
		: input.scope === "session"
			? { scope: input.scope, sessionId: input.sessionId }
			: { scope: input.scope };
}

function snippet(content: string, query: readonly string[], maxChars: number): string {
	const lower = content.toLocaleLowerCase();
	const first = query.map((word) => lower.indexOf(word)).filter((index) => index >= 0).sort((left, right) => left - right)[0] ?? 0;
	const start = Math.max(0, Math.min(first, Math.max(0, content.length - maxChars)));
	return content.slice(start, start + maxChars);
}

export class MemoryStore {
	readonly #clock: () => Date;
	readonly #sourceHead?: RuntimeStreamHead;
	readonly #records = new Map<MemoryId, MemoryRecord>();
	readonly #proposals = new Map<ProposalId, MemoryProposal>();
	readonly #content = new Map<MemoryId, string>();
	#generation = 0;

	public constructor(options: MemoryStoreOptions = {}) {
		this.#clock = options.clock ?? (() => new Date());
		this.#sourceHead = options.sourceHead;
	}

	public snapshot(): MemoryStoreSnapshot {
		return {
			version: 1,
			generation: this.#generation,
			records: [...this.#records.values()].sort((left, right) => left.memoryId.localeCompare(right.memoryId)),
			proposals: [...this.#proposals.values()].sort((left, right) => left.proposalId.localeCompare(right.proposalId)),
			contents: [...this.#content.entries()]
				.map(([memoryId, content]) => ({ memoryId, content, contentDigest: runtimeDigest(content) }))
				.sort((left, right) => left.memoryId.localeCompare(right.memoryId)),
		};
	}

	public restore(snapshot: MemoryStoreSnapshot): MemoryStoreResult<void> {
		if (!isMemoryStoreSnapshot(snapshot)) return failure("invalid_snapshot", "memory snapshot failed exact validation");
		this.#records.clear();
		this.#proposals.clear();
		this.#content.clear();
		for (const record of snapshot.records) this.#records.set(record.memoryId, record);
		for (const proposal of snapshot.proposals) this.#proposals.set(proposal.proposalId, proposal);
		for (const content of snapshot.contents) this.#content.set(content.memoryId, content.content);
		this.#generation = snapshot.generation;
		return { ok: true, value: undefined };
	}

	public propose(input: MemoryProposalInput): MemoryStoreResult<MemoryProposalValue> {
		if (!validScope(input) || input.title.trim().length === 0 || input.title.length > 256 || input.content.length === 0 || !isRuntimeContentRef(input.sourceRef) || !sameDigest(input.sourceRef.digest, input.sourceDigest)) {
			return failure("invalid_request", "memory proposal has invalid scope, title, content, or source reference");
		}
		const createdAt = nowIso(this.#clock);
		if (input.expiresAt !== undefined && (!isCanonicalUtcTimestamp(input.expiresAt) || Date.parse(input.expiresAt) <= Date.parse(createdAt))) {
			return failure("invalid_request", "memory expiry must be a future canonical UTC timestamp");
		}
		const contentDigest = runtimeDigest(input.content);
		const scope = scopeFields(input);
		const memoryId = createRuntimeId("memory", runtimeDigest({ scope, title: input.title, contentDigest, sourceDigest: input.sourceDigest }).digest.slice(0, 48));
		const record: MemoryRecord = {
			memoryId,
			...scope,
			title: input.title.trim(),
			contentDigest,
			contentRef: { subjectKind: "content", digest: contentDigest, mediaType: "text/plain", size: Buffer.byteLength(input.content, "utf8") },
			revision: 0,
			trust: "proposed",
			provenance: { sourceKind: input.sourceKind, sourceRef: input.sourceRef, sourceDigest: input.sourceDigest, createdAt },
			...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
			revocationRevision: 0,
		};
		if (!isMemoryRecord(record)) return failure("invalid_state", "memory proposal failed current record validation");
		const proposalId = createRuntimeId("proposal", runtimeDigest({ memoryId, recordDigest: runtimeDigest(record), createdAt }).digest.slice(0, 48));
		// 当前 Runtime proposal schema 只携带 scope；workspace/session binding 由 record
		// 承载，避免在 behavior 层扩展公共 proposal envelope。
		const proposal: MemoryProposal = { proposalId, memoryId, scope: input.scope, recordDigest: runtimeDigest(record), status: "pending", createdAt };
		if (!isMemoryProposal(proposal)) return failure("invalid_state", "memory proposal failed current proposal validation");
		this.#records.set(memoryId, record);
		this.#proposals.set(proposalId, proposal);
		this.#content.set(memoryId, input.content);
		this.#generation += 1;
		return { ok: true, value: { record, proposal } };
	}

	public approve(input: { readonly proposalId: ProposalId; readonly approvalRef: RuntimeContentRef }): MemoryStoreResult<MemoryApprovalValue> {
		if (!isRuntimeContentRef(input.approvalRef)) return failure("invalid_request", "memory approval reference is invalid");
		const proposal = this.#proposals.get(input.proposalId);
		if (!proposal) return failure("not_found", "memory proposal was not found");
		if (proposal.status !== "pending") return failure("invalid_state", "memory proposal is no longer pending");
		const record = this.#records.get(proposal.memoryId);
		if (!record || !sameDigest(runtimeDigest(record), proposal.recordDigest)) return failure("invalid_state", "memory proposal record is missing or changed");
		const approvedAt = nowIso(this.#clock);
		const nextRecord: MemoryRecord = { ...record, revision: record.revision + 1, trust: "approved", approvedAt };
		const nextProposal: MemoryProposal = { ...proposal, status: "approved", approvalRef: input.approvalRef };
		if (!isMemoryRecord(nextRecord) || !isMemoryProposal(nextProposal)) return failure("invalid_state", "memory approval failed current schema validation");
		this.#records.set(record.memoryId, nextRecord);
		this.#proposals.set(proposal.proposalId, nextProposal);
		this.#generation += 1;
		return { ok: true, value: { record: nextRecord, proposal: nextProposal } };
	}

	public reject(proposalId: ProposalId): MemoryStoreResult<MemoryProposal> {
		const proposal = this.#proposals.get(proposalId);
		if (!proposal) return failure("not_found", "memory proposal was not found");
		if (proposal.status !== "pending") return failure("invalid_state", "memory proposal is no longer pending");
		const rejected = { ...proposal, status: "rejected" as const };
		this.#proposals.set(proposalId, rejected);
		this.#generation += 1;
		return { ok: true, value: rejected };
	}

	public revoke(memoryId: MemoryId): MemoryStoreResult<MemoryRecord> {
		const record = this.#records.get(memoryId);
		if (!record) return failure("not_found", "memory record was not found");
		if (record.trust === "revoked") return { ok: true, value: record };
		const revoked: MemoryRecord = { ...record, revision: record.revision + 1, trust: "revoked", revocationRevision: record.revocationRevision + 1 };
		this.#records.set(memoryId, revoked);
		this.#generation += 1;
		return { ok: true, value: revoked };
	}

	public markContentDigest(memoryId: MemoryId, observedDigest: RuntimeDigest): MemoryStoreResult<MemoryRecord> {
		const record = this.#records.get(memoryId);
		if (!record) return failure("not_found", "memory record was not found");
		if (sameDigest(record.contentDigest, observedDigest) || record.trust === "revoked") return { ok: true, value: record };
		const changed: MemoryRecord = { ...record, revision: record.revision + 1, trust: "changed_unreviewed" };
		this.#records.set(memoryId, changed);
		this.#generation += 1;
		return { ok: true, value: changed };
	}

	public get(memoryId: MemoryId): MemoryStoreResult<MemoryRecord> {
		const record = this.#records.get(memoryId);
		return record ? { ok: true, value: record } : failure("not_found", "memory record was not found");
	}

	public search(input: MemorySearchOptions): MemoryStoreResult<MemorySearchValue> {
		if (!validScope(input) || input.query.trim().length === 0) return failure("invalid_request", "memory search requires a scope and non-empty query");
		const maxResults = boundedInteger(input.maxResults, DEFAULT_MAX_RESULTS, 64, "maxResults");
		if (!maxResults.ok) return maxResults;
		const maxSnippetChars = boundedInteger(input.maxSnippetChars, DEFAULT_MAX_SNIPPET_CHARS, 2_048, "maxSnippetChars");
		if (!maxSnippetChars.ok) return maxSnippetChars;
		const maxTotalTokens = boundedInteger(input.maxTotalTokens, DEFAULT_MAX_TOTAL_TOKENS, 8_192, "maxTotalTokens");
		if (!maxTotalTokens.ok) return maxTotalTokens;
		const offset = input.cursor === undefined ? 0 : Number(input.cursor);
		if (!Number.isSafeInteger(offset) || offset < 0) return failure("invalid_request", "memory search cursor is invalid");
		const query = words(input.query);
		if (query.length === 0) return failure("invalid_request", "memory search query has no searchable terms");
		const now = this.#clock().getTime();
		const scored = [...this.#records.values()]
			.filter((record) => record.trust === "approved" && (record.expiresAt === undefined || Date.parse(record.expiresAt) > now) && recordMatchesScope(record, input))
			.map((record) => {
				const content = this.#content.get(record.memoryId) ?? "";
				const titleWords = words(record.title);
				const bodyWords = words(content);
				const score = query.reduce((total, word) => total + titleWords.filter((item) => item === word).length * 3 + bodyWords.filter((item) => item === word).length, 0);
				return { record, content, score };
			})
			.filter((item) => item.score > 0)
			.sort((left, right) => right.score - left.score || left.record.memoryId.localeCompare(right.record.memoryId));
		const resultRows: MemorySearchResult[] = [];
		let usedTokens = 0;
		for (const item of scored.slice(offset)) {
			if (resultRows.length >= maxResults.value) break;
			const remainingTokens = maxTotalTokens.value - usedTokens;
			if (remainingTokens <= 0) break;
			const rowSnippet = snippet(item.content, query, Math.min(maxSnippetChars.value, remainingTokens * 4));
			const rowTokens = tokenCount(rowSnippet);
			if (rowSnippet.length === 0 || rowTokens > remainingTokens) break;
			resultRows.push({ memoryId: item.record.memoryId, title: item.record.title, snippet: rowSnippet, score: item.score, contentDigest: item.record.contentDigest, stale: false });
			usedTokens += rowTokens;
		}
		const indexDigest = runtimeDigest([...this.#records.values()].sort((left, right) => left.memoryId.localeCompare(right.memoryId)).map((record) => ({ memoryId: record.memoryId, revision: record.revision, trust: record.trust, contentDigest: record.contentDigest })));
		const scope = scopeFields(input);
		const sourceHead = this.#sourceHead ?? { streamId: createRuntimeId("trace", "memory-store"), sequence: this.#generation, eventHash: runtimeDigest({ generation: this.#generation, indexDigest }) };
		const receipt: MemorySearchReceipt = {
			receiptId: createRuntimeId("receipt", runtimeDigest({ query: input.query, scope, offset, resultIds: resultRows.map((row) => row.memoryId), indexDigest }).digest.slice(0, 48)),
			queryDigest: runtimeDigest(input.query),
			...scope,
			mode: "lexical",
			resultIds: resultRows.map((row) => row.memoryId),
			indexDigest,
			sourceHead,
			createdAt: nowIso(this.#clock),
		};
		if (!isMemorySearchReceipt(receipt)) return failure("invalid_state", "memory search receipt failed current schema validation");
		const nextOffset = offset + resultRows.length;
		return { ok: true, value: { results: resultRows, receipt, ...(nextOffset < scored.length ? { nextCursor: String(nextOffset) } : {}) } };
	}
}
