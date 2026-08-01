/** Capability、approval、credential、sandbox 与 artifact 的 Runtime 中立合同。 */

import { Type } from "typebox";
import { Value } from "typebox/value";
import { IdentityContextSchema, isIdentityContext } from "../identity/schemas.ts";
import type { IdentityContext } from "../identity/types.ts";
import { AdapterIdentityRefSchema, type AdapterIdentityRef } from "./adapter.ts";
import {
	CanonicalUtcTimestampSchema,
	RuntimeContentRefSchema,
	RuntimeDigestSchema,
	RuntimeIdSchema,
	isCanonicalUtcTimestamp,
} from "./foundation-schemas.ts";
import type { RuntimeContentRef, RuntimeDigest } from "./foundation.ts";
import { isRuntimeId } from "./ids.ts";
import type {
	AgentId,
	ApprovalId,
	ArtifactId,
	AuthorityId,
	CommandId,
	PrincipalId,
	ReceiptId,
	SessionId,
	TenantId,
	ToolCallId,
	TraceId,
	WorkspaceId,
} from "./ids.ts";

export const CAPABILITY_NAMES = [
	"repository_read",
	"workspace_write",
	"dependency_install",
	"network",
	"process",
	"credential",
	"deploy",
	"cross_workspace",
] as const;

export type CapabilityName = (typeof CAPABILITY_NAMES)[number];
export type CapabilityDecision = "allow" | "ask" | "deny";
export type CapabilityScope = "invocation" | "turn" | "session" | "workspace" | "authority_tenant";

export interface CapabilityClaim {
	readonly name: CapabilityName;
	readonly resourceKind: "filesystem" | "network" | "process" | "credential" | "workspace" | "tool";
	readonly resourceDigest: RuntimeDigest;
	readonly constraintsDigest: RuntimeDigest;
	readonly scope: CapabilityScope;
}

export interface CapabilityRequestSubject {
	readonly sessionId: SessionId;
	readonly agentId?: AgentId;
	readonly toolCallId?: ToolCallId;
	readonly traceId: TraceId;
}

export interface CapabilityRequest {
	readonly requestId: CommandId;
	readonly identity: IdentityContext;
	readonly subject: CapabilityRequestSubject;
	readonly claim: CapabilityClaim;
	readonly argumentsDigest: RuntimeDigest;
	readonly workspaceEnvelopeDigest?: RuntimeDigest;
	readonly policyDigest: RuntimeDigest;
	readonly nonceDigest: RuntimeDigest;
	readonly issuedAt: string;
	readonly expiresAt: string;
	readonly channel: "local_cli" | "daemon" | "remote" | "adapter";
	readonly signatureProofRef: RuntimeContentRef;
}

export interface CapabilityDecisionReceipt {
	readonly receiptId: ReceiptId;
	readonly requestId: CommandId;
	readonly decision: CapabilityDecision;
	readonly decisionRevision: number;
	readonly matchedRulesDigest: RuntimeDigest;
	readonly policyDigest: RuntimeDigest;
	readonly gateway: AdapterIdentityRef;
	readonly approverPrincipalId?: PrincipalId;
	readonly decidedAt: string;
	readonly expiresAt?: string;
	readonly revocationRevision: number;
}

export interface ApprovalTicket {
	readonly approvalId: ApprovalId;
	readonly requestDigest: RuntimeDigest;
	readonly scope: "once" | "session" | "project";
	readonly status: "pending";
	readonly principalId: PrincipalId;
	readonly createdAt: string;
	readonly expiresAt?: string;
}

export interface ApprovalReceiptRef {
	readonly receiptId: ReceiptId;
	readonly approvalId: ApprovalId;
	readonly requestDigest: RuntimeDigest;
	readonly scope: "once" | "session" | "project";
	readonly decision: "allowed" | "denied" | "cancelled" | "expired" | "revoked";
	readonly decisionRevision: number;
	readonly principalId: PrincipalId;
	readonly decidedAt: string;
	readonly expiresAt?: string;
	readonly receiptDigest: RuntimeDigest;
}

export interface RateLimitReceiptRef {
	readonly receiptId: ReceiptId;
	readonly principalId: PrincipalId;
	readonly capability: CapabilityName;
	readonly resourceDigest: RuntimeDigest;
	readonly windowStartedAt: string;
	readonly windowDurationMs: number;
	readonly reservationDigest: RuntimeDigest;
	readonly outcome: "reserved" | "denied" | "committed" | "released";
	readonly decisionRevision: number;
	readonly recordedAt: string;
}

