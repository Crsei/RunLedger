/** Phase 7 确定性 Orchestrator 的公共类型与持久化端口。 */

import type { ArtifactRef, CapabilityName } from "../protocol/v3/capability.ts";
import type { IdempotencyKey } from "../protocol/v3/coordination.ts";
import type {
	AgentId,
	BudgetReservationId,
	CheckpointId,
	CommandId,
	GoalId,
	PrincipalId,
	ReceiptId,
	ResourceId,
	SnapshotId,
	WorkspaceId,
} from "../protocol/v3/ids.ts";
import type { EpisodeSealCompletionRef } from "../verification/types.ts";

export const GOAL_PHASES = [
	"planning",
	"awaiting_plan_approval",
	"implementation",
	"build",
	"test",
	"security_review",
	"independent_review",
	"remediation",
	"reverification",
	"awaiting_verification",
	"awaiting_human",
	"completed",
	"failed",
	"stopped",
] as const;

export type GoalPhase = (typeof GOAL_PHASES)[number];
export type GoalTransitionActor = "runtime" | "human" | "trusted_verifier" | "model";
export type GoalEvidenceOutcome = "pass" | "fail" | "recorded";

export const GOAL_EVIDENCE_KINDS = [
	"plan",
	"plan_approval",
	"implementation",
	"build",
	"test",
	"security_review",
	"independent_review",
	"pull_request",
	"finding",
	"remediation",
	"reverification",
	"verification",
	"human_request",
	"human_decision",
	"failure",
	"stop_request",
] as const;

export type GoalEvidenceKind = (typeof GOAL_EVIDENCE_KINDS)[number];

export interface GoalEvidence {
	kind: GoalEvidenceKind;
	receiptId: ReceiptId;
	digest: string;
	outcome: GoalEvidenceOutcome;
	issuerId: string;
	issuedAt: string;
	artifact?: ArtifactRef;
	/** completed 的唯一信任输入；VerificationReport/模型自述不能替代 durable EpisodeSeal。 */
	episodeSeal?: EpisodeSealCompletionRef;
}

export interface GoalState {
	goalId: GoalId;
	phase: GoalPhase;
	revision: number;
	evidence: readonly GoalEvidence[];
	partialResults: readonly ArtifactRef[];
	/** awaiting_human 只能返回进入暂停前的这个状态。 */
	pausedFrom?: Exclude<GoalPhase, "awaiting_human" | "completed" | "failed" | "stopped">;
}

export interface GoalTransitionRequest {
	to: GoalPhase;
	actor: GoalTransitionActor;
	expectedRevision: number;
	evidence: readonly GoalEvidence[];
	partialResults?: readonly ArtifactRef[];
}

export interface CompletionTrustPort {
	verify(reference: EpisodeSealCompletionRef): Promise<boolean>;
}

export const ORCHESTRATOR_ERROR_CODES = [
	"invalid_transition",
	"revision_conflict",
	"missing_evidence",
	"untrusted_verification",
	"verification_disabled",
	"invalid_input",
	"invalid_dag",
	"reference_unavailable",
	"budget_exhausted",
	"budget_stopped",
	"reservation_not_found",
	"reservation_settled",
	"journal_conflict",
	"journal_unavailable",
	"idempotency_conflict",
	"operation_active",
	"operation_not_active",
	"settlement_failed",
	"queue_reconcile_required",
	"queue_item_not_found",
	"loop_broken",
] as const;

export type OrchestratorErrorCode = (typeof ORCHESTRATOR_ERROR_CODES)[number];

export interface OrchestratorError {
	code: OrchestratorErrorCode;
	message: string;
	retryable: boolean;
	details?: Readonly<Record<string, string | number | boolean>>;
}

export type OrchestratorResult<T> = { ok: true; value: T } | { ok: false; error: OrchestratorError };

export interface DurableJournalTransaction<TRecord> {
	transactionId: CommandId;
	idempotencyKey: IdempotencyKey;
	transactionDigest: string;
	committedAt: string;
	records: readonly TRecord[];
}

export interface DurableJournalSnapshot<TRecord> {
	revision: number;
	transactions: readonly DurableJournalTransaction<TRecord>[];
}

export type DurableJournalAppendOutcome<TRecord> =
	| {
			status: "committed" | "duplicate";
			revision: number;
			transaction: DurableJournalTransaction<TRecord>;
	  }
	| { status: "conflict"; actualRevision: number };

