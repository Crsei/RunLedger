/** Enterprise identity/policy/key 的 Runtime 中立引用；不包含凭据或策略正文。 */

import type {
	AuthorityId,
	CommandId,
	PrincipalId,
	ReceiptId,
	ResourceId,
	SessionId,
	TenantId,
	TraceId,
} from "../protocol/v3/ids.ts";

export const ENTERPRISE_CONTRACT_SCHEMA_VERSION = 1 as const;
export const ENTERPRISE_PRINCIPAL_KINDS = ["user", "service", "local_peer", "remote_workload", "session_credential"] as const;
export const MANAGED_POLICY_SOURCES = ["native-managed", "organization", "tenant", "project", "user", "session"] as const;
export const AUTHORIZATION_ACTIONS = [
	"read_resource", "use_tool", "write_workspace", "use_credential", "approve",
	"execute_remote", "manage_policy", "read_forensic",
] as const;
export const MANAGED_KEY_PROVIDERS = ["os_keyring", "kms"] as const;

export type EnterprisePrincipalKind = (typeof ENTERPRISE_PRINCIPAL_KINDS)[number];
export type ManagedPolicySource = (typeof MANAGED_POLICY_SOURCES)[number];
export type EnterpriseAuthorizationAction = (typeof AUTHORIZATION_ACTIONS)[number];
export type ManagedKeyProviderKind = (typeof MANAGED_KEY_PROVIDERS)[number];

export interface EnterpriseScope {
	authorityId: AuthorityId;
	tenantId: TenantId;
}

export interface PolicyBindingRefs {
	toolAllowlistDigest?: string;
	resourceAllowlistDigest?: string;
	telemetryManifestDigest?: string;
	retentionPolicyDigest?: string;
	budgetPolicyDigest?: string;
	executorEgressPolicyDigest?: string;
	marketplacePolicyDigest?: string;
}

export interface ManagedPolicySnapshotRef extends EnterpriseScope {
	schemaVersion: typeof ENTERPRISE_CONTRACT_SCHEMA_VERSION;
	policyId: ResourceId;
	source: ManagedPolicySource;
	priority: number;
	revision: number;
	snapshotDigest: string;
	bindings: PolicyBindingRefs;
	signerReceiptId: ReceiptId;
	issuedAt: string;
	expiresAt?: string;
}

export interface EffectivePolicySourceRef {
	policyId: ResourceId;
	source: ManagedPolicySource;
	priority: number;
	revision: number;
	snapshotDigest: string;
}

export interface EffectivePolicyReceiptRef extends EnterpriseScope {
	schemaVersion: typeof ENTERPRISE_CONTRACT_SCHEMA_VERSION;
	receiptId: ReceiptId;
	sources: readonly EffectivePolicySourceRef[];
	effectivePolicyDigest: string;
	decisionDigest: string;
	evaluatorId: string;
	evaluatedAt: string;
	receiptDigest: string;
}

export interface EnterprisePrincipalRef extends EnterpriseScope {
	schemaVersion: typeof ENTERPRISE_CONTRACT_SCHEMA_VERSION;
	principalId: PrincipalId;
	kind: EnterprisePrincipalKind;
	subjectDigest: string;
	issuerId: string;
	issuedAt: string;
	expiresAt?: string;
	attestationReceiptId?: ReceiptId;
	grantReceiptId?: ReceiptId;
}

/** 引用短期、audience-bound grant；任何 token/key/value 都不属于本合同。 */
export interface SessionCredentialGrantRef extends EnterpriseScope {
	schemaVersion: typeof ENTERPRISE_CONTRACT_SCHEMA_VERSION;
	grantId: ReceiptId;
	principalId: PrincipalId;
	sessionId: SessionId;
	credentialKind: string;
	audienceDigest: string;
	scopeDigest: string;
	keyRefId: ResourceId;
	issuedAt: string;
	expiresAt: string;
	receiptDigest: string;
}

/** Credential Broker 的输入只描述用途与 audience，不携带任何凭据材料。 */
export interface CredentialGrantIssueRequest extends EnterpriseScope {
	schemaVersion: typeof ENTERPRISE_CONTRACT_SCHEMA_VERSION;
	requestId: CommandId;
	principalId: PrincipalId;
	sessionId: SessionId;
	credentialKind: string;
	audienceDigest: string;
	scopeDigest: string;
	requestedTtlMs: number;
	requestedAt: string;
}

export interface CredentialAudienceValidationRequest extends EnterpriseScope {
	schemaVersion: typeof ENTERPRISE_CONTRACT_SCHEMA_VERSION;
	requestId: CommandId;
	principalId: PrincipalId;
	sessionId: SessionId;
	grant: SessionCredentialGrantRef;
	targetKind: "local" | "ci" | "ssh" | "relay";
	targetExecutorId: ResourceId;
	invocationDigest: string;
	requestedAt: string;
}

