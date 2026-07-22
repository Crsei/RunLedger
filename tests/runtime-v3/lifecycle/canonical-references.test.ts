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
	const approverId = createRuntimeId("principal", `${seed}-approver`);
	const sessionId = createRuntimeId("session", seed);
	const runtimeId = createRuntimeId("runtime", seed);
	const rootAgentId = createRuntimeId("agent", seed);
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
			rootAgentId,
		},
	});
	const approvalId = createRuntimeId("approval", seed);
	const requestId = createRuntimeId("command", `request-${seed}`);
	const turnId = createRuntimeId("turn", seed);
	const toolCallId = createRuntimeId("toolCall", seed);
	await append({
		type: "turn.started",
		principalId,
		traceId: createRuntimeId("trace", `${seed}-turn-started`),
		payload: { turnId, goalId: createRuntimeId("goal", seed) },
	});
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
		type: "tool.requested",
		principalId,
		traceId: createRuntimeId("trace", `${seed}-tool-requested`),
		payload: {
			turnId,
			toolCallId,
			agentId: rootAgentId,
			toolIdentityDigest: DIGEST_A,
			argumentsDigest: DIGEST_B,
		},
	});
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
		approverId,
		runtimeId,
		rootAgentId,
		approvalId,
		requestId,
		turnId,
		toolCallId,
		requestPayload,
		source: new CanonicalEventExternalReferenceSource(store, { authorityId, tenantId, sessionId }),
		scope: { authorityId, tenantId, sessionId },
	};
}

type FixtureContext = Awaited<ReturnType<typeof fixture>>;
type InitialDecision = "allowed" | "denied" | "cancelled";
type ToolTerminal = "tool.finished" | "tool.failed" | "tool.interrupted";

function approvalBody(
	context: FixtureContext,
	decision: InitialDecision,
	receiptId: ApprovalReceiptRef["receiptId"],
	decisionRevision = 1,
	decidedBy = context.approverId,
): Omit<ApprovalReceiptRef, "receiptDigest"> {
	return {
		authorityId: context.authorityId,
		tenantId: context.tenantId,
		principalId: context.principalId,
		receiptId,
		approvalId: context.approvalId,
		requestId: context.requestId,
		requestDigest: context.requestPayload.requestDigest,
		ticketDigest: context.requestPayload.ticketDigest,
		decision,
		decisionRevision,
		decidedBy,
		decidedAt: DECIDED_AT,
		evidenceComplete: true,
		evidenceTruncated: false,
		originalInputDigest: context.requestPayload.originalInputDigest,
		...(decision === "allowed" ? { expiresAt: EXPIRES_AT } : {}),
	};
}

async function appendDecision(
	context: FixtureContext,
	decision: InitialDecision,
	seed: string,
	decisionRevision = 1,
	decidedBy = context.approverId,
): Promise<ApprovalReceiptRef> {
	const receiptId = createRuntimeId("receipt", seed);
	const body = approvalBody(context, decision, receiptId, decisionRevision, decidedBy);
	const receipt: ApprovalReceiptRef = { ...body, receiptDigest: canonicalDigest(body) };
	await context.append({
		type: "permission.decided",
		principalId: context.principalId,
		traceId: createRuntimeId("trace", `${seed}-decision`),
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
			decision,
			decisionRevision,
			decidedBy,
			receiptId,
			receiptDigest: receipt.receiptDigest,
			decidedAt: DECIDED_AT,
			evidenceComplete: true,
			evidenceTruncated: false,
			originalInputDigest: context.requestPayload.originalInputDigest,
			...(decision === "allowed" ? { expiresAt: EXPIRES_AT } : {}),
		},
	});
	return receipt;
}

