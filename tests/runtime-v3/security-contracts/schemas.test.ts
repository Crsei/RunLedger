import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
	ApprovalReceiptRefSchema,
	ApprovalTicketSchema,
	CapabilityClaimSchema,
	CapabilityGatewayResultSchema,
	CapabilityRequestRefSchema,
	SandboxExecutionReceiptRefSchema,
	SandboxProfileRefSchema,
	ToolInvocationRequestSchema,
	approvalReceiptMatchesTicket,
	approvalTicketDigest,
	approvalTicketRequestDigest,
	isApprovalTicket,
	isApprovalTicketExpired,
	isToolInvocationRequest,
	type ApprovalReceiptRef,
	type ApprovalTicket,
	type CapabilityClaim,
	type CapabilityRequestRef,
	type SandboxExecutionReceiptRef,
} from "../../../src/runtime/protocol/v3/capability.ts";
import type { RuntimeEventPayloadMap } from "../../../src/runtime/protocol/v3/event-payloads.ts";
import type { RuntimeEventType } from "../../../src/runtime/protocol/v3/event-catalog.ts";
import {
	RUNTIME_SCHEMA_VERSION,
	createSessionEventStreamRef,
	type RuntimeEventEnvelopeV3,
} from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	PermissionRequestedPayloadSchema,
	SECURITY_EVENT_PAYLOAD_SCHEMAS,
	SECURITY_RUNTIME_EVENT_TYPES,
	SandboxResolvedPayloadSchema,
} from "../../../src/runtime/protocol/v3/security-events.ts";
import { RUNTIME_EVENT_PAYLOAD_SCHEMAS } from "../../../src/runtime/protocol/v3/event-payloads.ts";
import { validateRuntimeEvent } from "../../../src/runtime/protocol/v3/schemas.ts";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const DIGEST_D = "d".repeat(64);
const AUTHORITY_ID = createRuntimeId("authority", "security");
const TENANT_ID = createRuntimeId("tenant", "security");
const PRINCIPAL_ID = createRuntimeId("principal", "security");
const SESSION_ID = createRuntimeId("session", "security");
const RUNTIME_ID = createRuntimeId("runtime", "security");
const TURN_ID = createRuntimeId("turn", "security");
const TOOL_CALL_ID = createRuntimeId("toolCall", "security");
const REQUEST_ID = createRuntimeId("command", "security-request");
const APPROVAL_ID = createRuntimeId("approval", "security");

function claim(): CapabilityClaim {
	return {
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		name: "workspace_write",
		resourceKind: "filesystem",
		resourceDigest: DIGEST_A,
		constraintsDigest: DIGEST_B,
	};
}

function request(): CapabilityRequestRef {
	return {
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		principalId: PRINCIPAL_ID,
		requestId: REQUEST_ID,
		approvalId: APPROVAL_ID,
		sessionId: SESSION_ID,
		runtimeId: RUNTIME_ID,
		runtimeGeneration: 1,
		turnId: TURN_ID,
		toolCallId: TOOL_CALL_ID,
		capability: "workspace_write",
		argumentsDigest: DIGEST_A,
		workspaceEnvelopeDigest: DIGEST_B,
		policyDigest: DIGEST_C,
		serverScope: "tool_server",
		resourceScopeDigest: DIGEST_A,
		commandScopeDigest: DIGEST_B,
	};
}

function ticket(): ApprovalTicket {
	return {
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		principalId: PRINCIPAL_ID,
		approvalId: APPROVAL_ID,
		request: request(),
		scope: "once",
		createdAt: "2026-07-22T00:00:00.000Z",
		expiresAt: "2026-07-22T00:05:00.000Z",
	};
}

function receipt(decision: ApprovalReceiptRef["decision"] = "allowed"): ApprovalReceiptRef {
	const value = ticket();
	return {
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		principalId: PRINCIPAL_ID,
		receiptId: createRuntimeId("receipt", `approval-${decision}`),
		approvalId: APPROVAL_ID,
		requestId: REQUEST_ID,
		requestDigest: approvalTicketRequestDigest(value),
		ticketDigest: approvalTicketDigest(value),
		decision,
		decisionRevision: 1,
		decidedAt: decision === "expired" ? "2026-07-22T00:05:00.000Z" : "2026-07-22T00:01:00.000Z",
		expiresAt: value.expiresAt,
		evidenceComplete: true,
		evidenceTruncated: false,
		originalInputDigest: value.request.argumentsDigest,
		...(decision === "revoked" ? { revokedAt: "2026-07-22T00:02:00.000Z" } : {}),
		receiptDigest: DIGEST_D,
	};
}

