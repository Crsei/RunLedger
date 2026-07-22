import { describe, expect, it } from "vitest";
import type { SandboxExecutionReceiptRef } from "../../../src/runtime/protocol/v3/capability.ts";
import type { RuntimeEventPayloadMap } from "../../../src/runtime/protocol/v3/event-payloads.ts";
import type { RuntimeEventType } from "../../../src/runtime/protocol/v3/event-catalog.ts";
import {
	createSessionEventStreamRef,
	RUNTIME_SCHEMA_VERSION,
	type RuntimeEventEnvelopeV3,
	type RuntimeEventV3,
} from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { reduceSessionSecurityEvents } from "../../../src/runtime/session/security-reducer.ts";
import type { SessionSecurityProjection } from "../../../src/runtime/session/security-projection.ts";
import type { SessionResult } from "../../../src/runtime/session/types.ts";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const DIGEST_D = "d".repeat(64);
const AUTHORITY_ID = createRuntimeId("authority", "security-replay");
const TENANT_ID = createRuntimeId("tenant", "security-replay");
const PRINCIPAL_ID = createRuntimeId("principal", "security-replay");
const SESSION_ID = createRuntimeId("session", "security-replay");
const SESSION_STREAM = createSessionEventStreamRef(
	{ authorityId: AUTHORITY_ID, tenantId: TENANT_ID },
	SESSION_ID,
);
const RUNTIME_ID = createRuntimeId("runtime", "security-replay");
const APPROVAL_ID = createRuntimeId("approval", "security-replay");
const REQUEST_ID = createRuntimeId("command", "security-replay");
const PROFILE_ID = createRuntimeId("resource", "security-sandbox");

function hashFor(sequence: number): string {
	return sequence.toString(16).padStart(64, "0");
}

function event<TType extends RuntimeEventType>(
	type: TType,
	sequence: number,
	payload: RuntimeEventPayloadMap[TType],
): RuntimeEventEnvelopeV3<TType> {
	return {
		schemaVersion: RUNTIME_SCHEMA_VERSION,
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		principalId: PRINCIPAL_ID,
		eventId: createRuntimeId("event", `security-${sequence}`),
		stream: SESSION_STREAM,
		sequence,
		timestamp: "2026-07-22T00:00:00.000Z",
		type,
		previousEventHash: sequence === 0 ? null : hashFor(sequence - 1),
		payloadDigest: DIGEST_A,
		currentEventHash: hashFor(sequence),
		traceId: createRuntimeId("trace", `security-${sequence}`),
		payload,
	};
}

function created(): RuntimeEventV3 {
	return event("session.created", 0, {
		origin: "test",
		runtimeId: RUNTIME_ID,
		featureDigest: DIGEST_A,
		initialGoalId: createRuntimeId("goal", "security-replay"),
		rootAgentId: createRuntimeId("agent", "security-replay"),
	});
}

function requested(sequence = 1): RuntimeEventV3 {
	return event("permission.requested", sequence, {
		approvalId: APPROVAL_ID,
		requestId: REQUEST_ID,
		capability: "workspace_write",
		resourceKind: "filesystem",
		requestDigest: DIGEST_A,
		policyDigest: DIGEST_B,
		workspaceEnvelopeDigest: DIGEST_C,
		ticketDigest: DIGEST_D,
		scope: "once",
		requestedAt: "2026-07-22T00:00:00.000Z",
		expiresAt: "2026-07-22T00:05:00.000Z",
		summary: {
			operation: "write",
			toolIdentityDigest: DIGEST_A,
			targetDigest: DIGEST_B,
			environmentKeyDigests: [],
		},
	});
}

