/** Enterprise refs 的 exact TypeBox schema 与 scope/correlation 校验。 */

import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import { isRuntimeId } from "../protocol/v3/ids.ts";
import {
	AUTHORIZATION_ACTIONS,
	ENTERPRISE_CONTRACT_SCHEMA_VERSION,
	ENTERPRISE_PRINCIPAL_KINDS,
	MANAGED_KEY_PROVIDERS,
	MANAGED_POLICY_SOURCES,
	type AuthenticationReceiptRef,
	type AuthenticationRequest,
	type AuthorizationDecisionReceiptRef,
	type AuthorizationRequest,
	type CredentialAudienceValidationReceiptRef,
	type CredentialAudienceValidationRequest,
	type CredentialGrantIssueRequest,
	type CredentialGrantRevocationReceiptRef,
	type CredentialGrantRevocationRequest,
	type EffectivePolicyReceiptRef,
	type EnterprisePrincipalRef,
	type KeyLifecycleReceiptRef,
	type ManagedKeyRef,
	type ManagedPolicySnapshotRef,
	type SessionCredentialGrantRef,
} from "./enterprise-types.ts";

const runtimeId = (kind: string) =>
	Type.String({ pattern: `^${kind}_[A-Za-z0-9][A-Za-z0-9._~-]*$`, maxLength: 128 });
const digest = Type.String({ pattern: "^[a-f0-9]{64}$", maxLength: 64 });
const timestamp = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$", maxLength: 24 });
const token = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._:/~-]*$", minLength: 1, maxLength: 256 });
const revision = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const exact = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
const literalUnion = <T extends readonly string[]>(values: T) => Type.Union(values.map((value) => Type.Literal(value)));

const scope = { authorityId: runtimeId("authority"), tenantId: runtimeId("tenant") } as const;

export const PolicyBindingRefsSchema = exact({
	toolAllowlistDigest: Type.Optional(digest), resourceAllowlistDigest: Type.Optional(digest),
	telemetryManifestDigest: Type.Optional(digest), retentionPolicyDigest: Type.Optional(digest),
	budgetPolicyDigest: Type.Optional(digest), executorEgressPolicyDigest: Type.Optional(digest),
	marketplacePolicyDigest: Type.Optional(digest),
});

export const ManagedPolicySnapshotRefSchema = exact({
	schemaVersion: Type.Literal(ENTERPRISE_CONTRACT_SCHEMA_VERSION), ...scope,
	policyId: runtimeId("resource"), source: literalUnion(MANAGED_POLICY_SOURCES),
	priority: Type.Integer({ minimum: 0, maximum: 1_000_000 }), revision,
	snapshotDigest: digest, bindings: PolicyBindingRefsSchema, signerReceiptId: runtimeId("receipt"),
	issuedAt: timestamp, expiresAt: Type.Optional(timestamp),
});

export const EffectivePolicySourceRefSchema = exact({
	policyId: runtimeId("resource"), source: literalUnion(MANAGED_POLICY_SOURCES),
	priority: Type.Integer({ minimum: 0, maximum: 1_000_000 }), revision, snapshotDigest: digest,
});

export const EffectivePolicyReceiptRefSchema = exact({
	schemaVersion: Type.Literal(ENTERPRISE_CONTRACT_SCHEMA_VERSION), ...scope,
	receiptId: runtimeId("receipt"), sources: Type.Array(EffectivePolicySourceRefSchema, { minItems: 1, maxItems: 64 }),
	effectivePolicyDigest: digest, decisionDigest: digest, evaluatorId: token,
	evaluatedAt: timestamp, receiptDigest: digest,
});

const principalBase = {
	schemaVersion: Type.Literal(ENTERPRISE_CONTRACT_SCHEMA_VERSION), ...scope,
	principalId: runtimeId("principal"), subjectDigest: digest, issuerId: token, issuedAt: timestamp,
} as const;

export const EnterprisePrincipalRefSchema = Type.Union([
	exact({ ...principalBase, kind: Type.Literal("user") }),
	exact({ ...principalBase, kind: Type.Literal("service"), expiresAt: Type.Optional(timestamp) }),
	exact({ ...principalBase, kind: Type.Literal("local_peer"), attestationReceiptId: runtimeId("receipt") }),
	exact({ ...principalBase, kind: Type.Literal("remote_workload"), expiresAt: timestamp, attestationReceiptId: runtimeId("receipt") }),
	exact({ ...principalBase, kind: Type.Literal("session_credential"), expiresAt: timestamp, grantReceiptId: runtimeId("receipt") }),
]);

