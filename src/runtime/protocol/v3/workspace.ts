/**
 * Workspace/lease 的 Runtime 中立数据合同。
 *
 * 本模块只描述可序列化的 identity、receipt 与 adapter request/result；它不解析
 * 路径、不访问 Git/文件系统，也不实现 lease store、path guard 或 workspace manager。
 */

import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { canonicalDigest } from "./canonical-json.ts";
import { RuntimeContractError } from "./errors.ts";
import { EventCursorSchema } from "./event-references.ts";
import type { EventCursor } from "./events.ts";
import type {
	AgentId,
	ArtifactId,
	AuthorityId,
	CheckpointId,
	CommandId,
	LeaseId,
	PrincipalId,
	ReceiptId,
	RepositoryId,
	RuntimeInstanceId,
	SessionId,
	TenantId,
	ToolCallId,
	TraceId,
	WorkspaceId,
} from "./ids.ts";

const digestPattern = "^[a-f0-9]{64}$";
const timestampPattern = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$";
const worktreeIdPattern = "^worktree_[A-Za-z0-9][A-Za-z0-9._~-]*$";
const runtimeId = (kind: string) =>
	Type.String({ pattern: `^${kind}_[A-Za-z0-9][A-Za-z0-9._~-]*$`, maxLength: 128 });
const digest = Type.String({ pattern: digestPattern, maxLength: 64 });
const timestamp = Type.String({ pattern: timestampPattern, maxLength: 24 });
const pathText = Type.String({ minLength: 1, maxLength: 4096 });
const refText = Type.String({ minLength: 1, maxLength: 512 });
const opaqueToken = Type.String({ minLength: 1, maxLength: 512 });
const revision = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const exact = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

export const WORKSPACE_BINDING_KINDS = ["source", "managed_worktree", "readonly_checkout"] as const;
export type WorkspaceBindingKind = (typeof WORKSPACE_BINDING_KINDS)[number];

export const WORKSPACE_LEASE_STATES = ["requested", "active", "released", "stale", "revoked"] as const;
export type WorkspaceLeaseState = (typeof WORKSPACE_LEASE_STATES)[number];

export const WORKSPACE_VALIDATION_OUTCOMES = ["valid", "invalid", "unavailable"] as const;
export type WorkspaceValidationOutcome = (typeof WORKSPACE_VALIDATION_OUTCOMES)[number];

export const WORKSPACE_CHECKPOINT_COMPLETENESS = ["metadata_only", "complete", "partial"] as const;
export type WorkspaceCheckpointCompleteness = (typeof WORKSPACE_CHECKPOINT_COMPLETENESS)[number];

/** Worktree ID 在 Workspace adapter 域内稳定，且不把 manager 实现引入 Runtime。 */
export type WorktreeId = string & { readonly __workspaceWorktreeId: true };

export const WorktreeIdSchema = Type.String({ pattern: worktreeIdPattern, maxLength: 128 });

export function createWorktreeId(seed: string): WorktreeId {
	const value = `worktree_${seed}`;
	if (!Check(WorktreeIdSchema, value)) {
		throw new RuntimeContractError({ code: "invalid_id", message: "invalid worktree id seed", retryable: false });
	}
	return value as WorktreeId;
}

export function parseWorktreeId(value: string): WorktreeId | undefined {
	return Check(WorktreeIdSchema, value) ? (value as WorktreeId) : undefined;
}

export interface WorkspaceExecutionEnvelope {
	authorityId: AuthorityId;
	tenantId: TenantId;
	principalId: PrincipalId;
	sessionId: SessionId;
	workspaceId: WorkspaceId;
	repositoryId: RepositoryId;
	/** Adapter 已解析的 canonical workspace/worktree root。 */
	worktreePath: string;
	branch: string;
	baseCommit: string;
	agentId: AgentId;
	toolCallId: ToolCallId;
	traceId: TraceId;
	/** 本次调用的 effective cwd；其路径边界由 Workspace adapter 验证。 */
	cwd: string;
	ownerRuntimeId: RuntimeInstanceId;
	leaseRevision: number;
	/** 只在调用边界传递；持久事件只保存其 digest。 */
	fencingToken: string;
}

export interface WorkspaceBindingRef {
	authorityId: AuthorityId;
	tenantId: TenantId;
	workspaceId: WorkspaceId;
	repositoryId: RepositoryId;
	bindingKind: WorkspaceBindingKind;
	canonicalCwd: string;
	effectiveCwd: string;
	branch: string;
	baseCommit: string;
	headCommit: string;
	worktreeId?: WorktreeId;
}

