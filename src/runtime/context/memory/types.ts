/** Memory scope/proposal/diff/search 的版本化公共合同；store/index/approval 行为不在本模块。 */

import type { ApprovalReceiptRef, ArtifactRef } from "../../protocol/v3/capability.ts";
import type { ContextTrust, ContextTaint } from "../types.ts";
import type {
	AgentId,
	ApprovalId,
	AuthorityId,
	CommandId,
	CompactionId,
	ContextRequestId,
	MemoryId,
	MemoryProposalId,
	PrincipalId,
	ReceiptId,
	SessionId,
	TenantId,
	ToolCallId,
	WorkspaceId,
} from "../../protocol/v3/ids.ts";

export const MEMORY_CONTRACT_VERSION = 1 as const;

export const MEMORY_SCOPES = ["user", "workspace", "session"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export const MEMORY_STATUSES = ["proposed", "approved", "changed_unreviewed", "revoked", "expired"] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export type MemoryScopeRef =
	| { scope: "user"; ownerPrincipalId: PrincipalId }
	| { scope: "workspace"; workspaceId: WorkspaceId }
	| { scope: "session"; sessionId: SessionId };

interface MemorySourceBase {
	authorityId: AuthorityId;
	tenantId: TenantId;
	sourceDigest: string;
	trust: ContextTrust;
	taint: readonly ContextTaint[];
	observedAt: string;
}

export type MemorySourceRef =
	| (MemorySourceBase & { sourceType: "user"; principalId: PrincipalId })
	| (MemorySourceBase & { sourceType: "session"; sessionId: SessionId; fromSequence: number; toSequence: number })
	| (MemorySourceBase & { sourceType: "agent"; agentId: AgentId; sessionId: SessionId })
	| (MemorySourceBase & { sourceType: "tool"; toolCallId: ToolCallId; artifact: ArtifactRef })
	| (MemorySourceBase & { sourceType: "web" | "mcp" | "import"; artifact: ArtifactRef })
	| (MemorySourceBase & { sourceType: "compaction"; compactionId: CompactionId; artifact: ArtifactRef });

export interface MemoryRef {
	schemaVersion: typeof MEMORY_CONTRACT_VERSION;
	authorityId: AuthorityId;
	tenantId: TenantId;
	memoryId: MemoryId;
	scope: MemoryScopeRef;
	revision: number;
	contentDigest: string;
	status: MemoryStatus;
}

export interface MemoryRecord {
	schemaVersion: typeof MEMORY_CONTRACT_VERSION;
	authorityId: AuthorityId;
	tenantId: TenantId;
	memoryId: MemoryId;
	scope: MemoryScopeRef;
	revision: number;
	status: MemoryStatus;
	title: string;
	content: string;
	contentDigest: string;
	sourceRefs: readonly MemorySourceRef[];
	approvalReceipt?: ApprovalReceiptRef;
	createdByPrincipalId: PrincipalId;
	createdAt: string;
	updatedAt: string;
	expiresAt?: string;
	revokedAt?: string;
	revokedByPrincipalId?: PrincipalId;
	revocationRevision: number;
	supersedes?: MemoryRef;
}

export interface MemoryFieldDiff {
	field: "title" | "content" | "scope" | "sources" | "expiresAt" | "status";
	beforeDigest?: string;
	afterDigest?: string;
}

export interface MemoryDiff {
	kind: "create" | "update" | "delete" | "scope_change";
	before?: MemoryRef;
	after?: MemoryRef;
	changes: readonly MemoryFieldDiff[];
	diffArtifact: ArtifactRef;
	diffDigest: string;
}

export type MemoryProposalStatus = "pending" | "approved" | "rejected" | "expired" | "revoked";

export interface MemoryProposal {
	schemaVersion: typeof MEMORY_CONTRACT_VERSION;
	authorityId: AuthorityId;
	tenantId: TenantId;
	proposalId: MemoryProposalId;
	memory: MemoryRef;
	diff: MemoryDiff;
	status: MemoryProposalStatus;
	approvalId: ApprovalId;
	approvalReceipt?: ApprovalReceiptRef;
	proposedByPrincipalId: PrincipalId;
	createdAt: string;
	expiresAt?: string;
}

export interface MemorySearchRequest {
	schemaVersion: typeof MEMORY_CONTRACT_VERSION;
	authorityId: AuthorityId;
	tenantId: TenantId;
	principalId: PrincipalId;
	requestId: CommandId;
	query: string;
	queryDigest: string;
	scopes: readonly MemoryScopeRef[];
	maxResults: number;
	maxSnippetChars: number;
	maxTotalTokens: number;
	cursor?: string;
	includeStale: boolean;
}

export interface MemorySearchResult {
	memory: MemoryRef;
	score: number;
	stale: boolean;
	snippet: string;
	lineStart: number;
	lineEnd: number;
	sourceDigest: string;
}

export interface MemorySearchReceipt {
	schemaVersion: typeof MEMORY_CONTRACT_VERSION;
	authorityId: AuthorityId;
	tenantId: TenantId;
	principalId: PrincipalId;
	requestId: CommandId;
	receiptId: ReceiptId;
	queryDigest: string;
	mode: "lexical" | "vector" | "hybrid" | "none";
	indexDigest: string;
	results: readonly MemorySearchResult[];
	nextCursor?: string;
	diagnostics: readonly string[];
	searchedAt: string;
}

export interface MemoryInjectionReceipt {
	schemaVersion: typeof MEMORY_CONTRACT_VERSION;
	authorityId: AuthorityId;
	tenantId: TenantId;
	principalId: PrincipalId;
	receiptId: ReceiptId;
	contextRequestId: ContextRequestId;
	memories: readonly MemoryRef[];
	injectionDigest: string;
	injectedAt: string;
}
