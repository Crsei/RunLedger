import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createSessionEventStreamRef } from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { workspaceExecutionEnvelopeDigest } from "../../../src/runtime/protocol/v3/workspace.ts";
import { ENTERPRISE_CONTRACT_SCHEMA_VERSION, type EffectivePolicyReceiptRef, type EnterprisePrincipalRef, type SessionCredentialGrantRef } from "../../../src/runtime/identity/enterprise-types.ts";
import { REMOTE_EXECUTOR_SCHEMA_VERSION, type RemoteAttestationVerificationReceipt, type RemoteExecutorInvocation, type RemoteExecutorInvocationBody, type RemoteExecutorResultReceipt, type RemoteExecutorResultReceiptBody, type SessionHandoffManifest, type SessionHandoffManifestBody, type SessionHandoffReceipt } from "../../../src/runtime/executors/types.ts";
import { remoteExecutorInvocationDigest, remoteExecutorResultReceiptDigest, sessionHandoffManifestDigest } from "../../../src/runtime/executors/receipts.ts";

export const D1 = "a".repeat(64);
export const D2 = "b".repeat(64);
export const authorityId = createRuntimeId("authority", "remote-executor");
export const tenantId = createRuntimeId("tenant", "remote-executor");
export const principalId = createRuntimeId("principal", "remote-executor");
export const sessionId = createRuntimeId("session", "remote-executor");
export const workspaceId = createRuntimeId("workspace", "remote-executor");
export const leaseId = createRuntimeId("lease", "remote-executor");
export const executorId = createRuntimeId("resource", "remote-executor");
export const eventStream = createSessionEventStreamRef({ authorityId, tenantId }, sessionId);

export function principal(): EnterprisePrincipalRef {
	return {
		schemaVersion: ENTERPRISE_CONTRACT_SCHEMA_VERSION, authorityId, tenantId, principalId,
		kind: "remote_workload", subjectDigest: D1, issuerId: "managed-identity",
		issuedAt: "2026-07-22T00:00:00.000Z", expiresAt: "2026-07-22T01:00:00.000Z",
		attestationReceiptId: createRuntimeId("receipt", "principal-attestation"),
	};
}

export function effectivePolicy(): EffectivePolicyReceiptRef {
	return {
		schemaVersion: ENTERPRISE_CONTRACT_SCHEMA_VERSION, authorityId, tenantId,
		receiptId: createRuntimeId("receipt", "remote-effective-policy"),
		sources: [{ policyId: createRuntimeId("resource", "remote-policy"), source: "organization", priority: 100, revision: 1, snapshotDigest: D1 }],
		effectivePolicyDigest: D1, decisionDigest: D2, evaluatorId: "external-policy", evaluatedAt: "2026-07-22T00:00:00.000Z", receiptDigest: D2,
	};
}

export function credentialGrant(): SessionCredentialGrantRef {
	return {
		schemaVersion: ENTERPRISE_CONTRACT_SCHEMA_VERSION, authorityId, tenantId,
		grantId: createRuntimeId("receipt", "remote-credential-grant"), principalId, sessionId,
		credentialKind: "ci-oidc", audienceDigest: D1, scopeDigest: D2, keyRefId: createRuntimeId("resource", "remote-grant-key"),
		issuedAt: "2026-07-22T00:00:00.000Z", expiresAt: "2026-07-22T00:10:00.000Z", receiptDigest: D1,
	};
}

export function invocation(): RemoteExecutorInvocation {
	const workspaceEnvelope = {
		authorityId, tenantId, principalId, sessionId, workspaceId,
		repositoryId: createRuntimeId("repository", "remote-executor"), worktreePath: "/workspace/remote",
		branch: "runtime/remote", baseCommit: "1".repeat(40), agentId: createRuntimeId("agent", "remote-executor"),
		toolCallId: createRuntimeId("toolCall", "remote-executor"), traceId: createRuntimeId("trace", "remote-executor"),
		cwd: "/workspace/remote", ownerRuntimeId: createRuntimeId("runtime", "remote-executor"),
		leaseRevision: 3, fencingToken: "opaque-fencing-token",
	};
	const body: RemoteExecutorInvocationBody = {
		schemaVersion: REMOTE_EXECUTOR_SCHEMA_VERSION, authorityId, tenantId,
		requestId: createRuntimeId("command", "remote-executor"), idempotencyKey: createRuntimeId("command", "remote-executor-idempotency"),
		executorKind: "ci", executorId, principal: principal(), sessionId, traceId: workspaceEnvelope.traceId,
		workspaceEnvelope,
		workspaceLease: { authorityId, tenantId, principalId, leaseId, workspaceId, ownerRuntimeId: workspaceEnvelope.ownerRuntimeId, leaseRevision: 3, fencingTokenDigest: D1, state: "active" },
		workspaceValidation: { authorityId, tenantId, principalId, receiptId: createRuntimeId("receipt", "workspace-validation"), workspaceId, envelopeDigest: workspaceExecutionEnvelopeDigest(workspaceEnvelope), validatorId: createRuntimeId("principal", "workspace-validator"), validatedAt: "2026-07-22T00:00:00.000Z", outcome: "valid" },
		gate: { verificationId: createRuntimeId("verification", "remote-gate"), gateDigest: D1, baselineReceiptDigest: D2, candidateCommit: "2".repeat(40), verifierReceiptId: createRuntimeId("receipt", "remote-verifier"), verifierReceiptDigest: D1 },
		inputArtifacts: [{ authorityId, tenantId, artifactId: createRuntimeId("artifact", "remote-input"), storedDigest: D1, kind: "diff", originalSize: 10, storedSize: 10, mediaType: "text/x-diff", redaction: "redacted", transformReceipt: createRuntimeId("receipt", "remote-input-transform"), workspaceId }],
		eventHead: { stream: eventStream, sequence: 4, eventId: createRuntimeId("event", "remote-head"), eventHash: D1 },
		effectivePolicy: effectivePolicy(), credentialGrant: credentialGrant(), egressPolicyDigest: D2,
		attestationChallengeDigest: D1, requestedAt: "2026-07-22T00:00:00.000Z",
	};
	return { ...body, invocationDigest: remoteExecutorInvocationDigest(body) };
}

