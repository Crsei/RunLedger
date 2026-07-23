/** Capability/approval/sandbox event 的无副作用 replay reducer。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import type { ApprovalProjectionStatus } from "./security-projection.ts";
import type { RuntimeEventV3 } from "../protocol/v3/events.ts";
import {
	parseRuntimeId,
	type ApprovalId,
	type CommandId,
	type ReceiptId,
	type ResourceId,
	type ToolCallId,
} from "../protocol/v3/ids.ts";
import { isSecurityRuntimeEventType } from "../protocol/v3/security-events.ts";
import type {
	ApprovalSecurityProjection,
	SandboxSecurityProjection,
	SecurityReplayBlocker,
	SessionSecurityProjection,
	SessionSecurityProjectionState,
	ToolAuthorizationSecurityProjection,
} from "./security-projection.ts";
import type { SessionKernelError, SessionResult } from "./types.ts";

interface MutableSecurityProjection {
	authorityId: SessionSecurityProjectionState["authorityId"];
	tenantId: SessionSecurityProjectionState["tenantId"];
	principalId: SessionSecurityProjectionState["principalId"];
	sessionId: SessionSecurityProjectionState["sessionId"];
	approvals: ApprovalSecurityProjection[];
	sandboxes: SandboxSecurityProjection[];
	toolAuthorizations: ToolAuthorizationSecurityProjection[];
	lastSecuritySequence: number | null;
	duplicateEventCount: number;
}

interface ApprovalTerminalBinding {
	approvalId: string;
	requestId: string;
	sessionId: string;
	runtimeId: string;
	runtimeGeneration: number;
	turnId: string;
	toolCallId: string;
	requestDigest: string;
	ticketDigest: string;
	decisionRevision: number;
	receiptId: string;
	receiptDigest: string;
}

function failure<T>(error: SessionKernelError): SessionResult<T> {
	return { ok: false, error };
}

function invalidEvent<T>(message: string, event: RuntimeEventV3): SessionResult<T> {
	return failure({
		code: "invalid_event",
		message,
		retryable: false,
		details: { sequence: event.sequence, eventType: event.type },
	});
}

function findApproval(state: MutableSecurityProjection, approvalId: ApprovalId): number {
	return state.approvals.findIndex((approval) => approval.approvalId === approvalId);
}

function findSandbox(state: MutableSecurityProjection, requestId: CommandId): number {
	return state.sandboxes.findIndex((sandbox) => sandbox.requestId === requestId);
}

function findAuthorization(state: MutableSecurityProjection, toolCallId: ToolCallId): number {
	return state.toolAuthorizations.findIndex((authorization) => authorization.toolCallId === toolCallId);
}

function parseApprovalId(value: string, event: RuntimeEventV3): SessionResult<ApprovalId> {
	const parsed = parseRuntimeId("approval", value);
	return parsed ? { ok: true, value: parsed } : invalidEvent("security event has an invalid approval id", event);
}

function parseCommandId(value: string, event: RuntimeEventV3): SessionResult<CommandId> {
	const parsed = parseRuntimeId("command", value);
	return parsed ? { ok: true, value: parsed } : invalidEvent("security event has an invalid request id", event);
}

function parseReceiptId(value: string, event: RuntimeEventV3): SessionResult<ReceiptId> {
	const parsed = parseRuntimeId("receipt", value);
	return parsed ? { ok: true, value: parsed } : invalidEvent("security event has an invalid receipt id", event);
}

function parseResourceId(value: string, event: RuntimeEventV3): SessionResult<ResourceId> {
	const parsed = parseRuntimeId("resource", value);
	return parsed ? { ok: true, value: parsed } : invalidEvent("security event has an invalid profile id", event);
}

function parseToolCallId(value: string, event: RuntimeEventV3): SessionResult<ToolCallId> {
	const parsed = parseRuntimeId("toolCall", value);
	return parsed ? { ok: true, value: parsed } : invalidEvent("security event has an invalid tool call id", event);
}

function recordDuplicateApproval(
	state: MutableSecurityProjection,
	index: number,
	current: ApprovalSecurityProjection,
): SessionResult<boolean> {
	state.approvals[index] = { ...current, duplicateCount: current.duplicateCount + 1 };
	state.duplicateEventCount += 1;
	return { ok: true, value: true };
}

function recordDuplicateSandbox(
	state: MutableSecurityProjection,
	index: number,
	current: SandboxSecurityProjection,
): SessionResult<boolean> {
	state.sandboxes[index] = { ...current, duplicateCount: current.duplicateCount + 1 };
	state.duplicateEventCount += 1;
	return { ok: true, value: true };
}

function approvalBinding(
	state: MutableSecurityProjection,
	event: RuntimeEventV3,
	payload: ApprovalTerminalBinding,
): SessionResult<{
	index: number;
	current: ApprovalSecurityProjection;
	requestId: CommandId;
	receiptId: ReceiptId;
}> {
	const approvalId = parseApprovalId(payload.approvalId, event);
	if (!approvalId.ok) return approvalId;
	const requestId = parseCommandId(payload.requestId, event);
	if (!requestId.ok) return requestId;
	const receiptId = parseReceiptId(payload.receiptId, event);
	if (!receiptId.ok) return receiptId;
	const index = findApproval(state, approvalId.value);
	const current = state.approvals[index];
	if (index < 0 || !current) return invalidEvent("approval terminal event has no matching request", event);
	if (
		(current.requestId !== null && current.requestId !== requestId.value) ||
		current.requestDigest !== payload.requestDigest ||
		(current.ticketDigest !== null && current.ticketDigest !== payload.ticketDigest)
	) {
		return invalidEvent("approval terminal receipt is not bound to the requested ticket", event);
	}
	if (
		payload.sessionId !== state.sessionId ||
		payload.runtimeId !== current.runtimeId ||
		payload.runtimeGeneration !== current.runtimeGeneration ||
		payload.turnId !== current.turnId ||
		payload.toolCallId !== current.toolCallId
	) {
		return invalidEvent("approval terminal receipt is outside the requested execution correlation", event);
	}
	return { ok: true, value: { index, current, requestId: requestId.value, receiptId: receiptId.value } };
}

function sameTerminalReceipt(
	current: ApprovalSecurityProjection,
	status: ApprovalProjectionStatus,
	payload: ApprovalTerminalBinding,
): boolean {
	return (
		current.status === status &&
		current.decisionRevision === payload.decisionRevision &&
		current.receiptId === payload.receiptId &&
		current.receiptDigest === payload.receiptDigest
	);
}

function reducePermissionRequested(state: MutableSecurityProjection, event: RuntimeEventV3): SessionResult<boolean> {
	if (event.type !== "permission.requested") return { ok: true, value: false };
	const approvalId = parseApprovalId(event.payload.approvalId, event);
	if (!approvalId.ok) return approvalId;
	const requestId = event.payload.requestId ? parseCommandId(event.payload.requestId, event) : undefined;
	if (requestId && !requestId.ok) return requestId;
	const existingIndex = findApproval(state, approvalId.value);
	const existing = state.approvals[existingIndex];
	if (event.payload.sessionId !== state.sessionId) {
		return invalidEvent("approval request is outside the projected session", event);
	}
	if (existingIndex >= 0 && existing) {
		const sameRequest =
			existing.requestId === (requestId?.value ?? null) &&
			existing.runtimeId === event.payload.runtimeId &&
			existing.runtimeGeneration === event.payload.runtimeGeneration &&
			existing.turnId === event.payload.turnId &&
			existing.toolCallId === event.payload.toolCallId &&
			existing.requestDigest === event.payload.requestDigest &&
			existing.policyDigest === event.payload.policyDigest &&
			existing.workspaceEnvelopeDigest === event.payload.workspaceEnvelopeDigest &&
			existing.ticketDigest === (event.payload.ticketDigest ?? null);
		if (!sameRequest) return invalidEvent("approval id was reused for a different request", event);
		return recordDuplicateApproval(state, existingIndex, existing);
	}
	state.approvals.push({
		approvalId: approvalId.value,
		requestId: requestId?.value ?? null,
		runtimeId: event.payload.runtimeId,
		runtimeGeneration: event.payload.runtimeGeneration,
		turnId: event.payload.turnId,
		toolCallId: event.payload.toolCallId,
		capability: event.payload.capability ?? null,
		resourceKind: event.payload.resourceKind ?? null,
		requestDigest: event.payload.requestDigest,
		policyDigest: event.payload.policyDigest,
		workspaceEnvelopeDigest: event.payload.workspaceEnvelopeDigest,
		ticketDigest: event.payload.ticketDigest ?? null,
		scope: event.payload.scope ?? null,
		requestedAt: event.payload.requestedAt ?? null,
		expiresAt: event.payload.expiresAt ?? null,
		status: "pending",
		decisionRevision: null,
		receiptId: null,
		receiptDigest: null,
		requestedSequence: event.sequence,
		terminalSequence: null,
		duplicateCount: 0,
	});
	return { ok: true, value: true };
}

function reducePermissionDecided(state: MutableSecurityProjection, event: RuntimeEventV3): SessionResult<boolean> {
	if (event.type !== "permission.decided") return { ok: true, value: false };
	const binding = approvalBinding(state, event, event.payload);
	if (!binding.ok) return binding;
	const { index, current, requestId, receiptId } = binding.value;
	if (current.status !== "pending") {
		return sameTerminalReceipt(current, event.payload.decision, event.payload)
			? recordDuplicateApproval(state, index, current)
			: invalidEvent("approval has more than one distinct terminal decision", event);
	}
	state.approvals[index] = {
		...current,
		requestId,
		ticketDigest: event.payload.ticketDigest,
		expiresAt: event.payload.expiresAt ?? current.expiresAt,
		status: event.payload.decision,
		decisionRevision: event.payload.decisionRevision,
		receiptId,
		receiptDigest: event.payload.receiptDigest,
		terminalSequence: event.sequence,
	};
	return { ok: true, value: true };
}

function reducePermissionExpired(state: MutableSecurityProjection, event: RuntimeEventV3): SessionResult<boolean> {
	if (event.type !== "permission.expired") return { ok: true, value: false };
	const binding = approvalBinding(state, event, event.payload);
	if (!binding.ok) return binding;
	const { index, current, requestId, receiptId } = binding.value;
	if (current.status === "expired") {
		return sameTerminalReceipt(current, "expired", event.payload)
			? recordDuplicateApproval(state, index, current)
			: invalidEvent("approval has conflicting expiry receipts", event);
	}
	if (current.status !== "pending" && current.status !== "allowed") {
		return invalidEvent("only pending or allowed approval may expire", event);
	}
	if (current.decisionRevision !== null && event.payload.decisionRevision <= current.decisionRevision) {
		return invalidEvent("approval expiry revision is not monotonic", event);
	}
	state.approvals[index] = {
		...current,
		requestId,
		ticketDigest: event.payload.ticketDigest,
		expiresAt: event.payload.expiredAt,
		status: "expired",
		decisionRevision: event.payload.decisionRevision,
		receiptId,
		receiptDigest: event.payload.receiptDigest,
		terminalSequence: event.sequence,
	};
	return { ok: true, value: true };
}

function reducePermissionRevoked(state: MutableSecurityProjection, event: RuntimeEventV3): SessionResult<boolean> {
	if (event.type !== "permission.revoked") return { ok: true, value: false };
	const binding = approvalBinding(state, event, event.payload);
	if (!binding.ok) return binding;
	const { index, current, requestId, receiptId } = binding.value;
	if (current.status === "revoked") {
		return sameTerminalReceipt(current, "revoked", event.payload)
			? recordDuplicateApproval(state, index, current)
			: invalidEvent("approval has conflicting revocation receipts", event);
	}
	if (current.status !== "allowed") return invalidEvent("only an allowed approval may be revoked", event);
	if (current.decisionRevision !== null && event.payload.decisionRevision <= current.decisionRevision) {
		return invalidEvent("approval revocation revision is not monotonic", event);
	}
	state.approvals[index] = {
		...current,
		requestId,
		ticketDigest: event.payload.ticketDigest,
		status: "revoked",
		decisionRevision: event.payload.decisionRevision,
		receiptId,
		receiptDigest: event.payload.receiptDigest,
		terminalSequence: event.sequence,
	};
	return { ok: true, value: true };
}

function reduceSandboxResolved(state: MutableSecurityProjection, event: RuntimeEventV3): SessionResult<boolean> {
	if (event.type !== "sandbox.resolved") return { ok: true, value: false };
	const requestId = parseCommandId(event.payload.requestId, event);
	if (!requestId.ok) return requestId;
	const profileId = parseResourceId(event.payload.profileId, event);
	if (!profileId.ok) return profileId;
	const resolutionReceiptId = parseReceiptId(event.payload.resolutionReceiptId, event);
	if (!resolutionReceiptId.ok) return resolutionReceiptId;
	const reasonDigest = "reasonDigest" in event.payload ? event.payload.reasonDigest : null;
	const index = findSandbox(state, requestId.value);
	const current = state.sandboxes[index];
	if (index >= 0 && current) {
		const sameResolution =
			current.profileId === profileId.value &&
			current.requested === event.payload.requested &&
			current.resolved === event.payload.resolved &&
			current.policyDigest === event.payload.policyDigest &&
			current.resolutionReceiptId === resolutionReceiptId.value &&
			current.backendId === event.payload.backendId &&
			current.effectiveEnforcement === event.payload.effectiveEnforcement &&
			current.reasonDigest === reasonDigest;
		return sameResolution
			? recordDuplicateSandbox(state, index, current)
			: invalidEvent("sandbox request has conflicting resolution receipts", event);
	}
	state.sandboxes.push({
		requestId: requestId.value,
		profileId: profileId.value,
		requested: event.payload.requested,
		resolved: event.payload.resolved,
		policyDigest: event.payload.policyDigest,
		resolutionReceiptId: resolutionReceiptId.value,
		backendId: event.payload.backendId,
		effectiveEnforcement: event.payload.effectiveEnforcement,
		reasonDigest,
		resolvedSequence: event.sequence,
		executionReceiptId: null,
		invocationDigest: null,
		executionSequence: null,
		duplicateCount: 0,
	});
	return { ok: true, value: true };
}

function reduceSandboxExecution(state: MutableSecurityProjection, event: RuntimeEventV3): SessionResult<boolean> {
	if (event.type !== "sandbox.execution_recorded") return { ok: true, value: false };
	const requestId = parseCommandId(event.payload.requestId, event);
	if (!requestId.ok) return requestId;
	const receiptId = parseReceiptId(event.payload.receipt.receiptId, event);
	if (!receiptId.ok) return receiptId;
	const index = findSandbox(state, requestId.value);
	const current = state.sandboxes[index];
	if (index < 0 || !current) return invalidEvent("sandbox execution has no matching resolution", event);
	const receipt = event.payload.receipt;
	const receiptReason = "reasonDigest" in receipt ? receipt.reasonDigest : null;
	if (
		receipt.authorityId !== event.authorityId ||
		receipt.tenantId !== event.tenantId ||
		receipt.principalId !== event.principalId ||
		receipt.requestId !== event.payload.requestId ||
		receipt.profileId !== current.profileId ||
		receipt.requested !== current.requested ||
		receipt.resolved !== current.resolved ||
		receipt.policyDigest !== current.policyDigest ||
		receipt.backendId !== current.backendId ||
		receipt.effectiveEnforcement !== current.effectiveEnforcement ||
		receipt.invocationDigest !== event.payload.invocationDigest ||
		receiptReason !== current.reasonDigest
	) {
		return invalidEvent("sandbox execution receipt is not bound to its resolution and invocation", event);
	}
	if (current.executionReceiptId !== null) {
		const sameExecution =
			current.executionReceiptId === receiptId.value && current.invocationDigest === event.payload.invocationDigest;
		return sameExecution
			? recordDuplicateSandbox(state, index, current)
			: invalidEvent("sandbox request has conflicting execution receipts", event);
	}
	state.sandboxes[index] = {
		...current,
		executionReceiptId: receiptId.value,
		invocationDigest: event.payload.invocationDigest,
		executionSequence: event.sequence,
	};
	return { ok: true, value: true };
}

function reduceToolAuthorization(state: MutableSecurityProjection, event: RuntimeEventV3): SessionResult<boolean> {
	if (event.type !== "tool.authorized") return { ok: true, value: false };
	const toolCallId = parseToolCallId(event.payload.toolCallId, event);
	if (!toolCallId.ok) return toolCallId;
	const requestId = parseCommandId(event.payload.requestId, event);
	if (!requestId.ok) return requestId;
	const decisionReceiptId = parseReceiptId(event.payload.decisionReceiptId, event);
	if (!decisionReceiptId.ok) return decisionReceiptId;
	const sandboxResolutionReceiptId = event.payload.sandboxResolutionReceiptId
		? parseReceiptId(event.payload.sandboxResolutionReceiptId, event)
		: undefined;
	if (sandboxResolutionReceiptId && !sandboxResolutionReceiptId.ok) return sandboxResolutionReceiptId;
	const index = findAuthorization(state, toolCallId.value);
	const current = state.toolAuthorizations[index];
	if (index >= 0 && current) {
		const sameAuthorization =
			current.requestId === requestId.value &&
			current.decisionReceiptId === decisionReceiptId.value &&
			current.sandboxResolutionReceiptId === (sandboxResolutionReceiptId?.value ?? null);
		if (!sameAuthorization) return invalidEvent("tool call has conflicting authorization receipts", event);
		state.toolAuthorizations[index] = { ...current, duplicateCount: current.duplicateCount + 1 };
		state.duplicateEventCount += 1;
		return { ok: true, value: true };
	}
	state.toolAuthorizations.push({
		toolCallId: toolCallId.value,
		requestId: requestId.value,
		decisionReceiptId: decisionReceiptId.value,
		sandboxResolutionReceiptId: sandboxResolutionReceiptId?.value ?? null,
		sequence: event.sequence,
		duplicateCount: 0,
	});
	return { ok: true, value: true };
}

function reduceSecurityEvent(state: MutableSecurityProjection, event: RuntimeEventV3): SessionResult<void> {
	if (!isSecurityRuntimeEventType(event.type)) return { ok: true, value: undefined };
	const reducers = [
		reducePermissionRequested,
		reducePermissionDecided,
		reducePermissionExpired,
		reducePermissionRevoked,
		reduceSandboxResolved,
		reduceSandboxExecution,
		reduceToolAuthorization,
	] as const;
	for (const reducer of reducers) {
		const reduced = reducer(state, event);
		if (!reduced.ok) return reduced;
		if (reduced.value) {
			state.lastSecuritySequence = event.sequence;
			return { ok: true, value: undefined };
		}
	}
	return invalidEvent("known security event was not handled", event);
}

function toProjectionState(state: MutableSecurityProjection): SessionSecurityProjectionState {
	const pendingApprovalIds = state.approvals
		.filter((approval) => approval.status === "pending")
		.map((approval) => approval.approvalId);
	const unavailableSandboxRequestIds = state.sandboxes
		.filter((sandbox) => sandbox.effectiveEnforcement === "unavailable")
		.map((sandbox) => sandbox.requestId);
	const replayBlockers: SecurityReplayBlocker[] = [];
	if (pendingApprovalIds.length > 0) replayBlockers.push("pending_approval");
	if (unavailableSandboxRequestIds.length > 0) replayBlockers.push("sandbox_unavailable");
	return {
		authorityId: state.authorityId,
		tenantId: state.tenantId,
		principalId: state.principalId,
		sessionId: state.sessionId,
		approvals: state.approvals,
		sandboxes: state.sandboxes,
		toolAuthorizations: state.toolAuthorizations,
		pendingApprovalIds,
		unavailableSandboxRequestIds,
		replayBlockers,
		lastSecuritySequence: state.lastSecuritySequence,
		duplicateEventCount: state.duplicateEventCount,
	};
}

export function reduceSessionSecurityEvents(
	events: readonly RuntimeEventV3[],
): SessionResult<SessionSecurityProjection> {
	const first = events[0];
	if (!first) {
		return failure({
			code: "invalid_event",
			message: "security projection requires at least one scoped v3 event",
			retryable: false,
		});
	}
	if (first.stream.scope !== "session") {
		return failure({ code: "identity_mismatch", message: "security projection requires a session stream", retryable: false });
	}
	const state: MutableSecurityProjection = {
		authorityId: first.authorityId,
		tenantId: first.tenantId,
		principalId: first.principalId,
		sessionId: first.stream.sessionId,
		approvals: [],
		sandboxes: [],
		toolAuthorizations: [],
		lastSecuritySequence: null,
		duplicateEventCount: 0,
	};
	let previousSequence = -1;
	for (const event of events) {
		if (
			event.authorityId !== state.authorityId ||
			event.tenantId !== state.tenantId ||
			event.principalId !== state.principalId ||
				event.stream.scope !== "session" ||
				event.stream.sessionId !== state.sessionId
		) {
			return failure({
				code: "identity_mismatch",
				message: "security event is outside the projection scope",
				retryable: false,
				details: { sequence: event.sequence },
			});
		}
		if (event.sequence <= previousSequence) {
			return failure({
				code: "sequence_conflict",
				message: "security replay input is not strictly ordered",
				retryable: false,
				details: { previousSequence, actualSequence: event.sequence },
			});
		}
		previousSequence = event.sequence;
		const reduced = reduceSecurityEvent(state, event);
		if (!reduced.ok) return reduced;
	}
	const projectionState = toProjectionState(state);
	return {
		ok: true,
		value: { ...projectionState, projectionDigest: canonicalDigest(projectionState) },
	};
}

export const SessionSecurityReducer = {
	reduce: reduceSessionSecurityEvents,
} as const;