function workspaceEnvelope() {
	return {
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		principalId: PRINCIPAL_ID,
		sessionId: SESSION_ID,
		workspaceId: createRuntimeId("workspace", "security"),
		repositoryId: createRuntimeId("repository", "security"),
		worktreePath: "/workspace/security",
		branch: "runtime/security",
		baseCommit: "1".repeat(40),
		agentId: createRuntimeId("agent", "security"),
		toolCallId: createRuntimeId("toolCall", "security"),
		traceId: createRuntimeId("trace", "security-envelope"),
		cwd: "/workspace/security",
		ownerRuntimeId: createRuntimeId("runtime", "security"),
		leaseRevision: 1,
		fencingToken: "opaque-fence",
	};
}

function event<TType extends RuntimeEventType>(
	type: TType,
	payload: RuntimeEventPayloadMap[TType],
): RuntimeEventEnvelopeV3<TType> {
	return {
		schemaVersion: RUNTIME_SCHEMA_VERSION,
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		principalId: PRINCIPAL_ID,
		eventId: createRuntimeId("event", `security-${type.replaceAll(".", "-")}`),
		stream: createSessionEventStreamRef({ authorityId: AUTHORITY_ID, tenantId: TENANT_ID }, SESSION_ID),
		sequence: 1,
		timestamp: "2026-07-22T00:00:00.000Z",
		type,
		previousEventHash: DIGEST_A,
		payloadDigest: DIGEST_B,
		currentEventHash: DIGEST_C,
		traceId: createRuntimeId("trace", "security-event"),
		payload,
	};
}

describe("Phase 3 capability and approval exact schemas", () => {
	it("round-trips claims and request refs without accepting unknown or missing fields", () => {
		const value = claim();
		const requestRef = request();
		expect(Check(CapabilityClaimSchema, value)).toBe(true);
		expect(Check(CapabilityRequestRefSchema, requestRef)).toBe(true);
		expect(Check(CapabilityClaimSchema, { ...value, credential: "secret" })).toBe(false);
		expect(Check(CapabilityClaimSchema, { ...value, constraintsDigest: undefined })).toBe(false);
		expect(Check(CapabilityRequestRefSchema, { ...requestRef, capability: "unknown" })).toBe(false);
	});

	it("binds ticket scope and receipt to the exact request, expiry, and revocation", () => {
		const value = ticket();
		const allowed = receipt("allowed");
		const expired = receipt("expired");
		const revoked = receipt("revoked");
		expect(Check(ApprovalTicketSchema, value)).toBe(true);
		expect(isApprovalTicket(value)).toBe(true);
		expect(Check(ApprovalReceiptRefSchema, allowed)).toBe(true);
		expect(approvalReceiptMatchesTicket(allowed, value)).toBe(true);
		expect(approvalReceiptMatchesTicket(expired, value)).toBe(true);
		expect(approvalReceiptMatchesTicket(revoked, value)).toBe(true);
		expect(approvalReceiptMatchesTicket({ ...allowed, requestDigest: DIGEST_A }, value)).toBe(false);
		expect(approvalReceiptMatchesTicket({ ...allowed, tenantId: createRuntimeId("tenant", "other") }, value)).toBe(false);
		expect(Check(ApprovalReceiptRefSchema, { ...revoked, revokedAt: undefined })).toBe(false);
		expect(isApprovalTicketExpired(value, new Date("2026-07-22T00:04:59.999Z"))).toBe(false);
		expect(isApprovalTicketExpired(value, new Date("2026-07-22T00:05:00.000Z"))).toBe(true);
	});

	it("separates requested, resolved, and effective sandbox state", () => {
		const profile = {
			authorityId: AUTHORITY_ID,
			tenantId: TENANT_ID,
			profileId: createRuntimeId("resource", "sandbox-profile"),
			requested: "strict" as const,
			policyDigest: DIGEST_A,
		};
		const unavailable: SandboxExecutionReceiptRef = {
			authorityId: AUTHORITY_ID,
			tenantId: TENANT_ID,
			principalId: PRINCIPAL_ID,
			receiptId: createRuntimeId("receipt", "sandbox-unavailable"),
			requestId: REQUEST_ID,
			profileId: profile.profileId,
			requested: "strict",
			resolved: "read-only",
			policyDigest: DIGEST_A,
			backendId: "bwrap",
			effectiveEnforcement: "unavailable",
			invocationDigest: DIGEST_B,
			reasonDigest: DIGEST_C,
		};
		expect(Check(SandboxProfileRefSchema, profile)).toBe(true);
		expect(Check(SandboxExecutionReceiptRefSchema, unavailable)).toBe(true);
		expect(Check(SandboxExecutionReceiptRefSchema, { ...unavailable, reasonDigest: undefined })).toBe(false);
		expect(
			Check(SandboxExecutionReceiptRefSchema, {
				...unavailable,
				effectiveEnforcement: "enforced",
				reasonDigest: DIGEST_C,
			}),
		).toBe(false);
	});

	it("keeps raw invocation opaque at the port while binding claims to the workspace scope", () => {
		const invocation = {
			requestId: REQUEST_ID,
			toolManifestDigest: DIGEST_A,
			rawArguments: { path: "README.md", authorization: "port-only-fixture" },
			envelope: workspaceEnvelope(),
			requestedClaims: [claim()],
		};
		expect(Check(ToolInvocationRequestSchema, invocation)).toBe(true);
		expect(isToolInvocationRequest(invocation)).toBe(true);
		expect(
			isToolInvocationRequest({
				...invocation,
				requestedClaims: [{ ...claim(), tenantId: createRuntimeId("tenant", "other") }],
			}),
		).toBe(false);
		expect(Check(ToolInvocationRequestSchema, { ...invocation, backend: "local-shell" })).toBe(false);
	});

	it("makes ask/allow/deny explicit without embedding a policy merge algorithm", () => {
		const value = ticket();
		expect(
			Check(CapabilityGatewayResultSchema, {
				requestId: REQUEST_ID,
				decision: "ask",
				decisionDigest: DIGEST_A,
				approvalTicket: value,
			}),
		).toBe(true);
		expect(
			Check(CapabilityGatewayResultSchema, {
				requestId: REQUEST_ID,
				decision: "ask",
				decisionDigest: DIGEST_A,
			}),
		).toBe(false);
	});
});

