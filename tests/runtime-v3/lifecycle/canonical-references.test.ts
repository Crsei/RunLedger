import { describe, expect, it } from "vitest";
import {
	isApprovalReceiptRef,
	type ApprovalReceiptRef,
} from "../../../src/runtime/protocol/v3/capability.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createSessionEventStreamRef } from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { CanonicalEventExternalReferenceSource } from "../../../src/runtime/lifecycle/canonical-references.ts";
import { EventWriter } from "../../../src/runtime/session/event-writer.ts";
import { MemoryEventStore } from "../../../src/runtime/session/memory-event-store.ts";
import type { RuntimeEventDraft } from "../../../src/runtime/session/types.ts";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const DIGEST_D = "d".repeat(64);
const REQUESTED_AT = "2026-07-23T00:00:00.000Z";
const DECIDED_AT = "2026-07-23T00:01:00.000Z";
const EXPIRES_AT = "2026-07-23T00:05:00.000Z";

async function fixture(seed: string) {
	const authorityId = createRuntimeId("authority", seed);
	const tenantId = createRuntimeId("tenant", seed);
	const principalId = createRuntimeId("principal", seed);
	const sessionId = createRuntimeId("session", seed);
	const runtimeId = createRuntimeId("runtime", seed);
	const stream = createSessionEventStreamRef({ authorityId, tenantId }, sessionId);
	const store = new MemoryEventStore({
		authorityId,
		tenantId,
		stream,
		validateFence: () => true,
	});
	const writer = new EventWriter({
		authorityId,
		tenantId,
		stream,
		store,
		fence: {
			authorityId,
			tenantId,
			stream,
			leaseId: createRuntimeId("lease", seed),
			ownerRuntimeId: runtimeId,
			writerEpoch: 1,
			fencingToken: `${seed}-fence`,
		},
		clock: () => new Date(REQUESTED_AT),
	});
	const append = async (draft: RuntimeEventDraft): Promise<void> => {
		const result = await writer.append(draft);
		if (!result.ok) throw new Error(result.error.message);
	};
	await append({
		type: "session.created",
		principalId,
		traceId: createRuntimeId("trace", `${seed}-created`),
		payload: {
			origin: "test",
			runtimeId,
			featureDigest: DIGEST_A,
			initialGoalId: createRuntimeId("goal", seed),
			rootAgentId: createRuntimeId("agent", seed),
		},
	});
	const approvalId = createRuntimeId("approval", seed);
	const requestId = createRuntimeId("command", `request-${seed}`);
	const turnId = createRuntimeId("turn", seed);
	const toolCallId = createRuntimeId("toolCall", seed);
	const requestPayload = {
		approvalId,
		requestId,
		sessionId,
		runtimeId,
		runtimeGeneration: 1,
		turnId,
		toolCallId,
		capability: "workspace_write" as const,
		resourceKind: "filesystem" as const,
		requestDigest: DIGEST_A,
		policyDigest: DIGEST_B,
		workspaceEnvelopeDigest: DIGEST_C,
		ticketDigest: DIGEST_D,
		scope: "once" as const,
		requestedAt: REQUESTED_AT,
		expiresAt: EXPIRES_AT,
		attemptId: createRuntimeId("command", `attempt-${seed}`),
		serverScope: "tool_server" as const,
		resourceScopeDigest: DIGEST_A,
		commandScopeDigest: DIGEST_B,
		evidenceComplete: true as const,
		evidenceTruncated: false as const,
		originalInputDigest: DIGEST_C,
		summary: {
			operation: "write" as const,
			toolIdentityDigest: DIGEST_A,
			targetDigest: DIGEST_B,
			environmentKeyDigests: [],
		},
	};
	await append({
		type: "permission.requested",
		principalId,
		traceId: createRuntimeId("trace", `${seed}-requested`),
		payload: requestPayload,
	});
	return {
		append,
		authorityId,
		tenantId,
		principalId,
		runtimeId,
		approvalId,
		requestId,
		turnId,
		toolCallId,
		requestPayload,
		source: new CanonicalEventExternalReferenceSource(store, { authorityId, tenantId, sessionId }),
		scope: { authorityId, tenantId, sessionId },
	};
}