export interface WorkspaceLeaseRef {
	authorityId: AuthorityId;
	tenantId: TenantId;
	principalId: PrincipalId;
	leaseId: LeaseId;
	workspaceId: WorkspaceId;
	ownerRuntimeId: RuntimeInstanceId;
	leaseRevision: number;
	fencingTokenDigest: string;
	state: WorkspaceLeaseState;
}

export interface WorkspaceValidationReceiptRef {
	authorityId: AuthorityId;
	tenantId: TenantId;
	principalId: PrincipalId;
	receiptId: ReceiptId;
	workspaceId: WorkspaceId;
	envelopeDigest: string;
	validatorId: PrincipalId;
	validatedAt: string;
	outcome: WorkspaceValidationOutcome;
}

export interface WorkspaceCheckpointDescriptor {
	authorityId: AuthorityId;
	tenantId: TenantId;
	checkpointId: CheckpointId;
	workspaceId: WorkspaceId;
	eventCursor: EventCursor;
	baseCommit: string;
	headCommit: string;
	statusDigest: string;
	snapshotArtifactId?: ArtifactId;
	completeness: WorkspaceCheckpointCompleteness;
}

export const WorkspaceExecutionEnvelopeSchema = exact({
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	principalId: runtimeId("principal"),
	sessionId: runtimeId("session"),
	workspaceId: runtimeId("workspace"),
	repositoryId: runtimeId("repository"),
	worktreePath: pathText,
	branch: refText,
	baseCommit: refText,
	agentId: runtimeId("agent"),
	toolCallId: runtimeId("toolCall"),
	traceId: runtimeId("trace"),
	cwd: pathText,
	ownerRuntimeId: runtimeId("runtime"),
	leaseRevision: revision,
	fencingToken: opaqueToken,
});

const workspaceBindingBase = {
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	workspaceId: runtimeId("workspace"),
	repositoryId: runtimeId("repository"),
	canonicalCwd: pathText,
	effectiveCwd: pathText,
	branch: refText,
	baseCommit: refText,
	headCommit: refText,
};

export const WorkspaceBindingRefSchema = Type.Union([
	exact({ ...workspaceBindingBase, bindingKind: Type.Literal("source") }),
	exact({ ...workspaceBindingBase, bindingKind: Type.Literal("managed_worktree"), worktreeId: WorktreeIdSchema }),
	exact({ ...workspaceBindingBase, bindingKind: Type.Literal("readonly_checkout"), worktreeId: WorktreeIdSchema }),
]);

export const WorkspaceLeaseRefSchema = exact({
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	principalId: runtimeId("principal"),
	leaseId: runtimeId("lease"),
	workspaceId: runtimeId("workspace"),
	ownerRuntimeId: runtimeId("runtime"),
	leaseRevision: revision,
	fencingTokenDigest: digest,
	// 显式 tuple 保留 TypeBox Static 的 literal union；动态 map 会把这里推成 never。
	state: Type.Union([
		Type.Literal("requested"),
		Type.Literal("active"),
		Type.Literal("released"),
		Type.Literal("stale"),
		Type.Literal("revoked"),
	]),
});

export const WorkspaceValidationReceiptRefSchema = exact({
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	principalId: runtimeId("principal"),
	receiptId: runtimeId("receipt"),
	workspaceId: runtimeId("workspace"),
	envelopeDigest: digest,
	validatorId: runtimeId("principal"),
	validatedAt: timestamp,
	outcome: Type.Union(WORKSPACE_VALIDATION_OUTCOMES.map((outcome) => Type.Literal(outcome))),
});

const eventCursor = EventCursorSchema;
const workspaceCheckpointBase = {
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	checkpointId: runtimeId("checkpoint"),
	workspaceId: runtimeId("workspace"),
	eventCursor,
	baseCommit: refText,
	headCommit: refText,
	statusDigest: digest,
};

export const WorkspaceCheckpointDescriptorSchema = Type.Union([
	exact({ ...workspaceCheckpointBase, completeness: Type.Literal("metadata_only") }),
	exact({
		...workspaceCheckpointBase,
		snapshotArtifactId: runtimeId("artifact"),
		completeness: Type.Literal("complete"),
	}),
	exact({
		...workspaceCheckpointBase,
		snapshotArtifactId: Type.Optional(runtimeId("artifact")),
		completeness: Type.Literal("partial"),
	}),
]);

