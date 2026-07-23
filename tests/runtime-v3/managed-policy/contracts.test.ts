import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	AuthenticationReceiptRefSchema,
	AuthorizationDecisionReceiptRefSchema,
	AuthorizationRequestSchema,
	EffectivePolicyReceiptRefSchema,
	EnterprisePrincipalRefSchema,
	KeyLifecycleReceiptRefSchema,
	ManagedKeyRefSchema,
	ManagedPolicySnapshotRefSchema,
	SessionCredentialGrantRefSchema,
	authorizationReceiptMatchesRequest,
	authorizationRequestDigest,
	isAuthorizationRequest,
	isEffectivePolicyReceiptRef,
	isEnterprisePrincipalRef,
	isKeyLifecycleReceiptRef,
} from "../../../src/runtime/identity/enterprise-schemas.ts";
import {
	ENTERPRISE_CONTRACT_SCHEMA_VERSION,
	MANAGED_KEY_PROVIDERS,
	MANAGED_POLICY_SOURCES,
	type AuthorizationRequest,
	type AuthorizationDecisionReceiptRef,
	type EffectivePolicyReceiptRef,
	type EnterprisePrincipalRef,
	type ManagedPolicySnapshotRef,
	type SessionCredentialGrantRef,
} from "../../../src/runtime/identity/enterprise-types.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);
const authorityId = createRuntimeId("authority", "enterprise");
const tenantId = createRuntimeId("tenant", "enterprise");
const principalId = createRuntimeId("principal", "enterprise");
const approverId = createRuntimeId("principal", "enterprise-approver");

function principal(kind: EnterprisePrincipalRef["kind"] = "service"): EnterprisePrincipalRef {
	const base = {
		schemaVersion: ENTERPRISE_CONTRACT_SCHEMA_VERSION, authorityId, tenantId, principalId, kind,
		subjectDigest: A, issuerId: "managed-identity", issuedAt: "2026-07-22T00:00:00.000Z",
	};
	if (kind === "remote_workload") return { ...base, kind, expiresAt: "2026-07-22T01:00:00.000Z", attestationReceiptId: createRuntimeId("receipt", "principal-attestation") };
	if (kind === "local_peer") return { ...base, kind, attestationReceiptId: createRuntimeId("receipt", "principal-local-peer") };
	if (kind === "session_credential") return { ...base, kind, expiresAt: "2026-07-22T01:00:00.000Z", grantReceiptId: createRuntimeId("receipt", "principal-grant") };
	return { ...base, kind };
}

function effective(): EffectivePolicyReceiptRef {
	return {
		schemaVersion: ENTERPRISE_CONTRACT_SCHEMA_VERSION, authorityId, tenantId,
		receiptId: createRuntimeId("receipt", "effective-policy"),
		sources: [
			{ policyId: createRuntimeId("resource", "org-policy"), source: "organization", priority: 100, revision: 2, snapshotDigest: A },
			{ policyId: createRuntimeId("resource", "project-policy"), source: "project", priority: 50, revision: 3, snapshotDigest: B },
		],
		effectivePolicyDigest: A, decisionDigest: B, evaluatorId: "external-policy-engine",
		evaluatedAt: "2026-07-22T00:00:00.000Z", receiptDigest: A,
	};
}

function authorizationRequest(): AuthorizationRequest {
	return {
		schemaVersion: ENTERPRISE_CONTRACT_SCHEMA_VERSION, authorityId, tenantId,
		requestId: createRuntimeId("command", "enterprise-authz"), sessionId: createRuntimeId("session", "enterprise"),
		traceId: createRuntimeId("trace", "enterprise"), principal: principal(), action: "execute_remote",
		resourceKind: "executor", resourceDigest: A, risk: "high", effectivePolicy: effective(),
		separationOfDutyPrincipalIds: [approverId], requestedAt: "2026-07-22T00:00:00.000Z",
	};
}

describe("managed policy exact refs", () => {
		it("expresses source priority/snapshot and policy associations without parsing or merging policy", () => {
		const snapshot: ManagedPolicySnapshotRef = {
			schemaVersion: ENTERPRISE_CONTRACT_SCHEMA_VERSION, authorityId, tenantId,
			policyId: createRuntimeId("resource", "managed-policy"), source: "organization", priority: 100, revision: 4,
			snapshotDigest: A, bindings: {
				toolAllowlistDigest: A, resourceAllowlistDigest: B, telemetryManifestDigest: A,
				retentionPolicyDigest: B, budgetPolicyDigest: A, executorEgressPolicyDigest: B, marketplacePolicyDigest: A,
			},
			signerReceiptId: createRuntimeId("receipt", "policy-signer"), issuedAt: "2026-07-22T00:00:00.000Z",
		};
		expect(Check(ManagedPolicySnapshotRefSchema, snapshot)).toBe(true);
		expect(Check(ManagedPolicySnapshotRefSchema, { ...snapshot, policyBody: { deny: true } })).toBe(false);
		expect(Check(EffectivePolicyReceiptRefSchema, effective())).toBe(true);
			expect(isEffectivePolicyReceiptRef({ ...effective(), sources: [...effective().sources].reverse() })).toBe(false);
			expect(MANAGED_POLICY_SOURCES[0]).toBe("native-managed");
		});

	it("keeps enterprise principal variants exact and bounded", () => {
		for (const kind of ["user", "service", "local_peer", "remote_workload", "session_credential"] as const) {
			expect(Check(EnterprisePrincipalRefSchema, principal(kind))).toBe(true);
			expect(isEnterprisePrincipalRef(principal(kind))).toBe(true);
		}
		expect(Check(EnterprisePrincipalRefSchema, { ...principal("remote_workload"), attestationReceiptId: undefined })).toBe(false);
		expect(Check(EnterprisePrincipalRefSchema, { ...principal(), credential: "secret" })).toBe(false);
	});
});

