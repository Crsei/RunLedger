/** Capability、approval 与 sandbox v3 event 的封闭、脱敏 payload 合同。 */

import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import {
	ApprovalScopeSchema,
	AuthorizationServerScopeSchema,
	CapabilityNameSchema,
	CapabilityResourceKindSchema,
	SandboxEffectiveEnforcementSchema,
	SandboxExecutionReceiptRefSchema,
	SandboxProfileNameSchema,
	type ApprovalReceiptRef,
	type ApprovalReceiptDecision,
	type ApprovalTicket,
	type ApprovalScope,
	type AuthorizationServerScope,
	type CapabilityName,
	type CapabilityResourceKind,
	type SandboxEffectiveEnforcement,
	type SandboxExecutionReceiptRef,
	type SandboxProfileName,
} from "./capability.ts";
import type {
	ApprovalId,
	ArtifactId,
	CommandId,
	ReceiptId,
	PrincipalId,
	ResourceId,
	RuntimeInstanceId,
	SessionId,
	ToolCallId,
	TurnId,
} from "./ids.ts";

const runtimeId = (kind: string) =>
	Type.String({ pattern: `^${kind}_[A-Za-z0-9][A-Za-z0-9._~-]*$`, maxLength: 128 });
const digest = Type.String({ pattern: "^[a-f0-9]{64}$", maxLength: 64 });
const timestamp = Type.String({
	pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$",
	maxLength: 24,
});
const revision = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const approvalDecisionRevision = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const exact = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

export const SECURITY_RUNTIME_EVENT_TYPES = [
	"tool.authorized",
	"permission.requested",
	"permission.decided",
	"permission.expired",
	"permission.revoked",
	"sandbox.resolved",
	"sandbox.execution_recorded",
] as const;

export type SecurityRuntimeEventType = (typeof SECURITY_RUNTIME_EVENT_TYPES)[number];

/** 只允许固定分类与 digest；不提供 command、URL、header、env value 或 credential 字段。 */
export interface PermissionRequestSummary {
	operation: "read" | "write" | "execute" | "connect" | "credential_use" | "deploy" | "cross_workspace";
	toolIdentityDigest: string;
	targetDigest: string;
	environmentKeyDigests: readonly string[];
}

export interface PermissionRequestedPayload {
	approvalId: ApprovalId;
	requestId: CommandId;
	sessionId: SessionId;
	runtimeId: RuntimeInstanceId;
	runtimeGeneration: number;
	turnId: TurnId;
	toolCallId: ToolCallId;
	capability: CapabilityName;
	resourceKind: CapabilityResourceKind;
	requestDigest: string;
	policyDigest: string;
	workspaceEnvelopeDigest: string;
	ticketDigest: string;
	scope: ApprovalScope;
	requestedAt: string;
	expiresAt?: string;
	attemptId: CommandId;
	serverScope: AuthorizationServerScope;
	resourceScopeDigest: string;
	commandScopeDigest: string;
	evidenceComplete: boolean;
	evidenceTruncated: boolean;
	originalInputDigest: string;
	originalArtifactId?: ArtifactId;
	originalArtifactDigest?: string;
	summary: PermissionRequestSummary;
}

export interface PermissionDecidedPayload {
	approvalId: ApprovalId;
	requestId: CommandId;
	requestDigest: string;
	ticketDigest: string;
	sessionId: SessionId;
	runtimeId: RuntimeInstanceId;
	runtimeGeneration: number;
	turnId: TurnId;
	toolCallId: ToolCallId;
	decision: Exclude<ApprovalReceiptDecision, "expired" | "revoked">;
	decisionRevision: number;
	decidedBy: PrincipalId;
	receiptId: ReceiptId;
	receiptDigest: string;
	decidedAt: string;
	evidenceComplete: boolean;
	evidenceTruncated: boolean;
	originalInputDigest: string;
	expiresAt?: string;
}