function decided(sequence: number, decision: "allowed" | "denied" | "cancelled" = "allowed"): RuntimeEventV3 {
	return event("permission.decided", sequence, {
		approvalId: APPROVAL_ID,
		requestId: REQUEST_ID,
		requestDigest: DIGEST_A,
		ticketDigest: DIGEST_D,
		decision,
		decisionRevision: 1,
		receiptId: createRuntimeId("receipt", `security-${decision}`),
		receiptDigest: DIGEST_C,
		decidedAt: "2026-07-22T00:01:00.000Z",
		expiresAt: "2026-07-22T00:05:00.000Z",
	});
}

function resultValue(result: SessionResult<SessionSecurityProjection>): SessionSecurityProjection {
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.error.message);
	return result.value;
}

function resultError(result: SessionResult<SessionSecurityProjection>) {
	expect(result.ok).toBe(false);
	if (result.ok) throw new Error("expected security projection failure");
	return result.error;
}

function sandboxReceipt(
	enforcement: "enforced" | "degraded" | "unavailable" | "off",
	invocationDigest = DIGEST_C,
): SandboxExecutionReceiptRef {
	return {
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		principalId: PRINCIPAL_ID,
		receiptId: createRuntimeId("receipt", `sandbox-${enforcement}`),
		requestId: REQUEST_ID,
		profileId: PROFILE_ID,
		requested: "strict",
		resolved: "read-only",
		policyDigest: DIGEST_A,
		backendId: "bwrap",
		effectiveEnforcement: enforcement,
		invocationDigest,
		...(enforcement === "degraded" || enforcement === "unavailable" ? { reasonDigest: DIGEST_B } : {}),
	};
}

describe("SessionSecurityReducer approval replay", () => {
	it("leaves a crash-time request pending without re-running a decision", () => {
		const first = resultValue(reduceSessionSecurityEvents([created(), requested()]));
		const replayed = resultValue(reduceSessionSecurityEvents([created(), requested()]));
		expect(first.approvals).toEqual([
			expect.objectContaining({ approvalId: APPROVAL_ID, status: "pending", decisionRevision: null }),
		]);
		expect(first.pendingApprovalIds).toEqual([APPROVAL_ID]);
		expect(first.replayBlockers).toEqual(["pending_approval"]);
		expect(replayed).toEqual(first);
	});

	it("projects an identical duplicate decision idempotently and rejects a conflicting duplicate", () => {
		const duplicate = decided(3);
		const projection = resultValue(
			reduceSessionSecurityEvents([created(), requested(), decided(2), duplicate]),
		);
		expect(projection.approvals[0]).toMatchObject({
			status: "allowed",
			decisionRevision: 1,
			duplicateCount: 1,
		});
		expect(projection.pendingApprovalIds).toEqual([]);
		expect(projection.duplicateEventCount).toBe(1);
		expect(projection.replayBlockers).toEqual([]);

		const conflict = event("permission.decided", 3, {
			...decided(2).payload,
			decision: "denied",
			receiptId: createRuntimeId("receipt", "security-conflict"),
		});
		expect(resultError(reduceSessionSecurityEvents([created(), requested(), decided(2), conflict])).code).toBe(
			"invalid_event",
		);
	});

	it("applies monotonic expiry and revocation receipts", () => {
		const expired = event("permission.expired", 2, {
			approvalId: APPROVAL_ID,
			requestId: REQUEST_ID,
			requestDigest: DIGEST_A,
			ticketDigest: DIGEST_D,
			decisionRevision: 1,
			expiredAt: "2026-07-22T00:05:00.000Z",
			receiptId: createRuntimeId("receipt", "security-expired"),
			receiptDigest: DIGEST_C,
		});
		expect(resultValue(reduceSessionSecurityEvents([created(), requested(), expired])).approvals[0]).toMatchObject({
			status: "expired",
			decisionRevision: 1,
		});

		const revoked = event("permission.revoked", 3, {
			approvalId: APPROVAL_ID,
			requestId: REQUEST_ID,
			requestDigest: DIGEST_A,
			ticketDigest: DIGEST_D,
			decisionRevision: 2,
			revokedAt: "2026-07-22T00:02:00.000Z",
			receiptId: createRuntimeId("receipt", "security-revoked"),
			receiptDigest: DIGEST_D,
		});
		expect(
			resultValue(reduceSessionSecurityEvents([created(), requested(), decided(2), revoked])).approvals[0],
		).toMatchObject({ status: "revoked", decisionRevision: 2 });

		const stale = event("permission.revoked", 3, { ...revoked.payload, decisionRevision: 1 });
		expect(resultError(reduceSessionSecurityEvents([created(), requested(), decided(2), stale])).code).toBe(
			"invalid_event",
		);
	});
});

