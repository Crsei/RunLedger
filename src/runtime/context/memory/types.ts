/**
 * Memory record/proposal/search 的公共合同。
 *
 * TODO(runtime-phase-6): 冻结 provenance、approval、TTL/staleness、citation 和
 * scope 隔离字段；MemoryStore/Search/flush 行为归专项实现，默认不自动发布。
 */

export type MemoryScope = "user" | "workspace" | "session";
export type MemoryTrust = "untrusted" | "proposed" | "approved" | "revoked" | "changed_unreviewed";

export interface MemoryProvenance {
	sourceKind: "user" | "agent" | "tool" | "import" | "compaction";
	sourceRef: string;
	sourceDigest: string;
	createdAt: string;
}

export interface MemoryRecord {
	memoryId: string;
	scope: MemoryScope;
	workspaceId?: string;
	title: string;
	body: string;
	digest: string;
	trust: MemoryTrust;
	provenance: MemoryProvenance;
	approvedAt?: string;
	expiresAt?: string;
	revocationRevision: number;
}

export interface MemoryProposal {
	proposalId: string;
	scope: MemoryScope;
	record: MemoryRecord;
	status: "pending" | "approved" | "rejected" | "expired";
	createdAt: string;
}

export interface MemorySearchReceipt {
	queryDigest: string;
	scope: MemoryScope;
	mode: "lexical" | "vector" | "none";
	resultIds: readonly string[];
	indexDigest: string;
	createdAt: string;
}