export function result(request = invocation()): RemoteExecutorResultReceipt {
	const attestation = {
		schemaVersion: REMOTE_EXECUTOR_SCHEMA_VERSION, authorityId, tenantId,
		receiptId: createRuntimeId("receipt", "remote-attestation"), executorId, executorKind: request.executorKind,
		challengeDigest: request.attestationChallengeDigest, workloadIdentityDigest: D1, runnerImageDigest: D2,
		sandboxEnforcementDigest: D1, egressEnforcementDigest: D2, keyReceiptId: createRuntimeId("receipt", "remote-attestation-key"),
		issuedAt: "2026-07-22T00:00:01.000Z", expiresAt: "2026-07-22T00:10:00.000Z", receiptDigest: D1,
	} as const;
	const body: RemoteExecutorResultReceiptBody = {
		schemaVersion: REMOTE_EXECUTOR_SCHEMA_VERSION, authorityId, tenantId,
		receiptId: createRuntimeId("receipt", "remote-result"), requestId: request.requestId, executorId, executorKind: request.executorKind,
		invocationDigest: request.invocationDigest, attestation, status: "succeeded", workspaceId, leaseId, leaseRevision: 3,
		gateDigest: request.gate.gateDigest,
		outputArtifacts: [{ authorityId, tenantId, artifactId: createRuntimeId("artifact", "remote-output"), storedDigest: D2, kind: "test_report", originalSize: 10, storedSize: 10, mediaType: "application/json", redaction: "redacted", transformReceipt: createRuntimeId("receipt", "remote-output-transform"), workspaceId }],
		eventHead: { stream: eventStream, sequence: 5, eventId: createRuntimeId("event", "remote-result-head"), eventHash: D2 },
		startedAt: "2026-07-22T00:00:01.000Z", finishedAt: "2026-07-22T00:00:02.000Z", exitCode: 0,
	};
	return { ...body, receiptDigest: remoteExecutorResultReceiptDigest(body) };
}

export function verification(request = invocation(), execution = result(request)): RemoteAttestationVerificationReceipt {
	return {
		schemaVersion: REMOTE_EXECUTOR_SCHEMA_VERSION, authorityId, tenantId,
		receiptId: createRuntimeId("receipt", "attestation-verification"), attestationReceiptId: execution.attestation.receiptId,
		invocationDigest: request.invocationDigest, status: "verified", verifiedAt: "2026-07-22T00:00:03.000Z", receiptDigest: D2,
	};
}

export function handoff(): SessionHandoffManifest {
	const request = invocation();
	const body: SessionHandoffManifestBody = {
		schemaVersion: REMOTE_EXECUTOR_SCHEMA_VERSION, authorityId, tenantId, sessionId,
		sourceRuntimeId: request.workspaceEnvelope.ownerRuntimeId, targetExecutorId: executorId, eventHead: request.eventHead,
		artifactRefs: request.inputArtifacts,
		leaseTransfer: { leaseId, workspaceId, expectedRevision: 3, transferReceiptId: createRuntimeId("receipt", "lease-transfer"), transferReceiptDigest: D1 },
		effectivePolicyReceiptId: request.effectivePolicy.receiptId, issuedAt: "2026-07-22T00:00:00.000Z", expiresAt: "2026-07-22T00:10:00.000Z",
	};
	return { ...body, manifestDigest: sessionHandoffManifestDigest(body), signatureReceiptId: createRuntimeId("receipt", "handoff-signature"), signatureDigest: canonicalDigest(body) };
}

export function handoffReceipt(manifest = handoff()): SessionHandoffReceipt {
	return {
		schemaVersion: REMOTE_EXECUTOR_SCHEMA_VERSION, authorityId, tenantId,
		receiptId: createRuntimeId("receipt", "handoff-accepted"), sessionId,
		targetExecutorId: executorId, manifestDigest: manifest.manifestDigest, status: "accepted",
		decidedAt: "2026-07-22T00:00:01.000Z", receiptDigest: D2,
	};
}