export interface CredentialGrantRef {
	readonly grantId: ReceiptId;
	readonly credentialKind: string;
	readonly audienceDigest: RuntimeDigest;
	readonly scopeDigest: RuntimeDigest;
	readonly issuedAt: string;
	readonly expiresAt: string;
	readonly revocationRevision: number;
	readonly brokerReceiptRef: RuntimeContentRef;
}

export type SandboxProfileName = "off" | "read-only" | "workspace-write" | "strict" | "external";

export interface SandboxProfileRef {
	readonly profileId: string;
	readonly requested: SandboxProfileName;
	readonly effective: SandboxProfileName;
	readonly policyDigest: RuntimeDigest;
	readonly backendRequirementDigest: RuntimeDigest;
}

export interface SandboxExecutionReceiptRef {
	readonly receiptId: ReceiptId;
	readonly profileId: string;
	readonly backend: AdapterIdentityRef;
	readonly enforcement: "enforced" | "degraded" | "unavailable" | "off";
	readonly invocationDigest: RuntimeDigest;
	readonly platformAttestationRef: RuntimeContentRef;
	readonly executedAt: string;
}

export interface ArtifactRef {
	readonly artifactId: ArtifactId;
	readonly authorityId: AuthorityId;
	readonly tenantId: TenantId;
	readonly storedDigest: RuntimeDigest;
	readonly kind: "diff" | "tool_output" | "log" | "test_report" | "screenshot" | "session_report";
	readonly originalSize: number;
	readonly storedSize: number;
	readonly mediaType: string;
	readonly redaction: "metadata_only" | "redacted" | "encrypted_forensic";
	readonly transformReceiptRef: RuntimeContentRef;
	readonly workspaceId?: WorkspaceId;
}

const CapabilityNameSchema = Type.Union(CAPABILITY_NAMES.map((name) => Type.Literal(name)));
const CapabilityDecisionSchema = Type.Union([
	Type.Literal("allow"),
	Type.Literal("ask"),
	Type.Literal("deny"),
]);
const CapabilityScopeSchema = Type.Union([
	Type.Literal("invocation"),
	Type.Literal("turn"),
	Type.Literal("session"),
	Type.Literal("workspace"),
	Type.Literal("authority_tenant"),
]);

export const CapabilityClaimSchema = Type.Object(
	{
		name: CapabilityNameSchema,
		resourceKind: Type.Union([
			Type.Literal("filesystem"),
			Type.Literal("network"),
			Type.Literal("process"),
			Type.Literal("credential"),
			Type.Literal("workspace"),
			Type.Literal("tool"),
		]),
		resourceDigest: RuntimeDigestSchema,
		constraintsDigest: RuntimeDigestSchema,
		scope: CapabilityScopeSchema,
	},
	{ additionalProperties: false },
);

const CapabilityRequestSubjectSchema = Type.Object(
	{
		sessionId: RuntimeIdSchema,
		agentId: Type.Optional(RuntimeIdSchema),
		toolCallId: Type.Optional(RuntimeIdSchema),
		traceId: RuntimeIdSchema,
	},
	{ additionalProperties: false },
);

export const CapabilityRequestSchema = Type.Object(
	{
		requestId: RuntimeIdSchema,
		identity: IdentityContextSchema,
		subject: CapabilityRequestSubjectSchema,
		claim: CapabilityClaimSchema,
		argumentsDigest: RuntimeDigestSchema,
		workspaceEnvelopeDigest: Type.Optional(RuntimeDigestSchema),
		policyDigest: RuntimeDigestSchema,
		nonceDigest: RuntimeDigestSchema,
		issuedAt: CanonicalUtcTimestampSchema,
		expiresAt: CanonicalUtcTimestampSchema,
		channel: Type.Union([
			Type.Literal("local_cli"),
			Type.Literal("daemon"),
			Type.Literal("remote"),
			Type.Literal("adapter"),
		]),
		signatureProofRef: RuntimeContentRefSchema,
	},
	{ additionalProperties: false },
);

export const CapabilityDecisionReceiptSchema = Type.Object(
	{
		receiptId: RuntimeIdSchema,
		requestId: RuntimeIdSchema,
		decision: CapabilityDecisionSchema,
		decisionRevision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		matchedRulesDigest: RuntimeDigestSchema,
		policyDigest: RuntimeDigestSchema,
		gateway: AdapterIdentityRefSchema,
		approverPrincipalId: Type.Optional(RuntimeIdSchema),
		decidedAt: CanonicalUtcTimestampSchema,
		expiresAt: Type.Optional(CanonicalUtcTimestampSchema),
		revocationRevision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	},
	{ additionalProperties: false },
);

const ApprovalScopeSchema = Type.Union([
	Type.Literal("once"),
	Type.Literal("session"),
	Type.Literal("project"),
]);

