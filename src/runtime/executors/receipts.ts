/** Remote executor exact schemas、digest 和跨合同关联校验。 */

import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import { ArtifactRefSchema } from "../protocol/v3/capability.ts";
import { sameRuntimeEventStream } from "../protocol/v3/events.ts";
import { EventCursorSchema } from "../protocol/v3/event-references.ts";
import { isRuntimeId } from "../protocol/v3/ids.ts";
import {
	WorkspaceExecutionEnvelopeSchema,
	WorkspaceLeaseRefSchema,
	WorkspaceValidationReceiptRefSchema,
	isWorkspaceExecutionEnvelope,
	isWorkspaceLeaseRef,
	isWorkspaceValidationReceiptRef,
	workspaceExecutionEnvelopeDigest,
} from "../protocol/v3/workspace.ts";
import {
	EffectivePolicyReceiptRefSchema,
	EnterprisePrincipalRefSchema,
	SessionCredentialGrantRefSchema,
	isEffectivePolicyReceiptRef,
	isEnterprisePrincipalRef,
	isSessionCredentialGrantRef,
} from "../identity/enterprise-schemas.ts";
import {
	REMOTE_EXECUTOR_KINDS,
	REMOTE_EXECUTOR_SCHEMA_VERSION,
	type RemoteAttestationVerificationReceipt,
	type RemoteExecutorAttestationRef,
	type RemoteExecutorInvocation,
	type RemoteExecutorInvocationBody,
	type RemoteExecutorResultReceipt,
	type RemoteExecutorResultReceiptBody,
	type SessionHandoffManifest,
	type SessionHandoffManifestBody,
	type SessionHandoffReceipt,
} from "./types.ts";

const runtimeId = (kind: string) => Type.String({ pattern: `^${kind}_[A-Za-z0-9][A-Za-z0-9._~-]*$`, maxLength: 128 });
const digest = Type.String({ pattern: "^[a-f0-9]{64}$", maxLength: 64 });
const timestamp = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$", maxLength: 24 });
const token = Type.String({ minLength: 1, maxLength: 512 });
const revision = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const exact = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
const ExecutorKindSchema = Type.Union(REMOTE_EXECUTOR_KINDS.map((kind) => Type.Literal(kind)));

export const RemoteVerificationGateRefSchema = exact({
	verificationId: runtimeId("verification"), gateDigest: digest, baselineReceiptDigest: digest,
	candidateCommit: token, verifierReceiptId: runtimeId("receipt"), verifierReceiptDigest: digest,
});

const InvocationBodySchema = exact({
	schemaVersion: Type.Literal(REMOTE_EXECUTOR_SCHEMA_VERSION), authorityId: runtimeId("authority"), tenantId: runtimeId("tenant"),
	requestId: runtimeId("command"), idempotencyKey: runtimeId("command"), executorKind: ExecutorKindSchema,
	executorId: runtimeId("resource"), principal: EnterprisePrincipalRefSchema, sessionId: runtimeId("session"), traceId: runtimeId("trace"),
	workspaceEnvelope: WorkspaceExecutionEnvelopeSchema, workspaceLease: WorkspaceLeaseRefSchema,
	workspaceValidation: WorkspaceValidationReceiptRefSchema, gate: RemoteVerificationGateRefSchema,
	inputArtifacts: Type.Array(ArtifactRefSchema, { maxItems: 10_000 }), eventHead: EventCursorSchema,
	effectivePolicy: EffectivePolicyReceiptRefSchema, credentialGrant: Type.Optional(SessionCredentialGrantRefSchema),
	egressPolicyDigest: digest, attestationChallengeDigest: digest, requestedAt: timestamp,
});

export const RemoteExecutorInvocationSchema = exact({ ...InvocationBodySchema.properties, invocationDigest: digest });

