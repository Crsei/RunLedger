import { runtimeDigest, type RuntimeContentRef, type RuntimeDigest } from "../../protocol/foundation.ts";
import { isCanonicalUtcTimestamp, isRuntimeContentRef, isRuntimeDigest } from "../../protocol/foundation-schemas.ts";
import { createRuntimeId, isRuntimeId, type ApprovalId } from "../../protocol/ids.ts";
import { isPlanApprovalRef, isPlanArtifactRef, isPlanModeState } from "./schema.ts";
import type { PlanApprovalRef, PlanArtifactRef, PlanModeState } from "./types.ts";
import { planFailure, type PlanResult } from "./errors.ts";

export interface RequestPlanActivationCommand {
	readonly type: "request_activation";
	readonly expectedRevision: number;
	readonly requestedBy: "user" | "agent";
	readonly updatedAt: string;
}

export interface ActivatePlanModeCommand {
	readonly type: "activate";
	readonly expectedRevision: number;
	readonly plan: PlanArtifactRef;
	readonly updatedAt: string;
}

export interface CancelPlanActivationCommand {
	readonly type: "cancel_activation";
	readonly expectedRevision: number;
	readonly updatedAt: string;
}

export interface WritePlanRevisionCommand {
	readonly type: "write_plan";
	readonly expectedRevision: number;
	readonly expectedPlanRevision: number;
	readonly plan: PlanArtifactRef;
	readonly updatedAt: string;
}

export interface RequestPlanApprovalCommand {
	readonly type: "request_approval" | "request_exit";
	readonly expectedRevision: number;
	readonly expectedPlanRevision: number;
	readonly expectedPlanDigest: RuntimeDigest;
	readonly updatedAt: string;
}

export interface ResolvePlanApprovalCommand {
	readonly type: "resolve_approval";
	readonly expectedRevision: number;
	readonly approval: PlanApprovalRef;
	readonly updatedAt: string;
}

export interface InvalidatePlanApprovalCommand {
	readonly type: "invalidate_approval";
	readonly expectedRevision: number;
	readonly observedDigest: RuntimeDigest;
	readonly updatedAt: string;
}

export interface CancelPlanApprovalCommand {
	readonly type: "cancel_approval";
	readonly expectedRevision: number;
	readonly approvalId: ApprovalId;
	readonly updatedAt: string;
}

export interface SettlePlanExitCommand {
	readonly type: "settle_exit";
	readonly expectedRevision: number;
	readonly updatedAt: string;
}

export type PlanModeCommand =
	| RequestPlanActivationCommand
	| ActivatePlanModeCommand
	| CancelPlanActivationCommand
	| WritePlanRevisionCommand
	| RequestPlanApprovalCommand
	| ResolvePlanApprovalCommand
	| InvalidatePlanApprovalCommand
	| CancelPlanApprovalCommand
	| SettlePlanExitCommand;

function sameDigest(left: RuntimeDigest, right: RuntimeDigest): boolean {
	return left.algorithm === right.algorithm && left.digest === right.digest;
}

function validExpectedRevision(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0;
}

export function isValidPlanArtifactRef(value: unknown): value is PlanArtifactRef {
	if (!isPlanArtifactRef(value)) return false;
	if (value.artifactRef.subjectKind !== "artifact") return false;
	if (!sameDigest(value.digest, value.artifactRef.digest)) return false;
	const size = value.artifactRef.size;
	return (
		typeof value.artifactRef.mediaType === "string" &&
		value.artifactRef.mediaType.length > 0 &&
		typeof size === "number" &&
		Number.isSafeInteger(size) &&
		size >= 0
	);
}

function validApproval(value: unknown): value is PlanApprovalRef {
	if (!isPlanApprovalRef(value)) return false;
	if (value.status === "approved" && value.receiptRef?.subjectKind !== "receipt") return false;
	return value.receiptRef === undefined || isRuntimeContentRef(value.receiptRef);
}

/** 比公共 schema 更严格地验证 reducer 所需的跨字段不变量。 */
export function isValidPlanModeState(state: unknown): state is PlanModeState {
	if (!isPlanModeState(state)) return false;
	if (state.sourceHead.streamId !== state.sessionId) return false;
	if (state.status === "inactive" || state.status === "pending") {
		return state.plan === undefined && state.approval === undefined;
	}
	if (state.plan === undefined || !isValidPlanArtifactRef(state.plan)) return false;
	if (state.plan.goalId !== state.goalId) return false;
	if (state.approval !== undefined) {
		if (!validApproval(state.approval)) return false;
		if (
			state.approval.goalId !== state.goalId ||
			state.approval.revision !== state.plan.revision ||
			!sameDigest(state.approval.digest, state.plan.digest)
		) return false;
	}
	if (state.status === "awaiting_approval") return state.approval?.status === "pending";
	if (state.status === "exit_pending") return state.approval?.status === "approved";
	return state.approval === undefined || state.approval.status !== "pending" && state.approval.status !== "approved";
}

