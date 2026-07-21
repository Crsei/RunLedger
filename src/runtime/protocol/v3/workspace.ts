/**
 * Workspace/lease 的 Runtime 中立数据合同。
 *
 * TODO(runtime-phase-2): 由 Runtime contract PR 冻结 schema、receipt digest 和
 * event payload。Worktree/Sandbox/Permission 只实现这些接口的产生与验证，
 * 不应在自己的目录复制第二份公共类型。
 */

import type {
	AgentId,
	AuthorityId,
	PrincipalId,
	RepositoryId,
	SessionId,
	TenantId,
	TraceId,
	WorkspaceId,
} from "./ids.ts";

export interface WorkspaceExecutionEnvelope {
	authorityId: AuthorityId;
	tenantId: TenantId;
	principalId: PrincipalId;
	sessionId: SessionId;
	workspaceId: WorkspaceId;
	repositoryId: RepositoryId;
	worktreePath: string;
	branch: string;
	baseCommit: string;
	agentId: AgentId;
	toolCallId: string;
	traceId: TraceId;
	cwd: string;
	ownerRuntimeId: string;
	leaseRevision: number;
	fencingToken: string;
}

export interface WorkspaceBindingRef {
	workspaceId: WorkspaceId;
	repositoryId: RepositoryId;
	bindingKind: "source" | "managed_worktree" | "readonly_checkout";
	effectiveCwd: string;
	baseCommit: string;
	worktreeId?: string;
}

export interface WorkspaceLeaseRef {
	workspaceId: WorkspaceId;
	ownerRuntimeId: string;
	leaseRevision: number;
	fencingTokenDigest: string;
	state: "requested" | "active" | "released" | "stale" | "revoked";
}

export interface WorkspaceValidationReceiptRef {
	receiptId: string;
	workspaceId: WorkspaceId;
	envelopeDigest: string;
	validatorId: string;
	validatedAt: string;
	outcome: "valid" | "invalid" | "unavailable";
}

export interface WorkspaceCheckpointDescriptor {
	workspaceId: WorkspaceId;
	eventCursor: string;
	baseCommit: string;
	headCommit: string;
	statusDigest: string;
	snapshotArtifactRef?: string;
	completeness: "metadata_only" | "complete" | "partial";
}

export function isWorkspaceExecutionEnvelope(value: unknown): value is WorkspaceExecutionEnvelope {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.authorityId === "string" &&
		typeof candidate.tenantId === "string" &&
		typeof candidate.principalId === "string" &&
		typeof candidate.sessionId === "string" &&
		typeof candidate.workspaceId === "string" &&
		typeof candidate.repositoryId === "string" &&
		typeof candidate.worktreePath === "string" &&
		typeof candidate.cwd === "string" &&
		typeof candidate.leaseRevision === "number" &&
		Number.isInteger(candidate.leaseRevision) &&
		candidate.leaseRevision >= 0
	);
}
