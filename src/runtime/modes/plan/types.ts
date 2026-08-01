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
	readonly status: "pending" | "approved" | "rejected" | "expired" | "invalidated";
	readonly receiptRef?: RuntimeContentRef;
}

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