export const SessionCredentialGrantRefSchema = exact({
	schemaVersion: Type.Literal(ENTERPRISE_CONTRACT_SCHEMA_VERSION), ...scope,
	grantId: runtimeId("receipt"), principalId: runtimeId("principal"), sessionId: runtimeId("session"),
	credentialKind: token, audienceDigest: digest, scopeDigest: digest, keyRefId: runtimeId("resource"),
	issuedAt: timestamp, expiresAt: timestamp, receiptDigest: digest,
});

export const CredentialGrantIssueRequestSchema = exact({
	schemaVersion: Type.Literal(ENTERPRISE_CONTRACT_SCHEMA_VERSION), ...scope,
	requestId: runtimeId("command"), principalId: runtimeId("principal"), sessionId: runtimeId("session"),
	credentialKind: token, audienceDigest: digest, scopeDigest: digest,
	requestedTtlMs: Type.Integer({ minimum: 1, maximum: 86_400_000 }), requestedAt: timestamp,
});

export const CredentialAudienceValidationRequestSchema = exact({
	schemaVersion: Type.Literal(ENTERPRISE_CONTRACT_SCHEMA_VERSION), ...scope,
	requestId: runtimeId("command"), principalId: runtimeId("principal"), sessionId: runtimeId("session"),
	grant: SessionCredentialGrantRefSchema,
	targetKind: Type.Union([Type.Literal("local"), Type.Literal("ci"), Type.Literal("ssh"), Type.Literal("relay")]),
	targetExecutorId: runtimeId("resource"), invocationDigest: digest, requestedAt: timestamp,
});

const credentialAudienceReceiptBase = {
	schemaVersion: Type.Literal(ENTERPRISE_CONTRACT_SCHEMA_VERSION), ...scope,
	receiptId: runtimeId("receipt"), requestId: runtimeId("command"), grantId: runtimeId("receipt"),
	targetExecutorId: runtimeId("resource"), invocationDigest: digest, audienceDigest: digest,
	validatedAt: timestamp, receiptDigest: digest,
} as const;

export const CredentialAudienceValidationReceiptRefSchema = Type.Union([
	exact({ ...credentialAudienceReceiptBase, outcome: Type.Literal("valid") }),
	exact({ ...credentialAudienceReceiptBase, outcome: Type.Literal("rejected"), reasonDigest: digest }),
	exact({ ...credentialAudienceReceiptBase, outcome: Type.Literal("unavailable"), reasonDigest: digest }),
]);

export const CredentialGrantRevocationRequestSchema = exact({
	schemaVersion: Type.Literal(ENTERPRISE_CONTRACT_SCHEMA_VERSION), ...scope,
	requestId: runtimeId("command"), principalId: runtimeId("principal"), sessionId: runtimeId("session"),
	grantId: runtimeId("receipt"), expectedReceiptDigest: digest, reasonDigest: digest, requestedAt: timestamp,
});

const credentialRevocationReceiptBase = {
	schemaVersion: Type.Literal(ENTERPRISE_CONTRACT_SCHEMA_VERSION), ...scope,
	receiptId: runtimeId("receipt"), requestId: runtimeId("command"), grantId: runtimeId("receipt"),
	expectedReceiptDigest: digest, revokedAt: timestamp, receiptDigest: digest,
} as const;

export const CredentialGrantRevocationReceiptRefSchema = Type.Union([
	exact({ ...credentialRevocationReceiptBase, outcome: Type.Literal("revoked") }),
	exact({ ...credentialRevocationReceiptBase, outcome: Type.Literal("rejected"), reasonDigest: digest }),
	exact({ ...credentialRevocationReceiptBase, outcome: Type.Literal("unavailable"), reasonDigest: digest }),
]);

export const AuthenticationRequestSchema = exact({
	schemaVersion: Type.Literal(ENTERPRISE_CONTRACT_SCHEMA_VERSION), ...scope,
	requestId: runtimeId("command"), sessionId: runtimeId("session"), traceId: runtimeId("trace"),
	requestedKind: literalUnion(ENTERPRISE_PRINCIPAL_KINDS), presentationHandle: token,
	audienceDigest: digest, requestedAt: timestamp,
});

const authenticationReceiptBase = {
	schemaVersion: Type.Literal(ENTERPRISE_CONTRACT_SCHEMA_VERSION), ...scope,
	receiptId: runtimeId("receipt"), requestId: runtimeId("command"), requestDigest: digest,
	issuedAt: timestamp, receiptDigest: digest,
} as const;