export type CredentialAudienceValidationReceiptRef = EnterpriseScope & {
	schemaVersion: typeof ENTERPRISE_CONTRACT_SCHEMA_VERSION;
	receiptId: ReceiptId;
	requestId: CommandId;
	grantId: ReceiptId;
	targetExecutorId: ResourceId;
	invocationDigest: string;
	audienceDigest: string;
	outcome: "valid" | "rejected" | "unavailable";
	validatedAt: string;
	reasonDigest?: string;
	receiptDigest: string;
};

export interface CredentialGrantRevocationRequest extends EnterpriseScope {
	schemaVersion: typeof ENTERPRISE_CONTRACT_SCHEMA_VERSION;
	requestId: CommandId;
	principalId: PrincipalId;
	sessionId: SessionId;
	grantId: ReceiptId;
	expectedReceiptDigest: string;
	reasonDigest: string;
	requestedAt: string;
}

export interface CredentialGrantRevocationReceiptRef extends EnterpriseScope {
	schemaVersion: typeof ENTERPRISE_CONTRACT_SCHEMA_VERSION;
	receiptId: ReceiptId;
	requestId: CommandId;
	grantId: ReceiptId;
	expectedReceiptDigest: string;
	outcome: "revoked" | "rejected" | "unavailable";
	revokedAt: string;
	reasonDigest?: string;
	receiptDigest: string;
}

export interface AuthenticationRequest extends EnterpriseScope {
	schemaVersion: typeof ENTERPRISE_CONTRACT_SCHEMA_VERSION;
	requestId: CommandId;
	sessionId: SessionId;
	traceId: TraceId;
	requestedKind: EnterprisePrincipalKind;
	presentationHandle: string;
	audienceDigest: string;
	requestedAt: string;
}

export type AuthenticationReceiptRef =
	| (EnterpriseScope & {
			schemaVersion: typeof ENTERPRISE_CONTRACT_SCHEMA_VERSION;
			receiptId: ReceiptId;
			requestId: CommandId;
			outcome: "authenticated";
			principal: EnterprisePrincipalRef;
			requestDigest: string;
			issuedAt: string;
			expiresAt: string;
			receiptDigest: string;
	  })
	| (EnterpriseScope & {
			schemaVersion: typeof ENTERPRISE_CONTRACT_SCHEMA_VERSION;
			receiptId: ReceiptId;
			requestId: CommandId;
			outcome: "rejected" | "unavailable";
			requestDigest: string;
			reasonDigest: string;
			issuedAt: string;
			receiptDigest: string;
	  });

export interface AuthorizationRequest extends EnterpriseScope {
	schemaVersion: typeof ENTERPRISE_CONTRACT_SCHEMA_VERSION;
	requestId: CommandId;
	sessionId: SessionId;
	traceId: TraceId;
	principal: EnterprisePrincipalRef;
	action: EnterpriseAuthorizationAction;
	resourceKind: string;
	resourceDigest: string;
	risk: "low" | "medium" | "high" | "critical";
	effectivePolicy: EffectivePolicyReceiptRef;
	approvalReceiptId?: ReceiptId;
	separationOfDutyPrincipalIds: readonly PrincipalId[];
	requestedAt: string;
}

interface AuthorizationDecisionBase extends EnterpriseScope {
	schemaVersion: typeof ENTERPRISE_CONTRACT_SCHEMA_VERSION;
	receiptId: ReceiptId;
	requestId: CommandId;
	requestDigest: string;
	effectivePolicyReceiptId: ReceiptId;
	effectivePolicyDigest: string;
	separationOfDutyDigest: string;
	decidedAt: string;
	receiptDigest: string;
}

export type AuthorizationDecisionReceiptRef =
	| (AuthorizationDecisionBase & { decision: "allow"; obligationsDigest: string; approvalReceiptId?: ReceiptId })
	| (AuthorizationDecisionBase & { decision: "ask"; requiredApprovalDigest: string })
	| (AuthorizationDecisionBase & { decision: "deny" | "unavailable"; reasonDigest: string });

export interface ManagedKeyRef extends EnterpriseScope {
	schemaVersion: typeof ENTERPRISE_CONTRACT_SCHEMA_VERSION;
	keyRefId: ResourceId;
	provider: ManagedKeyProviderKind;
	purpose: "session_metadata" | "artifact_metadata" | "credential_grant" | "attestation";
	version: string;
	state: "available" | "rotating" | "revoked" | "lost" | "unavailable";
	providerReceiptId: ReceiptId;
	refDigest: string;
}

export interface KeyLifecycleReceiptRef extends EnterpriseScope {
	schemaVersion: typeof ENTERPRISE_CONTRACT_SCHEMA_VERSION;
	receiptId: ReceiptId;
	keyRefId: ResourceId;
	operation: "bootstrap" | "rotate" | "revoke" | "crypto_erase" | "resolve";
	outcome: "completed" | "rejected" | "unavailable";
	previousVersion?: string;
	currentVersion?: string;
	requestedAt: string;
	completedAt: string;
	receiptDigest: string;
}

export interface EnterprisePortError {
	code: "invalid_request" | "not_found" | "denied" | "unavailable" | "stale_receipt" | "scope_mismatch";
	retryable: boolean;
	reasonDigest: string;
}

export type EnterprisePortResult<T> = { ok: true; value: T } | { ok: false; error: EnterprisePortError };