export const ApprovalTicketSchema = Type.Object(
	{
		approvalId: RuntimeIdSchema,
		requestDigest: RuntimeDigestSchema,
		scope: ApprovalScopeSchema,
		status: Type.Literal("pending"),
		principalId: RuntimeIdSchema,
		createdAt: CanonicalUtcTimestampSchema,
		expiresAt: Type.Optional(CanonicalUtcTimestampSchema),
	},
	{ additionalProperties: false },
);

export const ApprovalReceiptRefSchema = Type.Object(
	{
		receiptId: RuntimeIdSchema,
		approvalId: RuntimeIdSchema,
		requestDigest: RuntimeDigestSchema,
		scope: ApprovalScopeSchema,
		decision: Type.Union([
			Type.Literal("allowed"),
			Type.Literal("denied"),
			Type.Literal("cancelled"),
			Type.Literal("expired"),
			Type.Literal("revoked"),
		]),
		decisionRevision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		principalId: RuntimeIdSchema,
		decidedAt: CanonicalUtcTimestampSchema,
		expiresAt: Type.Optional(CanonicalUtcTimestampSchema),
		receiptDigest: RuntimeDigestSchema,
	},
	{ additionalProperties: false },
);

export const RateLimitReceiptRefSchema = Type.Object(
	{
		receiptId: RuntimeIdSchema,
		principalId: RuntimeIdSchema,
		capability: CapabilityNameSchema,
		resourceDigest: RuntimeDigestSchema,
		windowStartedAt: CanonicalUtcTimestampSchema,
		windowDurationMs: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		reservationDigest: RuntimeDigestSchema,
		outcome: Type.Union([
			Type.Literal("reserved"),
			Type.Literal("denied"),
			Type.Literal("committed"),
			Type.Literal("released"),
		]),
		decisionRevision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		recordedAt: CanonicalUtcTimestampSchema,
	},
	{ additionalProperties: false },
);

export const CredentialGrantRefSchema = Type.Object(
	{
		grantId: RuntimeIdSchema,
		credentialKind: Type.String({ pattern: "^[A-Za-z0-9._-]+$", minLength: 1, maxLength: 64 }),
		audienceDigest: RuntimeDigestSchema,
		scopeDigest: RuntimeDigestSchema,
		issuedAt: CanonicalUtcTimestampSchema,
		expiresAt: CanonicalUtcTimestampSchema,
		revocationRevision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		brokerReceiptRef: RuntimeContentRefSchema,
	},
	{ additionalProperties: false },
);

const SandboxProfileNameSchema = Type.Union([
	Type.Literal("off"),
	Type.Literal("read-only"),
	Type.Literal("workspace-write"),
	Type.Literal("strict"),
	Type.Literal("external"),
]);
const SandboxProfileIdSchema = Type.String({ pattern: "^[A-Za-z0-9._-]+$", minLength: 1, maxLength: 128 });

export const SandboxProfileRefSchema = Type.Object(
	{
		profileId: SandboxProfileIdSchema,
		requested: SandboxProfileNameSchema,
		effective: SandboxProfileNameSchema,
		policyDigest: RuntimeDigestSchema,
		backendRequirementDigest: RuntimeDigestSchema,
	},
	{ additionalProperties: false },
);

export const SandboxExecutionReceiptRefSchema = Type.Object(
	{
		receiptId: RuntimeIdSchema,
		profileId: SandboxProfileIdSchema,
		backend: AdapterIdentityRefSchema,
		enforcement: Type.Union([
			Type.Literal("enforced"),
			Type.Literal("degraded"),
			Type.Literal("unavailable"),
			Type.Literal("off"),
		]),
		invocationDigest: RuntimeDigestSchema,
		platformAttestationRef: RuntimeContentRefSchema,
		executedAt: CanonicalUtcTimestampSchema,
	},
	{ additionalProperties: false },
);

export const ArtifactRefSchema = Type.Object(
	{
		artifactId: RuntimeIdSchema,
		authorityId: RuntimeIdSchema,
		tenantId: RuntimeIdSchema,
		storedDigest: RuntimeDigestSchema,
		kind: Type.Union([
			Type.Literal("diff"),
			Type.Literal("tool_output"),
			Type.Literal("log"),
			Type.Literal("test_report"),
			Type.Literal("screenshot"),
			Type.Literal("session_report"),
		]),
		originalSize: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		storedSize: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		mediaType: Type.String({ minLength: 1, maxLength: 128 }),
		redaction: Type.Union([
			Type.Literal("metadata_only"),
			Type.Literal("redacted"),
			Type.Literal("encrypted_forensic"),
		]),
		transformReceiptRef: RuntimeContentRefSchema,
		workspaceId: Type.Optional(RuntimeIdSchema),
	},
	{ additionalProperties: false },
);