export function isWorkspaceExecutionEnvelope(value: unknown): value is WorkspaceExecutionEnvelope {
	return Check(WorkspaceExecutionEnvelopeSchema, value);
}

export function isWorkspaceBindingRef(value: unknown): value is WorkspaceBindingRef {
	return Check(WorkspaceBindingRefSchema, value);
}

export function isWorkspaceLeaseRef(value: unknown): value is WorkspaceLeaseRef {
	return Check(WorkspaceLeaseRefSchema, value);
}

export function isWorkspaceValidationReceiptRef(value: unknown): value is WorkspaceValidationReceiptRef {
	return Check(WorkspaceValidationReceiptRefSchema, value);
}

export function isWorkspaceCheckpointDescriptor(value: unknown): value is WorkspaceCheckpointDescriptor {
	return Check(WorkspaceCheckpointDescriptorSchema, value);
}

export function workspaceExecutionEnvelopeDigest(envelope: WorkspaceExecutionEnvelope): string {
	if (!isWorkspaceExecutionEnvelope(envelope)) {
		throw new RuntimeContractError({ code: "invalid_schema", message: "invalid workspace envelope", retryable: false });
	}
	return canonicalDigest(envelope);
}

export function workspaceBindingDigest(binding: WorkspaceBindingRef): string {
	if (!isWorkspaceBindingRef(binding)) {
		throw new RuntimeContractError({ code: "invalid_schema", message: "invalid workspace binding", retryable: false });
	}
	return canonicalDigest(binding);
}

/** Digest correlation only；TOCTOU 防护必须由注入的 Workspace adapter 实现。 */
export function isWorkspaceValidationReceiptForEnvelope(
	receipt: WorkspaceValidationReceiptRef,
	envelope: WorkspaceExecutionEnvelope,
): boolean {
	return (
		isWorkspaceValidationReceiptRef(receipt) &&
		isWorkspaceExecutionEnvelope(envelope) &&
		receipt.authorityId === envelope.authorityId &&
		receipt.tenantId === envelope.tenantId &&
		receipt.principalId === envelope.principalId &&
		receipt.workspaceId === envelope.workspaceId &&
		receipt.envelopeDigest === workspaceExecutionEnvelopeDigest(envelope)
	);
}

export const WORKSPACE_SERVICE_SCHEMA_VERSION = 1 as const;

interface WorkspaceServiceRequestContext {
	schemaVersion: typeof WORKSPACE_SERVICE_SCHEMA_VERSION;
	requestId: CommandId;
	authorityId: AuthorityId;
	tenantId: TenantId;
	principalId: PrincipalId;
	sessionId: SessionId;
	agentId: AgentId;
	traceId: TraceId;
}

export interface WorkspaceBindRequest extends WorkspaceServiceRequestContext {
	kind: "bind";
	repositoryId: RepositoryId;
	bindingKind: WorkspaceBindingKind;
	requestedCwd: string;
	branch: string;
	baseCommit: string;
	ownerRuntimeId: RuntimeInstanceId;
}

export interface WorkspaceValidateRequest extends WorkspaceServiceRequestContext {
	kind: "validate";
	envelope: WorkspaceExecutionEnvelope;
	envelopeDigest: string;
}

export interface WorkspaceCheckpointRequest extends WorkspaceServiceRequestContext {
	kind: "checkpoint";
	envelope: WorkspaceExecutionEnvelope;
	envelopeDigest: string;
	eventCursor: EventCursor;
}

export interface WorkspaceReleaseRequest extends WorkspaceServiceRequestContext {
	kind: "release";
	envelope: WorkspaceExecutionEnvelope;
	envelopeDigest: string;
	expectedLeaseRevision: number;
	checkpoint?: WorkspaceCheckpointDescriptor;
}

export type WorkspaceServiceRequest =
	| WorkspaceBindRequest
	| WorkspaceValidateRequest
	| WorkspaceCheckpointRequest
	| WorkspaceReleaseRequest;

interface WorkspaceServiceResultContext {
	schemaVersion: typeof WORKSPACE_SERVICE_SCHEMA_VERSION;
	requestId: CommandId;
}

export interface WorkspaceBoundResult extends WorkspaceServiceResultContext {
	kind: "bound";
	receiptId: ReceiptId;
	binding: WorkspaceBindingRef;
	lease: WorkspaceLeaseRef;
}

