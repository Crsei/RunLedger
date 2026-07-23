import { canonicalDigest } from "../../protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../protocol/v3/ids.ts";
import type { ApprovalReceiptRef } from "../../protocol/v3/capability.ts";
import type { PlanApprovalRef, PlanArtifactRef } from "./types.ts";

export interface PlanApprovalDecisionInput {
	decision: "allowed" | "denied" | "expired" | "revoked";
	receipt: ApprovalReceiptRef;
}

export function createPlanApprovalRequest(
	plan: PlanArtifactRef,
	requestedAt: string,
): PlanApprovalRef {
	const seed = canonicalDigest({ planId: plan.planId, revision: plan.revision, contentDigest: plan.contentDigest, requestedAt });
	return {
		schemaVersion: 1,
		authorityId: plan.authorityId,
		tenantId: plan.tenantId,
		approvalId: createRuntimeId("approval", `plan-${seed.slice(0, 48)}`),
		planId: plan.planId,
		planRevision: plan.revision,
		contentDigest: plan.contentDigest,
		workspaceId: plan.workspaceId,
		requestedByPrincipalId: plan.createdByPrincipalId,
		requestedAt,
		state: "pending",
	};
}

export function resolvePlanApproval(
	pending: Extract<PlanApprovalRef, { state: "pending" }>,
	input: PlanApprovalDecisionInput,
): Exclude<PlanApprovalRef, { state: "pending" }> {
	if (
		input.receipt.authorityId !== pending.authorityId ||
		input.receipt.tenantId !== pending.tenantId ||
		input.receipt.approvalId !== pending.approvalId ||
		input.receipt.decision !== input.decision
	) throw new Error("approval receipt does not bind the pending plan approval");
	const state = input.decision === "allowed" ? "approved" : input.decision === "denied" ? "rejected" : input.decision;
	return { ...pending, state, receipt: input.receipt };
}