async function appendAllowedTransition(
	context: FixtureContext,
	previous: ApprovalReceiptRef,
	decision: "expired" | "revoked",
	seed: string,
	decisionRevision = previous.decisionRevision + 1,
	decidedBy = previous.decidedBy,
): Promise<ApprovalReceiptRef> {
	const occurredAt = "2026-07-23T00:02:00.000Z";
	const receiptId = createRuntimeId("receipt", seed);
	const { receiptDigest: _previousDigest, ...previousBody } = previous;
	const body: Omit<ApprovalReceiptRef, "receiptDigest"> = {
		...previousBody,
		receiptId,
		decision,
		decisionRevision,
		decidedBy,
		decidedAt: occurredAt,
		...(decision === "revoked" ? { revokedAt: occurredAt } : {}),
	};
	const receipt: ApprovalReceiptRef = { ...body, receiptDigest: canonicalDigest(body) };
	const binding = {
		approvalId: context.approvalId,
		requestId: context.requestId,
		sessionId: context.scope.sessionId,
		runtimeId: context.runtimeId,
		runtimeGeneration: 1,
		turnId: context.turnId,
		toolCallId: context.toolCallId,
		requestDigest: context.requestPayload.requestDigest,
		ticketDigest: context.requestPayload.ticketDigest,
		decisionRevision,
		decidedBy,
		receiptId,
		receiptDigest: receipt.receiptDigest,
	};
	await context.append(
		decision === "expired"
			? {
				type: "permission.expired",
				principalId: context.principalId,
				traceId: createRuntimeId("trace", `${seed}-expired`),
				payload: { ...binding, expiredAt: occurredAt },
			}
			: {
				type: "permission.revoked",
				principalId: context.principalId,
				traceId: createRuntimeId("trace", `${seed}-revoked`),
				payload: { ...binding, revokedAt: occurredAt },
			},
	);
	return receipt;
}

async function appendAuthorization(context: FixtureContext, receipt: ApprovalReceiptRef, seed: string): Promise<void> {
	await context.append({
		type: "tool.authorized",
		principalId: context.principalId,
		traceId: createRuntimeId("trace", `${seed}-authorized`),
		payload: {
			toolCallId: context.toolCallId,
			requestId: context.requestId,
			decisionReceiptId: createRuntimeId("receipt", `${seed}-authorization`),
			approvalId: context.approvalId,
			sessionId: context.scope.sessionId,
			runtimeId: context.runtimeId,
			runtimeGeneration: 1,
			turnId: context.turnId,
			capability: context.requestPayload.capability,
			requestDigest: context.requestPayload.requestDigest,
			policyDigest: context.requestPayload.policyDigest,
			workspaceEnvelopeDigest: context.requestPayload.workspaceEnvelopeDigest,
			sandboxResolutionReceiptId: createRuntimeId("receipt", `${seed}-sandbox`),
			approvalReceiptId: receipt.receiptId,
			approvalReceiptDigest: receipt.receiptDigest,
			approvalDecisionRevision: receipt.decisionRevision,
		},
	});
}

async function appendToolStart(context: FixtureContext, seed: string): Promise<void> {
	await context.append({
		type: "tool.started",
		principalId: context.principalId,
		traceId: createRuntimeId("trace", `${seed}-started`),
		payload: {
			toolCallId: context.toolCallId,
			invocationDigest: DIGEST_C,
			workspaceReceiptId: createRuntimeId("receipt", `${seed}-workspace`),
		},
	});
}

async function appendToolTerminal(context: FixtureContext, terminal: ToolTerminal, seed: string): Promise<void> {
	if (terminal === "tool.finished") {
		await context.append({
			type: terminal,
			principalId: context.principalId,
			traceId: createRuntimeId("trace", `${seed}-finished`),
			payload: { toolCallId: context.toolCallId, resultDigest: DIGEST_D },
		});
		return;
	}
	if (terminal === "tool.failed") {
		await context.append({
			type: terminal,
			principalId: context.principalId,
			traceId: createRuntimeId("trace", `${seed}-failed`),
			payload: {
				toolCallId: context.toolCallId,
				error: { code: "tool_failed", messageDigest: DIGEST_D, retryable: false },
				outcomeCertain: true,
			},
		});
		return;
	}
	await context.append({
		type: terminal,
		principalId: context.principalId,
		traceId: createRuntimeId("trace", `${seed}-interrupted`),
		payload: { toolCallId: context.toolCallId, reason: "interrupted", outcomeCertain: true },
	});
}