export const AuthenticationReceiptRefSchema = Type.Union([
	exact({ ...authenticationReceiptBase, outcome: Type.Literal("authenticated"), principal: EnterprisePrincipalRefSchema, expiresAt: timestamp }),
	exact({ ...authenticationReceiptBase, outcome: Type.Literal("rejected"), reasonDigest: digest }),
	exact({ ...authenticationReceiptBase, outcome: Type.Literal("unavailable"), reasonDigest: digest }),
]);

export const AuthorizationRequestSchema = exact({
	schemaVersion: Type.Literal(ENTERPRISE_CONTRACT_SCHEMA_VERSION), ...scope,
	requestId: runtimeId("command"), sessionId: runtimeId("session"), traceId: runtimeId("trace"),
	principal: EnterprisePrincipalRefSchema, action: literalUnion(AUTHORIZATION_ACTIONS),
	resourceKind: token, resourceDigest: digest,
	risk: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("critical")]),
	effectivePolicy: EffectivePolicyReceiptRefSchema, approvalReceiptId: Type.Optional(runtimeId("receipt")),
	separationOfDutyPrincipalIds: Type.Array(runtimeId("principal"), { maxItems: 64, uniqueItems: true }),
	requestedAt: timestamp,
});

const authorizationReceiptBase = {
	schemaVersion: Type.Literal(ENTERPRISE_CONTRACT_SCHEMA_VERSION), ...scope,
	receiptId: runtimeId("receipt"), requestId: runtimeId("command"), requestDigest: digest,
	effectivePolicyReceiptId: runtimeId("receipt"), effectivePolicyDigest: digest,
	separationOfDutyDigest: digest, decidedAt: timestamp, receiptDigest: digest,
} as const;

export const AuthorizationDecisionReceiptRefSchema = Type.Union([
	exact({ ...authorizationReceiptBase, decision: Type.Literal("allow"), obligationsDigest: digest, approvalReceiptId: Type.Optional(runtimeId("receipt")) }),
	exact({ ...authorizationReceiptBase, decision: Type.Literal("ask"), requiredApprovalDigest: digest }),
	exact({ ...authorizationReceiptBase, decision: Type.Literal("deny"), reasonDigest: digest }),
	exact({ ...authorizationReceiptBase, decision: Type.Literal("unavailable"), reasonDigest: digest }),
]);

export const ManagedKeyRefSchema = exact({
	schemaVersion: Type.Literal(ENTERPRISE_CONTRACT_SCHEMA_VERSION), ...scope,
	keyRefId: runtimeId("resource"), provider: literalUnion(MANAGED_KEY_PROVIDERS),
	purpose: Type.Union([Type.Literal("session_metadata"), Type.Literal("artifact_metadata"), Type.Literal("credential_grant"), Type.Literal("attestation")]),
	version: token, state: Type.Union([Type.Literal("available"), Type.Literal("rotating"), Type.Literal("revoked"), Type.Literal("lost"), Type.Literal("unavailable")]),
	providerReceiptId: runtimeId("receipt"), refDigest: digest,
});

export const KeyLifecycleReceiptRefSchema = exact({
	schemaVersion: Type.Literal(ENTERPRISE_CONTRACT_SCHEMA_VERSION), ...scope,
	receiptId: runtimeId("receipt"), keyRefId: runtimeId("resource"),
	operation: Type.Union([Type.Literal("bootstrap"), Type.Literal("rotate"), Type.Literal("revoke"), Type.Literal("crypto_erase"), Type.Literal("resolve")]),
	outcome: Type.Union([Type.Literal("completed"), Type.Literal("rejected"), Type.Literal("unavailable")]),
	previousVersion: Type.Optional(token), currentVersion: Type.Optional(token),
	requestedAt: timestamp, completedAt: timestamp, receiptDigest: digest,
});

function validWindow(issuedAt: string, expiresAt?: string): boolean {
	return Number.isFinite(Date.parse(issuedAt)) && (expiresAt === undefined || Date.parse(expiresAt) > Date.parse(issuedAt));
}

function validScope(value: { authorityId: unknown; tenantId: unknown }): boolean {
	return isRuntimeId(value.authorityId, "authority") && isRuntimeId(value.tenantId, "tenant");
}

export function isManagedPolicySnapshotRef(value: unknown): value is ManagedPolicySnapshotRef {
	return Check(ManagedPolicySnapshotRefSchema, value) && validScope(value) &&
		isRuntimeId(value.policyId, "resource") && isRuntimeId(value.signerReceiptId, "receipt") &&
		validWindow(value.issuedAt, value.expiresAt);
}