export const RemoteExecutorAttestationRefSchema = exact({
	schemaVersion: Type.Literal(REMOTE_EXECUTOR_SCHEMA_VERSION), authorityId: runtimeId("authority"), tenantId: runtimeId("tenant"),
	receiptId: runtimeId("receipt"), executorId: runtimeId("resource"), executorKind: ExecutorKindSchema,
	challengeDigest: digest, workloadIdentityDigest: digest, runnerImageDigest: digest,
	sandboxEnforcementDigest: digest, egressEnforcementDigest: digest, keyReceiptId: runtimeId("receipt"),
	issuedAt: timestamp, expiresAt: timestamp, receiptDigest: digest,
});

const ResultReceiptBodySchema = exact({
	schemaVersion: Type.Literal(REMOTE_EXECUTOR_SCHEMA_VERSION), authorityId: runtimeId("authority"), tenantId: runtimeId("tenant"),
	receiptId: runtimeId("receipt"), requestId: runtimeId("command"), executorId: runtimeId("resource"), executorKind: ExecutorKindSchema,
	invocationDigest: digest, attestation: RemoteExecutorAttestationRefSchema,
	status: Type.Union([Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("cancelled"), Type.Literal("uncertain")]),
	workspaceId: runtimeId("workspace"), leaseId: runtimeId("lease"), leaseRevision: revision, gateDigest: digest,
	outputArtifacts: Type.Array(ArtifactRefSchema, { maxItems: 10_000 }), eventHead: EventCursorSchema,
	startedAt: timestamp, finishedAt: timestamp, exitCode: Type.Optional(Type.Integer({ minimum: -255, maximum: 255 })),
	reasonDigest: Type.Optional(digest),
});

export const RemoteExecutorResultReceiptSchema = exact({ ...ResultReceiptBodySchema.properties, receiptDigest: digest });

export const RemoteAttestationVerificationReceiptSchema = Type.Union([
	exact({ schemaVersion: Type.Literal(REMOTE_EXECUTOR_SCHEMA_VERSION), authorityId: runtimeId("authority"), tenantId: runtimeId("tenant"), receiptId: runtimeId("receipt"), attestationReceiptId: runtimeId("receipt"), invocationDigest: digest, status: Type.Literal("verified"), verifiedAt: timestamp, receiptDigest: digest }),
	exact({ schemaVersion: Type.Literal(REMOTE_EXECUTOR_SCHEMA_VERSION), authorityId: runtimeId("authority"), tenantId: runtimeId("tenant"), receiptId: runtimeId("receipt"), attestationReceiptId: runtimeId("receipt"), invocationDigest: digest, status: Type.Literal("rejected"), verifiedAt: timestamp, reasonDigest: digest, receiptDigest: digest }),
	exact({ schemaVersion: Type.Literal(REMOTE_EXECUTOR_SCHEMA_VERSION), authorityId: runtimeId("authority"), tenantId: runtimeId("tenant"), receiptId: runtimeId("receipt"), attestationReceiptId: runtimeId("receipt"), invocationDigest: digest, status: Type.Literal("unavailable"), verifiedAt: timestamp, reasonDigest: digest, receiptDigest: digest }),
]);

const HandoffBodySchema = exact({
	schemaVersion: Type.Literal(REMOTE_EXECUTOR_SCHEMA_VERSION), authorityId: runtimeId("authority"), tenantId: runtimeId("tenant"),
	sessionId: runtimeId("session"), sourceRuntimeId: runtimeId("runtime"), targetExecutorId: runtimeId("resource"),
	eventHead: EventCursorSchema, artifactRefs: Type.Array(ArtifactRefSchema, { maxItems: 10_000 }),
	leaseTransfer: exact({ leaseId: runtimeId("lease"), workspaceId: runtimeId("workspace"), expectedRevision: revision, transferReceiptId: runtimeId("receipt"), transferReceiptDigest: digest }),
	effectivePolicyReceiptId: runtimeId("receipt"), issuedAt: timestamp, expiresAt: timestamp,
});