describe("canonical approval external references", () => {
	it("projects a pending approval expiry into one exact receipt reference", async () => {
		const context = await fixture("approval-expired");
		const receiptId = createRuntimeId("receipt", "approval-expired");
		const receiptBody: Omit<ApprovalReceiptRef, "receiptDigest"> = {
			authorityId: context.authorityId,
			tenantId: context.tenantId,
			principalId: context.principalId,
			receiptId,
			approvalId: context.approvalId,
			requestId: context.requestId,
			requestDigest: context.requestPayload.requestDigest,
			ticketDigest: context.requestPayload.ticketDigest,
			decision: "expired",
			decisionRevision: 1,
			decidedAt: EXPIRES_AT,
			expiresAt: EXPIRES_AT,
			evidenceComplete: true,
			evidenceTruncated: false,
			originalInputDigest: DIGEST_C,
		};
		const expectedReceipt: ApprovalReceiptRef = {
			...receiptBody,
			receiptDigest: canonicalDigest(receiptBody),
		};
		const expiredPayload = {
			approvalId: context.approvalId,
			requestId: context.requestId,
			sessionId: context.scope.sessionId,
			runtimeId: context.runtimeId,
			runtimeGeneration: 1,
			turnId: context.turnId,
			toolCallId: context.toolCallId,
			requestDigest: context.requestPayload.requestDigest,
			ticketDigest: context.requestPayload.ticketDigest,
			decisionRevision: 1,
			expiredAt: EXPIRES_AT,
			receiptId,
			receiptDigest: expectedReceipt.receiptDigest,
		};
		await context.append({
			type: "permission.expired",
			principalId: context.principalId,
			traceId: createRuntimeId("trace", "approval-expired"),
			payload: expiredPayload,
		});
		await context.append({
			type: "permission.expired",
			principalId: context.principalId,
			traceId: createRuntimeId("trace", "approval-expired-duplicate"),
			payload: expiredPayload,
		});

		const projected = await context.source.loadReferences(context.scope);

		expect(projected.ok).toBe(true);
		if (!projected.ok) throw new Error(projected.error.message);
		expect(projected.value.approvalDecisions).toHaveLength(1);
		const receipt = projected.value.approvalDecisions[0];
		expect(isApprovalReceiptRef(receipt)).toBe(true);
		expect(receipt).toEqual(expectedReceipt);
		expect(receipt).not.toHaveProperty("sessionId");
	});

	it("projects revocation from the prior allowed receipt without payload-only fields", async () => {
		const context = await fixture("approval-revoked");
		const allowedReceiptId = createRuntimeId("receipt", "approval-allowed");
		const allowedBody: Omit<ApprovalReceiptRef, "receiptDigest"> = {
			authorityId: context.authorityId,
			tenantId: context.tenantId,
			principalId: context.principalId,
			receiptId: allowedReceiptId,
			approvalId: context.approvalId,
			requestId: context.requestId,
			requestDigest: context.requestPayload.requestDigest,
			ticketDigest: context.requestPayload.ticketDigest,
			decision: "allowed",
			decisionRevision: 1,
			decidedAt: DECIDED_AT,
			expiresAt: EXPIRES_AT,
			evidenceComplete: true,
			evidenceTruncated: false,
			originalInputDigest: DIGEST_C,
		};
		const allowedReceipt: ApprovalReceiptRef = {
			...allowedBody,
			receiptDigest: canonicalDigest(allowedBody),
		};
		await context.append({
			type: "permission.decided",
			principalId: context.principalId,
			traceId: createRuntimeId("trace", "approval-allowed"),
			payload: {
				approvalId: context.approvalId,
				requestId: context.requestId,
				requestDigest: context.requestPayload.requestDigest,
				ticketDigest: context.requestPayload.ticketDigest,
				sessionId: context.scope.sessionId,
				runtimeId: context.runtimeId,
				runtimeGeneration: 1,
				turnId: context.turnId,
				toolCallId: context.toolCallId,
				decision: "allowed",
				decisionRevision: 1,
				receiptId: allowedReceiptId,
				receiptDigest: allowedReceipt.receiptDigest,
				decidedAt: DECIDED_AT,
				expiresAt: EXPIRES_AT,
				evidenceComplete: true,
				evidenceTruncated: false,
				originalInputDigest: DIGEST_C,
			},
		});
		const revokedAt = "2026-07-23T00:02:00.000Z";
		const receiptId = createRuntimeId("receipt", "approval-revoked");
		const revokedBody: Omit<ApprovalReceiptRef, "receiptDigest"> = {
			...allowedBody,
			receiptId,
			decision: "revoked",
			decisionRevision: 2,
			decidedAt: revokedAt,
			revokedAt,
		};
		const expectedReceipt: ApprovalReceiptRef = {
			...revokedBody,
			receiptDigest: canonicalDigest(revokedBody),
		};
		const revokedPayload = {
			approvalId: context.approvalId,
			requestId: context.requestId,
			sessionId: context.scope.sessionId,
			runtimeId: context.runtimeId,
			runtimeGeneration: 1,
			turnId: context.turnId,
			toolCallId: context.toolCallId,
			requestDigest: context.requestPayload.requestDigest,
			ticketDigest: context.requestPayload.ticketDigest,
			decisionRevision: 2,
			revokedAt,
			receiptId,
			receiptDigest: expectedReceipt.receiptDigest,
		};
		await context.append({
			type: "permission.revoked",
			principalId: context.principalId,
			traceId: createRuntimeId("trace", "approval-revoked"),
			payload: revokedPayload,
		});
		await context.append({
			type: "permission.revoked",
			principalId: context.principalId,
			traceId: createRuntimeId("trace", "approval-revoked-duplicate"),
			payload: revokedPayload,
		});

		const projected = await context.source.loadReferences(context.scope);

		expect(projected.ok).toBe(true);
		if (!projected.ok) throw new Error(projected.error.message);
		expect(projected.value.approvalDecisions).toHaveLength(1);
		const receipt = projected.value.approvalDecisions[0];
		expect(isApprovalReceiptRef(receipt)).toBe(true);
		expect(receipt).toEqual(expectedReceipt);
		expect(receipt).not.toHaveProperty("runtimeGeneration");
	});

	it("fails closed on terminal correlation drift that the projection cannot authorize", async () => {
		const context = await fixture("approval-binding-drift");
		await context.append({
			type: "permission.expired",
			principalId: context.principalId,
			traceId: createRuntimeId("trace", "approval-binding-drift"),
			payload: {
				approvalId: context.approvalId,
				requestId: context.requestId,
				sessionId: context.scope.sessionId,
				runtimeId: context.runtimeId,
				runtimeGeneration: 2,
				turnId: context.turnId,
				toolCallId: context.toolCallId,
				requestDigest: context.requestPayload.requestDigest,
				ticketDigest: context.requestPayload.ticketDigest,
				decisionRevision: 1,
				expiredAt: EXPIRES_AT,
				receiptId: createRuntimeId("receipt", "approval-binding-drift"),
				receiptDigest: DIGEST_D,
			},
		});

		const projected = await context.source.loadReferences(context.scope);

		expect(projected).toMatchObject({
			ok: false,
			error: { code: "integrity_failed" },
		});
	});

	it("fails closed when a duplicate request drifts evidence outside reducer fields", async () => {
		const context = await fixture("approval-request-drift");
		await context.append({
			type: "permission.requested",
			principalId: context.principalId,
			traceId: createRuntimeId("trace", "approval-request-drift-duplicate"),
			payload: {
				...context.requestPayload,
				originalInputDigest: DIGEST_D,
			},
		});

		const projected = await context.source.loadReferences(context.scope);

		expect(projected).toMatchObject({
			ok: false,
			error: { code: "integrity_failed" },
		});
	});
});