async function appendValidToolTerminal(
	context: FixtureContext,
	receipt: ApprovalReceiptRef,
	terminal: ToolTerminal,
	seed: string,
): Promise<void> {
	await appendAuthorization(context, receipt, seed);
	await appendToolStart(context, seed);
	await appendToolTerminal(context, terminal, seed);
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
			decidedBy: context.approverId,
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
			decidedBy: context.approverId,
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
			decidedBy: context.approverId,
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
				decidedBy: context.approverId,
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
			decidedBy: context.approverId,
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

	it.each(["denied", "cancelled"] as const)(
		"does not project a %s decision as an active dependency",
		async (decision) => {
			const context = await fixture(`inactive-${decision}`);
			await appendDecision(context, decision, `inactive-${decision}`);

			const projected = await context.source.loadReferences(context.scope);

			expect(projected.ok).toBe(true);
			if (!projected.ok) throw new Error(projected.error.message);
			expect(projected.value.approvalDecisions).toEqual([]);
		},
	);

	it("keeps an allowed receipt active through authorization and start, then consumes it at matching finish", async () => {
		const context = await fixture("allowed-active-until-finish");
		const allowed = await appendDecision(context, "allowed", "allowed-active-until-finish");

		let projected = await context.source.loadReferences(context.scope);
		expect(projected).toMatchObject({ ok: true, value: { approvalDecisions: [allowed] } });

		await appendAuthorization(context, allowed, "allowed-active-until-finish");
		projected = await context.source.loadReferences(context.scope);
		expect(projected).toMatchObject({ ok: true, value: { approvalDecisions: [allowed] } });

		await appendToolStart(context, "allowed-active-until-finish");
		projected = await context.source.loadReferences(context.scope);
		expect(projected).toMatchObject({ ok: true, value: { approvalDecisions: [allowed] } });

		await appendToolTerminal(context, "tool.finished", "allowed-active-until-finish");
		projected = await context.source.loadReferences(context.scope);
		expect(projected).toMatchObject({ ok: true, value: { approvalDecisions: [] } });
	});

	it("does not consume an allowed receipt for a complete unrelated tool lifecycle", async () => {
		const context = await fixture("unrelated-tool-terminal");
		const allowed = await appendDecision(context, "allowed", "unrelated-tool-terminal");
		const otherToolCallId = createRuntimeId("toolCall", "unrelated-tool-terminal-other");
		const otherRequestId = createRuntimeId("command", "unrelated-tool-terminal-other");
		await context.append({
			type: "tool.requested",
			principalId: context.principalId,
			traceId: createRuntimeId("trace", "unrelated-tool-requested"),
			payload: {
				turnId: context.turnId,
				toolCallId: otherToolCallId,
				agentId: context.rootAgentId,
				toolIdentityDigest: DIGEST_A,
				argumentsDigest: DIGEST_B,
			},
		});
		await context.append({
			type: "tool.authorized",
			principalId: context.principalId,
			traceId: createRuntimeId("trace", "unrelated-tool-authorized"),
			payload: {
				toolCallId: otherToolCallId,
				requestId: otherRequestId,
				decisionReceiptId: createRuntimeId("receipt", "unrelated-tool-authorization"),
				approvalId: createRuntimeId("approval", "unrelated-tool-terminal-other"),
				sessionId: context.scope.sessionId,
				runtimeId: context.runtimeId,
				runtimeGeneration: 1,
				turnId: context.turnId,
				capability: "workspace_write",
				requestDigest: DIGEST_A,
				policyDigest: DIGEST_B,
				workspaceEnvelopeDigest: DIGEST_C,
				sandboxResolutionReceiptId: createRuntimeId("receipt", "unrelated-tool-sandbox"),
			},
		});
		await context.append({
			type: "tool.started",
			principalId: context.principalId,
			traceId: createRuntimeId("trace", "unrelated-tool-started"),
			payload: {
				toolCallId: otherToolCallId,
				invocationDigest: DIGEST_C,
				workspaceReceiptId: createRuntimeId("receipt", "unrelated-tool-workspace"),
			},
		});
		await context.append({
			type: "tool.finished",
			principalId: context.principalId,
			traceId: createRuntimeId("trace", "unrelated-tool-finished"),
			payload: { toolCallId: otherToolCallId, resultDigest: DIGEST_D },
		});

		const projected = await context.source.loadReferences(context.scope);

		expect(projected).toMatchObject({ ok: true, value: { approvalDecisions: [allowed] } });
	});

	it("fails closed when tool authorization names an unjournaled approval receipt", async () => {
		const context = await fixture("unjournaled-tool-approval");
		await context.append({
			type: "tool.authorized",
			principalId: context.principalId,
			traceId: createRuntimeId("trace", "unjournaled-tool-approval"),
			payload: {
				toolCallId: createRuntimeId("toolCall", "unjournaled-tool-approval"),
				requestId: createRuntimeId("command", "unjournaled-tool-approval"),
				decisionReceiptId: createRuntimeId("receipt", "unjournaled-tool-approval-decision"),
				approvalId: createRuntimeId("approval", "unjournaled-tool-approval"),
				sessionId: context.scope.sessionId,
				runtimeId: context.runtimeId,
				runtimeGeneration: 1,
				turnId: context.turnId,
				capability: "workspace_write",
				requestDigest: DIGEST_A,
				policyDigest: DIGEST_B,
				workspaceEnvelopeDigest: DIGEST_C,
				sandboxResolutionReceiptId: createRuntimeId("receipt", "unjournaled-tool-approval-sandbox"),
				approvalReceiptId: createRuntimeId("receipt", "unjournaled-tool-approval-receipt"),
				approvalReceiptDigest: DIGEST_D,
				approvalDecisionRevision: 1,
			},
		});

		const projected = await context.source.loadReferences(context.scope);

		expect(projected).toMatchObject({ ok: false, error: { code: "integrity_failed" } });
	});

	it.each(["none", "authorized_only"] as const)(
		"requires authorized -> started -> terminal before consuming an allowed receipt (%s)",
		async (prefix) => {
			const context = await fixture(`incomplete-tool-${prefix}`);
			const allowed = await appendDecision(context, "allowed", `incomplete-tool-${prefix}`);
			if (prefix === "authorized_only") {
				await appendAuthorization(context, allowed, `incomplete-tool-${prefix}`);
			}
			await appendToolTerminal(context, "tool.failed", `incomplete-tool-${prefix}`);

			const projected = await context.source.loadReferences(context.scope);

			expect(projected).toMatchObject({ ok: true, value: { approvalDecisions: [allowed] } });
		},
	);

	it.each(["tool.failed", "tool.interrupted"] as const)(
		"consumes an allowed receipt after a matching authorized and started %s",
		async (terminal) => {
			const context = await fixture(`allowed-${terminal}`);
			const allowed = await appendDecision(context, "allowed", `allowed-${terminal}`);
			await appendValidToolTerminal(context, allowed, terminal, `allowed-${terminal}`);

			const projected = await context.source.loadReferences(context.scope);

			expect(projected).toMatchObject({ ok: true, value: { approvalDecisions: [] } });
		},
	);

	it.each(["expired", "revoked"] as const)(
		"keeps a %s transition as an active blocker until the already-authorized tool terminates",
		async (decision) => {
			const context = await fixture(`active-${decision}-blocker`);
			const allowed = await appendDecision(context, "allowed", `active-${decision}-allowed`);
			await appendAuthorization(context, allowed, `active-${decision}-tool`);
			await appendToolStart(context, `active-${decision}-tool`);
			const blocker = await appendAllowedTransition(context, allowed, decision, `active-${decision}-blocker`);

			let projected = await context.source.loadReferences(context.scope);
			expect(projected).toMatchObject({ ok: true, value: { approvalDecisions: [blocker] } });

			await appendToolTerminal(context, "tool.finished", `active-${decision}-tool`);
			projected = await context.source.loadReferences(context.scope);
			expect(projected).toMatchObject({ ok: true, value: { approvalDecisions: [] } });
		},
	);

	it.each([
		{ label: "initial revision gap", seed: "initial-gap", initialRevision: 2, transitionRevision: undefined },
		{ label: "transition revision reuse", seed: "transition-reuse", initialRevision: 1, transitionRevision: 1 },
		{ label: "transition revision gap", seed: "transition-gap", initialRevision: 1, transitionRevision: 3 },
	] as const)("fails closed on $label", async ({ seed, initialRevision, transitionRevision }) => {
		const context = await fixture(`revision-${seed}`);
		const allowed = await appendDecision(context, "allowed", `revision-${seed}`, initialRevision);
		if (transitionRevision !== undefined) {
			await appendAllowedTransition(context, allowed, "revoked", `revision-${seed}-revoked`, transitionRevision);
		}

		const projected = await context.source.loadReferences(context.scope);

		expect(projected).toMatchObject({ ok: false, error: { code: "integrity_failed" } });
	});

	it("attributes a revision transition to its current terminal actor", async () => {
		const context = await fixture("approval-approver-drift");
		const allowed = await appendDecision(context, "allowed", "approval-approver-drift-allowed");
		const revoker = createRuntimeId("principal", "different-revoker");
		await appendAllowedTransition(
			context,
			allowed,
			"revoked",
			"approval-approver-drift-revoked",
			2,
			revoker,
		);

		const projected = await context.source.loadReferences(context.scope);

		expect(projected).toMatchObject({
			ok: true,
			value: { approvalDecisions: [{ decision: "revoked", decidedBy: revoker }] },
		});
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
				decidedBy: context.approverId,
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
