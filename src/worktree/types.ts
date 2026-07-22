/** Worktree 专项内部合同；Runtime Workspace refs 直接复用 v3 公共类型。 */

import type { ApprovalReceiptRef } from "../runtime/protocol/v3/capability.ts";
import type {
	AgentId,
	AuthorityId,
	CommandId,
	LeaseId,
	PrincipalId,
	ReceiptId,
	RepositoryId,
	RuntimeInstanceId,
	SessionId,
	TenantId,
	TraceId,
	WorkspaceId,
} from "../runtime/protocol/v3/ids.ts";
import type {
	WorktreeId,
	WorkspaceBindingKind,
	WorkspaceBindingRef,
	WorkspaceCheckpointDescriptor,
	WorkspaceExecutionEnvelope,
	WorkspaceLeaseRef,
	WorkspaceValidationReceiptRef,
} from "../runtime/protocol/v3/workspace.ts";

export type WorktreeState =
	| "creating"
	| "ready"
	| "active"
	| "retained"
	| "removing"
	| "removed"
	| "stale"
	| "failed";

export interface PersistedWorkspaceBinding {
	authorityId: AuthorityId;
	tenantId: TenantId;
	principalId: PrincipalId;
	sessionId: SessionId;
	bindingKind: WorkspaceBindingKind;
	workspaceId: WorkspaceId;
	repositoryId: RepositoryId;
	sourceRepo: string;
	sourceCwd: string;
	effectiveCwd: string;
	worktreeId?: WorktreeId;
	worktreePath: string;
	subdirOffset: string;
	baseCommit: string;
	headCommit: string;
	branch: string;
	leaseId: LeaseId;
	leaseRevision: number;
	ownerRuntimeId: RuntimeInstanceId;
	bindingDigest: string;
}

export interface WorktreeRecord {
	authorityId: AuthorityId;
	tenantId: TenantId;
	principalId: PrincipalId;
	workspaceId: WorkspaceId;
	repositoryId: RepositoryId;
	sessionId: SessionId;
	createRequestId: CommandId;
	createRequestDigest: string;
	bindingKind: WorkspaceBindingKind;
	sourceRepo: string;
	sourceCwd: string;
	worktreeId?: WorktreeId;
	worktreePath: string;
	effectiveCwd: string;
	subdirOffset: string;
	label: string;
	baseRef: string;
	baseCommit: string;
	headCommit: string;
	branch: string;
	state: WorktreeState;
	createdAt: string;
	lastAccessedAt: string;
	ownerRuntimeId: RuntimeInstanceId;
	leaseRevision: number;
	lease?: WorkspaceLeaseRef;
	lastCheckpoint?: WorkspaceCheckpointDescriptor;
	errorDigest?: string;
}

export interface WorktreeCreateRequest {
	authorityId: AuthorityId;
	tenantId: TenantId;
	principalId: PrincipalId;
	sessionId: SessionId;
	repositoryId: RepositoryId;
	sourceRepo: string;
	sourceCwd: string;
	label: string;
	bindingKind?: "managed_worktree" | "readonly_checkout";
	baseRef?: string;
	branch?: string;
	ownerRuntimeId: RuntimeInstanceId;
	requestId: CommandId;
}

export interface WorktreeCreateResult {
	record: WorktreeRecord;
	binding: PersistedWorkspaceBinding;
	runtimeBinding: WorkspaceBindingRef;
	lease: WorkspaceLeaseRef;
	fencingToken: string;
	receiptId: ReceiptId;
}

export interface SourceBindingRequest extends Omit<WorktreeCreateRequest, "label" | "bindingKind"> {
	bindingKind: "source";
}

export interface WorktreeRemoveRequest {
	authorityId: AuthorityId;
	tenantId: TenantId;
	principalId: PrincipalId;
	workspaceId: WorkspaceId;
	dryRun: boolean;
	force: boolean;
	expectedLeaseRevision: number;
	requestId: CommandId;
	checkpoint?: WorkspaceCheckpointDescriptor;
	forceApproval?: ApprovalReceiptRef;
}

export interface WorktreeRemovePreview {
	workspaceId: WorkspaceId;
	worktreePath: string;
	dirty: boolean;
	unpublished: boolean;
	active: boolean;
	registered: boolean;
	checkpointCurrent: boolean;
	removable: boolean;
	reasonCodes: readonly string[];
	previewDigest: string;
}

export interface WorktreeApplyPreview {
	workspaceId: WorkspaceId;
	sourceRepo: string;
	baseCommit: string;
	headCommit: string;
	status: string;
	diff: string;
	conflicts: readonly string[];
	previewDigest: string;
}

export interface WorktreeRegistryEntry {
	revision: number;
	operation: "upsert" | "remove";
	record: WorktreeRecord;
	entryDigest: string;
}

export interface WorktreeLeaseHandoff {
	authorityId: AuthorityId;
	tenantId: TenantId;
	principalId: PrincipalId;
	workspaceId: WorkspaceId;
	leaseId: LeaseId;
	fromRuntimeId: RuntimeInstanceId;
	toRuntimeId: RuntimeInstanceId;
	expectedRevision: number;
	nextRevision: number;
	handoffTokenDigest: string;
	receiptId: ReceiptId;
}

export interface WorktreeGcCandidate {
	workspaceId: WorkspaceId;
	worktreePath: string;
	state: WorktreeState;
	lastAccessedAt: string;
	dirty: boolean;
	unpublished: boolean;
	active: boolean;
	reason: string;
}

export interface WorktreeRuntimeContext {
	authorityId: AuthorityId;
	tenantId: TenantId;
	principalId: PrincipalId;
	sessionId: SessionId;
	agentId: AgentId;
	traceId: TraceId;
}

export interface WorktreeValidationResult {
	binding: PersistedWorkspaceBinding;
	envelope: WorkspaceExecutionEnvelope;
	validation: WorkspaceValidationReceiptRef;
}

export interface WorktreeCheckpointResult {
	checkpoint: WorkspaceCheckpointDescriptor;
	receiptId: ReceiptId;
}

export type WorktreeErrorCode =
	| "invalid_request"
	| "invalid_scope"
	| "not_repository"
	| "outside_managed_root"
	| "collision"
	| "already_exists"
	| "not_found"
	| "dirty"
	| "unpublished"
	| "active"
	| "checkpoint_required"
	| "checkpoint_failed"
	| "stale"
	| "lease_conflict"
	| "approval_required"
	| "git_failed"
	| "registry_failed"
	| "cleanup_failed"
	| "uncertain";

export interface WorktreeError {
	code: WorktreeErrorCode;
	message: string;
	retryable: boolean;
}

export type WorktreeResult<T> = { ok: true; value: T } | { ok: false; error: WorktreeError };
