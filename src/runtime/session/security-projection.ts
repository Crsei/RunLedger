/** Runtime v3 security events 重放得到的纯数据投影。 */

import type {
	ApprovalReceiptDecision,
	ApprovalScope,
	CapabilityName,
	CapabilityResourceKind,
	SandboxEffectiveEnforcement,
	SandboxProfileName,
} from "../protocol/v3/capability.ts";
import type {
	ApprovalId,
	AuthorityId,
	CommandId,
	PrincipalId,
	ReceiptId,
	ResourceId,
	RuntimeInstanceId,
	SessionId,
	TenantId,
	ToolCallId,
	TurnId,
} from "../protocol/v3/ids.ts";

export type ApprovalProjectionStatus = "pending" | ApprovalReceiptDecision;
export type SecurityReplayBlocker = "pending_approval" | "sandbox_unavailable";

export interface ApprovalSecurityProjection {
	readonly approvalId: ApprovalId;
	readonly requestId: CommandId | null;
	readonly runtimeId: RuntimeInstanceId;
	readonly runtimeGeneration: number;
	readonly turnId: TurnId;
	readonly toolCallId: ToolCallId;
	readonly capability: CapabilityName | null;
	readonly resourceKind: CapabilityResourceKind | null;
	readonly requestDigest: string;
	readonly policyDigest: string;
	readonly workspaceEnvelopeDigest: string;
	readonly ticketDigest: string | null;
	readonly scope: ApprovalScope | null;
	readonly requestedAt: string | null;
	readonly expiresAt: string | null;
	readonly status: ApprovalProjectionStatus;
	readonly decisionRevision: number | null;
	readonly receiptId: ReceiptId | null;
	readonly receiptDigest: string | null;
	readonly requestedSequence: number;
	readonly terminalSequence: number | null;
	readonly duplicateCount: number;
}

export interface SandboxSecurityProjection {
	readonly requestId: CommandId;
	readonly profileId: ResourceId;
	readonly requested: SandboxProfileName;
	readonly resolved: SandboxProfileName;
	readonly policyDigest: string;
	readonly resolutionReceiptId: ReceiptId;
	readonly backendId: string;
	readonly effectiveEnforcement: SandboxEffectiveEnforcement;
	readonly reasonDigest: string | null;
	readonly resolvedSequence: number;
	readonly executionReceiptId: ReceiptId | null;
	readonly invocationDigest: string | null;
	readonly executionSequence: number | null;
	readonly duplicateCount: number;
}

export interface ToolAuthorizationSecurityProjection {
	readonly toolCallId: ToolCallId;
	readonly requestId: CommandId;
	readonly decisionReceiptId: ReceiptId;
	readonly sandboxResolutionReceiptId: ReceiptId | null;
	readonly sequence: number;
	readonly duplicateCount: number;
}

export interface SessionSecurityProjectionState {
	readonly authorityId: AuthorityId;
	readonly tenantId: TenantId;
	readonly principalId: PrincipalId;
	readonly sessionId: SessionId;
	readonly approvals: readonly ApprovalSecurityProjection[];
	readonly sandboxes: readonly SandboxSecurityProjection[];
	readonly toolAuthorizations: readonly ToolAuthorizationSecurityProjection[];
	readonly pendingApprovalIds: readonly ApprovalId[];
	readonly unavailableSandboxRequestIds: readonly CommandId[];
	readonly replayBlockers: readonly SecurityReplayBlocker[];
	readonly lastSecuritySequence: number | null;
	readonly duplicateEventCount: number;
}

export interface SessionSecurityProjection extends SessionSecurityProjectionState {
	readonly projectionDigest: string;
}
