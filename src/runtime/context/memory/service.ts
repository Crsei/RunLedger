import { canonicalDigest } from "../../protocol/v3/canonical-json.ts";
import type { ApprovalReceiptRef, ArtifactRef } from "../../protocol/v3/capability.ts";
import type { RuntimeEventPayloadMap } from "../../protocol/v3/event-payloads.ts";
import { createRuntimeId, type AuthorityId, type ContextRequestId, type PrincipalId, type SessionId, type TenantId, type TraceId, type WorkspaceId } from "../../protocol/v3/ids.ts";
import type { DeclassificationReceiptRef } from "../../protocol/v3/taint.ts";
import type { ContextFragment } from "../types.ts";
import { createMemoryContextFragment, createMemoryInjectionReceipt } from "./context-fragment.ts";
import { createMemorySearchRequest } from "./search.ts";
import type { MemoryDiff, MemoryProposal, MemoryRecord, MemoryScopeRef, MemorySearchReceipt, MemorySearchRequest, MemorySourceRef } from "./types.ts";
import { isMemoryProposal, isMemoryRecord } from "./schema.ts";

export type MemoryRuntimeEvent = {
	[TType in "memory.proposed" | "memory.approved" | "memory.rejected" | "memory.published" | "memory.searched" | "memory.injected" | "memory.revoked" | "memory.expired"]: {
		type: TType;
		principalId: PrincipalId;
		traceId: TraceId;
		payload: RuntimeEventPayloadMap[TType];
	};
}["memory.proposed" | "memory.approved" | "memory.rejected" | "memory.published" | "memory.searched" | "memory.injected" | "memory.revoked" | "memory.expired"];

export interface MemoryEventSink {
	append(event: MemoryRuntimeEvent): Promise<void>;
}

export interface MemoryServiceIdentity {
	authorityId: AuthorityId;
	tenantId: TenantId;
	principalId: PrincipalId;
	sessionId: SessionId;
	workspaceId: WorkspaceId;
}

function memoryRef(record: MemoryRecord) {
	return {
		schemaVersion: 1 as const,
		authorityId: record.authorityId,
		tenantId: record.tenantId,
		memoryId: record.memoryId,
		scope: record.scope,
		revision: record.revision,
		contentDigest: record.contentDigest,
		status: record.status,
	};
}

export interface MemoryStorePort {
	createDiffArtifact(diffBody: string, scope: MemoryScopeRef): ArtifactRef;
	saveProposal(proposal: MemoryProposal, draft: MemoryRecord): Promise<void>;
	publish(scope: MemoryScopeRef, proposalId: MemoryProposal["proposalId"], receipt: ApprovalReceiptRef, now: string): Promise<MemoryRecord>;
	reject(scope: MemoryScopeRef, proposalId: MemoryProposal["proposalId"], receipt: ApprovalReceiptRef): Promise<MemoryProposal>;
	publishRevocation(scope: MemoryScopeRef, proposalId: MemoryProposal["proposalId"], receipt: ApprovalReceiptRef, now: string): Promise<MemoryRecord>;
	expire(record: MemoryRecord, now: string): Promise<MemoryRecord>;
	listRecords(scopes: readonly MemoryScopeRef[]): Promise<readonly MemoryRecord[]>;
}

export interface MemorySearchIndexPort {
	search(request: MemorySearchRequest, records: readonly MemoryRecord[], now: Date): Promise<MemorySearchReceipt>;
}

function diffArtifact(store: MemoryStorePort, scope: MemoryScopeRef, body: Readonly<Record<string, unknown>>) {
	const serialized = JSON.stringify(body);
	return { artifact: store.createDiffArtifact(serialized, scope), digest: canonicalDigest(body) };
}

