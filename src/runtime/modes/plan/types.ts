/**
 * Plan Mode 的公共状态合同。
 *
 * TODO(runtime-phase-6): 冻结 durable revision、approval ref 和安全点事件；
 * reducer/service/policy/tool 行为归 plan-context-memory 专项，不在此实现。
 */

export type PlanModeStatus = "inactive" | "pending" | "active" | "awaiting_approval" | "exit_pending";

export interface PlanArtifactRef {
	planId: string;
	workspaceId: string;
	revision: number;
	digest: string;
	artifactRef: string;
}

export interface PlanApprovalRef {
	approvalId: string;
	planId: string;
	revision: number;
	digest: string;
	status: "pending" | "approved" | "rejected" | "expired" | "invalidated";
}

export interface PlanModeState {
	status: PlanModeStatus;
	revision: number;
	plan?: PlanArtifactRef;
	approval?: PlanApprovalRef;
	updatedAt: string;
}