describe("SessionSecurityReducer sandbox and authorization replay", () => {
	it("surfaces unavailable sandbox as a stable replay blocker", () => {
		const resolved = event("sandbox.resolved", 1, {
			requestId: REQUEST_ID,
			profileId: PROFILE_ID,
			requested: "strict",
			resolved: "read-only",
			policyDigest: DIGEST_A,
			resolutionReceiptId: createRuntimeId("receipt", "sandbox-resolution"),
			backendId: "bwrap",
			effectiveEnforcement: "unavailable",
			reasonDigest: DIGEST_B,
		});
		const duplicate = event("sandbox.resolved", 2, resolved.payload);
		const projection = resultValue(reduceSessionSecurityEvents([created(), resolved, duplicate]));
		expect(projection.sandboxes[0]).toMatchObject({
			requested: "strict",
			resolved: "read-only",
			effectiveEnforcement: "unavailable",
			reasonDigest: DIGEST_B,
			duplicateCount: 1,
		});
		expect(projection.unavailableSandboxRequestIds).toEqual([REQUEST_ID]);
		expect(projection.replayBlockers).toEqual(["sandbox_unavailable"]);
	});

	it("binds an execution receipt to resolution, invocation, identity, and degraded reason", () => {
		const resolved = event("sandbox.resolved", 1, {
			requestId: REQUEST_ID,
			profileId: PROFILE_ID,
			requested: "strict",
			resolved: "read-only",
			policyDigest: DIGEST_A,
			resolutionReceiptId: createRuntimeId("receipt", "sandbox-resolution"),
			backendId: "bwrap",
			effectiveEnforcement: "degraded",
			reasonDigest: DIGEST_B,
		});
		const recorded = event("sandbox.execution_recorded", 2, {
			requestId: REQUEST_ID,
			invocationDigest: DIGEST_C,
			receipt: sandboxReceipt("degraded"),
		});
		const duplicate = event("sandbox.execution_recorded", 3, recorded.payload);
		const projection = resultValue(reduceSessionSecurityEvents([created(), resolved, recorded, duplicate]));
		expect(projection.sandboxes[0]).toMatchObject({
			executionReceiptId: createRuntimeId("receipt", "sandbox-degraded"),
			invocationDigest: DIGEST_C,
			duplicateCount: 1,
		});

		const mismatched = event("sandbox.execution_recorded", 2, {
			...recorded.payload,
			receipt: sandboxReceipt("degraded", DIGEST_D),
		});
		expect(resultError(reduceSessionSecurityEvents([created(), resolved, mismatched])).code).toBe("invalid_event");
	});

	it("deduplicates the same tool authorization without executing anything", () => {
		const authorized = event("tool.authorized", 1, {
			toolCallId: createRuntimeId("toolCall", "security"),
			requestId: REQUEST_ID,
			decisionReceiptId: createRuntimeId("receipt", "security-authorization"),
			sandboxResolutionReceiptId: createRuntimeId("receipt", "sandbox-resolution"),
		});
		const projection = resultValue(
			reduceSessionSecurityEvents([created(), authorized, event("tool.authorized", 2, authorized.payload)]),
		);
		expect(projection.toolAuthorizations[0]).toMatchObject({ duplicateCount: 1 });
		expect(projection.duplicateEventCount).toBe(1);
	});
});