describe("AuthN/AuthZ and key refs", () => {
	it("correlates authorization decision to tenant/principal policy request without implementing RBAC", () => {
		const request = authorizationRequest();
		expect(Check(AuthorizationRequestSchema, request)).toBe(true);
		expect(isAuthorizationRequest(request)).toBe(true);
		const receipt: AuthorizationDecisionReceiptRef = {
			schemaVersion: ENTERPRISE_CONTRACT_SCHEMA_VERSION, authorityId, tenantId,
			receiptId: createRuntimeId("receipt", "authz"), requestId: request.requestId,
			requestDigest: authorizationRequestDigest(request), effectivePolicyReceiptId: request.effectivePolicy.receiptId,
			effectivePolicyDigest: request.effectivePolicy.effectivePolicyDigest, separationOfDutyDigest: B,
			decidedAt: "2026-07-22T00:00:01.000Z", receiptDigest: A, decision: "allow", obligationsDigest: B,
		};
		expect(Check(AuthorizationDecisionReceiptRefSchema, receipt)).toBe(true);
		expect(authorizationReceiptMatchesRequest(receipt, request)).toBe(true);
		expect(authorizationReceiptMatchesRequest({ ...receipt, tenantId: createRuntimeId("tenant", "other") }, request)).toBe(false);
		expect(isAuthorizationRequest({ ...request, separationOfDutyPrincipalIds: [principalId] })).toBe(false);
	});

	it("represents authentication, ephemeral grant and key lifecycle as refs without secret bytes", () => {
		const authentication = {
			schemaVersion: ENTERPRISE_CONTRACT_SCHEMA_VERSION, authorityId, tenantId,
			receiptId: createRuntimeId("receipt", "authentication"), requestId: createRuntimeId("command", "authentication"),
			outcome: "authenticated", principal: principal("remote_workload"), requestDigest: A,
			issuedAt: "2026-07-22T00:00:00.000Z", expiresAt: "2026-07-22T01:00:00.000Z", receiptDigest: B,
		};
		const grant: SessionCredentialGrantRef = {
			schemaVersion: ENTERPRISE_CONTRACT_SCHEMA_VERSION, authorityId, tenantId,
			grantId: createRuntimeId("receipt", "credential-grant"), principalId, sessionId: createRuntimeId("session", "enterprise"),
			credentialKind: "github-app", audienceDigest: A, scopeDigest: B, keyRefId: createRuntimeId("resource", "grant-key"),
			issuedAt: "2026-07-22T00:00:00.000Z", expiresAt: "2026-07-22T00:10:00.000Z", receiptDigest: A,
		};
		const key = {
			schemaVersion: ENTERPRISE_CONTRACT_SCHEMA_VERSION, authorityId, tenantId,
			keyRefId: createRuntimeId("resource", "kms-key"), provider: "kms", purpose: "credential_grant",
			version: "v3", state: "available", providerReceiptId: createRuntimeId("receipt", "kms-provider"), refDigest: A,
		};
		const lifecycle = {
			schemaVersion: ENTERPRISE_CONTRACT_SCHEMA_VERSION, authorityId, tenantId,
			receiptId: createRuntimeId("receipt", "key-rotation"), keyRefId: key.keyRefId, operation: "rotate", outcome: "completed",
			previousVersion: "v2", currentVersion: "v3", requestedAt: "2026-07-22T00:00:00.000Z", completedAt: "2026-07-22T00:00:01.000Z", receiptDigest: B,
		};
		expect(Check(AuthenticationReceiptRefSchema, authentication)).toBe(true);
		expect(Check(SessionCredentialGrantRefSchema, grant)).toBe(true);
		expect(Check(ManagedKeyRefSchema, key)).toBe(true);
		expect(Check(KeyLifecycleReceiptRefSchema, lifecycle)).toBe(true);
		expect(isKeyLifecycleReceiptRef(lifecycle)).toBe(true);
		expect(MANAGED_KEY_PROVIDERS).toEqual(["os_keyring", "kms"]);
		const serialized = JSON.stringify({ authentication, grant, key, lifecycle });
		expect(serialized).not.toMatch(/"(?:secret|token|password|keyBytes|value)"/u);
	});
});
