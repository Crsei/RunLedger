/** CI/SSH/relay executor 的 Runtime invocation/result/handoff 中立合同。 */

import type { ArtifactRef } from "../protocol/v3/capability.ts";
import type { EventCursor } from "../protocol/v3/events.ts";
import type {
	AuthorityId,
	CommandId,
	LeaseId,
	ReceiptId,
	ResourceId,
	RuntimeInstanceId,
	SessionId,
	TenantId,
	TraceId,
	VerificationId,
	WorkspaceId,
} from "../protocol/v3/ids.ts";
import type {
	WorkspaceExecutionEnvelope,
	WorkspaceLeaseRef,
	WorkspaceValidationReceiptRef,
} from "../protocol/v3/workspace.ts";
import type {
	EffectivePolicyReceiptRef,
	EnterprisePrincipalRef,
	SessionCredentialGrantRef,
} from "../identity/enterprise-types.ts";

export const REMOTE_EXECUTOR_SCHEMA_VERSION = 1 as const;
export const REMOTE_EXECUTOR_KINDS = ["ci", "ssh", "relay"] as const;
export type RemoteExecutorKind = (typeof REMOTE_EXECUTOR_KINDS)[number];

export interface RemoteVerificationGateRef {
	verificationId: VerificationId;
	gateDigest: string;
	baselineReceiptDigest: string;
	candidateCommit: string;
	verifierReceiptId: ReceiptId;
	verifierReceiptDigest: string;
}

export interface RemoteExecutorInvocationBody {
	schemaVersion: typeof REMOTE_EXECUTOR_SCHEMA_VERSION;
	authorityId: AuthorityId;
	tenantId: TenantId;
	requestId: CommandId;
	idempotencyKey: CommandId;
	executorKind: RemoteExecutorKind;
	executorId: ResourceId;
	principal: EnterprisePrincipalRef;
	sessionId: SessionId;
	traceId: TraceId;
	workspaceEnvelope: WorkspaceExecutionEnvelope;
	workspaceLease: WorkspaceLeaseRef;
	workspaceValidation: WorkspaceValidationReceiptRef;
	gate: RemoteVerificationGateRef;
	inputArtifacts: readonly ArtifactRef[];
	eventHead: EventCursor;
	effectivePolicy: EffectivePolicyReceiptRef;
	credentialGrant?: SessionCredentialGrantRef;
	egressPolicyDigest: string;
	attestationChallengeDigest: string;
	requestedAt: string;
}

/** 只在 executor port 调用边界存在；canonical receipt 只保存 invocationDigest。 */
export interface RemoteExecutorInvocation extends RemoteExecutorInvocationBody {
	invocationDigest: string;
}

export interface RemoteExecutorAttestationRef {
	schemaVersion: typeof REMOTE_EXECUTOR_SCHEMA_VERSION;
	authorityId: AuthorityId;
	tenantId: TenantId;
	receiptId: ReceiptId;
	executorId: ResourceId;
	executorKind: RemoteExecutorKind;
	challengeDigest: string;
	workloadIdentityDigest: string;
	runnerImageDigest: string;
	sandboxEnforcementDigest: string;
	egressEnforcementDigest: string;
	keyReceiptId: ReceiptId;
	issuedAt: string;
	expiresAt: string;
	receiptDigest: string;
}

export interface RemoteExecutorResultReceiptBody {
	schemaVersion: typeof REMOTE_EXECUTOR_SCHEMA_VERSION;
	authorityId: AuthorityId;
	tenantId: TenantId;
	receiptId: ReceiptId;
	requestId: CommandId;
	executorId: ResourceId;
	executorKind: RemoteExecutorKind;
	invocationDigest: string;
	attestation: RemoteExecutorAttestationRef;
	status: "succeeded" | "failed" | "cancelled" | "uncertain";
	workspaceId: WorkspaceId;
	leaseId: LeaseId;
	leaseRevision: number;
	gateDigest: string;
	outputArtifacts: readonly ArtifactRef[];
	eventHead: EventCursor;
	startedAt: string;
	finishedAt: string;
	exitCode?: number;
	reasonDigest?: string;
}

export interface RemoteExecutorResultReceipt extends RemoteExecutorResultReceiptBody {
	receiptDigest: string;
}

export interface RemoteAttestationVerificationReceipt {
	schemaVersion: typeof REMOTE_EXECUTOR_SCHEMA_VERSION;
	authorityId: AuthorityId;
	tenantId: TenantId;
	receiptId: ReceiptId;
	attestationReceiptId: ReceiptId;
	invocationDigest: string;
	status: "verified" | "rejected" | "unavailable";
	verifiedAt: string;
	reasonDigest?: string;
	receiptDigest: string;
}

export interface SessionHandoffManifestBody {
	schemaVersion: typeof REMOTE_EXECUTOR_SCHEMA_VERSION;
	authorityId: AuthorityId;
	tenantId: TenantId;
	sessionId: SessionId;
	sourceRuntimeId: RuntimeInstanceId;
	targetExecutorId: ResourceId;
	eventHead: EventCursor;
	artifactRefs: readonly ArtifactRef[];
	leaseTransfer: {
		leaseId: LeaseId;
		workspaceId: WorkspaceId;
		expectedRevision: number;
		transferReceiptId: ReceiptId;
		transferReceiptDigest: string;
	};
	effectivePolicyReceiptId: ReceiptId;
	issuedAt: string;
	expiresAt: string;
}

/** Handoff 不含 credential；signatureReceipt 只引用外部 signer 的证明。 */
export interface SessionHandoffManifest extends SessionHandoffManifestBody {
	manifestDigest: string;
	signatureReceiptId: ReceiptId;
	signatureDigest: string;
}

export type SessionHandoffReceipt =
	| {
			schemaVersion: typeof REMOTE_EXECUTOR_SCHEMA_VERSION;
			authorityId: AuthorityId;
			tenantId: TenantId;
			receiptId: ReceiptId;
			sessionId: SessionId;
			targetExecutorId: ResourceId;
			manifestDigest: string;
			status: "accepted";
			decidedAt: string;
			receiptDigest: string;
	  }
	| {
			schemaVersion: typeof REMOTE_EXECUTOR_SCHEMA_VERSION;
			authorityId: AuthorityId;
			tenantId: TenantId;
			receiptId: ReceiptId;
			sessionId: SessionId;
			targetExecutorId: ResourceId;
			manifestDigest: string;
			status: "rejected" | "unavailable";
			reasonDigest: string;
			decidedAt: string;
			receiptDigest: string;
	  };
