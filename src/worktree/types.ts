/**
 * Worktree 专项 Phase 0 的内部类型。
 *
 * TODO(worktree-phase-3): 实现 managed root、GitOperations、registry lock/replay、
 * create/remove fencing 和 resume 校验。本文件只描述状态，不执行 Git 或删除路径。
 */

import type { RepositoryId, WorkspaceId } from "../runtime/protocol/v3/ids.ts";
import type { WorkspaceBindingRef, WorkspaceLeaseRef } from "../runtime/protocol/v3/workspace.ts";

export type WorktreeState = "preparing" | "active" | "dirty" | "released" | "stale" | "failed";

export interface PersistedWorkspaceBinding {
	workspaceId: WorkspaceId;
	repositoryId: RepositoryId;
	sourceRepo: string;
	sourceCwd: string;
	effectiveCwd: string;
	baseCommit: string;
	branch: string;
	worktreePath: string;
	leaseRevision: number;
	ownerRuntimeId: string;
}

export interface WorktreeRecord {
	workspaceId: WorkspaceId;
	repositoryId: RepositoryId;
	sessionId: string;
	sourceRepo: string;
	worktreePath: string;
	label: string;
	baseCommit: string;
	state: WorktreeState;
	createdAt: string;
	lastAccessedAt: string;
	lease?: WorkspaceLeaseRef;
}

export interface WorktreeCreateRequest {
	sessionId: string;
	sourceRepo: string;
	sourceCwd: string;
	label: string;
	baseRef?: string;
}

export interface WorktreeCreateResult {
	record: WorktreeRecord;
	binding: PersistedWorkspaceBinding;
	runtimeBinding: WorkspaceBindingRef;
}

export interface WorktreeRemoveRequest {
	workspaceId: WorkspaceId;
	dryRun: boolean;
	expectedState: Extract<WorktreeState, "active" | "dirty" | "released" | "stale">;
}
