/** Approval store/event-log 半提交的启动前精确 reconciliation。 */

import {
	approvalReceiptMatchesTicket,
	approvalTicketDigest,
	approvalTicketRequestDigest,
	isApprovalReceiptRef,
	type ApprovalReceiptRef,
	type ApprovalTicket,
} from "../runtime/protocol/v3/capability.ts";
import { canonicalDigest } from "../runtime/protocol/v3/canonical-json.ts";
import type { RuntimeEventV3 } from "../runtime/protocol/v3/events.ts";
import { parseRuntimeId } from "../runtime/protocol/v3/ids.ts";
import { projectExternalReceiptReferences } from "../runtime/lifecycle/canonical-references.ts";
import type { LifecycleResult } from "../runtime/lifecycle/recovery.ts";
import { readAllRuntimeEvents } from "../runtime/session/snapshot.ts";
import {
	createApprovalSupersessionReceipt,
	SYSTEM_APPROVAL_PRINCIPAL_ID,
	validateApprovalStateCommit,
	type ApprovalStateStorePort,
} from "../security/permission/approval-coordinator.ts";
import type { V3SessionManager } from "./v3-session-manager.ts";

type ApprovalRequestEvent = Extract<RuntimeEventV3, { type: "permission.requested" }>;
type ApprovalTerminalEvent = Extract<
	RuntimeEventV3,
	{ type: "permission.decided" | "permission.expired" | "permission.revoked" }
>;

export interface ApprovalEventReconciliationReport {
	requested: number;
	matched: number;
	appended: number;
	transitioned: number;
}

function failure(
	code: "integrity_failed" | "external_unavailable" | "mutation_failed",
	message: string,
): LifecycleResult<never> {
	return { ok: false, error: { code, message, retryable: false } };
}

function ticketFromRequest(event: ApprovalRequestEvent): ApprovalTicket | undefined {
	const payload = event.payload;
	const approvalId = parseRuntimeId("approval", payload.approvalId);
	const requestId = parseRuntimeId("command", payload.requestId);
	const sessionId = parseRuntimeId("session", payload.sessionId);
	const runtimeId = parseRuntimeId("runtime", payload.runtimeId);
	const turnId = parseRuntimeId("turn", payload.turnId);
	const toolCallId = parseRuntimeId("toolCall", payload.toolCallId);
	if (!approvalId || !requestId || !sessionId || !runtimeId || !turnId || !toolCallId) return undefined;
	const ticket: ApprovalTicket = {
		authorityId: event.authorityId,
		tenantId: event.tenantId,
		principalId: event.principalId,
		approvalId,
		request: {
			authorityId: event.authorityId,
			tenantId: event.tenantId,
			principalId: event.principalId,
			requestId,
			approvalId,
			sessionId,
			runtimeId,
			runtimeGeneration: payload.runtimeGeneration,
			turnId,
			toolCallId,
			capability: payload.capability,
			argumentsDigest: payload.originalInputDigest,
			workspaceEnvelopeDigest: payload.workspaceEnvelopeDigest,
			policyDigest: payload.policyDigest,
			serverScope: payload.serverScope,
			resourceScopeDigest: payload.resourceScopeDigest,
			commandScopeDigest: payload.commandScopeDigest,
		},
		scope: payload.scope,
		createdAt: payload.requestedAt,
		...(payload.expiresAt === undefined ? {} : { expiresAt: payload.expiresAt }),
	};
	return approvalTicketRequestDigest(ticket) === payload.requestDigest &&
		approvalTicketDigest(ticket) === payload.ticketDigest
		? ticket
		: undefined;
}

function terminalDecision(event: ApprovalTerminalEvent): ApprovalReceiptRef["decision"] {
	if (event.type === "permission.expired") return "expired";
	if (event.type === "permission.revoked") return "revoked";
	return event.payload.decision;
}

function terminalMatchesReceipt(event: ApprovalTerminalEvent, receipt: ApprovalReceiptRef): boolean {
	return event.authorityId === receipt.authorityId &&
		event.tenantId === receipt.tenantId &&
		event.principalId === receipt.principalId &&
		event.payload.approvalId === receipt.approvalId &&
		event.payload.requestId === receipt.requestId &&
		event.payload.requestDigest === receipt.requestDigest &&
		event.payload.ticketDigest === receipt.ticketDigest &&
		event.payload.receiptId === receipt.receiptId &&
		event.payload.receiptDigest === receipt.receiptDigest &&
		event.payload.decisionRevision === receipt.decisionRevision &&
		event.payload.decidedBy === receipt.decidedBy &&
		terminalDecision(event) === receipt.decision;
}

