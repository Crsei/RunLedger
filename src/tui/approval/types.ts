import type { TuiPortRequest, TuiResultEnvelope } from "../application/common.ts";
import type { SafeBoundedText } from "../presentation/tools/types.ts";

export type ApprovalDecision = "allowed" | "denied" | "cancelled";
export type ApprovalItemState = "pending" | "resolved" | "expired" | "unknown";

export interface ApprovalItemSnapshot {
	readonly approvalId: string;
	readonly sessionId: string;
	readonly state: ApprovalItemState;
	readonly summary: SafeBoundedText;
	readonly ticketDigestPrefix: SafeBoundedText;
	readonly decisionRevision: number;
	readonly authorityGeneration: number;
}

export interface ApprovalDecisionReceipt {
	readonly approvalId: string;
	readonly decision: ApprovalDecision;
	readonly decisionRevision: number;
	readonly receiptDigestPrefix: SafeBoundedText;
	readonly recoveryRequired: boolean;
}

export interface ApprovalSnapshot {
	readonly items: readonly ApprovalItemSnapshot[];
	readonly authorityGeneration: number;
	readonly decisionRevision: number;
}

export type ApprovalSnapshotResult = TuiResultEnvelope<ApprovalSnapshot>;
export type ApprovalResolutionResult = TuiResultEnvelope<ApprovalDecisionReceipt>;

export type ApprovalWorkflowState =
	| { readonly state: "unavailable"; readonly reason: string }
	| { readonly state: "idle"; readonly generation: number }
	| { readonly state: "loading"; readonly generation: number; readonly requestId: string; readonly effectId: string }
	| { readonly state: "ready"; readonly generation: number; readonly value: ApprovalSnapshot }
	| { readonly state: "empty"; readonly generation: number }
	| { readonly state: "error"; readonly generation: number; readonly code: string; readonly message: string; readonly retryable: boolean; readonly recoveryRequired?: boolean };

export interface ApprovalWorkflowPort {
	readonly inspect: (input: TuiPortRequest) => Promise<ApprovalSnapshotResult>;
	readonly resolve: (input: TuiPortRequest & { readonly item: ApprovalItemSnapshot; readonly decision: ApprovalDecision }) => Promise<ApprovalResolutionResult>;
}