function unavailableSearchReceipt(
	identity: MemoryServiceIdentity,
	request: ReturnType<typeof createMemorySearchRequest>,
	now: string,
	diagnostic: "memory_unavailable" | "memory_event_sink_unavailable",
): MemorySearchReceipt {
	const indexDigest = canonicalDigest([]);
	const seed = canonicalDigest({ requestId: request.requestId, queryDigest: request.queryDigest, diagnostic });
	return {
		schemaVersion: 1,
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		principalId: identity.principalId,
		requestId: request.requestId,
		receiptId: createRuntimeId("receipt", `memory-unavailable-${seed.slice(0, 40)}`),
		queryDigest: request.queryDigest,
		mode: "none",
		indexDigest,
		results: [],
		diagnostics: [diagnostic],
		searchedAt: now,
	};
}

export class MemoryService {
	readonly #identity: MemoryServiceIdentity;
	readonly #store: MemoryStorePort;
	readonly #index: MemorySearchIndexPort;
	readonly #events: MemoryEventSink;
	readonly #clock: () => Date;

	public constructor(options: { identity: MemoryServiceIdentity; store: MemoryStorePort; index: MemorySearchIndexPort; events: MemoryEventSink; clock?: () => Date }) {
		this.#identity = options.identity;
		this.#store = options.store;
		this.#index = options.index;
		this.#events = options.events;
		this.#clock = options.clock ?? (() => new Date());
	}