export const SessionHandoffManifestSchema = exact({
	...HandoffBodySchema.properties, manifestDigest: digest, signatureReceiptId: runtimeId("receipt"), signatureDigest: digest,
});

const handoffReceiptBase = {
	schemaVersion: Type.Literal(REMOTE_EXECUTOR_SCHEMA_VERSION), authorityId: runtimeId("authority"), tenantId: runtimeId("tenant"),
	receiptId: runtimeId("receipt"), sessionId: runtimeId("session"), targetExecutorId: runtimeId("resource"),
	manifestDigest: digest, decidedAt: timestamp, receiptDigest: digest,
} as const;

export const SessionHandoffReceiptSchema = Type.Union([
	exact({ ...handoffReceiptBase, status: Type.Literal("accepted") }),
	exact({ ...handoffReceiptBase, status: Type.Literal("rejected"), reasonDigest: digest }),
	exact({ ...handoffReceiptBase, status: Type.Literal("unavailable"), reasonDigest: digest }),
]);

function withoutInvocationDigest<T extends { invocationDigest: string }>(value: T): Omit<T, "invocationDigest"> {
	const { invocationDigest: _invocationDigest, ...body } = value;
	return body;
}

function withoutResultDigest<T extends { receiptDigest: string }>(value: T): Omit<T, "receiptDigest"> {
	const { receiptDigest: _receiptDigest, ...body } = value;
	return body;
}

function handoffBody<T extends { manifestDigest: string; signatureReceiptId: string; signatureDigest: string }>(
	value: T,
): Omit<T, "manifestDigest" | "signatureReceiptId" | "signatureDigest"> {
	const { manifestDigest: _manifestDigest, signatureReceiptId: _signatureReceiptId, signatureDigest: _signatureDigest, ...body } = value;
	return body;
}

function artifactsMatchScope(
	artifacts: readonly { authorityId: string; tenantId: string; workspaceId?: string }[],
	authorityId: string,
	tenantId: string,
	workspaceId?: string,
): boolean {
	return artifacts.every((artifact) => artifact.authorityId === authorityId && artifact.tenantId === tenantId &&
		(workspaceId === undefined || artifact.workspaceId === undefined || artifact.workspaceId === workspaceId));
}

export function remoteExecutorInvocationDigest(body: RemoteExecutorInvocationBody): string {
	return canonicalDigest(body);
}

export function remoteExecutorResultReceiptDigest(body: RemoteExecutorResultReceiptBody): string {
	return canonicalDigest(body);
}

export function sessionHandoffManifestDigest(body: SessionHandoffManifestBody): string {
	return canonicalDigest(body);
}

