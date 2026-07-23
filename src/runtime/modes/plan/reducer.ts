import { canonicalDigest } from "../../protocol/v3/canonical-json.ts";
import { isApprovedPlanRef, isPlanModeCommand, isPlanModeState } from "./schema.ts";
import type { ApprovedPlanRef, PlanModeCommand, PlanModeState } from "./types.ts";

export type PlanTransitionErrorCode =
	| "invalid_state"
	| "invalid_command"
	| "revision_conflict"
	| "illegal_transition"
	| "approval_mismatch";

export class PlanTransitionError extends Error {
	public readonly code: PlanTransitionErrorCode;
	public constructor(code: PlanTransitionErrorCode, message: string) {
		super(message);
		this.name = "PlanTransitionError";
		this.code = code;
	}
}

function stateBase(state: PlanModeState, command: PlanModeCommand, updatedAt: string) {
	return {
		schemaVersion: 1 as const,
		authorityId: state.authorityId,
		tenantId: state.tenantId,
		sessionId: state.sessionId,
		modeRevision: state.modeRevision + 1,
		updatedByPrincipalId: command.principalId,
		updatedAt,
	};
}

function assertCommand(state: PlanModeState, command: PlanModeCommand): void {
	if (!isPlanModeState(state)) throw new PlanTransitionError("invalid_state", "plan mode state failed contract validation");
	if (!isPlanModeCommand(command)) throw new PlanTransitionError("invalid_command", "plan mode command failed contract validation");
	if (
		state.authorityId !== command.authorityId ||
		state.tenantId !== command.tenantId ||
		state.sessionId !== command.sessionId
	) throw new PlanTransitionError("invalid_command", "plan command scope does not match mode state");
	if (command.kind !== "request_activation" && command.expectedModeRevision !== state.modeRevision) {
		throw new PlanTransitionError("revision_conflict", "plan mode revision changed before command execution");
	}
}

function approvedPlan(command: Extract<PlanModeCommand, { kind: "resolve_approval" }>): ApprovedPlanRef {
	if (command.approval.state !== "approved") {
		throw new PlanTransitionError("approval_mismatch", "implementation requires an approved plan receipt");
	}
	const ref: ApprovedPlanRef = {
		schemaVersion: 1,
		authorityId: command.authorityId,
		tenantId: command.tenantId,
		planId: command.plan.planId,
		workspaceId: command.plan.workspaceId,
		revision: command.plan.revision,
		contentDigest: command.plan.contentDigest,
		artifact: command.plan.artifact,
		approvalReceipt: command.approval.receipt,
	};
	if (!isApprovedPlanRef(ref)) throw new PlanTransitionError("approval_mismatch", "approval receipt does not bind the plan revision");
	return ref;
}

/** expected revision + legal transition 的纯归约器；不读取 TUI 或 prompt 文本。 */
export function reducePlanModeCommand(
	state: PlanModeState,
	command: PlanModeCommand,
	updatedAt: string,
): PlanModeState {
	assertCommand(state, command);
	const nextBase = stateBase(state, command, updatedAt);
	switch (command.kind) {
		case "request_activation":
			if (state.kind !== "inactive") throw new PlanTransitionError("illegal_transition", "activation requires inactive mode");
			return { ...nextBase, kind: "pending_activation", mode: "default", requestedBy: command.requestedBy, commandId: command.commandId };
		case "activate":
			if (state.kind !== "pending_activation") throw new PlanTransitionError("illegal_transition", "only a pending activation can become active");
			return { ...nextBase, kind: "active", mode: "plan", plan: command.plan, activationDelivered: false };
		case "write_revision":
			if (state.kind !== "active") throw new PlanTransitionError("illegal_transition", "plan revisions can only be written while active");
			if (state.plan.planId !== command.plan.planId || state.plan.revision !== command.expectedPlanRevision) {
				throw new PlanTransitionError("revision_conflict", "plan revision changed before write");
			}
			return { ...nextBase, kind: "active", mode: "plan", plan: command.plan, activationDelivered: state.activationDelivered };
		case "request_approval":
			if (state.kind !== "active") throw new PlanTransitionError("illegal_transition", "approval requires active plan mode");
			if (canonicalDigest(state.plan) !== canonicalDigest(command.plan) || command.approval.state !== "pending") {
				throw new PlanTransitionError("approval_mismatch", "approval request does not pin the active immutable revision");
			}
			return { ...nextBase, kind: "awaiting_approval", mode: "plan", plan: command.plan, approval: command.approval };
		case "resolve_approval": {
			if (state.kind !== "awaiting_approval") throw new PlanTransitionError("illegal_transition", "approval resolution requires awaiting state");
			if (
				state.approval.approvalId !== command.approval.approvalId ||
				canonicalDigest(state.plan) !== canonicalDigest(command.plan)
			) throw new PlanTransitionError("approval_mismatch", "approval resolution is stale or targets another plan");
			if (command.action === "approve_same_session" || command.action === "approve_fresh_context") {
				return { ...nextBase, kind: "exit_pending", mode: "plan", plan: command.plan, reason: "approved", approvedPlan: approvedPlan(command) };
			}
			if (command.action === "request_changes" || command.action === "reject") {
				return { ...nextBase, kind: "active", mode: "plan", plan: command.plan, activationDelivered: true };
			}
			return { ...nextBase, kind: "exit_pending", mode: "plan", plan: command.plan, reason: "cancelled" };
		}
		case "request_exit":
			if (state.kind !== "active" && state.kind !== "awaiting_approval") {
				throw new PlanTransitionError("illegal_transition", "exit requires active or awaiting plan mode");
			}
			return { ...nextBase, kind: "exit_pending", mode: "plan", plan: state.plan, reason: command.reason };
	}
}

export function markPlanActivationDelivered(state: PlanModeState, updatedAt: string): PlanModeState {
	if (state.kind !== "active" || state.activationDelivered) return state;
	return { ...state, modeRevision: state.modeRevision + 1, activationDelivered: true, updatedAt };
}

export function settlePlanExit(state: PlanModeState, updatedAt: string): PlanModeState {
	if (state.kind !== "exit_pending") throw new PlanTransitionError("illegal_transition", "only exit_pending can settle to inactive");
	return {
		schemaVersion: 1,
		authorityId: state.authorityId,
		tenantId: state.tenantId,
		sessionId: state.sessionId,
		kind: "inactive",
		mode: "default",
		modeRevision: state.modeRevision + 1,
		updatedByPrincipalId: state.updatedByPrincipalId,
		updatedAt,
	};
}

export interface RecoveredPlanMode {
	state: PlanModeState;
	exitReminderRequired: boolean;
}

export function recoverPlanModeState(state: PlanModeState, recoveredAt: string): RecoveredPlanMode {
	if (state.kind !== "pending_activation" && state.kind !== "exit_pending") return { state, exitReminderRequired: false };
	return {
		state: {
			schemaVersion: 1,
			authorityId: state.authorityId,
			tenantId: state.tenantId,
			sessionId: state.sessionId,
			kind: "inactive",
			mode: "default",
			modeRevision: state.modeRevision + 1,
			updatedByPrincipalId: state.updatedByPrincipalId,
			updatedAt: recoveredAt,
		},
		exitReminderRequired: state.kind === "exit_pending",
	};
}
