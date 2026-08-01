/**
 * Workspace/lease 的 Runtime 中立数据合同。
 *
 * TODO(runtime-phase-2): 由 Runtime contract PR 冻结 schema、receipt digest 和
 * event payload。Worktree/Sandbox/Permission 只实现这些接口的产生与验证，
 * 不应在自己的目录复制第二份公共类型。
 */

import { Type } from "typebox";
import { Value } from "typebox/value";
import { AdapterIdentityRefSchema, type AdapterIdentityRef } from "./adapter.ts";
import {
	CanonicalUtcTimestampSchema,
	RuntimeContentRefSchema,
	RuntimeDigestSchema,
	RuntimeIdSchema,
	RuntimeStreamHeadSchema,
	isCanonicalUtcTimestamp,
} from "./foundation-schemas.ts";
import type { RuntimeContentRef, RuntimeDigest, RuntimeStreamHead } from "./foundation.ts";
import { isRuntimeId } from "./ids.ts";
import type {
	AgentId,
	AuthorityId,
	PrincipalId,
	RepositoryId,
	ReceiptId,
	RuntimeInstanceId,
	SessionId,
	TenantId,
	TraceId,
	ToolCallId,
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
	toolCallId: ToolCallId;
	traceId: TraceId;
	cwd: string;
	ownerRuntimeId: RuntimeInstanceId;
	leaseRevision: number;
	fencingTokenDigest: RuntimeDigest;
}

export interface WorkspaceBindingRef {
	workspaceId: WorkspaceId;
	repositoryId: RepositoryId;
	bindingKind: "source" | "managed_worktree" | "readonly_checkout";
	effectiveCwdDigest: RuntimeDigest;
	baseCommit: string;
	headCommit?: string;
	worktreeRef?: RuntimeContentRef;
}

export interface WorkspaceLeaseRef {
	workspaceId: WorkspaceId;
	ownerRuntimeId: RuntimeInstanceId;
	leaseRevision: number;
	fencingTokenDigest: RuntimeDigest;
	state: "requested" | "active" | "released" | "stale" | "revoked";
	expiresAt?: string;
}

export interface WorkspaceValidationReceiptRef {
	receiptId: ReceiptId;
	workspaceId: WorkspaceId;
	envelopeDigest: RuntimeDigest;
	validator: AdapterIdentityRef;
	validatedAt: string;
	outcome: "valid" | "invalid" | "unavailable";
	sourceHead: RuntimeStreamHead;
}

export interface WorkspaceCheckpointDescriptor {
	workspaceId: WorkspaceId;
	eventHead: RuntimeStreamHead;
	baseCommit: string;
	headCommit: string;
	statusDigest: RuntimeDigest;
	snapshotRef?: RuntimeContentRef;
	completeness: "metadata_only" | "complete" | "partial";
}