export interface PermissionExpiredPayload {
	approvalId: ApprovalId;
	requestId: CommandId;
	sessionId: SessionId;
	runtimeId: RuntimeInstanceId;
	runtimeGeneration: number;
	turnId: TurnId;
	toolCallId: ToolCallId;
	requestDigest: string;
	ticketDigest: string;
	decisionRevision: number;
	decidedBy: PrincipalId;
	expiredAt: string;
	receiptId: ReceiptId;
	receiptDigest: string;
}

export interface PermissionRevokedPayload {
	approvalId: ApprovalId;
	requestId: CommandId;
	sessionId: SessionId;
	runtimeId: RuntimeInstanceId;
	runtimeGeneration: number;
	turnId: TurnId;
	toolCallId: ToolCallId;
	requestDigest: string;
	ticketDigest: string;
	decisionRevision: number;
	decidedBy: PrincipalId;
	revokedAt: string;
	receiptId: ReceiptId;
	receiptDigest: string;
}

export interface ToolAuthorizedPayload {
	toolCallId: ToolCallId;
	requestId: CommandId;
	decisionReceiptId: ReceiptId;
	approvalId: ApprovalId;
	sessionId: SessionId;
	runtimeId: RuntimeInstanceId;
	runtimeGeneration: number;
	turnId: TurnId;
	capability: CapabilityName;
	requestDigest: string;
	policyDigest: string;
	workspaceEnvelopeDigest: string;
	sandboxResolutionReceiptId: ReceiptId;
	approvalReceiptId?: ReceiptId;
	approvalReceiptDigest?: string;
	approvalDecisionRevision?: number;
}

export interface ApprovalRequestEventEvidence {
	attemptId: CommandId;
	resourceKind: CapabilityResourceKind;
	summary: PermissionRequestSummary;
}

/** session-owned canonical journal；producer 必须等待 append+flush 后才继续 prompt/grant。 */
export interface ApprovalLifecycleEventPort {
	recordApprovalRequested(ticket: ApprovalTicket, evidence: ApprovalRequestEventEvidence): Promise<void>;
	recordApprovalTerminal(ticket: ApprovalTicket, receipt: ApprovalReceiptRef): Promise<void>;
}

export interface SandboxResolvedPayload {
	requestId: CommandId;
	profileId: ResourceId;
	requested: SandboxProfileName;
	resolved: SandboxProfileName;
	policyDigest: string;
	resolutionReceiptId: ReceiptId;
	backendId: string;
	effectiveEnforcement: SandboxEffectiveEnforcement;
	reasonDigest?: string;
}

export interface SandboxExecutionRecordedPayload {
	requestId: CommandId;
	invocationDigest: string;
	receipt: SandboxExecutionReceiptRef;
	toolCallId?: ToolCallId;
}

export const PermissionRequestSummarySchema = exact({
	operation: Type.Union([
		Type.Literal("read"),
		Type.Literal("write"),
		Type.Literal("execute"),
		Type.Literal("connect"),
		Type.Literal("credential_use"),
		Type.Literal("deploy"),
		Type.Literal("cross_workspace"),
	]),
	toolIdentityDigest: digest,
	targetDigest: digest,
	environmentKeyDigests: Type.Array(digest, { maxItems: 64, uniqueItems: true }),
});

export const PermissionRequestedPayloadSchema = Type.Unsafe<PermissionRequestedPayload>(exact({
	approvalId: runtimeId("approval"),
	requestId: runtimeId("command"),
	sessionId: runtimeId("session"),
	runtimeId: runtimeId("runtime"),
	runtimeGeneration: revision,
	turnId: runtimeId("turn"),
	toolCallId: runtimeId("toolCall"),
	capability: CapabilityNameSchema,
	resourceKind: CapabilityResourceKindSchema,
	requestDigest: digest,
	policyDigest: digest,
	workspaceEnvelopeDigest: digest,
	ticketDigest: digest,
	scope: ApprovalScopeSchema,
	requestedAt: timestamp,
	expiresAt: Type.Optional(timestamp),
	attemptId: runtimeId("command"),
	serverScope: AuthorizationServerScopeSchema,
	resourceScopeDigest: digest,
	commandScopeDigest: digest,
	evidenceComplete: Type.Boolean(),
	evidenceTruncated: Type.Boolean(),
	originalInputDigest: digest,
	originalArtifactId: Type.Optional(runtimeId("artifact")),
	originalArtifactDigest: Type.Optional(digest),
	summary: PermissionRequestSummarySchema,
}));

