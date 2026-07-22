import { describe, expect, it } from "vitest";
import { UnavailableArtifactKeyProvider } from "../../../src/runtime/artifacts/key-provider.ts";
import type {
	EnterpriseAuthorizationPort,
	ManagedPolicyProviderPort,
} from "../../../src/runtime/identity/enterprise-ports.ts";
import {
	isAuthorizationRequest,
	isEffectivePolicyReceiptRef,
} from "../../../src/runtime/identity/enterprise-schemas.ts";
import {
	ENTERPRISE_CONTRACT_SCHEMA_VERSION,
	type AuthorizationRequest,
	type EffectivePolicyReceiptRef,
	type EnterprisePrincipalRef,
} from "../../../src/runtime/identity/enterprise-types.ts";
import {
	CapabilityReplayGuard,
	capabilityGatewayRequestDigest,
	validateCapabilityGatewayRequest,
	type CapabilityGatewayRequest,
	type CapabilityGatewayRequestBody,
} from "../../../src/runtime/protocol/v3/capability.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);
const authorityId = createRuntimeId("authority", "harness-enterprise");
const tenantId = createRuntimeId("tenant", "harness-enterprise");
const principalId = createRuntimeId("principal", "harness-enterprise");

function principal(overrides: Partial<EnterprisePrincipalRef> = {}): EnterprisePrincipalRef {
	return {
		schemaVersion: ENTERPRISE_CONTRACT_SCHEMA_VERSION,
		authorityId,
		tenantId,
		principalId,
		kind: "user",
		subjectDigest: A,
		issuerId: "managed-identity",
		issuedAt: "2026-07-22T00:00:00.000Z",
		...overrides,
	};
}

function effectivePolicy(): EffectivePolicyReceiptRef {
	return {
		schemaVersion: ENTERPRISE_CONTRACT_SCHEMA_VERSION,
		authorityId,
		tenantId,
		receiptId: createRuntimeId("receipt", "harness-effective-policy"),
		sources: [
			{ policyId: createRuntimeId("resource", "organization-deny"), source: "organization", priority: 100, revision: 4, snapshotDigest: A },
			{ policyId: createRuntimeId("resource", "project-allow"), source: "project", priority: 10, revision: 7, snapshotDigest: B },
		],
		effectivePolicyDigest: A,
		decisionDigest: B,
		evaluatorId: "specialty-policy-engine",
		evaluatedAt: "2026-07-22T00:00:00.000Z",
		receiptDigest: A,
	};
}

function authorizationRequest(overrides: Partial<AuthorizationRequest> = {}): AuthorizationRequest {
	return {
		schemaVersion: ENTERPRISE_CONTRACT_SCHEMA_VERSION,
		authorityId,
		tenantId,
		requestId: createRuntimeId("command", "harness-authorization"),
		sessionId: createRuntimeId("session", "harness-enterprise"),
		traceId: createRuntimeId("trace", "harness-enterprise"),
		principal: principal(),
		action: "approve",
		resourceKind: "high-risk-change",
		resourceDigest: A,
		risk: "critical",
		effectivePolicy: effectivePolicy(),
		separationOfDutyPrincipalIds: [createRuntimeId("principal", "independent-approver")],
		requestedAt: "2026-07-22T00:00:00.000Z",
		...overrides,
	};
}

function capabilityRequest(): CapabilityGatewayRequest {
	const envelope = {
		authorityId,
		tenantId,
		principalId,
		sessionId: createRuntimeId("session", "harness-token"),
		workspaceId: createRuntimeId("workspace", "harness-token"),
		repositoryId: createRuntimeId("repository", "harness-token"),
		worktreePath: "/workspace/harness-token",
		branch: "harness/token",
		baseCommit: "1".repeat(40),
		agentId: createRuntimeId("agent", "harness-token"),
		toolCallId: createRuntimeId("toolCall", "harness-token"),
		traceId: createRuntimeId("trace", "harness-token"),
		cwd: "/workspace/harness-token",
		ownerRuntimeId: createRuntimeId("runtime", "harness-token"),
		leaseRevision: 1,
		fencingToken: "opaque-token-fence",
	};
	const requestId = createRuntimeId("command", "harness-token");
	const body: CapabilityGatewayRequestBody = {
		request: {
			authorityId,
			tenantId,
			principalId,
			requestId,
			approvalId: createRuntimeId("approval", "harness-token"),
			sessionId: envelope.sessionId,
			runtimeId: envelope.ownerRuntimeId,
			runtimeGeneration: envelope.leaseRevision,
			turnId: createRuntimeId("turn", "harness-token"),
			toolCallId: envelope.toolCallId,
			capability: "credential",
			argumentsDigest: A,
			workspaceEnvelopeDigest: B,
			policyDigest: A,
			serverScope: "tool_server",
			resourceScopeDigest: A,
			commandScopeDigest: B,
		},
		invocation: {
			requestId,
			toolManifestDigest: B,
			rawArguments: { credentialHandle: "opaque-ref" },
			envelope,
			requestedClaims: [{
				authorityId,
				tenantId,
				name: "credential",
				resourceKind: "credential",
				resourceDigest: A,
				constraintsDigest: B,
			}],
		},
		idempotencyKey: requestId,
		inputSources: [],
		targetSink: "context",
		declassificationReceipts: [],
	};
	return {
		...body,
		authentication: {
			channel: "local_socket",
			channelBindingDigest: A,
			requestDigest: capabilityGatewayRequestDigest(body),
			nonce: "harness.token.nonce.0001",
			issuedAt: "2026-07-22T00:00:00.000Z",
			expiresAt: "2026-07-22T00:10:00.000Z",
			keyRevision: 7,
		},
	};
}