const CommitSchema = Type.String({ pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$", minLength: 40, maxLength: 64 });

export const WorkspaceBindingRefSchema = Type.Object(
	{
		workspaceId: RuntimeIdSchema,
		repositoryId: RuntimeIdSchema,
		bindingKind: Type.Union([
			Type.Literal("source"),
			Type.Literal("managed_worktree"),
			Type.Literal("readonly_checkout"),
		]),
		effectiveCwdDigest: RuntimeDigestSchema,
		baseCommit: CommitSchema,
		headCommit: Type.Optional(CommitSchema),
		worktreeRef: Type.Optional(RuntimeContentRefSchema),
	},
	{ additionalProperties: false },
);

export const WorkspaceLeaseRefSchema = Type.Object(
	{
		workspaceId: RuntimeIdSchema,
		ownerRuntimeId: RuntimeIdSchema,
		leaseRevision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		fencingTokenDigest: RuntimeDigestSchema,
		state: Type.Union([
			Type.Literal("requested"),
			Type.Literal("active"),
			Type.Literal("released"),
			Type.Literal("stale"),
			Type.Literal("revoked"),
		]),
		expiresAt: Type.Optional(CanonicalUtcTimestampSchema),
	},
	{ additionalProperties: false },
);

export const WorkspaceValidationReceiptRefSchema = Type.Object(
	{
		receiptId: RuntimeIdSchema,
		workspaceId: RuntimeIdSchema,
		envelopeDigest: RuntimeDigestSchema,
		validator: AdapterIdentityRefSchema,
		validatedAt: CanonicalUtcTimestampSchema,
		outcome: Type.Union([Type.Literal("valid"), Type.Literal("invalid"), Type.Literal("unavailable")]),
		sourceHead: RuntimeStreamHeadSchema,
	},
	{ additionalProperties: false },
);

export const WorkspaceCheckpointDescriptorSchema = Type.Object(
	{
		workspaceId: RuntimeIdSchema,
		eventHead: RuntimeStreamHeadSchema,
		baseCommit: CommitSchema,
		headCommit: CommitSchema,
		statusDigest: RuntimeDigestSchema,
		snapshotRef: Type.Optional(RuntimeContentRefSchema),
		completeness: Type.Union([Type.Literal("metadata_only"), Type.Literal("complete"), Type.Literal("partial")]),
	},
	{ additionalProperties: false },
);

export function isWorkspaceBindingRef(value: unknown): value is WorkspaceBindingRef {
	if (!Value.Check(WorkspaceBindingRefSchema, value)) return false;
	return isRuntimeId(value.workspaceId, "workspace") && isRuntimeId(value.repositoryId, "repository");
}

export function isWorkspaceLeaseRef(value: unknown): value is WorkspaceLeaseRef {
	if (!Value.Check(WorkspaceLeaseRefSchema, value)) return false;
	return (
		isRuntimeId(value.workspaceId, "workspace") &&
		isRuntimeId(value.ownerRuntimeId, "runtime") &&
		(value.expiresAt === undefined || isCanonicalUtcTimestamp(value.expiresAt))
	);
}

export function isWorkspaceValidationReceiptRef(value: unknown): value is WorkspaceValidationReceiptRef {
	if (!Value.Check(WorkspaceValidationReceiptRefSchema, value)) return false;
	return (
		isRuntimeId(value.receiptId, "receipt") &&
		isRuntimeId(value.workspaceId, "workspace") &&
		isCanonicalUtcTimestamp(value.validatedAt)
	);
}

export function isWorkspaceCheckpointDescriptor(value: unknown): value is WorkspaceCheckpointDescriptor {
	if (!Value.Check(WorkspaceCheckpointDescriptorSchema, value)) return false;
	return isRuntimeId(value.workspaceId, "workspace");
}

export const WorkspaceExecutionEnvelopeSchema = Type.Object(
	{
		authorityId: RuntimeIdSchema,
		tenantId: RuntimeIdSchema,
		principalId: RuntimeIdSchema,
		sessionId: RuntimeIdSchema,
		workspaceId: RuntimeIdSchema,
		repositoryId: RuntimeIdSchema,
		worktreePath: Type.String({ minLength: 1, maxLength: 4096 }),
		branch: Type.String({ minLength: 1, maxLength: 256 }),
		baseCommit: Type.String({ pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$", minLength: 40, maxLength: 64 }),
		agentId: RuntimeIdSchema,
		toolCallId: RuntimeIdSchema,
		traceId: RuntimeIdSchema,
		cwd: Type.String({ minLength: 1, maxLength: 4096 }),
		ownerRuntimeId: RuntimeIdSchema,
		leaseRevision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		fencingTokenDigest: RuntimeDigestSchema,
	},
	{ additionalProperties: false },
);

export function isWorkspaceExecutionEnvelope(value: unknown): value is WorkspaceExecutionEnvelope {
	if (!Value.Check(WorkspaceExecutionEnvelopeSchema, value)) return false;
	return (
		isRuntimeId(value.authorityId, "authority") &&
		isRuntimeId(value.tenantId, "tenant") &&
		isRuntimeId(value.principalId, "principal") &&
		isRuntimeId(value.sessionId, "session") &&
		isRuntimeId(value.workspaceId, "workspace") &&
		isRuntimeId(value.repositoryId, "repository") &&
		isRuntimeId(value.agentId, "agent") &&
		isRuntimeId(value.toolCallId, "toolCall") &&
		isRuntimeId(value.traceId, "trace") &&
		isRuntimeId(value.ownerRuntimeId, "runtime")
	);
}