export interface WorkspaceValidatedResult extends WorkspaceServiceResultContext {
	kind: "validated";
	validation: WorkspaceValidationReceiptRef;
}

export interface WorkspaceCheckpointedResult extends WorkspaceServiceResultContext {
	kind: "checkpointed";
	receiptId: ReceiptId;
	checkpoint: WorkspaceCheckpointDescriptor;
}

export interface WorkspaceReleasedResult extends WorkspaceServiceResultContext {
	kind: "released";
	receiptId: ReceiptId;
	workspaceId: WorkspaceId;
	leaseId: LeaseId;
	leaseRevision: number;
}

export interface WorkspaceRejectedResult extends WorkspaceServiceResultContext {
	kind: "rejected";
	code: string;
	messageDigest: string;
	retryable: boolean;
}

export type WorkspaceServiceResult =
	| WorkspaceBoundResult
	| WorkspaceValidatedResult
	| WorkspaceCheckpointedResult
	| WorkspaceReleasedResult
	| WorkspaceRejectedResult;

const serviceRequestContext = {
	schemaVersion: Type.Literal(WORKSPACE_SERVICE_SCHEMA_VERSION),
	requestId: runtimeId("command"),
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	principalId: runtimeId("principal"),
	sessionId: runtimeId("session"),
	agentId: runtimeId("agent"),
	traceId: runtimeId("trace"),
};

export const WorkspaceServiceRequestSchema = Type.Union([
	exact({
		...serviceRequestContext,
		kind: Type.Literal("bind"),
		repositoryId: runtimeId("repository"),
		bindingKind: Type.Union(WORKSPACE_BINDING_KINDS.map((kind) => Type.Literal(kind))),
		requestedCwd: pathText,
		branch: refText,
		baseCommit: refText,
		ownerRuntimeId: runtimeId("runtime"),
	}),
	exact({
		...serviceRequestContext,
		kind: Type.Literal("validate"),
		envelope: WorkspaceExecutionEnvelopeSchema,
		envelopeDigest: digest,
	}),
	exact({
		...serviceRequestContext,
		kind: Type.Literal("checkpoint"),
		envelope: WorkspaceExecutionEnvelopeSchema,
		envelopeDigest: digest,
		eventCursor,
	}),
	exact({
		...serviceRequestContext,
		kind: Type.Literal("release"),
		envelope: WorkspaceExecutionEnvelopeSchema,
		envelopeDigest: digest,
		expectedLeaseRevision: revision,
		checkpoint: Type.Optional(WorkspaceCheckpointDescriptorSchema),
	}),
]);

const serviceResultContext = {
	schemaVersion: Type.Literal(WORKSPACE_SERVICE_SCHEMA_VERSION),
	requestId: runtimeId("command"),
};

export const WorkspaceServiceResultSchema = Type.Union([
	exact({
		...serviceResultContext,
		kind: Type.Literal("bound"),
		receiptId: runtimeId("receipt"),
		binding: WorkspaceBindingRefSchema,
		lease: WorkspaceLeaseRefSchema,
	}),
	exact({
		...serviceResultContext,
		kind: Type.Literal("validated"),
		validation: WorkspaceValidationReceiptRefSchema,
	}),
	exact({
		...serviceResultContext,
		kind: Type.Literal("checkpointed"),
		receiptId: runtimeId("receipt"),
		checkpoint: WorkspaceCheckpointDescriptorSchema,
	}),
	exact({
		...serviceResultContext,
		kind: Type.Literal("released"),
		receiptId: runtimeId("receipt"),
		workspaceId: runtimeId("workspace"),
		leaseId: runtimeId("lease"),
		leaseRevision: revision,
	}),
	exact({
		...serviceResultContext,
		kind: Type.Literal("rejected"),
		code: Type.String({ minLength: 1, maxLength: 128 }),
		messageDigest: digest,
		retryable: Type.Boolean(),
	}),
]);

export function isWorkspaceServiceRequest(value: unknown): value is WorkspaceServiceRequest {
	return Check(WorkspaceServiceRequestSchema, value);
}

export function isWorkspaceServiceResult(value: unknown): value is WorkspaceServiceResult {
	return Check(WorkspaceServiceResultSchema, value);
}

/** Adapter 只能交换封闭 request/result，不暴露 manager、store、path handle 或 broker。 */
export interface WorkspaceServicePort {
	request(request: WorkspaceServiceRequest, signal?: AbortSignal): Promise<WorkspaceServiceResult>;
}