const permissionDecidedBaseProperties = {
	approvalId: runtimeId("approval"),
	requestId: runtimeId("command"),
	requestDigest: digest,
	ticketDigest: digest,
	sessionId: runtimeId("session"),
	runtimeId: runtimeId("runtime"),
	runtimeGeneration: revision,
	turnId: runtimeId("turn"),
	toolCallId: runtimeId("toolCall"),
	decisionRevision: approvalDecisionRevision,
	decidedBy: runtimeId("principal"),
	receiptId: runtimeId("receipt"),
	receiptDigest: digest,
	decidedAt: timestamp,
	originalInputDigest: digest,
	expiresAt: Type.Optional(timestamp),
} as const;

export const PermissionDecidedPayloadSchema = Type.Unsafe<PermissionDecidedPayload>(Type.Union([
	exact({
		...permissionDecidedBaseProperties,
		decision: Type.Literal("allowed"),
		evidenceComplete: Type.Literal(true),
		evidenceTruncated: Type.Literal(false),
	}),
	...(["denied", "cancelled", "follow_up_replaced", "channel_failed", "transferred_to_human"] as const).map(
		(decision) => exact({
			...permissionDecidedBaseProperties,
			decision: Type.Literal(decision),
			evidenceComplete: Type.Boolean(),
			evidenceTruncated: Type.Boolean(),
		}),
	),
]));

export const PermissionExpiredPayloadSchema = exact({
	approvalId: runtimeId("approval"),
	requestId: runtimeId("command"),
	sessionId: runtimeId("session"),
	runtimeId: runtimeId("runtime"),
	runtimeGeneration: revision,
	turnId: runtimeId("turn"),
	toolCallId: runtimeId("toolCall"),
	requestDigest: digest,
	ticketDigest: digest,
	decisionRevision: approvalDecisionRevision,
	decidedBy: runtimeId("principal"),
	expiredAt: timestamp,
	receiptId: runtimeId("receipt"),
	receiptDigest: digest,
});

export const PermissionRevokedPayloadSchema = exact({
	approvalId: runtimeId("approval"),
	requestId: runtimeId("command"),
	sessionId: runtimeId("session"),
	runtimeId: runtimeId("runtime"),
	runtimeGeneration: revision,
	turnId: runtimeId("turn"),
	toolCallId: runtimeId("toolCall"),
	requestDigest: digest,
	ticketDigest: digest,
	decisionRevision: approvalDecisionRevision,
	decidedBy: runtimeId("principal"),
	revokedAt: timestamp,
	receiptId: runtimeId("receipt"),
	receiptDigest: digest,
});

const toolAuthorizedBaseProperties = {
	toolCallId: runtimeId("toolCall"),
	requestId: runtimeId("command"),
	decisionReceiptId: runtimeId("receipt"),
	approvalId: runtimeId("approval"),
	sessionId: runtimeId("session"),
	runtimeId: runtimeId("runtime"),
	runtimeGeneration: revision,
	turnId: runtimeId("turn"),
	capability: CapabilityNameSchema,
	requestDigest: digest,
	policyDigest: digest,
	workspaceEnvelopeDigest: digest,
	sandboxResolutionReceiptId: runtimeId("receipt"),
} as const;

export const ToolAuthorizedPayloadSchema = Type.Unsafe<ToolAuthorizedPayload>(Type.Union([
	exact(toolAuthorizedBaseProperties),
	exact({
		...toolAuthorizedBaseProperties,
		approvalReceiptId: runtimeId("receipt"),
		approvalReceiptDigest: digest,
		approvalDecisionRevision,
	}),
]));

