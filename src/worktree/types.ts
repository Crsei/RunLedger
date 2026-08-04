/** Worktree 专项内部结果合同；公共 Workspace ref 由 Runtime contracts 提供。 */

import type { RuntimeDigest, RuntimeInstanceId, RepositoryId, SessionId, WorkspaceId } from "../runtime/contracts/public.ts";

export type WorktreeErrorCode =
	| "invalid_request"
	| "outside_managed_root"
	| "git_failed"
	| "registry_failed"
	| "not_found"
	| "invalid_state"
	| "dirty_worktree"
	| "approval_required"
	| "lease_conflict"
	| "lease_stale"
	| "reconcile_stale";

export interface WorktreeError {
	readonly code: WorktreeErrorCode;
	readonly message: string;
	readonly retryable: boolean;
}

export type WorktreeResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: WorktreeError };

export type WorktreeState = "creating" | "ready" | "active" | "retained" | "removing" | "removed" | "failed";

export interface WorktreeRepositoryRef {
	readonly repositoryId: RepositoryId;
	readonly rootDigest: RuntimeDigest;
	readonly displayName: string;
}

/** registry 内的 source/worktree locator 是 private state，不投影到公共 Runtime event。 */
export interface WorktreeRecord {
	readonly id: string;
	readonly sessionId: SessionId;
	readonly workspaceId: WorkspaceId;
	readonly sourceRepositoryRef: WorktreeRepositoryRef;
	readonly sourceRepositoryPath: string;
	readonly sourceSubdir: string;
	readonly worktreeLocator: string;
	readonly effectiveSubdir: string;
	readonly baseRef: string;
	readonly baseCommit: string;
	readonly branch?: string;
	readonly label: string;
	readonly state: WorktreeState;
	readonly createdAt: number;
	readonly lastAccessedAt: number;
	readonly error?: string;
}

export interface WorktreeLeaseRecord {
	readonly workspaceId: WorkspaceId;
	readonly ownerRuntimeId: RuntimeInstanceId;
	readonly leaseRevision: number;
	readonly fencingTokenDigest: RuntimeDigest;
	readonly state: "requested" | "active" | "released" | "stale" | "revoked";
	readonly expiresAt?: string;
}
