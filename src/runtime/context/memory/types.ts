/** Memory record/proposal/search 的被动公共合同。 */

import type { RuntimeContentRef, RuntimeDigest, RuntimeStreamHead } from "../../protocol/foundation.ts";
import type { MemoryId, ProposalId, ReceiptId, SessionId, WorkspaceId } from "../../protocol/ids.ts";

export type MemoryScope = "user" | "workspace" | "session";
export type MemoryTrust = "untrusted" | "proposed" | "approved" | "revoked" | "changed_unreviewed";

export interface MemoryProvenance {
	readonly sourceKind: "user" | "agent" | "tool" | "import" | "compaction";
	readonly sourceRef: RuntimeContentRef;
	readonly sourceDigest: RuntimeDigest;
	readonly createdAt: string;
}

export interface MemoryRecord {
	readonly memoryId: MemoryId;
	readonly scope: MemoryScope;
	readonly workspaceId?: WorkspaceId;
	readonly sessionId?: SessionId;
	readonly title: string;
	readonly contentDigest: RuntimeDigest;
	readonly contentRef: RuntimeContentRef;
	readonly revision: number;
	readonly trust: MemoryTrust;
	readonly provenance: MemoryProvenance;
	readonly approvedAt?: string;
	readonly expiresAt?: string;
	readonly revocationRevision: number;
}

export interface MemoryProposal {
	readonly proposalId: ProposalId;
	readonly memoryId: MemoryId;
	readonly scope: MemoryScope;
	readonly recordDigest: RuntimeDigest;
	readonly status: "pending" | "approved" | "rejected" | "expired";
	readonly approvalRef?: RuntimeContentRef;
	readonly createdAt: string;
}

export interface MemorySearchReceipt {
	readonly receiptId: ReceiptId;
	readonly queryDigest: RuntimeDigest;
	readonly scope: MemoryScope;
	readonly workspaceId?: WorkspaceId;
	readonly sessionId?: SessionId;
	readonly mode: "lexical" | "vector" | "none";
	readonly resultIds: readonly MemoryId[];
	readonly indexDigest: RuntimeDigest;
	readonly sourceHead: RuntimeStreamHead;
	readonly createdAt: string;
}