describe("Harness Regression: enterprise contract-boundary attacks", () => {
	it("[contract boundary] policy deny precedence remains specialty-owned and a deny result has no Runtime fallback", async () => {
		const effective = effectivePolicy();
		expect(isEffectivePolicyReceiptRef(effective)).toBe(true);
		expect(isEffectivePolicyReceiptRef({ ...effective, sources: [...effective.sources].reverse() })).toBe(false);

		// Runtime 刻意不实现 policy body 合并；该可执行边界只验证专项 evaluator 的 deny 不会被低优先级 allow 覆盖。
		const provider: ManagedPolicyProviderPort = {
			resolve: async () => ({ ok: false, error: { code: "denied", retryable: false, reasonDigest: A } }),
		};
		expect(await provider.resolve({
			authorityId,
			tenantId,
			requestId: createRuntimeId("command", "policy-deny"),
			principalId,
			resourceDigest: B,
			sourceSnapshotIds: effective.sources.map((source) => source.policyId),
			requestedAt: "2026-07-22T00:00:00.000Z",
		})).toEqual({ ok: false, error: { code: "denied", retryable: false, reasonDigest: A } });
	});

	it("forged principal and unauthorized self-approval are rejected before an authorization adapter can allow", async () => {
		const forged = authorizationRequest({
			principal: principal({ tenantId: createRuntimeId("tenant", "attacker") }),
		});
		expect(isAuthorizationRequest(forged)).toBe(false);

		const selfApproval = authorizationRequest({ separationOfDutyPrincipalIds: [principalId] });
		expect(isAuthorizationRequest(selfApproval)).toBe(false);
		let calls = 0;
		const authorization: EnterpriseAuthorizationPort = {
			authorize: async () => {
				calls += 1;
				return { ok: false, error: { code: "denied", retryable: false, reasonDigest: B } };
			},
		};
		if (isAuthorizationRequest(selfApproval)) await authorization.authorize(selfApproval);
		expect(calls).toBe(0);
	});

	it("old token/key replay is rejected by nonce and revoked-key guards", () => {
		const request = capabilityRequest();
		const at = new Date("2026-07-22T00:05:00.000Z");
		const replay = new CapabilityReplayGuard();
		expect(validateCapabilityGatewayRequest(request, { at, replayGuard: replay }).ok).toBe(true);
		expect(validateCapabilityGatewayRequest(request, { at, replayGuard: replay })).toEqual({
			ok: false,
			reason: "replayed_nonce",
		});
		expect(validateCapabilityGatewayRequest(request, { at, revokedKeyRevisions: new Set([7]) })).toEqual({
			ok: false,
			reason: "revoked_key",
		});
	});

	it("[contract boundary] rotation interruption denies key use without fallback bytes", async () => {
		// 这里只验证 Runtime 对专项 key provider 不可用状态的 fail-closed 边界，不冒充真实 KMS rotation 测试。
		const provider = new UnavailableArtifactKeyProvider("rotating");
		let operationCalls = 0;
		const result = await provider.withKey({ purpose: "forensic_encrypt", version: "v2" }, () => {
			operationCalls += 1;
			return "must-not-run";
		});
		expect(result).toMatchObject({
			ok: false,
			error: { code: "key_unavailable", retryable: true },
		});
		expect(operationCalls).toBe(0);
		expect(await provider.status()).toEqual({ state: "rotating", availableVersions: [], backend: "unavailable" });
	});
});