describe("Phase 3 exact redacted event payloads", () => {
	it("registers every security event with its dedicated schema", () => {
		expect(Object.keys(SECURITY_EVENT_PAYLOAD_SCHEMAS)).toEqual([...SECURITY_RUNTIME_EVENT_TYPES]);
		for (const type of SECURITY_RUNTIME_EVENT_TYPES) {
			expect(RUNTIME_EVENT_PAYLOAD_SCHEMAS[type]).toBe(SECURITY_EVENT_PAYLOAD_SCHEMAS[type]);
		}
	});

	it("accepts only a digest-based request summary and rejects secret-bearing fields", () => {
		const payload: RuntimeEventPayloadMap["permission.requested"] = {
			approvalId: APPROVAL_ID,
			requestId: REQUEST_ID,
			sessionId: SESSION_ID,
			runtimeId: RUNTIME_ID,
			runtimeGeneration: 1,
			turnId: TURN_ID,
			toolCallId: TOOL_CALL_ID,
			capability: "workspace_write",
			resourceKind: "filesystem",
			requestDigest: DIGEST_A,
			policyDigest: DIGEST_B,
			workspaceEnvelopeDigest: DIGEST_C,
			ticketDigest: DIGEST_D,
			scope: "once",
			requestedAt: "2026-07-22T00:00:00.000Z",
			attemptId: createRuntimeId("command", "security-attempt"),
			serverScope: "tool_server",
			resourceScopeDigest: DIGEST_A,
			commandScopeDigest: DIGEST_B,
			evidenceComplete: true,
			evidenceTruncated: false,
			originalInputDigest: DIGEST_C,
			summary: {
				operation: "write",
				toolIdentityDigest: DIGEST_A,
				targetDigest: DIGEST_B,
				environmentKeyDigests: [DIGEST_C],
			},
		};
		expect(Check(PermissionRequestedPayloadSchema, payload)).toBe(true);
		expect(validateRuntimeEvent(event("permission.requested", payload))).toMatchObject({ ok: true });
		expect(
			validateRuntimeEvent({ ...event("permission.requested", payload), payload: { ...payload, command: "curl secret" } }),
		).toMatchObject({ ok: false, code: "unknown_field" });
		expect(
			validateRuntimeEvent({
				...event("permission.requested", payload),
				payload: { ...payload, summary: { ...payload.summary, authorizationHeader: "Bearer secret" } },
			}),
		).toMatchObject({ ok: false, code: "unknown_field" });
		expect(Check(PermissionRequestedPayloadSchema, { ...payload, approvalId: undefined })).toBe(false);
	});

	it("requires an unavailable/degraded reason and rejects unknown versions", () => {
		const unavailable = {
			requestId: REQUEST_ID,
			profileId: createRuntimeId("resource", "sandbox-profile"),
			requested: "strict" as const,
			resolved: "read-only" as const,
			policyDigest: DIGEST_A,
			resolutionReceiptId: createRuntimeId("receipt", "sandbox-resolution"),
			backendId: "bwrap",
			effectiveEnforcement: "unavailable" as const,
			reasonDigest: DIGEST_B,
		};
		expect(Check(SandboxResolvedPayloadSchema, unavailable)).toBe(true);
		expect(Check(SandboxResolvedPayloadSchema, { ...unavailable, reasonDigest: undefined })).toBe(false);
		expect(validateRuntimeEvent({ ...event("sandbox.resolved", unavailable), schemaVersion: 4 })).toMatchObject({
			ok: false,
			code: "unknown_schema_version",
		});
	});
});