const sandboxResolvedBaseProperties = {
	requestId: runtimeId("command"),
	profileId: runtimeId("resource"),
	requested: SandboxProfileNameSchema,
	resolved: SandboxProfileNameSchema,
	policyDigest: digest,
	resolutionReceiptId: runtimeId("receipt"),
	backendId: Type.String({ minLength: 1, maxLength: 128 }),
} as const;

export const SandboxResolvedPayloadSchema = Type.Union([
	exact({
		...sandboxResolvedBaseProperties,
		effectiveEnforcement: Type.Literal("enforced"),
	}),
	exact({
		...sandboxResolvedBaseProperties,
		effectiveEnforcement: Type.Literal("off"),
	}),
	exact({
		...sandboxResolvedBaseProperties,
		effectiveEnforcement: Type.Literal("degraded"),
		reasonDigest: digest,
	}),
	exact({
		...sandboxResolvedBaseProperties,
		effectiveEnforcement: Type.Literal("unavailable"),
		reasonDigest: digest,
	}),
]);

export const SandboxExecutionRecordedPayloadSchema = exact({
	requestId: runtimeId("command"),
	invocationDigest: digest,
	receipt: SandboxExecutionReceiptRefSchema,
	toolCallId: Type.Optional(runtimeId("toolCall")),
});

export const SECURITY_EVENT_PAYLOAD_SCHEMAS = {
	"tool.authorized": ToolAuthorizedPayloadSchema,
	"permission.requested": PermissionRequestedPayloadSchema,
	"permission.decided": PermissionDecidedPayloadSchema,
	"permission.expired": PermissionExpiredPayloadSchema,
	"permission.revoked": PermissionRevokedPayloadSchema,
	"sandbox.resolved": SandboxResolvedPayloadSchema,
	"sandbox.execution_recorded": SandboxExecutionRecordedPayloadSchema,
} as const satisfies Record<SecurityRuntimeEventType, TSchema>;

const SECURITY_EVENT_TYPE_SET: ReadonlySet<string> = new Set(SECURITY_RUNTIME_EVENT_TYPES);

export function isSecurityRuntimeEventType(value: unknown): value is SecurityRuntimeEventType {
	return typeof value === "string" && SECURITY_EVENT_TYPE_SET.has(value);
}

export function isPermissionRequestedPayload(value: unknown): value is PermissionRequestedPayload {
	if (!Check(PermissionRequestedPayloadSchema, value)) return false;
	const payload = value as unknown as PermissionRequestedPayload;
	const hasArtifactId = payload.originalArtifactId !== undefined;
	const hasArtifactDigest = payload.originalArtifactDigest !== undefined;
	return hasArtifactId === hasArtifactDigest && !(payload.evidenceComplete && payload.evidenceTruncated);
}

export function isPermissionDecidedPayload(value: unknown): value is PermissionDecidedPayload {
	if (!Check(PermissionDecidedPayloadSchema, value)) return false;
	const payload = value as PermissionDecidedPayload;
	return !(payload.evidenceComplete && payload.evidenceTruncated);
}

export function isPermissionExpiredPayload(value: unknown): value is PermissionExpiredPayload {
	return Check(PermissionExpiredPayloadSchema, value);
}

export function isPermissionRevokedPayload(value: unknown): value is PermissionRevokedPayload {
	return Check(PermissionRevokedPayloadSchema, value);
}

export function isToolAuthorizedPayload(value: unknown): value is ToolAuthorizedPayload {
	return Check(ToolAuthorizedPayloadSchema, value);
}

export function isSandboxResolvedPayload(value: unknown): value is SandboxResolvedPayload {
	return Check(SandboxResolvedPayloadSchema, value);
}

export function isSandboxExecutionRecordedPayload(value: unknown): value is SandboxExecutionRecordedPayload {
	return Check(SandboxExecutionRecordedPayloadSchema, value);
}
