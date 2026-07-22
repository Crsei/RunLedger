/** Compaction cut/checkpoint/invariant 的版本化公共合同；不包含 planner 或 summarizer。 */

import type { ArtifactRef } from "../../protocol/v3/capability.ts";
import type {
	ApprovalId,
	ArtifactId,
	AuthorityId,
	CheckpointId,
	CommandId,
	CompactionId,
	PrincipalId,
	ReceiptId,
	ResourceId,
	SessionId,
	TenantId,
} from "../../protocol/v3/ids.ts";
import type { WorkspaceBindingRef } from "../../protocol/v3/workspace.ts";
import type { DeclassificationReceiptRef, InputSourceRef } from "../../protocol/v3/taint.ts";
import type { ApprovedPlanRef } from "../../modes/plan/types.ts";

export const COMPACTION_CONTRACT_VERSION = 1 as const;

export const COMPACTION_INSTALLATION_STATES = [
	"prepared",
	"durably_committed",
	"live_projection_installed",
] as const;
export type CompactionInstallationState = (typeof COMPACTION_INSTALLATION_STATES)[number];

export const COMPACTION_REASONS = ["manual", "auto", "overflow", "model_switch"] as const;
export type CompactionReason = (typeof COMPACTION_REASONS)[number];

export interface CompactionCut {
	sourceFromSequence: number;
	sourceToSequence: number;
	retainedFromSequence: number;
	completedTurnCount: number;
	toolPairingDigest: string;
	offloadedArtifacts: readonly ArtifactRef[];
}

export interface CompactionInvariantSnapshot {
	authorityId: AuthorityId;
	tenantId: TenantId;
	sessionId: SessionId;
	workspace: WorkspaceBindingRef;
	modeRevision: number;
	approvedPlan?: ApprovedPlanRef;
	pendingApprovalIds: readonly ApprovalId[];
	goalStateDigest: string;
	taskStateDigest: string;
	workspaceStateDigest: string;
	verificationStateDigest: string;
	toolPairingDigest: string;
	inputSources: readonly InputSourceRef[];
	declassificationReceipts: readonly DeclassificationReceiptRef[];
	invariantDigest: string;
}

export const COMPACTION_VALIDATION_CODES = [
	"summary_empty",
	"summary_budget_exceeded",
	"tool_pair_split",
	"range_gap",
	"range_overlap",
	"invariant_mismatch",
	"secret_detected",
	"target_budget_exceeded",
	"checkpoint_chain_mismatch",
	"artifact_scope_mismatch",
	"taint_mismatch",
] as const;
export type CompactionValidationCode = (typeof COMPACTION_VALIDATION_CODES)[number];

export interface CompactionValidationDiagnostic {
	code: CompactionValidationCode;
	diagnosticDigest: string;
	sequence?: number;
	artifactId?: ArtifactId;
}

export type CompactionValidationResult =
	| {
			outcome: "valid";
			validationDigest: string;
			validatedAt: string;
			diagnostics: readonly [];
	  }
	| {
			outcome: "invalid";
			validationDigest: string;
			validatedAt: string;
			diagnostics: readonly CompactionValidationDiagnostic[];
	  };

export interface CompactionCheckpointRef {
	schemaVersion: typeof COMPACTION_CONTRACT_VERSION;
	authorityId: AuthorityId;
	tenantId: TenantId;
	checkpointId: CheckpointId;
	compactionId: CompactionId;
	sessionId: SessionId;
	sourceFromSequence: number;
	sourceToSequence: number;
	retainedFromSequence: number;
	survivingSuffixFromSequence: number;
	summaryArtifact: ArtifactRef;
	summaryDigest: string;
	replacementHistoryArtifact: ArtifactRef;
	replacementHistoryDigest: string;
	invariantDigest: string;
	previousCheckpointId?: CheckpointId;
	previousCheckpointDigest?: string;
	previousReplacementHistoryDigest?: string;
	checkpointDigest: string;
}