	public async propose(input: {
		title: string;
		content: string;
		scope: MemoryScopeRef;
		sourceRefs: readonly MemorySourceRef[];
		traceId: TraceId;
		expiresAt?: string;
	}): Promise<{ proposal: MemoryProposal; draft: MemoryRecord }> {
		const now = this.#clock().toISOString();
		const memoryId = createRuntimeId("memory");
		const content = input.content.slice(0, 65_536);
		const draft: MemoryRecord = {
			schemaVersion: 1,
			authorityId: this.#identity.authorityId,
			tenantId: this.#identity.tenantId,
			memoryId,
			scope: input.scope,
			revision: 0,
			status: "proposed",
			title: input.title.trim().slice(0, 256),
			content,
			contentDigest: canonicalDigest(content),
			sourceRefs: input.sourceRefs,
			createdByPrincipalId: this.#identity.principalId,
			createdAt: now,
			updatedAt: now,
			...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
			revocationRevision: 0,
		};
		if (!isMemoryRecord(draft)) throw new Error("memory draft failed public contract validation");
		const after = memoryRef(draft);
		const diffBody = { kind: "create", after, fields: ["title", "content", "scope", "sources", "expiresAt"] } as const;
		const storedDiff = diffArtifact(this.#store, input.scope, diffBody);
		const diff: MemoryDiff = {
			kind: "create",
			after,
			changes: [
				{ field: "title", afterDigest: canonicalDigest(draft.title) },
				{ field: "content", afterDigest: draft.contentDigest },
				{ field: "scope", afterDigest: canonicalDigest(draft.scope) },
				{ field: "sources", afterDigest: canonicalDigest(draft.sourceRefs) },
			],
			diffArtifact: storedDiff.artifact,
			diffDigest: storedDiff.digest,
		};
		const proposal: MemoryProposal = {
			schemaVersion: 1,
			authorityId: this.#identity.authorityId,
			tenantId: this.#identity.tenantId,
			proposalId: createRuntimeId("memoryProposal"),
			memory: after,
			diff,
			status: "pending",
			approvalId: createRuntimeId("approval"),
			proposedByPrincipalId: this.#identity.principalId,
			createdAt: now,
		};
		if (!isMemoryProposal(proposal)) throw new Error("memory proposal failed public contract validation");
		await this.#store.saveProposal(proposal, draft);
		await this.#events.append({
			type: "memory.proposed", principalId: this.#identity.principalId, traceId: input.traceId,
			payload: {
				memoryId, proposalId: proposal.proposalId, scope: input.scope.scope, contentDigest: draft.contentDigest,
				diffArtifactId: diff.diffArtifact.artifactId, diffDigest: diff.diffDigest, approvalId: proposal.approvalId,
			},
		});
		return { proposal, draft };
	}

	public async approve(proposal: MemoryProposal, receipt: ApprovalReceiptRef, traceId: TraceId): Promise<MemoryRecord> {
		const published = await this.#store.publish(proposal.memory.scope, proposal.proposalId, receipt, this.#clock().toISOString());
		await this.#events.append({ type: "memory.approved", principalId: this.#identity.principalId, traceId, payload: { memoryId: published.memoryId, proposalId: proposal.proposalId, approvalId: proposal.approvalId, receiptId: receipt.receiptId } });
		await this.#events.append({ type: "memory.published", principalId: this.#identity.principalId, traceId, payload: { memoryId: published.memoryId, recordDigest: canonicalDigest(published), publicationReceiptId: receipt.receiptId } });
		return published;
	}

	public async reject(proposal: MemoryProposal, receipt: ApprovalReceiptRef, traceId: TraceId): Promise<void> {
		await this.#store.reject(proposal.memory.scope, proposal.proposalId, receipt);
		await this.#events.append({ type: "memory.rejected", principalId: this.#identity.principalId, traceId, payload: { memoryId: proposal.memory.memoryId, proposalId: proposal.proposalId, approvalId: proposal.approvalId, reasonDigest: canonicalDigest({ decision: receipt.decision }) } });
	}

	public async proposeRevocation(record: MemoryRecord, traceId: TraceId): Promise<{ proposal: MemoryProposal; draft: MemoryRecord }> {
		if (record.status !== "approved") throw new Error("only approved memory can be proposed for revocation");
		const now = this.#clock().toISOString();
		const draft: MemoryRecord = {
			...record,
			status: "proposed",
			updatedAt: now,
			supersedes: memoryRef(record),
		};
		delete draft.approvalReceipt;
		if (!isMemoryRecord(draft)) throw new Error("memory revocation draft failed public contract validation");
		const before = memoryRef(record);
		const diffBody = { kind: "delete", before, fields: ["status"] } as const;
		const storedDiff = diffArtifact(this.#store, record.scope, diffBody);
		const diff: MemoryDiff = {
			kind: "delete",
			before,
			changes: [{ field: "status", beforeDigest: canonicalDigest(record.status), afterDigest: canonicalDigest("revoked") }],
			diffArtifact: storedDiff.artifact,
			diffDigest: storedDiff.digest,
		};
		const proposal: MemoryProposal = {
			schemaVersion: 1,
			authorityId: this.#identity.authorityId,
			tenantId: this.#identity.tenantId,
			proposalId: createRuntimeId("memoryProposal"),
			memory: before,
			diff,
			status: "pending",
			approvalId: createRuntimeId("approval"),
			proposedByPrincipalId: this.#identity.principalId,
			createdAt: now,
		};
		if (!isMemoryProposal(proposal)) throw new Error("memory revocation proposal failed public contract validation");
		await this.#store.saveProposal(proposal, draft);
		await this.#events.append({
			type: "memory.proposed", principalId: this.#identity.principalId, traceId,
			payload: {
				memoryId: record.memoryId, proposalId: proposal.proposalId, scope: record.scope.scope,
				contentDigest: record.contentDigest, diffArtifactId: diff.diffArtifact.artifactId,
				diffDigest: diff.diffDigest, approvalId: proposal.approvalId,
			},
		});
		return { proposal, draft };
	}

	public async revoke(proposal: MemoryProposal, receipt: ApprovalReceiptRef, traceId: TraceId): Promise<MemoryRecord> {
		const revoked = await this.#store.publishRevocation(proposal.memory.scope, proposal.proposalId, receipt, this.#clock().toISOString());
		await this.#events.append({ type: "memory.approved", principalId: this.#identity.principalId, traceId, payload: { memoryId: revoked.memoryId, proposalId: proposal.proposalId, approvalId: proposal.approvalId, receiptId: receipt.receiptId } });
		await this.#events.append({ type: "memory.revoked", principalId: this.#identity.principalId, traceId, payload: { memoryId: revoked.memoryId, revocationRevision: revoked.revocationRevision, receiptId: receipt.receiptId } });
		return revoked;
	}

	public async expire(record: MemoryRecord, traceId: TraceId): Promise<MemoryRecord> {
		const now = this.#clock().toISOString();
		const expired = await this.#store.expire(record, now);
		await this.#events.append({ type: "memory.expired", principalId: this.#identity.principalId, traceId, payload: { memoryId: expired.memoryId, expiredAt: now, recordDigest: canonicalDigest(expired) } });
		return expired;
	}

	public async search(input: {
		query: string;
		scopes: readonly MemoryScopeRef[];
		traceId: TraceId;
		maxResults?: number;
		maxSnippetChars?: number;
		maxTotalTokens?: number;
		cursor?: string;
	}): Promise<{ receipt: MemorySearchReceipt; records: readonly MemoryRecord[] }> {
		const request = createMemorySearchRequest({
			authorityId: this.#identity.authorityId, tenantId: this.#identity.tenantId, principalId: this.#identity.principalId,
			query: input.query, scopes: input.scopes, maxResults: input.maxResults, maxSnippetChars: input.maxSnippetChars,
			maxTotalTokens: input.maxTotalTokens, cursor: input.cursor,
		});
		const now = this.#clock().toISOString();
		let records: readonly MemoryRecord[];
		let receipt: MemorySearchReceipt;
		try {
			records = await this.#store.listRecords(input.scopes);
			receipt = await this.#index.search(request, records, new Date(now));
		} catch {
			return { receipt: unavailableSearchReceipt(this.#identity, request, now, "memory_unavailable"), records: [] };
		}
		try {
			await this.#events.append({ type: "memory.searched", principalId: this.#identity.principalId, traceId: input.traceId, payload: { requestId: receipt.requestId, receiptId: receipt.receiptId, queryDigest: receipt.queryDigest, mode: receipt.mode, resultCount: receipt.results.length, receiptDigest: canonicalDigest(receipt) } });
		} catch {
			return { receipt: unavailableSearchReceipt(this.#identity, request, now, "memory_event_sink_unavailable"), records: [] };
		}
		return { receipt, records };
	}

	public async injection(input: {
		search: MemorySearchReceipt;
		records: readonly MemoryRecord[];
		contextRequestId: ContextRequestId;
		declassificationReceipts: readonly DeclassificationReceiptRef[];
		traceId: TraceId;
		maxChars: number;
		maxTokens: number;
	}): Promise<{ fragment?: ContextFragment; receipt: ReturnType<typeof createMemoryInjectionReceipt> }> {
		const fragment = createMemoryContextFragment({ receipt: input.search, records: input.records, declassificationReceipts: input.declassificationReceipts, maxChars: input.maxChars, maxTokens: input.maxTokens });
		const receipt = createMemoryInjectionReceipt({ receipt: input.search, records: input.records, contextRequestId: input.contextRequestId, principalId: this.#identity.principalId, injectedAt: this.#clock().toISOString() });
		try {
			for (const memory of receipt.memories) {
				await this.#events.append({ type: "memory.injected", principalId: this.#identity.principalId, traceId: input.traceId, payload: { memoryId: memory.memoryId, contextRequestId: receipt.contextRequestId, receiptId: receipt.receiptId, recordDigest: memory.contentDigest, receiptDigest: canonicalDigest(receipt) } });
			}
		} catch {
			const emptySearch = { ...input.search, results: [] };
			return {
				receipt: createMemoryInjectionReceipt({ receipt: emptySearch, records: [], contextRequestId: input.contextRequestId, principalId: this.#identity.principalId, injectedAt: this.#clock().toISOString() }),
			};
		}
		return { ...(fragment === undefined ? {} : { fragment }), receipt };
	}
}
