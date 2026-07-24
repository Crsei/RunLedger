import { describe, expect, it } from "vitest";
import type { ArtifactRef, ApprovalReceiptRef } from "../../../src/runtime/protocol/v3/capability.ts";
import {
	validateControlPlaneV2PlanContextMemoryCommand,
	validateControlPlaneV2PlanContextMemoryQuery,
	type MemoryProposeCommandV2,
	type PlanEnterCommandV2,
	type PlanResolveCommandV2,
} from "../../../src/runtime/control-plane/plan-context-memory-contracts.ts";
import { createIdempotencyKey } from "../../../src/runtime/protocol/v3/coordination.ts";
import { createSessionEventStreamRef } from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";

const authorityId = createRuntimeId("authority", "pcm-contract");
const tenantId = createRuntimeId("tenant", "pcm-contract");
const principalId = createRuntimeId("principal", "pcm-contract");
const sessionId = createRuntimeId("session", "pcm-contract");
const digest = "a".repeat(64);
const handle = { handleId: "handle_0123456789abcdef", sessionId, generation: 3 };
const expectedSessionRevision = {
	stream: createSessionEventStreamRef({ authorityId, tenantId }, sessionId),
	sequence: 7,
	eventHash: digest,
};

function base(commandId: string) {
	return {
		kind: "command" as const,
		commandId: createRuntimeId("command", commandId),
		idempotencyKey: createIdempotencyKey(`${commandId}-contract-key`),
		authorityId,
		tenantId,
		principalId,
		expectedSessionRevision,
		expectedDomainRevision: 2,
		sessionHandle: handle,
	};
}

function artifact(seed: string): ArtifactRef {
	return {
		authorityId,
		tenantId,
		artifactId: createRuntimeId("artifact", seed),
		storedDigest: digest,
		kind: "session_report",
		originalSize: 10,
		storedSize: 10,
		mediaType: "application/json",
		redaction: "redacted",
		transformReceipt: createRuntimeId("receipt", `${seed}-transform`),
	};
}

function receipt(approvalId = createRuntimeId("approval", "plan")): ApprovalReceiptRef {
	return {
		authorityId,
		tenantId,
		principalId,
		receiptId: createRuntimeId("receipt", "plan-resolution"),
		approvalId,
		requestId: createRuntimeId("command", "approval-request"),
		requestDigest: digest,
		ticketDigest: digest,
		decision: "allowed",
		decisionRevision: 1,
		decidedBy: principalId,
		decidedAt: "2026-07-24T00:00:00.000Z",
		receiptDigest: digest,
		evidenceComplete: true,
		evidenceTruncated: false,
		originalInputDigest: digest,
	};
}

describe("Plan/Context/Memory Control Plane v2 contracts", () => {
	it("accepts exact plan entry and rejects unknown fields or stale handle correlation", () => {
		const command: PlanEnterCommandV2 = {
			...base("plan-enter"),
			type: "plan:enter",
			payload: { sessionId, requestedBy: "user" },
		};
		expect(validateControlPlaneV2PlanContextMemoryCommand(command)).toMatchObject({ ok: true });
		expect(validateControlPlaneV2PlanContextMemoryCommand({
			...command,
			payload: { ...command.payload, unknown: true },
		})).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		expect(validateControlPlaneV2PlanContextMemoryCommand({
			...command,
			payload: { ...command.payload, sessionId: createRuntimeId("session", "other") },
		})).toMatchObject({ ok: false, error: { code: "invalid_request" } });
	});

	it("binds plan approval to the exact approval receipt", () => {
		const approvalId = createRuntimeId("approval", "plan");
		const command: PlanResolveCommandV2 = {
			...base("plan-resolve"),
			type: "plan:resolve",
			payload: {
				sessionId,
				approvalId,
				planId: createRuntimeId("plan", "current"),
				action: "approve_same_session",
				expectedModeRevision: 4,
				expectedPlanRevision: 3,
				contentDigest: digest,
				resolutionReceipt: receipt(approvalId),
			},
		};
		expect(validateControlPlaneV2PlanContextMemoryCommand(command)).toMatchObject({ ok: true });
		expect(validateControlPlaneV2PlanContextMemoryCommand({
			...command,
			payload: {
				...command.payload,
				resolutionReceipt: receipt(createRuntimeId("approval", "other")),
			},
		})).toMatchObject({ ok: false, error: { code: "invalid_request" } });
	});

	it("requires optimistic concurrency for every non-create memory proposal", () => {
		const command: MemoryProposeCommandV2 = {
			...base("memory-propose"),
			type: "memory:propose",
			payload: {
				sessionId,
				operation: "update",
				expectedMemoryRevision: 2,
				expectedContentDigest: digest,
				draftArtifact: artifact("memory-draft"),
				diffArtifact: artifact("memory-diff"),
				proposalDigest: digest,
			},
		};
		expect(validateControlPlaneV2PlanContextMemoryCommand(command)).toMatchObject({ ok: true });
		expect(validateControlPlaneV2PlanContextMemoryCommand({
			...command,
			payload: {
				...command.payload,
				expectedMemoryRevision: null,
				expectedContentDigest: null,
			},
		})).toMatchObject({ ok: false, error: { code: "invalid_request" } });
	});

	it("validates bounded queries and exact session-handle correlation", () => {
		const query = {
			kind: "query",
			type: "memory:list",
			queryId: "memory-list",
			authorityId,
			tenantId,
			principalId,
			payload: {
				sessionId,
				sessionHandle: handle,
				statuses: ["approved"],
				cursor: null,
				limit: 50,
			},
		};
		expect(validateControlPlaneV2PlanContextMemoryQuery(query)).toMatchObject({ ok: true });
		expect(validateControlPlaneV2PlanContextMemoryQuery({
			...query,
			payload: { ...query.payload, limit: 101 },
		})).toMatchObject({ ok: false, error: { code: "invalid_request" } });
	});
});