/**
 * append 必须把 expectedRevision 检查、idempotency 检查和整批 records 写入放在
 * 同一个 durable transaction 中。重复 key + 相同 digest 返回 duplicate；相同 key
 * + 不同 digest 必须失败。
 */
export interface DurableOrchestratorJournalPort<TRecord> {
	load(): Promise<OrchestratorResult<DurableJournalSnapshot<TRecord>>>;
	append(
		expectedRevision: number,
		transaction: DurableJournalTransaction<TRecord>,
	): Promise<OrchestratorResult<DurableJournalAppendOutcome<TRecord>>>;
}

export interface ModelSavePointRef {
	modelId: string;
	profileId: ResourceId;
	manifestDigest: string;
	profileDigest: string;
}

export interface ToolSavePointRef {
	snapshotId: SnapshotId;
	snapshotDigest: string;
	toolIdentityDigests: readonly string[];
}

export interface ResourceSavePointRef {
	snapshotId: SnapshotId;
	snapshotDigest: string;
	adapterGeneration: number;
	adapterGenerationDigest: string;
}

export interface ConfigSavePointRef {
	revision: number;
	configDigest: string;
}

/** 只保存 opaque identity/version；实际可用性由 Phase 2 Workspace port 判断。 */
export interface TaskWorkspaceRef {
	workspaceId: WorkspaceId;
	bindingRevision: number;
	bindingDigest: string;
}

/** 只保存授权 receipt identity/version；capability 子集由 Phase 3 port 判断。 */
export interface TaskCapabilityRef {
	receiptId: ReceiptId;
	capability: CapabilityName;
	decisionRevision: number;
	receiptDigest: string;
}

export interface OperationBindings {
	model: ModelSavePointRef;
	tools: ToolSavePointRef;
	resources: ResourceSavePointRef;
	config: ConfigSavePointRef;
	workspace?: TaskWorkspaceRef;
	capabilities: readonly TaskCapabilityRef[];
}

export interface OperationSavePoint {
	savePointId: CheckpointId;
	operationId: CommandId;
	bindings: OperationBindings;
	bindingsDigest: string;
	createdAt: string;
}

export type OperationMutation =
	| { mutationId: CommandId; kind: "model"; value: ModelSavePointRef }
	| { mutationId: CommandId; kind: "tools"; value: ToolSavePointRef }
	| { mutationId: CommandId; kind: "resources"; value: ResourceSavePointRef }
	| { mutationId: CommandId; kind: "config"; value: ConfigSavePointRef }
	| { mutationId: CommandId; kind: "workspace"; value?: TaskWorkspaceRef }
	| { mutationId: CommandId; kind: "capabilities"; value: readonly TaskCapabilityRef[] };

export type SavePointJournalRecord =
	| { kind: "save_point.created"; savePoint: OperationSavePoint }
	| { kind: "save_point.mutation_queued"; operationId: CommandId; mutation: OperationMutation; queuedAt: string }
	| {
			kind: "save_point.settled";
			operationId: CommandId;
			savePointId: CheckpointId;
			outcome: "succeeded" | "failed" | "cancelled" | "uncertain";
			resultDigest: string;
			settledAt: string;
	  }
	| {
			kind: "save_point.mutations_applied";
			mutationIds: readonly CommandId[];
			bindings: OperationBindings;
			bindingsDigest: string;
			appliedAt: string;
	  };

export interface ExpectedTaskArtifact {
	kind: ArtifactRef["kind"];
	mediaType: string;
	logicalName: string;
}

export interface OrchestratorTask {
	taskId: string;
	owner: { kind: "agent"; id: AgentId } | { kind: "principal"; id: PrincipalId };
	dependsOn: readonly string[];
	expectedArtifacts: readonly ExpectedTaskArtifact[];
	workspace: TaskWorkspaceRef;
	capabilities: readonly TaskCapabilityRef[];
}

export interface TaskDag {
	goalId: GoalId;
	revision: number;
	tasks: readonly OrchestratorTask[];
}

export type ReferenceValidation =
	| { status: "valid" }
	| { status: "missing" | "stale" | "unavailable"; reasonDigest: string };

export interface TaskWorkspaceReferencePort {
	validate(ref: TaskWorkspaceRef): Promise<ReferenceValidation>;
}

export interface TaskCapabilityReferencePort {
	validate(ref: TaskCapabilityRef): Promise<ReferenceValidation>;
}

export interface OperationBudgetReservationRef {
	reservationId: BudgetReservationId;
	operationId: CommandId;
}