function allowedReceiptFromTerminal(
	request: ApprovalRequestEvent,
	event: ApprovalTerminalEvent,
	ticket: ApprovalTicket,
): ApprovalReceiptRef | undefined {
	if (event.type !== "permission.decided" || event.payload.decision !== "allowed") return undefined;
	const payload = event.payload;
	const candidate: ApprovalReceiptRef = {
		authorityId: event.authorityId,
		tenantId: event.tenantId,
		principalId: event.principalId,
		receiptId: payload.receiptId,
		approvalId: payload.approvalId,
		requestId: payload.requestId,
		requestDigest: payload.requestDigest,
		ticketDigest: payload.ticketDigest,
		decision: "allowed",
		decisionRevision: payload.decisionRevision,
		decidedBy: payload.decidedBy,
		decidedAt: payload.decidedAt,
		...(payload.expiresAt === undefined ? {} : { expiresAt: payload.expiresAt }),
		receiptDigest: payload.receiptDigest,
		evidenceComplete: true,
		evidenceTruncated: false,
		originalInputDigest: payload.originalInputDigest,
		...(request.payload.originalArtifactId === undefined
			? {}
			: {
				originalArtifactId: request.payload.originalArtifactId,
				originalArtifactDigest: request.payload.originalArtifactDigest,
			}),
	};
	return isApprovalReceiptRef(candidate) && approvalReceiptMatchesTicket(candidate, ticket)
		? candidate
		: undefined;
}

function terminalCanPrecedeStore(
	request: ApprovalRequestEvent,
	event: ApprovalTerminalEvent,
	receipt: ApprovalReceiptRef,
	ticket: ApprovalTicket,
): boolean {
	if (!(event.type === "permission.decided" &&
		event.payload.decision === "allowed" &&
		(receipt.decision === "expired" || receipt.decision === "revoked") &&
		receipt.decisionRevision === event.payload.decisionRevision + 1)) return false;
	const allowed = allowedReceiptFromTerminal(request, event, ticket);
	if (!allowed) return false;
	const transition = validateApprovalStateCommit(allowed, receipt, allowed.decisionRevision);
	return transition.ok && transition.value === "apply";
}

export async function reconcileApprovalEvents(
	manager: V3SessionManager,
	store: ApprovalStateStorePort,
	clock: () => Date = () => new Date(),
): Promise<LifecycleResult<ApprovalEventReconciliationReport>> {
	const replay = await readAllRuntimeEvents(manager.eventStore());
	if (!replay.ok) return failure("integrity_failed", "approval reconciliation could not replay canonical events");
	const identity = manager.identity();
	const scope = {
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		sessionId: manager.sessionId(),
	};
	const projected = projectExternalReceiptReferences(replay.value, scope);
	if (!projected.ok) return projected;

	const requests = new Map<string, ApprovalRequestEvent>();
	const terminals = new Map<string, ApprovalTerminalEvent>();
	for (const event of replay.value) {
		if (event.type === "permission.requested") {
			const previous = requests.get(event.payload.approvalId);
			if (previous && canonicalDigest(previous.payload) !== canonicalDigest(event.payload)) {
				return failure("integrity_failed", "approval request duplicates disagree during reconciliation");
			}
			requests.set(event.payload.approvalId, event);
		}
		if (event.type === "permission.decided" || event.type === "permission.expired" || event.type === "permission.revoked") {
			terminals.set(event.payload.approvalId, event);
		}
	}

	let matched = 0;
	let appended = 0;
	let transitioned = 0;
	for (const approvalId of [...requests.keys()].sort()) {
		const request = requests.get(approvalId);
		if (!request) continue;
		const ticket = ticketFromRequest(request);
		if (!ticket) return failure("integrity_failed", "canonical approval request digest cannot reconstruct its ticket");
		let current: ApprovalReceiptRef | undefined;
		try {
			current = await store.read(ticket.approvalId);
		} catch {
			return failure("external_unavailable", "approval state store is unavailable during reconciliation");
		}
		const terminal = terminals.get(approvalId);
		if (!current) {
			if (terminal) return failure("integrity_failed", "canonical approval terminal has no authoritative store receipt");
			continue;
		}
		if (!approvalReceiptMatchesTicket(current, ticket)) {
			return failure("integrity_failed", "approval state store receipt does not match the canonical request ticket");
		}
		if (terminal && terminalMatchesReceipt(terminal, current)) {
			matched += 1;
		} else if (terminal && !terminalCanPrecedeStore(request, terminal, current, ticket)) {
			return failure("integrity_failed", "approval store and canonical terminal event disagree");
		} else if (!terminal && (current.decisionRevision !== 1 || current.decision === "revoked")) {
			return failure("integrity_failed", "approval store revision gap cannot be reconstructed safely");
		} else {
			try {
				await manager.sessionEvents().recordApprovalTerminal(ticket, current);
			} catch {
				return failure("mutation_failed", "approval terminal event could not be durably reconciled");
			}
			appended += 1;
		}
		if (
			current.decision === "allowed" &&
			current.expiresAt !== undefined &&
			Date.parse(current.expiresAt) <= clock().getTime()
		) {
			const expired = createApprovalSupersessionReceipt(
				current,
				"expired",
				clock().toISOString(),
				SYSTEM_APPROVAL_PRINCIPAL_ID,
			);
			let committed;
			try {
				committed = await store.commit(expired, current.decisionRevision);
			} catch {
				return failure("external_unavailable", "approval expiry transition could not reach the durable store");
			}
			if (!committed.ok) return failure("integrity_failed", "approval expiry transition lost its exact CAS predecessor");
			current = committed.value;
			transitioned += 1;
			try {
				await manager.sessionEvents().recordApprovalTerminal(ticket, current);
			} catch {
				return failure("mutation_failed", "approval expiry event could not be durably reconciled");
			}
			appended += 1;
		}
	}
	return { ok: true, value: { requested: requests.size, matched, appended, transitioned } };
}