function clonePlanModeState(state: PlanModeState): PlanModeState {
	return {
		...state,
		...(state.plan === undefined
			? {}
			: { plan: { ...state.plan, digest: { ...state.plan.digest }, artifactRef: { ...state.plan.artifactRef, digest: { ...state.plan.artifactRef.digest } } } }),
		...(state.approval === undefined
			? {}
			: { approval: { ...state.approval, digest: { ...state.approval.digest }, ...(state.approval.receiptRef === undefined ? {} : { receiptRef: { ...state.approval.receiptRef, digest: { ...state.approval.receiptRef.digest } } }) } }),
	};
}

export function snapshotPlanModeState(state: PlanModeState): PlanResult<PlanModeState> {
	return isValidPlanModeState(state)
		? { ok: true, value: clonePlanModeState(state) }
		: planFailure("invalid_state", "plan mode state failed snapshot invariants");
}

export function restorePlanModeState(snapshot: unknown): PlanResult<PlanModeState> {
	return isValidPlanModeState(snapshot)
		? { ok: true, value: clonePlanModeState(snapshot) }
		: planFailure("invalid_snapshot", "plan mode snapshot failed exact and cross-field validation");
}

function commandEnvelope(value: unknown): value is { readonly expectedRevision: number; readonly updatedAt: string } {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return validExpectedRevision(record.expectedRevision as number) && isCanonicalUtcTimestamp(record.updatedAt);
}

function nextState(
	state: PlanModeState,
		changes: Omit<PlanModeState, "sessionId" | "goalId" | "revision" | "policyCeilingDigest" | "sourceHead" | "projectionDigest" | "completeness" | "updatedAt">,
		updatedAt: string,
): PlanResult<PlanModeState> {
	const next = {
		...state,
		...changes,
		revision: state.revision + 1,
		updatedAt,
	} as PlanModeState;
	return isValidPlanModeState(next) ? { ok: true, value: next } : planFailure("invalid_state", "plan reducer produced an invalid state");
}

function inactiveState(state: PlanModeState, updatedAt: string): PlanResult<PlanModeState> {
	const { plan: _plan, approval: _approval, ...base } = state;
	return nextState({ ...base, status: state.status } as PlanModeState, { status: "inactive" }, updatedAt);
}

function pendingApproval(state: PlanModeState, plan: PlanArtifactRef): PlanApprovalRef {
	const seed = runtimeDigest({
		sessionId: state.sessionId,
		goalId: state.goalId,
		workspaceId: plan.workspaceId,
		revision: plan.revision,
		digest: plan.digest,
	}).digest.slice(0, 48);
	return {
		approvalId: createRuntimeId("approval", `plan-${seed}`),
		goalId: state.goalId,
		revision: plan.revision,
		digest: plan.digest,
		status: "pending",
	};
}

function checkPlanRevision(
	state: PlanModeState,
		command: WritePlanRevisionCommand | RequestPlanApprovalCommand,
	): PlanResult<PlanArtifactRef> {
	if (state.plan === undefined || !isValidPlanArtifactRef(state.plan)) return planFailure("invalid_state", "active Plan Mode has no valid plan artifact");
	if (command.expectedPlanRevision !== state.plan.revision) {
		return planFailure("stale_expected_plan_revision", "plan revision changed before command execution", {
			retryable: true,
			expectedRevision: command.expectedPlanRevision,
			actualRevision: state.plan.revision,
		});
	}
	if ("expectedPlanDigest" in command && !sameDigest(command.expectedPlanDigest, state.plan.digest)) {
		return planFailure("stale_expected_digest", "plan digest changed before command execution", {
			retryable: true,
			expectedDigest: command.expectedPlanDigest,
			actualDigest: state.plan.digest,
		});
	}
	return { ok: true, value: state.plan };
}

function checkStateAndCommand(state: PlanModeState, command: PlanModeCommand): PlanResult<void> {
	if (!isValidPlanModeState(state)) return planFailure("invalid_state", "plan mode state failed reducer invariants");
	if (!commandEnvelope(command)) return planFailure("invalid_command", "plan command has an invalid expected revision or timestamp");
	if (command.expectedRevision !== state.revision) {
		return planFailure("stale_expected_revision", "plan mode revision changed before command execution", {
			retryable: true,
			expectedRevision: command.expectedRevision,
			actualRevision: state.revision,
		});
	}
	return { ok: true, value: undefined };
}

