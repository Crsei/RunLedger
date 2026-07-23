/** Policy/AuthN/AuthZ/Key 的 opaque provider ports；Runtime 不实现 merge、RBAC、KMS。 */

import type {
	AuthenticationReceiptRef,
	AuthenticationRequest,
	AuthorizationDecisionReceiptRef,
	AuthorizationRequest,
	CredentialAudienceValidationReceiptRef,
	CredentialAudienceValidationRequest,
	CredentialGrantIssueRequest,
	CredentialGrantRevocationReceiptRef,
	CredentialGrantRevocationRequest,
	EffectivePolicyReceiptRef,
	EnterprisePortResult,
	EnterpriseScope,
	KeyLifecycleReceiptRef,
	ManagedKeyRef,
	ManagedPolicySnapshotRef,
	SessionCredentialGrantRef,
} from "./enterprise-types.ts";
import type { CommandId, PrincipalId, ReceiptId, ResourceId } from "../protocol/v3/ids.ts";

export interface ManagedPolicyResolveRequest extends EnterpriseScope {
	requestId: CommandId;
	principalId: PrincipalId;
	resourceDigest: string;
	sourceSnapshotIds: readonly ResourceId[];
	requestedAt: string;
}

export interface ManagedPolicyResolveResult {
	snapshots: readonly ManagedPolicySnapshotRef[];
	effective: EffectivePolicyReceiptRef;
}

export interface ManagedPolicyProviderPort {
	resolve(request: ManagedPolicyResolveRequest, signal?: AbortSignal): Promise<EnterprisePortResult<ManagedPolicyResolveResult>>;
}

export interface EnterpriseAuthenticationPort {
	authenticate(request: AuthenticationRequest, signal?: AbortSignal): Promise<EnterprisePortResult<AuthenticationReceiptRef>>;
}

export interface EnterpriseAuthorizationPort {
	authorize(request: AuthorizationRequest, signal?: AbortSignal): Promise<EnterprisePortResult<AuthorizationDecisionReceiptRef>>;
}

/**
 * Runtime 只持有 grant/validation/revocation receipt；实际 token、key 与注入句柄
 * 永远留在专项 Credential Broker 内部。
 */
export interface CredentialBrokerPort {
	issue(
		request: CredentialGrantIssueRequest,
		signal?: AbortSignal,
	): Promise<EnterprisePortResult<SessionCredentialGrantRef>>;
	validateAudience(
		request: CredentialAudienceValidationRequest,
		signal?: AbortSignal,
	): Promise<EnterprisePortResult<CredentialAudienceValidationReceiptRef>>;
	revoke(
		request: CredentialGrantRevocationRequest,
		signal?: AbortSignal,
	): Promise<EnterprisePortResult<CredentialGrantRevocationReceiptRef>>;
}

export interface ManagedKeyResolveRequest extends EnterpriseScope {
	requestId: CommandId;
	keyRefId: ResourceId;
	purpose: ManagedKeyRef["purpose"];
	requiredState: "available";
	requestedAt: string;
}

export interface ManagedKeyResolveResult {
	key: ManagedKeyRef;
	lifecycleReceipt: KeyLifecycleReceiptRef;
}

export interface ManagedKeyLifecycleRequest extends EnterpriseScope {
	requestId: CommandId;
	keyRefId: ResourceId;
	operation: Exclude<KeyLifecycleReceiptRef["operation"], "resolve">;
	expectedProviderReceiptId?: ReceiptId;
	requestedAt: string;
}

/** 返回 key ref/receipt，不返回 key bytes、token 或 provider credential。 */
export interface ManagedKeyProviderPort {
	resolve(request: ManagedKeyResolveRequest, signal?: AbortSignal): Promise<EnterprisePortResult<ManagedKeyResolveResult>>;
	lifecycle(request: ManagedKeyLifecycleRequest, signal?: AbortSignal): Promise<EnterprisePortResult<KeyLifecycleReceiptRef>>;
}
