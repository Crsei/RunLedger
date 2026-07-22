import { describe, expect, it } from "vitest";
import {
	CapabilityReplayGuard,
	capabilityGatewayRequestDigest,
	gatewayRateLimitReceiptMatchesRequest,
	isCapabilityGatewayRequest,
	isGatewayRateLimitReceipt,
	validateCapabilityGatewayRequest,
	type CapabilityGatewayRequest,
	type CapabilityGatewayRequestBody,
	type GatewayRateLimitReceipt,
	type GatewayRateLimitRequest,
} from "../../../src/runtime/protocol/v3/capability.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	declassificationAllowsSourceAtSink,
	isDeclassificationReceiptRef,
	isInputSourceRef,
	propagateInputSources,
	type DeclassificationReceiptRef,
	type InputSourceRef,
} from "../../../src/runtime/protocol/v3/taint.ts";

const AUTHORITY_ID = createRuntimeId("authority", "security-auth");
const TENANT_ID = createRuntimeId("tenant", "security-auth");
const PRINCIPAL_ID = createRuntimeId("principal", "security-auth");
const REQUEST_ID = createRuntimeId("command", "security-auth");
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const NOW = new Date("2026-07-22T00:01:00.000Z");

function source(): InputSourceRef {
	return {
		schemaVersion: 1,
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		sourceId: createRuntimeId("inputSource", "candidate-comment"),
		kind: "comment",
		sourceDigest: DIGEST_A,
		trust: "tainted",
		taintLabels: ["external_untrusted"],
		observedAt: "2026-07-22T00:00:00.000Z",
	};
}

function declassification(input = source()): DeclassificationReceiptRef {
	const body: Omit<DeclassificationReceiptRef, "receiptDigest"> = {
		schemaVersion: 1,
		authorityId: input.authorityId,
		tenantId: input.tenantId,
		receiptId: createRuntimeId("declassification", "candidate-comment-shell"),
		sourceId: input.sourceId,
		sourceDigest: input.sourceDigest,
		allowedSink: "shell",
		policyDigest: DIGEST_B,
		approverPrincipalId: createRuntimeId("principal", "independent-reviewer"),
		decisionRevision: 1,
		issuedAt: "2026-07-22T00:00:30.000Z",
		expiresAt: "2026-07-22T00:05:00.000Z",
	};
	return { ...body, receiptDigest: canonicalDigest(body) };
}

function gatewayBody(receipts: readonly DeclassificationReceiptRef[] = []): CapabilityGatewayRequestBody {
	const input = source();
	const envelope = {
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		principalId: PRINCIPAL_ID,
		sessionId: createRuntimeId("session", "security-auth"),
		workspaceId: createRuntimeId("workspace", "security-auth"),
		repositoryId: createRuntimeId("repository", "security-auth"),
		worktreePath: "/workspace/security-auth",
		branch: "runtime/security-auth",
		baseCommit: "1".repeat(40),
		agentId: createRuntimeId("agent", "security-auth"),
		toolCallId: createRuntimeId("toolCall", "security-auth"),
		traceId: createRuntimeId("trace", "security-auth"),
		cwd: "/workspace/security-auth",
		ownerRuntimeId: createRuntimeId("runtime", "security-auth"),
		leaseRevision: 1,
		fencingToken: "security-auth-fence",
	};
	return {
		request: {
			authorityId: AUTHORITY_ID,
			tenantId: TENANT_ID,
			principalId: PRINCIPAL_ID,
			requestId: REQUEST_ID,
			approvalId: createRuntimeId("approval", "security-auth"),
			sessionId: envelope.sessionId,
			runtimeId: envelope.ownerRuntimeId,
			runtimeGeneration: envelope.leaseRevision,
			turnId: createRuntimeId("turn", "security-auth"),
			toolCallId: envelope.toolCallId,
			capability: "process",
			argumentsDigest: DIGEST_A,
			workspaceEnvelopeDigest: DIGEST_B,
			policyDigest: DIGEST_B,
			serverScope: "tool_server",
			resourceScopeDigest: DIGEST_A,
			commandScopeDigest: DIGEST_B,
		},
		invocation: {
			requestId: REQUEST_ID,
			toolManifestDigest: DIGEST_A,
			rawArguments: { argv: ["trusted-tool", "untrusted-value"] },
			envelope,
			requestedClaims: [{
				authorityId: AUTHORITY_ID,
				tenantId: TENANT_ID,
				name: "process",
				resourceKind: "process",
				resourceDigest: DIGEST_A,
				constraintsDigest: DIGEST_B,
			}],
		},
		idempotencyKey: REQUEST_ID,
		inputSources: [input],
		targetSink: "shell",
		declassificationReceipts: receipts,
	};
}