export function isRemoteExecutorInvocation(value: unknown): value is RemoteExecutorInvocation {
	if (!Check(RemoteExecutorInvocationSchema, value)) return false;
	if (
		!isRuntimeId(value.authorityId, "authority") || !isRuntimeId(value.tenantId, "tenant") ||
		!isRuntimeId(value.requestId, "command") || !isRuntimeId(value.idempotencyKey, "command") ||
		!isRuntimeId(value.executorId, "resource") || !isRuntimeId(value.sessionId, "session") ||
		!isRuntimeId(value.traceId, "trace") || !isWorkspaceExecutionEnvelope(value.workspaceEnvelope) ||
		!isWorkspaceLeaseRef(value.workspaceLease) || !isWorkspaceValidationReceiptRef(value.workspaceValidation)
	) return false;
	return isEnterprisePrincipalRef(value.principal) && isEffectivePolicyReceiptRef(value.effectivePolicy) &&
		value.invocationDigest === canonicalDigest(withoutInvocationDigest(value)) &&
		value.principal.authorityId === value.authorityId && value.principal.tenantId === value.tenantId &&
		value.workspaceEnvelope.authorityId === value.authorityId && value.workspaceEnvelope.tenantId === value.tenantId &&
		value.workspaceEnvelope.principalId === value.principal.principalId && value.workspaceEnvelope.sessionId === value.sessionId &&
		value.workspaceLease.authorityId === value.authorityId && value.workspaceLease.tenantId === value.tenantId &&
		value.workspaceLease.workspaceId === value.workspaceEnvelope.workspaceId && value.workspaceLease.leaseRevision === value.workspaceEnvelope.leaseRevision &&
		value.workspaceValidation.authorityId === value.authorityId && value.workspaceValidation.tenantId === value.tenantId &&
		value.workspaceValidation.workspaceId === value.workspaceEnvelope.workspaceId && value.workspaceValidation.envelopeDigest === workspaceExecutionEnvelopeDigest(value.workspaceEnvelope) &&
		value.eventHead.stream.scope === "session" && value.eventHead.stream.sessionId === value.sessionId &&
		value.effectivePolicy.authorityId === value.authorityId && value.effectivePolicy.tenantId === value.tenantId &&
		value.workspaceLease.state === "active" && value.workspaceValidation.outcome === "valid" &&
		artifactsMatchScope(value.inputArtifacts, value.authorityId, value.tenantId, value.workspaceEnvelope.workspaceId) &&
		(value.principal.expiresAt === undefined || Date.parse(value.principal.expiresAt) > Date.parse(value.requestedAt)) &&
		(value.credentialGrant === undefined || (isSessionCredentialGrantRef(value.credentialGrant) && value.credentialGrant.authorityId === value.authorityId && value.credentialGrant.tenantId === value.tenantId && value.credentialGrant.principalId === value.principal.principalId && value.credentialGrant.sessionId === value.sessionId && Date.parse(value.credentialGrant.issuedAt) <= Date.parse(value.requestedAt) && Date.parse(value.credentialGrant.expiresAt) > Date.parse(value.requestedAt)));
}

export function isRemoteExecutorAttestationRef(value: unknown): value is RemoteExecutorAttestationRef {
	return Check(RemoteExecutorAttestationRefSchema, value) &&
		isRuntimeId(value.authorityId, "authority") && isRuntimeId(value.tenantId, "tenant") &&
		isRuntimeId(value.receiptId, "receipt") && isRuntimeId(value.executorId, "resource") &&
		isRuntimeId(value.keyReceiptId, "receipt") && Date.parse(value.expiresAt) > Date.parse(value.issuedAt);
}

export function isRemoteExecutorResultReceipt(value: unknown): value is RemoteExecutorResultReceipt {
	if (!Check(RemoteExecutorResultReceiptSchema, value)) return false;
	if (
		!isRuntimeId(value.authorityId, "authority") || !isRuntimeId(value.tenantId, "tenant") ||
		!isRuntimeId(value.receiptId, "receipt") || !isRuntimeId(value.requestId, "command") ||
		!isRuntimeId(value.executorId, "resource") || !isRuntimeId(value.workspaceId, "workspace") ||
		!isRuntimeId(value.leaseId, "lease") || value.eventHead.stream.scope !== "session" ||
		!isRuntimeId(value.eventHead.stream.sessionId, "session") ||
		!isRuntimeId(value.eventHead.eventId, "event")
	) return false;
	return isRemoteExecutorAttestationRef(value.attestation) && value.receiptDigest === canonicalDigest(withoutResultDigest(value)) &&
		value.attestation.authorityId === value.authorityId && value.attestation.tenantId === value.tenantId &&
		value.attestation.executorId === value.executorId && value.attestation.executorKind === value.executorKind &&
		artifactsMatchScope(value.outputArtifacts, value.authorityId, value.tenantId, value.workspaceId) &&
		value.eventHead.stream.sessionId.length > 0 && Date.parse(value.finishedAt) >= Date.parse(value.startedAt) &&
		(value.status === "succeeded" ? value.reasonDigest === undefined : value.reasonDigest !== undefined);
}