export interface CompactionCheckpoint {
	schemaVersion: typeof COMPACTION_CONTRACT_VERSION;
	authorityId: AuthorityId;
	tenantId: TenantId;
	principalId: PrincipalId;
	compactionId: CompactionId;
	checkpointId: CheckpointId;
	sessionId: SessionId;
	reason: CompactionReason;
	commandId: CommandId;
	cut: CompactionCut;
	inputArtifact: ArtifactRef;
	summaryArtifact: ArtifactRef;
	summaryDigest: string;
	replacementHistoryArtifact: ArtifactRef;
	replacementHistoryDigest: string;
	survivingSuffixFromSequence: number;
	previousReplacementHistoryDigest?: string;
	summarizerProfileId: ResourceId;
	summarizerProfileDigest: string;
	preEstimatedTokens: number;
	postEstimatedTokens: number;
	maxSummaryTokens: number;
	invariantsBefore: CompactionInvariantSnapshot;
	invariantsAfter: CompactionInvariantSnapshot;
	validation: CompactionValidationResult;
	previousCheckpoint?: CompactionCheckpointRef;
	checkpointDigest: string;
	createdAt: string;
}

/** CAS 安装 live projection 后的唯一成功收据。prepared/committed 不能伪装成 installed。 */
export interface CompactionProjectionInstallationReceipt {
	schemaVersion: typeof COMPACTION_CONTRACT_VERSION;
	authorityId: AuthorityId;
	tenantId: TenantId;
	sessionId: SessionId;
	receiptId: ReceiptId;
	state: "live_projection_installed";
	checkpointId: CheckpointId;
	checkpointDigest: string;
	replacementHistoryArtifact: ArtifactRef;
	replacementHistoryDigest: string;
	expectedProjectionRevision: number;
	installedProjectionRevision: number;
	previousProjectionDigest: string;
	projectionDigest: string;
	installedAt: string;
	receiptDigest: string;
}

export const COMPACTION_SUPPRESSION_REASONS = [
	"active_tool_batch",
	"pending_approval",
	"no_safe_cut",
	"insufficient_history",
	"already_attempted",
	"policy_denied",
	"schema_invalid",
] as const;
export type CompactionSuppressionReason = (typeof COMPACTION_SUPPRESSION_REASONS)[number];

export interface CompactionSuppressionReceipt {
	schemaVersion: typeof COMPACTION_CONTRACT_VERSION;
	authorityId: AuthorityId;
	tenantId: TenantId;
	principalId: PrincipalId;
	receiptId: ReceiptId;
	compactionId: CompactionId;
	sessionId: SessionId;
	reason: CompactionSuppressionReason;
	attemptDigest: string;
	suppressedAt: string;
}

export type CompactionAttemptReceipt =
	| {
			schemaVersion: typeof COMPACTION_CONTRACT_VERSION;
			authorityId: AuthorityId;
			tenantId: TenantId;
			principalId: PrincipalId;
			receiptId: ReceiptId;
			compactionId: CompactionId;
			sessionId: SessionId;
			status: "started";
			attemptDigest: string;
			startedAt: string;
	  }
	| {
			schemaVersion: typeof COMPACTION_CONTRACT_VERSION;
			authorityId: AuthorityId;
			tenantId: TenantId;
			principalId: PrincipalId;
			receiptId: ReceiptId;
			compactionId: CompactionId;
			sessionId: SessionId;
			status: "completed";
			attemptDigest: string;
			checkpoint: CompactionCheckpointRef;
			completedAt: string;
	  }
	| {
			schemaVersion: typeof COMPACTION_CONTRACT_VERSION;
			authorityId: AuthorityId;
			tenantId: TenantId;
			principalId: PrincipalId;
			receiptId: ReceiptId;
			compactionId: CompactionId;
			sessionId: SessionId;
			status: "failed";
			attemptDigest: string;
			errorCode: string;
			errorDigest: string;
			originalProjectionDigest: string;
			failedAt: string;
	  }
	| {
			schemaVersion: typeof COMPACTION_CONTRACT_VERSION;
			authorityId: AuthorityId;
			tenantId: TenantId;
			principalId: PrincipalId;
			receiptId: ReceiptId;
			compactionId: CompactionId;
			sessionId: SessionId;
			status: "suppressed";
			attemptDigest: string;
			suppression: CompactionSuppressionReceipt;
	  };