export function isEffectivePolicyReceiptRef(value: unknown): value is EffectivePolicyReceiptRef {
	if (!Check(EffectivePolicyReceiptRefSchema, value)) return false;
	if (!validScope(value) || !isRuntimeId(value.receiptId, "receipt") ||
		!value.sources.every((source) => isRuntimeId(source.policyId, "resource"))) return false;
	const seen = new Set<string>();
	let previousPriority = Number.MAX_SAFE_INTEGER;
	for (const source of value.sources) {
		const key = `${source.policyId}/${source.snapshotDigest}`;
		if (seen.has(key) || source.priority > previousPriority) return false;
		seen.add(key);
		previousPriority = source.priority;
	}
	return true;
}

export function isEnterprisePrincipalRef(value: unknown): value is EnterprisePrincipalRef {
	return Check(EnterprisePrincipalRefSchema, value) && validScope(value) &&
		isRuntimeId(value.principalId, "principal") &&
		(!("attestationReceiptId" in value) || isRuntimeId(value.attestationReceiptId, "receipt")) &&
		(!("grantReceiptId" in value) || isRuntimeId(value.grantReceiptId, "receipt")) &&
		validWindow(value.issuedAt, "expiresAt" in value ? value.expiresAt : undefined);
}

export function isSessionCredentialGrantRef(value: unknown): value is SessionCredentialGrantRef {
	return Check(SessionCredentialGrantRefSchema, value) && validScope(value) &&
		isRuntimeId(value.grantId, "receipt") && isRuntimeId(value.principalId, "principal") &&
		isRuntimeId(value.sessionId, "session") && isRuntimeId(value.keyRefId, "resource") &&
		validWindow(value.issuedAt, value.expiresAt);
}

export function isCredentialGrantIssueRequest(value: unknown): value is CredentialGrantIssueRequest {
	return Check(CredentialGrantIssueRequestSchema, value) && validScope(value) &&
		isRuntimeId(value.requestId, "command") && isRuntimeId(value.principalId, "principal") &&
		isRuntimeId(value.sessionId, "session") && Number.isFinite(Date.parse(value.requestedAt));
}

export function isCredentialAudienceValidationRequest(
	value: unknown,
): value is CredentialAudienceValidationRequest {
	return Check(CredentialAudienceValidationRequestSchema, value) && validScope(value) &&
		isRuntimeId(value.requestId, "command") && isRuntimeId(value.principalId, "principal") &&
		isRuntimeId(value.sessionId, "session") && isRuntimeId(value.targetExecutorId, "resource") &&
		isSessionCredentialGrantRef(value.grant) && value.grant.authorityId === value.authorityId &&
		value.grant.tenantId === value.tenantId && value.grant.principalId === value.principalId &&
		value.grant.sessionId === value.sessionId && Date.parse(value.grant.issuedAt) <= Date.parse(value.requestedAt) &&
		Date.parse(value.grant.expiresAt) > Date.parse(value.requestedAt);
}

export function isCredentialAudienceValidationReceiptRef(
	value: unknown,
): value is CredentialAudienceValidationReceiptRef {
	if (!Check(CredentialAudienceValidationReceiptRefSchema, value)) return false;
	const { receiptDigest, ...body } = value;
	return validScope(value) &&
		isRuntimeId(value.receiptId, "receipt") && isRuntimeId(value.requestId, "command") &&
		isRuntimeId(value.grantId, "receipt") && isRuntimeId(value.targetExecutorId, "resource") &&
		receiptDigest === canonicalDigest(body);
}

export function credentialAudienceValidationRequestDigest(request: CredentialAudienceValidationRequest): string {
	return canonicalDigest(request);
}

export function credentialAudienceReceiptMatchesRequest(
	receipt: CredentialAudienceValidationReceiptRef,
	request: CredentialAudienceValidationRequest,
): boolean {
	return isCredentialAudienceValidationRequest(request) && isCredentialAudienceValidationReceiptRef(receipt) &&
		receipt.authorityId === request.authorityId && receipt.tenantId === request.tenantId &&
		receipt.requestId === request.requestId && receipt.grantId === request.grant.grantId &&
		receipt.targetExecutorId === request.targetExecutorId && receipt.invocationDigest === request.invocationDigest &&
		receipt.audienceDigest === request.grant.audienceDigest;
}