function gatewayRequest(receipts: readonly DeclassificationReceiptRef[] = []): CapabilityGatewayRequest {
	const body = gatewayBody(receipts);
	return {
		...body,
		authentication: {
			channel: "local_socket",
			channelBindingDigest: DIGEST_A,
			requestDigest: capabilityGatewayRequestDigest(body),
			nonce: "nonce.security.auth.0001",
			issuedAt: "2026-07-22T00:00:00.000Z",
			expiresAt: "2026-07-22T00:05:00.000Z",
			keyRevision: 7,
		},
	};
}

describe("authenticated capability requests and taint propagation", () => {
	it("preserves exact source labels and requires a sink-specific independent receipt", () => {
		const input = source();
		const receipt = declassification(input);
		expect(isInputSourceRef(input)).toBe(true);
		expect(isDeclassificationReceiptRef(receipt)).toBe(true);
		expect(propagateInputSources([input], [input])).toEqual([input]);
		expect(declassificationAllowsSourceAtSink(receipt, input, "shell", NOW)).toBe(true);
		expect(declassificationAllowsSourceAtSink(receipt, input, "network", NOW)).toBe(false);
		expect(isInputSourceRef({ ...input, trust: "trusted", taintLabels: [] })).toBe(false);
	});

	it("rejects undeclassified sinks, replayed nonces, expired requests, and revoked key revisions", () => {
		const undeclassified = gatewayRequest();
		expect(isCapabilityGatewayRequest(undeclassified)).toBe(true);
		expect(validateCapabilityGatewayRequest(undeclassified, { at: NOW })).toEqual({
			ok: false,
			reason: "taint_not_declassified",
		});

		const request = gatewayRequest([declassification()]);
		const replayGuard = new CapabilityReplayGuard();
		expect(validateCapabilityGatewayRequest(request, { at: NOW, replayGuard }).ok).toBe(true);
		expect(validateCapabilityGatewayRequest(request, { at: NOW, replayGuard })).toEqual({
			ok: false,
			reason: "replayed_nonce",
		});
		expect(validateCapabilityGatewayRequest(request, { at: NOW, revokedKeyRevisions: new Set([7]) })).toEqual({
			ok: false,
			reason: "revoked_key",
		});
		expect(validateCapabilityGatewayRequest(request, { at: new Date("2026-07-22T00:05:00.000Z") })).toEqual({
			ok: false,
			reason: "expired",
		});
		expect(isCapabilityGatewayRequest({
			...request,
			inputSources: [{ ...source(), tenantId: createRuntimeId("tenant", "other") }],
		})).toBe(false);
	});
});

describe("Gateway rate-limit receipts", () => {
	it("binds reserve receipts to principal, capability, resource, window, and units", () => {
		const request: GatewayRateLimitRequest = {
			authorityId: AUTHORITY_ID,
			tenantId: TENANT_ID,
			principalId: PRINCIPAL_ID,
			rateLimitId: createRuntimeId("rateLimit", "security-auth"),
			requestId: REQUEST_ID,
			operation: "reserve",
			capability: "process",
			resourceDigest: DIGEST_A,
			windowStartedAt: "2026-07-22T00:00:00.000Z",
			windowExpiresAt: "2026-07-22T00:05:00.000Z",
			units: 1,
			idempotencyKey: createRuntimeId("command", "rate-limit-reserve"),
		};
		const body: Omit<GatewayRateLimitReceipt, "receiptDigest"> = {
			authorityId: AUTHORITY_ID,
			tenantId: TENANT_ID,
			principalId: PRINCIPAL_ID,
			receiptId: createRuntimeId("receipt", "rate-limit-reserve"),
			rateLimitId: request.rateLimitId,
			requestId: request.requestId,
			operation: request.operation,
			outcome: "reserved",
			capability: request.capability,
			resourceDigest: request.resourceDigest,
			windowStartedAt: request.windowStartedAt,
			windowExpiresAt: request.windowExpiresAt,
			requestedUnits: request.units,
			acceptedUnits: 1,
			remainingUnits: 9,
			policyDigest: DIGEST_B,
			issuedAt: "2026-07-22T00:01:00.000Z",
		};
		const receipt: GatewayRateLimitReceipt = { ...body, receiptDigest: canonicalDigest(body) };
		expect(isGatewayRateLimitReceipt(receipt)).toBe(true);
		expect(gatewayRateLimitReceiptMatchesRequest(receipt, request)).toBe(true);
		expect(isGatewayRateLimitReceipt({ ...receipt, acceptedUnits: 2 })).toBe(false);
		expect(gatewayRateLimitReceiptMatchesRequest({ ...receipt, tenantId: createRuntimeId("tenant", "other") }, request)).toBe(false);
	});
});
