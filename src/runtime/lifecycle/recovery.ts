/** Startup 外部 receipt 审计合同；实际 Workspace/Approval store 仍由专项拥有。 */

import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import {
	ApprovalReceiptRefSchema,
	isApprovalReceiptRef,
	type ApprovalReceiptRef,
} from "../protocol/v3/capability.ts";
import { isRuntimeId } from "../protocol/v3/ids.ts";
import type {
	AuthorityId,
	ReceiptId,
	SessionId,
	TenantId,
} from "../protocol/v3/ids.ts";
import {
	WorkspaceLeaseRefSchema,
	isWorkspaceLeaseRef,
	type WorkspaceLeaseRef,
} from "../protocol/v3/workspace.ts";

export const LIFECYCLE_SCHEMA_VERSION = 1 as const;

export interface LifecycleError {
	code:
		| "invalid_request"
		| "integrity_failed"
		| "external_unavailable"
		| "timeout"
		| "mutation_failed"
		| "mutation_uncertain";
	message: string;
	retryable: boolean;
}

export type LifecycleResult<T> = { ok: true; value: T } | { ok: false; error: LifecycleError };

export interface ExternalReceiptReferenceSet {
	schemaVersion: typeof LIFECYCLE_SCHEMA_VERSION;
	authorityId: AuthorityId;
	tenantId: TenantId;
	sessionId: SessionId;
	completeness: "complete" | "unknown";
	workspaceLeases: readonly WorkspaceLeaseRef[];
	approvalDecisions: readonly ApprovalReceiptRef[];
}

export interface ExternalReceiptAuditReceipt {
	schemaVersion: typeof LIFECYCLE_SCHEMA_VERSION;
	authorityId: AuthorityId;
	tenantId: TenantId;
	sessionId: SessionId;
	auditReceiptId: ReceiptId;
	subjectKind: "workspace_lease" | "approval_decision";
	subjectId: string;
	status: "valid" | "invalid" | "unavailable";
	checkedAt: string;
	receiptDigest: string;
}

export interface StartupExternalReferenceSourcePort {
	loadReferences(
		scope: { authorityId: AuthorityId; tenantId: TenantId; sessionId: SessionId },
		signal?: AbortSignal,
	): Promise<LifecycleResult<ExternalReceiptReferenceSet>>;
}

export interface StartupExternalReceiptAuditPort {
	auditWorkspaceLease(
		sessionId: SessionId,
		lease: WorkspaceLeaseRef,
		signal?: AbortSignal,
	): Promise<LifecycleResult<ExternalReceiptAuditReceipt>>;
	auditApprovalDecision(
		sessionId: SessionId,
		receipt: ApprovalReceiptRef,
		signal?: AbortSignal,
	): Promise<LifecycleResult<ExternalReceiptAuditReceipt>>;
}

const runtimeId = (kind: string) => Type.String({ pattern: `^${kind}_[A-Za-z0-9][A-Za-z0-9._~-]*$`, maxLength: 128 });
const digest = Type.String({ pattern: "^[a-f0-9]{64}$", maxLength: 64 });
const timestamp = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$", maxLength: 24 });
const exact = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });

export const ExternalReceiptReferenceSetSchema = exact({
	schemaVersion: Type.Literal(LIFECYCLE_SCHEMA_VERSION), authorityId: runtimeId("authority"), tenantId: runtimeId("tenant"), sessionId: runtimeId("session"),
	completeness: Type.Union([Type.Literal("complete"), Type.Literal("unknown")]),
	workspaceLeases: Type.Array(WorkspaceLeaseRefSchema, { maxItems: 10_000 }),
	approvalDecisions: Type.Array(ApprovalReceiptRefSchema, { maxItems: 10_000 }),
});

export const ExternalReceiptAuditReceiptSchema = exact({
	schemaVersion: Type.Literal(LIFECYCLE_SCHEMA_VERSION), authorityId: runtimeId("authority"), tenantId: runtimeId("tenant"), sessionId: runtimeId("session"),
	auditReceiptId: runtimeId("receipt"), subjectKind: Type.Union([Type.Literal("workspace_lease"), Type.Literal("approval_decision")]),
	subjectId: Type.String({ minLength: 1, maxLength: 128 }), status: Type.Union([Type.Literal("valid"), Type.Literal("invalid"), Type.Literal("unavailable")]),
	checkedAt: timestamp, receiptDigest: digest,
});

export function isExternalReceiptReferenceSet(value: unknown): value is ExternalReceiptReferenceSet {
	if (!Check(ExternalReceiptReferenceSetSchema, value)) return false;
	if (!isRuntimeId(value.authorityId, "authority") || !isRuntimeId(value.tenantId, "tenant") ||
		!isRuntimeId(value.sessionId, "session")) return false;
	return value.workspaceLeases.every((lease) => isWorkspaceLeaseRef(lease) && lease.authorityId === value.authorityId && lease.tenantId === value.tenantId) &&
		value.approvalDecisions.every((receipt) => isApprovalReceiptRef(receipt) && receipt.authorityId === value.authorityId && receipt.tenantId === value.tenantId);
}

export function isExternalReceiptAuditReceipt(value: unknown): value is ExternalReceiptAuditReceipt {
	return Check(ExternalReceiptAuditReceiptSchema, value) &&
		isRuntimeId(value.authorityId, "authority") && isRuntimeId(value.tenantId, "tenant") &&
		isRuntimeId(value.sessionId, "session") && isRuntimeId(value.auditReceiptId, "receipt");
}

export function auditReceiptMatchesWorkspaceLease(
	audit: ExternalReceiptAuditReceipt,
	sessionId: SessionId,
	lease: WorkspaceLeaseRef,
): boolean {
	return isExternalReceiptAuditReceipt(audit) && audit.subjectKind === "workspace_lease" &&
		audit.authorityId === lease.authorityId && audit.tenantId === lease.tenantId && audit.sessionId === sessionId &&
		audit.subjectId === lease.leaseId;
}

export function auditReceiptMatchesApproval(
	audit: ExternalReceiptAuditReceipt,
	sessionId: SessionId,
	receipt: ApprovalReceiptRef,
): boolean {
	return isExternalReceiptAuditReceipt(audit) && audit.subjectKind === "approval_decision" &&
		audit.authorityId === receipt.authorityId && audit.tenantId === receipt.tenantId && audit.sessionId === sessionId &&
		audit.subjectId === receipt.receiptId;
}