export function isCredentialGrantRevocationRequest(value: unknown): value is CredentialGrantRevocationRequest {
	return Check(CredentialGrantRevocationRequestSchema, value) && validScope(value) &&
		isRuntimeId(value.requestId, "command") && isRuntimeId(value.principalId, "principal") &&
		isRuntimeId(value.sessionId, "session") && isRuntimeId(value.grantId, "receipt");
}

export function isCredentialGrantRevocationReceiptRef(
	value: unknown,
): value is CredentialGrantRevocationReceiptRef {
	if (!Check(CredentialGrantRevocationReceiptRefSchema, value)) return false;
	const { receiptDigest, ...body } = value;
	return validScope(value) &&
		isRuntimeId(value.receiptId, "receipt") && isRuntimeId(value.requestId, "command") &&
		isRuntimeId(value.grantId, "receipt") && receiptDigest === canonicalDigest(body);
}

export function isAuthenticationRequest(value: unknown): value is AuthenticationRequest {
	return Check(AuthenticationRequestSchema, value) && validScope(value) &&
		isRuntimeId(value.requestId, "command") && isRuntimeId(value.sessionId, "session") &&
		isRuntimeId(value.traceId, "trace");
}

export function isAuthenticationReceiptRef(value: unknown): value is AuthenticationReceiptRef {
	if (!Check(AuthenticationReceiptRefSchema, value)) return false;
	if (!validScope(value) || !isRuntimeId(value.receiptId, "receipt") || !isRuntimeId(value.requestId, "command")) return false;
	return value.outcome !== "authenticated" || (
		isEnterprisePrincipalRef(value.principal) &&
		value.principal.authorityId === value.authorityId && value.principal.tenantId === value.tenantId &&
		Date.parse(value.expiresAt) > Date.parse(value.issuedAt)
	);
}

export function isAuthorizationRequest(value: unknown): value is AuthorizationRequest {
	if (!Check(AuthorizationRequestSchema, value)) return false;
	if (!validScope(value) || !isRuntimeId(value.requestId, "command") || !isRuntimeId(value.sessionId, "session") ||
		!isRuntimeId(value.traceId, "trace") || !isEnterprisePrincipalRef(value.principal) ||
		!isEffectivePolicyReceiptRef(value.effectivePolicy)) return false;
	return value.separationOfDutyPrincipalIds.every((id) => isRuntimeId(id, "principal")) &&
		value.principal.authorityId === value.authorityId && value.principal.tenantId === value.tenantId &&
		value.effectivePolicy.authorityId === value.authorityId && value.effectivePolicy.tenantId === value.tenantId &&
		!value.separationOfDutyPrincipalIds.includes(value.principal.principalId);
}

export function isAuthorizationDecisionReceiptRef(value: unknown): value is AuthorizationDecisionReceiptRef {
	return Check(AuthorizationDecisionReceiptRefSchema, value) && validScope(value) &&
		isRuntimeId(value.receiptId, "receipt") && isRuntimeId(value.requestId, "command") &&
		(!("approvalReceiptId" in value) || isRuntimeId(value.approvalReceiptId, "receipt"));
}

export function authorizationRequestDigest(request: AuthorizationRequest): string {
	return canonicalDigest(request);
}

export function authorizationReceiptMatchesRequest(receipt: AuthorizationDecisionReceiptRef, request: AuthorizationRequest): boolean {
	return isAuthorizationRequest(request) && isAuthorizationDecisionReceiptRef(receipt) &&
		receipt.authorityId === request.authorityId && receipt.tenantId === request.tenantId &&
		receipt.requestId === request.requestId && receipt.requestDigest === authorizationRequestDigest(request) &&
		receipt.effectivePolicyReceiptId === request.effectivePolicy.receiptId &&
		receipt.effectivePolicyDigest === request.effectivePolicy.effectivePolicyDigest;
}

export function isManagedKeyRef(value: unknown): value is ManagedKeyRef {
	return Check(ManagedKeyRefSchema, value) && validScope(value) &&
		isRuntimeId(value.keyRefId, "resource") && isRuntimeId(value.providerReceiptId, "receipt");
}

export function isKeyLifecycleReceiptRef(value: unknown): value is KeyLifecycleReceiptRef {
	if (!Check(KeyLifecycleReceiptRefSchema, value)) return false;
	return validScope(value) && isRuntimeId(value.receiptId, "receipt") && isRuntimeId(value.keyRefId, "resource") &&
		Date.parse(value.completedAt) >= Date.parse(value.requestedAt) &&
		(value.outcome !== "completed" || value.currentVersion !== undefined || value.operation === "revoke" || value.operation === "crypto_erase");
}