function isOrderedTimestamp(start: string, end: string | undefined): boolean {
	return end === undefined || Date.parse(end) > Date.parse(start);
}

export function isCapabilityClaim(value: unknown): value is CapabilityClaim {
	return Value.Check(CapabilityClaimSchema, value);
}

export function isCapabilityRequest(value: unknown): value is CapabilityRequest {
	if (!Value.Check(CapabilityRequestSchema, value)) return false;
	return (
		isRuntimeId(value.requestId, "command") &&
		isIdentityContext(value.identity) &&
		isRuntimeId(value.subject.sessionId, "session") &&
		(value.subject.agentId === undefined || isRuntimeId(value.subject.agentId, "agent")) &&
		(value.subject.toolCallId === undefined || isRuntimeId(value.subject.toolCallId, "toolCall")) &&
		isRuntimeId(value.subject.traceId, "trace") &&
		isCanonicalUtcTimestamp(value.issuedAt) &&
		isCanonicalUtcTimestamp(value.expiresAt) &&
		isOrderedTimestamp(value.issuedAt, value.expiresAt)
	);
}

export function isCapabilityDecisionReceipt(value: unknown): value is CapabilityDecisionReceipt {
	if (!Value.Check(CapabilityDecisionReceiptSchema, value)) return false;
	return (
		isRuntimeId(value.receiptId, "receipt") &&
		isRuntimeId(value.requestId, "command") &&
		(value.approverPrincipalId === undefined || isRuntimeId(value.approverPrincipalId, "principal")) &&
		isCanonicalUtcTimestamp(value.decidedAt) &&
		(value.expiresAt === undefined || isCanonicalUtcTimestamp(value.expiresAt)) &&
		isOrderedTimestamp(value.decidedAt, value.expiresAt)
	);
}

export function isApprovalTicket(value: unknown): value is ApprovalTicket {
	if (!Value.Check(ApprovalTicketSchema, value)) return false;
	return (
		isRuntimeId(value.approvalId, "approval") &&
		isRuntimeId(value.principalId, "principal") &&
		isCanonicalUtcTimestamp(value.createdAt) &&
		(value.expiresAt === undefined || isCanonicalUtcTimestamp(value.expiresAt)) &&
		isOrderedTimestamp(value.createdAt, value.expiresAt)
	);
}

export function isApprovalReceiptRef(value: unknown): value is ApprovalReceiptRef {
	if (!Value.Check(ApprovalReceiptRefSchema, value)) return false;
	return (
		isRuntimeId(value.receiptId, "receipt") &&
		isRuntimeId(value.approvalId, "approval") &&
		isRuntimeId(value.principalId, "principal") &&
		isCanonicalUtcTimestamp(value.decidedAt) &&
		(value.expiresAt === undefined || isCanonicalUtcTimestamp(value.expiresAt)) &&
		isOrderedTimestamp(value.decidedAt, value.expiresAt)
	);
}

export function isRateLimitReceiptRef(value: unknown): value is RateLimitReceiptRef {
	if (!Value.Check(RateLimitReceiptRefSchema, value)) return false;
	return (
		isRuntimeId(value.receiptId, "receipt") &&
		isRuntimeId(value.principalId, "principal") &&
		isCanonicalUtcTimestamp(value.windowStartedAt) &&
		isCanonicalUtcTimestamp(value.recordedAt)
	);
}

export function isCredentialGrantRef(value: unknown): value is CredentialGrantRef {
	if (!Value.Check(CredentialGrantRefSchema, value)) return false;
	return (
		isRuntimeId(value.grantId, "receipt") &&
		isCanonicalUtcTimestamp(value.issuedAt) &&
		isCanonicalUtcTimestamp(value.expiresAt) &&
		isOrderedTimestamp(value.issuedAt, value.expiresAt)
	);
}

export function isSandboxProfileRef(value: unknown): value is SandboxProfileRef {
	return Value.Check(SandboxProfileRefSchema, value);
}

export function isSandboxExecutionReceiptRef(value: unknown): value is SandboxExecutionReceiptRef {
	if (!Value.Check(SandboxExecutionReceiptRefSchema, value)) return false;
	return isRuntimeId(value.receiptId, "receipt") && isCanonicalUtcTimestamp(value.executedAt);
}

export function isArtifactRef(value: unknown): value is ArtifactRef {
	if (!Value.Check(ArtifactRefSchema, value)) return false;
	return (
		isRuntimeId(value.artifactId, "artifact") &&
		isRuntimeId(value.authorityId, "authority") &&
		isRuntimeId(value.tenantId, "tenant") &&
		(value.workspaceId === undefined || isRuntimeId(value.workspaceId, "workspace"))
	);
}
