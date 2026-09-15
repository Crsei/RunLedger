/** Plan Mode 的被动公共状态合同。 */

import type { RuntimeContentRef, RuntimeDigest, RuntimeStreamHead } from "../../protocol/foundation.ts";
import type { ApprovalId, GoalId, SessionId, WorkspaceId } from "../../protocol/ids.ts";

export type PlanModeStatus = "inactive" | "pending" | "active" | "awaiting_approval" | "exit_pending";

export interface PlanArtifactRef {
	readonly goalId: GoalId;
	readonly workspaceId: WorkspaceId;
	readonly revision: number;
	readonly digest: RuntimeDigest;
	readonly artifactRef: RuntimeContentRef;
}

export interface PlanApprovalRef {
	readonly approvalId: ApprovalId;
	readonly goalId: GoalId;
	readonly revision: number;
	readonly digest: RuntimeDigest;
	readonly status: "pending" | "approved" | "rejected" | "changes_requested" | "expired" | "invalidated";
	readonly receiptRef?: RuntimeContentRef;
}

/** 计划正文的单 goal 累计上限；超限以 typed 失败拒绝，不截断。 */
export const PLAN_GOAL_MAX_BYTES = 2_097_152;

export interface PlanModeState {
	readonly status: PlanModeStatus;
	readonly sessionId: SessionId;
	readonly goalId: GoalId;
	readonly revision: number;
	readonly plan?: PlanArtifactRef;
	readonly approval?: PlanApprovalRef;
	readonly policyCeilingDigest: RuntimeDigest;
	readonly sourceHead: RuntimeStreamHead;
	readonly projectionDigest: RuntimeDigest;
	readonly completeness: "complete" | "partial";
	readonly updatedAt: string;
}