/** 只归约当前冻结 PlanModeState；不读取 prompt、TUI 或外部状态。 */
export function reducePlanModeState(
	state: PlanModeState,
	command: PlanModeCommand,
): PlanResult<PlanModeState> {
	const checked = checkStateAndCommand(state, command);
	if (!checked.ok) return checked;

	switch (command.type) {
		case "request_activation":
			if (state.status !== "inactive") return planFailure("illegal_transition", "activation requires inactive Plan Mode");
			return nextState(state, { status: "pending" }, command.updatedAt);

		case "activate":
			if (state.status !== "pending") return planFailure("illegal_transition", "activation delivery requires pending Plan Mode");
			if (!isValidPlanArtifactRef(command.plan) || command.plan.goalId !== state.goalId || command.plan.revision !== 0) {
				return planFailure("invalid_artifact", "initial plan activation requires a valid goal-scoped revision zero artifact");
			}
			return nextState(state, { status: "active", plan: command.plan }, command.updatedAt);

		case "cancel_activation":
			if (state.status !== "pending") return planFailure("illegal_transition", "only pending activation can be cancelled");
			return inactiveState(state, command.updatedAt);

		case "write_plan": {
			if (state.status !== "active") return planFailure("illegal_transition", "plan writes require active Plan Mode");
			if (state.plan === undefined || !isValidPlanArtifactRef(state.plan)) return planFailure("invalid_state", "active Plan Mode has no valid plan artifact");
			if (command.expectedPlanRevision !== state.plan.revision) {
				return planFailure("stale_expected_plan_revision", "plan revision changed before plan write", {
					retryable: true,
					expectedRevision: command.expectedPlanRevision,
					actualRevision: state.plan.revision,
				});
			}
			if (
				!isValidPlanArtifactRef(command.plan) ||
				command.plan.goalId !== state.goalId ||
				command.plan.workspaceId !== state.plan.workspaceId ||
				command.plan.revision !== state.plan.revision + 1
			) return planFailure("invalid_artifact", "plan write must create the next immutable revision in the same scope");
			return nextState(state, { status: "active", plan: command.plan, approval: undefined }, command.updatedAt);
		}

		case "request_approval":
		case "request_exit": {
			if (state.status !== "active") return planFailure("illegal_transition", "plan approval requires active Plan Mode");
			const currentPlan = checkPlanRevision(state, command);
			if (!currentPlan.ok) return currentPlan;
			return nextState(state, { status: "awaiting_approval", plan: currentPlan.value, approval: pendingApproval(state, currentPlan.value) }, command.updatedAt);
		}

		case "resolve_approval": {
			if (state.status !== "awaiting_approval" || state.plan === undefined || state.approval?.status !== "pending") {
				return planFailure("illegal_transition", "approval resolution requires a pending Plan Mode approval");
			}
			if (!validApproval(command.approval)) return planFailure("approval_mismatch", "approval resolution failed exact approval validation");
			if (
				command.approval.approvalId !== state.approval.approvalId ||
				command.approval.goalId !== state.goalId ||
				command.approval.revision !== state.plan.revision ||
				!sameDigest(command.approval.digest, state.plan.digest) ||
				command.approval.status === "pending"
			) return planFailure("approval_mismatch", "approval does not bind the current plan revision and digest");
			if (command.approval.status === "approved") {
				return nextState(state, { status: "exit_pending", approval: command.approval }, command.updatedAt);
			}
			return nextState(state, { status: "active", approval: command.approval }, command.updatedAt);
		}

		case "invalidate_approval": {
			if (state.status !== "awaiting_approval" || state.plan === undefined || state.approval?.status !== "pending") {
				return planFailure("illegal_transition", "approval invalidation requires a pending Plan Mode approval");
			}
			if (!isRuntimeDigest(command.observedDigest)) return planFailure("invalid_command", "observed plan digest is invalid");
			if (sameDigest(command.observedDigest, state.plan.digest)) {
				return planFailure("stale_expected_digest", "observed plan digest has not drifted");
			}
			const invalidated: PlanApprovalRef = { ...state.approval, status: "invalidated" };
			return nextState(state, { status: "active", approval: invalidated }, command.updatedAt);
		}

		case "cancel_approval":
			if (state.status !== "awaiting_approval" || state.approval?.approvalId !== command.approvalId) {
				return planFailure("approval_mismatch", "cancelled approval does not match the pending approval");
			}
			if (!isRuntimeId(command.approvalId, "approval")) return planFailure("invalid_command", "approval id is invalid");
			return inactiveState(state, command.updatedAt);

		case "settle_exit":
			if (state.status !== "exit_pending" || state.approval?.status !== "approved") {
				return planFailure("illegal_transition", "only an approved exit can settle Plan Mode");
			}
			return inactiveState(state, command.updatedAt);
	}
}

export function assertPlanArtifactDigest(ref: PlanArtifactRef, observedContent: string): PlanResult<void> {
	if (!isValidPlanArtifactRef(ref)) return planFailure("invalid_artifact", "plan artifact reference failed exact validation");
	const observedDigest = runtimeDigest(observedContent);
	return sameDigest(ref.digest, observedDigest)
		? { ok: true, value: undefined }
		: planFailure("artifact_digest_drift", "observed plan content does not match the pinned artifact digest", {
			expectedDigest: ref.digest,
			actualDigest: observedDigest,
		});
}

export function isPlanContentRef(value: unknown): value is RuntimeContentRef {
	return isRuntimeContentRef(value);
}
