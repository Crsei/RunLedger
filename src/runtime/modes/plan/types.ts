/** Plan Mode 的版本化公共状态合同；状态迁移、store、policy 与工具不在本模块。 */

import type { ApprovalReceiptRef, ArtifactRef } from "../../protocol/v3/capability.ts";
import type { ExpectedRevision } from "../../protocol/v3/events.ts";
import type {
	ApprovalId,
	AuthorityId,
	CommandId,
	PlanId,
	PrincipalId,
	SessionId,
	TenantId,
	WorkspaceId,
} from "../../protocol/v3/ids.ts";

export const PLAN_MODE_CONTRACT_VERSION = 1 as const;

export const SESSION_MODES = ["default", "plan"] as const;
export type SessionMode = (typeof SESSION_MODES)[number];

export interface PlanArtifactRef {
	schemaVersion: typeof PLAN_MODE_CONTRACT_VERSION;
	authorityId: AuthorityId;
	tenantId: TenantId;
	planId: PlanId;
	workspaceId: WorkspaceId;
	revision: number;
	contentDigest: string;
	artifact: ArtifactRef;
	createdByPrincipalId: PrincipalId;
	createdAt: string;
}

interface PlanApprovalBase {
	schemaVersion: typeof PLAN_MODE_CONTRACT_VERSION;
	authorityId: AuthorityId;
	tenantId: TenantId;
	approvalId: ApprovalId;
	planId: PlanId;
	planRevision: number;
	contentDigest: string;
	workspaceId: WorkspaceId;
	requestedByPrincipalId: PrincipalId;
	requestedAt: string;
}

export type PlanApprovalRef =
	| (PlanApprovalBase & { state: "pending" })
	| (PlanApprovalBase & {
			state: "approved" | "rejected" | "expired" | "revoked";
			receipt: ApprovalReceiptRef;
	  });

export interface ApprovedPlanRef {
	schemaVersion: typeof PLAN_MODE_CONTRACT_VERSION;
	authorityId: AuthorityId;
	tenantId: TenantId;
	planId: PlanId;
	workspaceId: WorkspaceId;
	revision: number;
	contentDigest: string;
	artifact: ArtifactRef;
	approvalReceipt: ApprovalReceiptRef;
}

interface PlanModeStateBase {
	schemaVersion: typeof PLAN_MODE_CONTRACT_VERSION;
	authorityId: AuthorityId;
	tenantId: TenantId;
	sessionId: SessionId;
	modeRevision: number;
	updatedByPrincipalId: PrincipalId;
	updatedAt: string;
}

export type PlanModeState =
	| (PlanModeStateBase & { kind: "inactive"; mode: "default" })
	| (PlanModeStateBase & {
			kind: "pending_activation";
			mode: "default";
			requestedBy: "user" | "agent";
			commandId: CommandId;
			approval?: PlanApprovalRef;
	  })
	| (PlanModeStateBase & {
			kind: "active";
			mode: "plan";
			plan: PlanArtifactRef;
			activationDelivered: boolean;
	  })
	| (PlanModeStateBase & {
			kind: "awaiting_approval";
			mode: "plan";
			plan: PlanArtifactRef;
			approval: PlanApprovalRef;
	  })
	| (PlanModeStateBase & {
			kind: "exit_pending";
			mode: "plan";
			plan: PlanArtifactRef;
			reason: "user_toggle" | "approved" | "cancelled";
			approvedPlan?: ApprovedPlanRef;
	  });

interface PlanCommandBase {
	schemaVersion: typeof PLAN_MODE_CONTRACT_VERSION;
	authorityId: AuthorityId;
	tenantId: TenantId;
	principalId: PrincipalId;
	sessionId: SessionId;
	commandId: CommandId;
	expectedRevision: ExpectedRevision;
}

export type PlanModeCommand =
	| (PlanCommandBase & { kind: "request_activation"; requestedBy: "user" | "agent" })
	| (PlanCommandBase & { kind: "activate"; expectedModeRevision: number; plan: PlanArtifactRef })
	| (PlanCommandBase & {
			kind: "write_revision";
			expectedModeRevision: number;
			expectedPlanRevision: number;
			plan: PlanArtifactRef;
	  })
	| (PlanCommandBase & {
			kind: "request_approval";
			expectedModeRevision: number;
			plan: PlanArtifactRef;
			approval: PlanApprovalRef;
	  })
	| (PlanCommandBase & {
			kind: "resolve_approval";
			expectedModeRevision: number;
			plan: PlanArtifactRef;
			approval: PlanApprovalRef;
			action: "approve_same_session" | "approve_fresh_context" | "request_changes" | "reject" | "cancel";
	  })
	| (PlanCommandBase & {
			kind: "request_exit";
			expectedModeRevision: number;
			reason: "user_toggle" | "approved" | "cancelled";
	  });
