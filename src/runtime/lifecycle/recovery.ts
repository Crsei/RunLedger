/** Startup 外部 receipt 审计合同；实际 Workspace/Approval store 仍由专项拥有。 */

import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import {
	ApprovalReceiptRefSchema,
	isApprovalReceiptRef,
	type ApprovalReceiptRef,
} from "../protocol/v3/capability.ts";
import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import { createRuntimeId, isRuntimeId } from "../protocol/v3/ids.ts";
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
	completeness: "complete" | "partial" | "unknown";
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
	/** 被审计的 canonical reference；同 ID 的旧 revision 不能复用 receipt。 */
	subjectDigest: string;
	/** authoritative store 返回对象时才存在；not_found/unavailable 不得伪造。 */
	authoritativeDigest?: string;
	observedRevision?: number;
	status: "valid" | "invalid" | "unavailable";
	outcomeReason:
		| "exact_match"
		| "stale"
		| "revoked"
		| "expired"
		| "not_found"
		| "scope_mismatch"
		| "digest_mismatch"
		| "timeout"
		| "store_unavailable"
		| "external_unavailable";
	checkedAt: string;
	validThrough: string | null;
	receiptDigest: string;
}

export type ExternalReceiptAuditReceiptInput = Omit<
	ExternalReceiptAuditReceipt,
	"schemaVersion" | "auditReceiptId" | "receiptDigest"
>;

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
	completeness: Type.Union([Type.Literal("complete"), Type.Literal("partial"), Type.Literal("unknown")]),
	workspaceLeases: Type.Array(WorkspaceLeaseRefSchema, { maxItems: 10_000 }),
	approvalDecisions: Type.Array(ApprovalReceiptRefSchema, { maxItems: 10_000 }),
});

export const ExternalReceiptAuditReceiptSchema = exact({
	schemaVersion: Type.Literal(LIFECYCLE_SCHEMA_VERSION), authorityId: runtimeId("authority"), tenantId: runtimeId("tenant"), sessionId: runtimeId("session"),
	auditReceiptId: runtimeId("receipt"), subjectKind: Type.Union([Type.Literal("workspace_lease"), Type.Literal("approval_decision")]),
	subjectId: Type.String({ minLength: 1, maxLength: 128 }), subjectDigest: digest,
	authoritativeDigest: Type.Optional(digest),
	observedRevision: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
	status: Type.Union([Type.Literal("valid"), Type.Literal("invalid"), Type.Literal("unavailable")]),
	outcomeReason: Type.Union([
		Type.Literal("exact_match"), Type.Literal("stale"), Type.Literal("revoked"), Type.Literal("expired"),
		Type.Literal("not_found"), Type.Literal("scope_mismatch"), Type.Literal("digest_mismatch"),
		Type.Literal("timeout"), Type.Literal("store_unavailable"), Type.Literal("external_unavailable"),
	]),
	checkedAt: timestamp, validThrough: Type.Union([timestamp, Type.Null()]), receiptDigest: digest,
});

export function isExternalReceiptReferenceSet(value: unknown): value is ExternalReceiptReferenceSet {
	if (!Check(ExternalReceiptReferenceSetSchema, value)) return false;
	if (!isRuntimeId(value.authorityId, "authority") || !isRuntimeId(value.tenantId, "tenant") ||
		!isRuntimeId(value.sessionId, "session")) return false;
	return value.workspaceLeases.every((lease) => isWorkspaceLeaseRef(lease) && lease.authorityId === value.authorityId && lease.tenantId === value.tenantId) &&
		value.approvalDecisions.every((receipt) => isApprovalReceiptRef(receipt) && receipt.authorityId === value.authorityId && receipt.tenantId === value.tenantId);
}

export function isExternalReceiptAuditReceipt(value: unknown): value is ExternalReceiptAuditReceipt {
	if (!Check(ExternalReceiptAuditReceiptSchema, value) ||
		!isRuntimeId(value.authorityId, "authority") || !isRuntimeId(value.tenantId, "tenant") ||
		!isRuntimeId(value.sessionId, "session") || !isRuntimeId(value.auditReceiptId, "receipt") ||
		!Number.isFinite(Date.parse(value.checkedAt)) ||
		(value.validThrough !== null && (
			!Number.isFinite(Date.parse(value.validThrough)) || Date.parse(value.validThrough) < Date.parse(value.checkedAt)
		))) return false;
	const validReason = value.status === "valid" && value.outcomeReason === "exact_match" &&
		value.authoritativeDigest === value.subjectDigest && value.observedRevision !== undefined;
	const invalidReason = value.status === "invalid" && [
		"stale", "revoked", "expired", "scope_mismatch", "digest_mismatch",
	].includes(value.outcomeReason);
	const unavailableReason = value.status === "unavailable" &&
		["not_found", "timeout", "store_unavailable", "external_unavailable"].includes(value.outcomeReason) &&
		value.authoritativeDigest === undefined && value.observedRevision === undefined;
	if (!validReason && !invalidReason && !unavailableReason) return false;
	const { receiptDigest, ...body } = value;
	return canonicalDigest(body) === receiptDigest;
}

export function createExternalReceiptAuditReceipt(
	input: ExternalReceiptAuditReceiptInput,
): ExternalReceiptAuditReceipt {
	const auditReceiptId = createRuntimeId(
		"receipt",
		`startup-audit-${canonicalDigest({ domain: "runledger.startup-external-receipt-audit.v1", input }).slice(0, 48)}`,
	);
	const body: Omit<ExternalReceiptAuditReceipt, "receiptDigest"> = {
		schemaVersion: LIFECYCLE_SCHEMA_VERSION,
		auditReceiptId,
		...input,
	};
	return { ...body, receiptDigest: canonicalDigest(body) };
}

export function auditReceiptMatchesWorkspaceLease(
	audit: ExternalReceiptAuditReceipt,
	sessionId: SessionId,
	lease: WorkspaceLeaseRef,
): boolean {
	return isExternalReceiptAuditReceipt(audit) && audit.subjectKind === "workspace_lease" &&
		audit.authorityId === lease.authorityId && audit.tenantId === lease.tenantId && audit.sessionId === sessionId &&
		audit.subjectId === lease.leaseId && audit.subjectDigest === canonicalDigest(lease) &&
		(audit.status !== "valid" || audit.observedRevision === lease.leaseRevision);
}

export function auditReceiptMatchesApproval(
	audit: ExternalReceiptAuditReceipt,
	sessionId: SessionId,
	receipt: ApprovalReceiptRef,
): boolean {
	return isExternalReceiptAuditReceipt(audit) && audit.subjectKind === "approval_decision" &&
		audit.authorityId === receipt.authorityId && audit.tenantId === receipt.tenantId && audit.sessionId === sessionId &&
		audit.subjectId === receipt.receiptId && audit.subjectDigest === canonicalDigest(receipt) &&
		(audit.status !== "valid" || audit.observedRevision === receipt.decisionRevision) &&
		(audit.status !== "valid" || audit.validThrough === (receipt.expiresAt ?? null));
}