export function remoteExecutorResultMatchesInvocation(result: RemoteExecutorResultReceipt, invocation: RemoteExecutorInvocation): boolean {
	return isRemoteExecutorInvocation(invocation) && isRemoteExecutorResultReceipt(result) &&
		result.authorityId === invocation.authorityId && result.tenantId === invocation.tenantId &&
		result.requestId === invocation.requestId && result.executorId === invocation.executorId && result.executorKind === invocation.executorKind &&
		result.invocationDigest === invocation.invocationDigest && result.workspaceId === invocation.workspaceEnvelope.workspaceId &&
		result.leaseId === invocation.workspaceLease.leaseId && result.leaseRevision === invocation.workspaceLease.leaseRevision &&
		result.gateDigest === invocation.gate.gateDigest &&
		result.eventHead.stream.scope === "session" && result.eventHead.stream.sessionId === invocation.sessionId &&
		sameRuntimeEventStream(result.eventHead.stream, invocation.eventHead.stream) &&
		result.eventHead.sequence >= invocation.eventHead.sequence &&
		result.attestation.challengeDigest === invocation.attestationChallengeDigest;
}

export function isRemoteAttestationVerificationReceipt(value: unknown): value is RemoteAttestationVerificationReceipt {
	return Check(RemoteAttestationVerificationReceiptSchema, value) &&
		isRuntimeId(value.authorityId, "authority") && isRuntimeId(value.tenantId, "tenant") &&
		isRuntimeId(value.receiptId, "receipt") && isRuntimeId(value.attestationReceiptId, "receipt");
}

export function attestationVerificationMatches(
	verification: RemoteAttestationVerificationReceipt,
	result: RemoteExecutorResultReceipt,
): boolean {
	return isRemoteAttestationVerificationReceipt(verification) && isRemoteExecutorResultReceipt(result) &&
		verification.authorityId === result.authorityId && verification.tenantId === result.tenantId &&
		verification.attestationReceiptId === result.attestation.receiptId && verification.invocationDigest === result.invocationDigest;
}

export function isSessionHandoffManifest(value: unknown): value is SessionHandoffManifest {
	if (!Check(SessionHandoffManifestSchema, value)) return false;
	if (
		!isRuntimeId(value.authorityId, "authority") || !isRuntimeId(value.tenantId, "tenant") ||
		!isRuntimeId(value.sessionId, "session") || !isRuntimeId(value.sourceRuntimeId, "runtime") ||
		!isRuntimeId(value.targetExecutorId, "resource") || !isRuntimeId(value.signatureReceiptId, "receipt") ||
		value.eventHead.stream.scope !== "session" ||
		!isRuntimeId(value.eventHead.stream.sessionId, "session") || !isRuntimeId(value.eventHead.eventId, "event")
	) return false;
	return value.manifestDigest === canonicalDigest(handoffBody(value)) &&
		value.eventHead.stream.sessionId === value.sessionId && artifactsMatchScope(value.artifactRefs, value.authorityId, value.tenantId, value.leaseTransfer.workspaceId) &&
		Date.parse(value.expiresAt) > Date.parse(value.issuedAt) &&
		!("credential" in value) && !("credentialGrant" in value);
}

export function isSessionHandoffReceipt(value: unknown): value is SessionHandoffReceipt {
	return Check(SessionHandoffReceiptSchema, value) &&
		isRuntimeId(value.authorityId, "authority") && isRuntimeId(value.tenantId, "tenant") &&
		isRuntimeId(value.receiptId, "receipt") && isRuntimeId(value.sessionId, "session") &&
		isRuntimeId(value.targetExecutorId, "resource");
}

export function handoffReceiptMatchesManifest(receipt: SessionHandoffReceipt, manifest: SessionHandoffManifest): boolean {
	return isSessionHandoffReceipt(receipt) && isSessionHandoffManifest(manifest) &&
		receipt.authorityId === manifest.authorityId && receipt.tenantId === manifest.tenantId &&
		receipt.sessionId === manifest.sessionId && receipt.targetExecutorId === manifest.targetExecutorId &&
		receipt.manifestDigest === manifest.manifestDigest;
}
