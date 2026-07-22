/** Worktree 的低层 IO/CAS/liveness 端口；实现目录不得直接 fs/spawn。 */

import type { ApprovalReceiptRef, ArtifactRef } from "../runtime/protocol/v3/capability.ts";
import type {
	ArtifactReadRequest,
	ArtifactReadResult,
	ArtifactResult,
	ArtifactWriteOutcome,
	ArtifactWriteRequest,
	CompositeCheckpointRef,
	WorkspaceCleanupReceipt,
	WorkspaceRewindReceipt,
} from "../runtime/artifacts/types.ts";
import type { ArtifactReconciliationReport } from "../runtime/artifacts/cas-store.ts";
import type {
	ApprovalId,
	ArtifactId,
	CheckpointId,
	CommandId,
	RuntimeInstanceId,
	WorkspaceId,
} from "../runtime/protocol/v3/ids.ts";
import type { EventCursor } from "../runtime/protocol/v3/events.ts";
import type { WorktreeRecord, WorktreeRegistryEntry, WorktreeRemoveRequest, WorktreeResult } from "./types.ts";

export interface WorktreePathStats {
	exists: boolean;
	isDirectory: boolean;
	isSymbolicLink: boolean;
}

export interface WorktreeFileSystemPort {
	realpath(path: string): Promise<string>;
	stat(path: string): Promise<WorktreePathStats>;
	mkdir(path: string): Promise<void>;
	rm(path: string): Promise<void>;
}

export interface GitCommandRequest {
	cwd: string;
	arguments: readonly string[];
	stdin?: string;
	environment?: Readonly<Record<string, string>>;
	timeoutMs: number;
}

export interface GitCommandResult {
	stdout: string;
	/** 二进制 Git object 只能从此字段读取，不能从 UTF-8 stdout 反推。 */
	stdoutBytes?: Uint8Array;
	stderr: string;
	exitCode: number;
	signaled: boolean;
}

export interface GitCommandPort {
	run(request: GitCommandRequest, signal?: AbortSignal): Promise<GitCommandResult>;
}

/** append 必须在一个原子 CAS/lock 临界区比较 expectedRevision。 */
export interface WorktreeRegistryMutationPort {
	read(): Promise<readonly WorktreeRegistryEntry[]>;
	append(entry: WorktreeRegistryEntry, expectedRevision: number): Promise<"applied" | "conflict">;
}

export interface WorkspaceLeaseSecret {
	record: NonNullable<WorktreeRecord["lease"]>;
	fencingToken: string;
	issuedAt: string;
	lastRenewedAt: string;
}

export interface WorkspaceLeaseMutationPort {
	read(workspaceId: WorkspaceId): Promise<WorkspaceLeaseSecret | undefined>;
	create(secret: WorkspaceLeaseSecret): Promise<"applied" | "conflict">;
	compareAndSwap(workspaceId: WorkspaceId, expectedRevision: number, next: WorkspaceLeaseSecret): Promise<"applied" | "conflict">;
	remove(workspaceId: WorkspaceId, expectedRevision: number): Promise<"applied" | "conflict" | "not_found">;
}

export interface WorktreeTokenPort {
	issue(): Promise<string>;
}

export interface WorktreeLivenessPort {
	activeOwners(workspaceId: WorkspaceId, worktreePath: string): Promise<readonly RuntimeInstanceId[]>;
}

export interface WorktreeForceApprovalPort {
	verify(
		request: WorktreeRemoveRequest,
		record: WorktreeRecord,
		receipt: ApprovalReceiptRef,
	): Promise<WorktreeResult<void>>;
}

export interface WorktreeSnapshotCaptureRequest {
	record: WorktreeRecord;
	checkpointId: CheckpointId;
	eventCursor: EventCursor;
	status: {
		status: string;
		dirty: boolean;
		headCommit: string;
		unpublished: boolean;
	};
	capturedAt: string;
}

export interface WorktreeSnapshotCaptureResult {
	snapshotArtifactId: ArtifactId;
	completeness: "complete" | "partial";
}

/**
 * Workspace 快照由 Artifact 专项实现；manager 只消费可审计结果，不能自行
 * 把 Git metadata 冒充成可物理恢复的 snapshot。
 */
export interface WorktreeSnapshotPort {
	capture(request: WorktreeSnapshotCaptureRequest): Promise<WorktreeResult<WorktreeSnapshotCaptureResult>>;
}

export type WorktreeContentEntry =
	| { kind: "regular"; mode: string; content: Uint8Array }
	| { kind: "symlink"; mode: "120000"; target: string };

/** 路径实现必须拒绝绝对路径、`..` 和 symlink parent，且 regular read 不跟随 leaf symlink。 */
export interface WorktreeContentPort {
	read(root: string, relativePath: string): Promise<WorktreeResult<WorktreeContentEntry>>;
	replace(root: string, relativePath: string, entry: WorktreeContentEntry): Promise<WorktreeResult<void>>;
}

export interface WorktreeForensicAuthorization {
	approvalId: ApprovalId;
	purpose: string;
}

/** 实现必须在每次 capture 时重检真实 approval；静态默认授权不是生产实现。 */
export interface WorktreeForensicAuthorizationPort {
	authorizeCapture(request: WorktreeSnapshotCaptureRequest): Promise<WorktreeResult<WorktreeForensicAuthorization>>;
}

/** ArtifactRepository / ArtifactAccessService 的最小组合面。 */
export interface WorktreeArtifactPort {
	reconcile(scope: Pick<ArtifactWriteRequest, "authorityId" | "tenantId">): Promise<ArtifactResult<ArtifactReconciliationReport>>;
	write(request: ArtifactWriteRequest): Promise<ArtifactResult<ArtifactWriteOutcome>>;
	read(request: ArtifactReadRequest): Promise<ArtifactResult<ArtifactReadResult>>;
}

/** CompositeCheckpointRef 不含 ArtifactId，必须由受信索引解析，不能猜测路径或扫描 CAS。 */
export interface WorktreeCheckpointArtifactResolverPort {
	resolve(checkpoint: CompositeCheckpointRef): Promise<ArtifactResult<ArtifactRef>>;
}

export type WorktreeCheckpointEffectReceipt = WorkspaceRewindReceipt | WorkspaceCleanupReceipt;

export interface WorktreeCheckpointEffectIntent {
	effectId: CommandId;
	operation: "rewind" | "cleanup";
	requestDigest: string;
	checkpointId: CheckpointId;
	workspaceId: WorkspaceId;
	createdAt: string;
}

export interface WorktreeCheckpointEffectRecord {
	intent: WorktreeCheckpointEffectIntent;
	receipt?: WorktreeCheckpointEffectReceipt;
	recordDigest: string;
}

/** begin / complete 都必须是单临界区 CAS；实现用于进程崩溃后的 intent-reconcile。 */
export interface WorktreeCheckpointEffectPort {
	read(effectId: CommandId): Promise<WorktreeCheckpointEffectRecord | undefined>;
	begin(record: WorktreeCheckpointEffectRecord): Promise<"applied" | "replay" | "conflict">;
	complete(
		effectId: CommandId,
		expectedRequestDigest: string,
		record: WorktreeCheckpointEffectRecord,
	): Promise<"applied" | "replay" | "conflict">;
}
