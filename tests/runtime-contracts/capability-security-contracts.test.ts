import { describe, expect, it } from "vitest";
import { createRuntimeId } from "../../src/runtime/protocol/ids.ts";
import {
	isApprovalReceiptRef,
	isApprovalTicket,
	isArtifactRef,
	isCapabilityClaim,
	isCapabilityDecisionReceipt,
	isCapabilityRequest,
	isCredentialGrantRef,
	isRateLimitReceiptRef,
	isSandboxExecutionReceiptRef,
	isSandboxProfileRef,
} from "../../src/runtime/protocol/capability.ts";

const digest = {
	algorithm: "sha256",
	digest: "c".repeat(64),
} as const;

const identity = {
	authorityId: createRuntimeId("authority", "security"),
	tenantId: createRuntimeId("tenant", "security"),
	principalId: createRuntimeId("principal", "security"),
	principalKind: "local",
	issuedAt: "2026-08-02T00:00:00.000Z",
} as const;

const claim = {
	name: "workspace_write",
	resourceKind: "workspace",
	resourceDigest: digest,
	constraintsDigest: digest,
	scope: "session",
} as const;

describe("Capability and external security exact contracts", () => {
	it("binds capability requests and decisions without accepting raw authorization material", () => {
		const request = {
			requestId: createRuntimeId("command", "capability"),
			identity,
			subject: {
				sessionId: createRuntimeId("session", "security"),
				agentId: createRuntimeId("agent", "security"),
				toolCallId: createRuntimeId("toolCall", "security"),
				traceId: createRuntimeId("trace", "security"),
			},
			claim,
			argumentsDigest: digest,
			workspaceEnvelopeDigest: digest,
			policyDigest: digest,
			nonceDigest: digest,
			issuedAt: "2026-08-02T00:00:00.000Z",
			expiresAt: "2026-08-02T00:05:00.000Z",
			channel: "local_cli",
			signatureProofRef: { subjectKind: "attestation", digest },
		};
		const decision = {
			receiptId: createRuntimeId("receipt", "capability"),
			requestId: request.requestId,
			decision: "allow",
			decisionRevision: 3,
			matchedRulesDigest: digest,
			policyDigest: digest,
			gateway: {
				adapterId: "capability-gateway",
				generation: 2,
				configDigest: digest,
			},
			approverPrincipalId: identity.principalId,
			decidedAt: "2026-08-02T00:00:01.000Z",
			expiresAt: "2026-08-02T00:05:00.000Z",
			revocationRevision: 0,
		};

		expect(isCapabilityClaim(claim)).toBe(true);
		expect(isCapabilityClaim({ ...claim, token: "secret" })).toBe(false);
		expect(isCapabilityRequest(request)).toBe(true);
		expect(isCapabilityRequest({ ...request, nonce: "raw-nonce" })).toBe(false);
		expect(isCapabilityRequest({ ...request, credential: "raw-secret" })).toBe(false);
		expect(isCapabilityDecisionReceipt(decision)).toBe(true);
		expect(isCapabilityDecisionReceipt({ ...decision, policy: { allow: true } })).toBe(false);
	});

	it("binds approval, rate-limit, and credential refs to revisions and digests", () => {
		const ticket = {
			approvalId: createRuntimeId("approval", "security"),
			requestDigest: digest,
			scope: "once",
			status: "pending",
			principalId: identity.principalId,
			createdAt: "2026-08-02T00:00:00.000Z",
			expiresAt: "2026-08-02T00:05:00.000Z",
		};
		const approval = {
			receiptId: createRuntimeId("receipt", "approval"),
			approvalId: ticket.approvalId,
			requestDigest: digest,
			scope: ticket.scope,
			decision: "allowed",
			decisionRevision: 1,
			principalId: identity.principalId,
			decidedAt: "2026-08-02T00:00:01.000Z",
			receiptDigest: digest,
		};
		const rateLimit = {
			receiptId: createRuntimeId("receipt", "rate-limit"),
			principalId: identity.principalId,
			capability: "workspace_write",
			resourceDigest: digest,
			windowStartedAt: "2026-08-02T00:00:00.000Z",
			windowDurationMs: 60_000,
			reservationDigest: digest,
			outcome: "reserved",
			decisionRevision: 4,
			recordedAt: "2026-08-02T00:00:01.000Z",
		};
		const grant = {
			grantId: createRuntimeId("receipt", "credential-grant"),
			credentialKind: "api_key",
			audienceDigest: digest,
			scopeDigest: digest,
			issuedAt: "2026-08-02T00:00:00.000Z",
			expiresAt: "2026-08-02T00:05:00.000Z",
			revocationRevision: 0,
			brokerReceiptRef: { subjectKind: "receipt", digest },
		};

		expect(isApprovalTicket(ticket)).toBe(true);
		expect(isApprovalReceiptRef(approval)).toBe(true);
		expect(isRateLimitReceiptRef(rateLimit)).toBe(true);
		expect(isRateLimitReceiptRef({ ...rateLimit, windowDurationMs: -1 })).toBe(false);
		expect(isCredentialGrantRef(grant)).toBe(true);
		expect(isCredentialGrantRef({ ...grant, credential: "usable-secret" })).toBe(false);
	});

	it("records sandbox enforcement and artifacts only through bounded digest refs", () => {
		const profile = {
			profileId: "sandbox.strict",
			requested: "strict",
			effective: "strict",
			policyDigest: digest,
			backendRequirementDigest: digest,
		};
		const execution = {
			receiptId: createRuntimeId("receipt", "sandbox"),
			profileId: profile.profileId,
			backend: {
				adapterId: "linux-sandbox",
				generation: 7,
				configDigest: digest,
			},
			invocationDigest: digest,
			enforcement: "enforced",
			platformAttestationRef: { subjectKind: "attestation", digest },
			executedAt: "2026-08-02T00:00:01.000Z",
		};
		const artifact = {
			artifactId: createRuntimeId("artifact", "test-report"),
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			storedDigest: digest,
			kind: "test_report",
			mediaType: "application/json",
			originalSize: 256,
			storedSize: 128,
			redaction: "redacted",
			transformReceiptRef: { subjectKind: "receipt", digest },
			workspaceId: createRuntimeId("workspace", "security"),
		};

		expect(isSandboxProfileRef(profile)).toBe(true);
		expect(isSandboxExecutionReceiptRef(execution)).toBe(true);
		expect(isSandboxExecutionReceiptRef({ ...execution, processHandle: 42 })).toBe(false);
		expect(isArtifactRef(artifact)).toBe(true);
		expect(isArtifactRef({ ...artifact, absolutePath: "/tmp/test-report.json" })).toBe(false);
		expect(isArtifactRef({ ...artifact, content: "unbounded body" })).toBe(false);
	});
});
