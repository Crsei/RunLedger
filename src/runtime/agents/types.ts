/** Phase 9 有界 Multi-Agent 的持久化合同与外部适配端口。 */

import type { ArtifactRef, CapabilityName } from "../protocol/v3/capability.ts";
import type { IdempotencyKey } from "../protocol/v3/coordination.ts";
import type { EventCursor, IntegrityStatus } from "../protocol/v3/events.ts";
import type { DeclassificationReceiptRef, InputSourceRef } from "../protocol/v3/taint.ts";
import type {
	AgentId,
	BudgetReservationId,
	CommandId,
	GoalId,
	LeaseId,
	PrincipalId,
	ReceiptId,
	RepositoryId,
	ResourceId,
	RuntimeInstanceId,
	SessionId,
	TraceId,
	TurnId,
	WorkspaceId,
} from "../protocol/v3/ids.ts";

export const AGENT_ROLES = ["search", "build", "review", "qa"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export const AGENT_STATES = [
	"pending",
	"starting",
	"running",
	"paused",
	"partial",
	"completed",
	"failed",
	"stopped",
] as const;
export type AgentState = (typeof AGENT_STATES)[number];

export const AGENT_RESIDENCY_STATES = ["nonresident", "resident", "evicted", "recovering", "unavailable"] as const;
export type AgentResidencyState = (typeof AGENT_RESIDENCY_STATES)[number];

export const AGENT_INTERRUPTION_CAUSES = [
	"cancelled",
	"timeout",
	"crash",
	"residency_evicted",
	"budget_exhausted",
	"delegation_revoked",
	"workspace_lost",
] as const;
export type AgentInterruptionCause = (typeof AGENT_INTERRUPTION_CAUSES)[number];

export interface AgentGraphLimits {
	maxDepth: number;
	maxChildrenPerAgent: number;
	maxTotalAgents: number;
}

/** 这些是 Runtime 硬上界；组织策略只能进一步收窄。 */
export const DEFAULT_AGENT_GRAPH_LIMITS: AgentGraphLimits = {
	maxDepth: 2,
	maxChildrenPerAgent: 3,
	maxTotalAgents: 8,
};

export interface AgentBudgetRequest {
	maxTurns: number;
	maxInputTokens: number;
	maxOutputTokens: number;
	maxUsdMicros: number;
	maxWallTimeMs: number;
	maxToolCalls: number;
	maxNetworkBytes: number;
	maxStorageBytes: number;
}

export interface AgentBudgetUsage {
	inputTokens: number;
	outputTokens: number;
	usdMicros: number;
	wallTimeMs: number;
	toolCalls: number;
	networkBytes: number;
	storageBytes: number;
	artifactCount: number;
	verifications: number;
}

export interface AgentBudgetReservationRef {
	reservationId: BudgetReservationId;
	operationId: CommandId;
	requestDigest: string;
}

export interface ParentCapabilityGrantRef {
	receiptId: ReceiptId;
	receiptDigest: string;
	decisionRevision: number;
	expiresAt?: string;
}

/** builtin/MCP/custom/unknown tool 均必须通过同一个 subset evaluator。 */
export type AgentCapabilityRequestRef =
	| {
			kind: "capability";
			requestId: CommandId;
			capability: CapabilityName;
			requestDigest: string;
	  }
	| {
			kind: "tool";
			requestId: CommandId;
			toolKind: "builtin" | "mcp" | "custom" | "unknown";
			resourceId: ResourceId;
			manifestDigest: string;
			requiredClaimsDigest: string;
	  };

export interface DelegationReceiptRef {
	receiptId: ReceiptId;
	parentAgentId: AgentId;
	childAgentId: AgentId;
	parentGrantReceiptId: ReceiptId;
	parentGrantDigest: string;
	requestDigest: string;
	decision: "allowed" | "denied";
	childSpawnAllowed: boolean;
	decisionRevision: number;
	evaluatorId: PrincipalId;
	evaluatedAt: string;
	expiresAt?: string;
	receiptDigest: string;
}

export interface CapabilitySubsetEvaluationRequest {
	requestId: CommandId;
	parentAgentId: AgentId;
	childAgentId: AgentId;
	parentGrant: ParentCapabilityGrantRef;
	requestedCapabilities: readonly AgentCapabilityRequestRef[];
	inputSources: readonly InputSourceRef[];
	declassificationReceipts: readonly DeclassificationReceiptRef[];
	requestDigest: string;
}

export interface CapabilitySubsetRevalidationRequest {
	requestId: CommandId;
	agentId: AgentId;
	parentAgentId: AgentId;
	parentGrant: ParentCapabilityGrantRef;
	requestedCapabilities: readonly AgentCapabilityRequestRef[];
	inputSources: readonly InputSourceRef[];
	declassificationReceipts: readonly DeclassificationReceiptRef[];
	previousReceipt: DelegationReceiptRef;
	requestDigest: string;
}

export interface CapabilitySubsetEvaluatorPort {
	evaluate(
		request: CapabilitySubsetEvaluationRequest,
		signal?: AbortSignal,
	): Promise<AgentResult<DelegationReceiptRef>>;
	revalidate(
		request: CapabilitySubsetRevalidationRequest,
		signal?: AbortSignal,
	): Promise<AgentResult<DelegationReceiptRef>>;
}

export interface AgentDenialReceiptRef {
	receiptId: ReceiptId;
	agentId: AgentId;
	sessionId: SessionId;
	status: "allowed" | "denied" | "revoked" | "unavailable";
	decisionRevision: number;
	checkedAt: string;
	receiptDigest: string;
}

export interface AgentDenialEvaluatorPort {
	check(agentId: AgentId, sessionId: SessionId, signal?: AbortSignal): Promise<AgentResult<AgentDenialReceiptRef>>;
}

export const AGENT_WORKSPACE_STRATEGIES = ["managed_worktree", "isolated_lease", "readonly_checkout"] as const;
export type AgentWorkspaceStrategy = (typeof AGENT_WORKSPACE_STRATEGIES)[number];

export interface AgentWorkspaceStrategyRef {
	strategyId: ResourceId;
	kind: AgentWorkspaceStrategy;
	strategyDigest: string;
}

/** 只保存 Workspace 真源签发的引用，不保存路径、fencing token 或可写 handle。 */
export interface AgentWorkspaceReceiptRef {
	receiptId: ReceiptId;
	strategy: AgentWorkspaceStrategyRef;
	sessionId: SessionId;
	workspaceId: WorkspaceId;
	repositoryId: RepositoryId;
	bindingRevision: number;
	bindingDigest: string;
	leaseId?: LeaseId;
	leaseRevision?: number;
	status: "active" | "readonly" | "released" | "stale" | "unavailable";
	issuedAt: string;
	expiresAt?: string;
	receiptDigest: string;
}

export interface AgentWorkspaceAllocateRequest {
	requestId: CommandId;
	parentAgentId: AgentId;
	parentSessionId: SessionId;
	parentWorkspaceId: WorkspaceId;
	childAgentId: AgentId;
	childSessionId: SessionId;
	role: AgentRole;
	strategy: AgentWorkspaceStrategyRef;
	requestDigest: string;
}

export interface AgentWorkspaceValidateRequest {
	requestId: CommandId;
	agentId: AgentId;
	sessionId: SessionId;
	previousReceipt: AgentWorkspaceReceiptRef;
	requestDigest: string;
}

export interface AgentWorkspaceReleaseRequest {
	requestId: CommandId;
	agentId: AgentId;
	sessionId: SessionId;
	previousReceipt: AgentWorkspaceReceiptRef;
	reason: "spawn_aborted" | "completed" | "failed" | "stopped";
	requestDigest: string;
}

export interface AgentWorkspacePort {
	allocate(
		request: AgentWorkspaceAllocateRequest,
		signal?: AbortSignal,
	): Promise<AgentResult<AgentWorkspaceReceiptRef>>;
	validate(
		request: AgentWorkspaceValidateRequest,
		signal?: AbortSignal,
	): Promise<AgentResult<AgentWorkspaceReceiptRef>>;
	release(request: AgentWorkspaceReleaseRequest, signal?: AbortSignal): Promise<AgentResult<AgentWorkspaceReceiptRef>>;
}

export interface ExpectedAgentArtifact {
	kind: ArtifactRef["kind"];
	mediaType: string;
	logicalName: string;
}

export interface AgentArtifactContract {
	expected: readonly ExpectedAgentArtifact[];
	allowPartial: boolean;
	contractDigest: string;
}

export type AgentArtifactVerificationStatus = "verified" | "unverified" | "failed" | "inconclusive";

export interface AgentArtifactReport {
	agentId: AgentId;
	logicalName: string;
	artifact: ArtifactRef;
	integrity: IntegrityStatus;
	verification: AgentArtifactVerificationStatus;
	inputSources: readonly InputSourceRef[];
	declassificationReceipts: readonly DeclassificationReceiptRef[];
	reportedAt: string;
}

export interface AgentResidencyReceiptRef {
	receiptId: ReceiptId;
	agentId: AgentId;
	sessionId: SessionId;
	runtimeInstanceId: RuntimeInstanceId;
	state: AgentResidencyState;
	revision: number;
	observedAt: string;
	reasonDigest?: string;
	receiptDigest: string;
}

export interface AgentLaunchReceiptRef {
	receiptId: ReceiptId;
	agentId: AgentId;
	sessionId: SessionId;
	launchRevision: number;
	launchedAt: string;
	receiptDigest: string;
}

export interface AgentLaunchRequest {
	requestId: CommandId;
	agentId: AgentId;
	sessionId: SessionId;
	parentAgentId: AgentId;
	role: AgentRole;
	objective: string;
	delegationReceipt: DelegationReceiptRef;
	workspaceReceipt: AgentWorkspaceReceiptRef;
	budgetReservation: AgentBudgetReservationRef;
	artifactContract: AgentArtifactContract;
	inputSources: readonly InputSourceRef[];
	declassificationReceipts: readonly DeclassificationReceiptRef[];
	requestDigest: string;
}

export type AgentLaunchResult =
	| {
			status: "started";
			launchReceipt: AgentLaunchReceiptRef;
			residencyReceipt: AgentResidencyReceiptRef;
	  }
	| { status: "rejected" | "unavailable"; reasonDigest: string; retryable: boolean };

export interface AgentCancelRequest {
	requestId: CommandId;
	agentId: AgentId;
	sessionId: SessionId;
	reasonDigest: string;
	requestDigest: string;
}

export interface AgentResumeLaunchRequest {
	requestId: CommandId;
	agentId: AgentId;
	sessionId: SessionId;
	parentAgentId: AgentId;
	delegationReceipt: DelegationReceiptRef;
	workspaceReceipt: AgentWorkspaceReceiptRef;
	budgetReservation: AgentBudgetReservationRef;
	inputSources: readonly InputSourceRef[];
	declassificationReceipts: readonly DeclassificationReceiptRef[];
	requestDigest: string;
}

export interface AgentLauncherPort {
	launch(request: AgentLaunchRequest, signal?: AbortSignal): Promise<AgentResult<AgentLaunchResult>>;
	resume(request: AgentResumeLaunchRequest, signal?: AbortSignal): Promise<AgentResult<AgentLaunchResult>>;
	cancel(request: AgentCancelRequest, signal?: AbortSignal): Promise<AgentResult<ReceiptId>>;
}

export interface RootAgentBudgetReserveRequest {
	requestId: CommandId;
	idempotencyKey: IdempotencyKey;
	agentId: AgentId;
	budget: AgentBudgetRequest;
	requestDigest: string;
}

export interface RootAgentBudgetSettleRequest {
	idempotencyKey: IdempotencyKey;
	reservation: AgentBudgetReservationRef;
	outcome: "completed" | "failed" | "stopped" | "not_started";
	usage?: AgentBudgetUsage;
	partialResults: readonly ArtifactRef[];
}

export interface RootAgentBudgetPort {
	reserve(request: RootAgentBudgetReserveRequest): Promise<AgentResult<AgentBudgetReservationRef>>;
	settle(request: RootAgentBudgetSettleRequest): Promise<AgentResult<void>>;
}

export interface SpawnAgentRequest {
	requestId: CommandId;
	idempotencyKey: IdempotencyKey;
	parentAgentId: AgentId;
	childAgentId: AgentId;
	childSessionId: SessionId;
	role: AgentRole;
	objective: string;
	expectedArtifacts: readonly ExpectedAgentArtifact[];
	allowPartial: boolean;
	depth: number;
	budget: AgentBudgetRequest;
	parentGrant: ParentCapabilityGrantRef;
	requestedCapabilities: readonly AgentCapabilityRequestRef[];
	workspaceStrategy: AgentWorkspaceStrategyRef;
	inputSources: readonly InputSourceRef[];
	declassificationReceipts: readonly DeclassificationReceiptRef[];
}

export interface RegisterRootAgentRequest {
	requestId: CommandId;
	idempotencyKey: IdempotencyKey;
	agentId: AgentId;
	sessionId: SessionId;
	goalId: GoalId;
	role: AgentRole;
	workspaceReceipt: AgentWorkspaceReceiptRef;
	capabilityGrant: ParentCapabilityGrantRef;
	inputSources: readonly InputSourceRef[];
	declassificationReceipts: readonly DeclassificationReceiptRef[];
	registeredAt?: string;
}

export interface AgentGraphEdge {
	parentAgentId: AgentId;
	childAgentId: AgentId;
	createdAt: string;
}

export interface AgentNode {
	agentId: AgentId;
	rootAgentId: AgentId;
	parentAgentId?: AgentId;
	sessionId: SessionId;
	goalId: GoalId;
	role: AgentRole;
	objectiveDigest: string;
	admissionRequestDigest?: string;
	depth: number;
	state: AgentState;
	stateReason?: AgentInterruptionCause | "launch_rejected" | "resume_rejected";
	capabilityGrant?: ParentCapabilityGrantRef;
	requestedCapabilities: readonly AgentCapabilityRequestRef[];
	delegationReceipt?: DelegationReceiptRef;
	workspaceReceipt: AgentWorkspaceReceiptRef;
	budget: AgentBudgetRequest;
	budgetReservation?: AgentBudgetReservationRef;
	turnsUsed: number;
	turnIds: readonly TurnId[];
	artifactContract: AgentArtifactContract;
	artifacts: readonly AgentArtifactReport[];
	inputSources: readonly InputSourceRef[];
	declassificationReceipts: readonly DeclassificationReceiptRef[];
	cursor?: EventCursor;
	residency?: AgentResidencyReceiptRef;
	launchReceipt?: AgentLaunchReceiptRef;
	createdAt: string;
	updatedAt: string;
}

export interface AgentHandoffManifest {
	manifestVersion: 1;
	handoffId: CommandId;
	agentId: AgentId;
	parentAgentId: AgentId;
	sessionId: SessionId;
	workspaceId: WorkspaceId;
	cursor?: EventCursor;
	delegationReceiptId: ReceiptId;
	workspaceReceiptId: ReceiptId;
	artifacts: readonly AgentArtifactReport[];
	inputSources: readonly InputSourceRef[];
	declassificationReceipts: readonly DeclassificationReceiptRef[];
	status: "complete" | "partial" | "failed";
	integrity: IntegrityStatus;
	createdAt: string;
	manifestDigest: string;
}

export interface DeclarativeMergeRequest {
	requestId: CommandId;
	idempotencyKey: IdempotencyKey;
	parentAgentId: AgentId;
	childAgentId: AgentId;
	targetWorkspace: AgentWorkspaceReceiptRef;
	sourceHandoff: AgentHandoffManifest;
	artifacts: readonly AgentArtifactReport[];
	inputSources: readonly InputSourceRef[];
	declassificationReceipts: readonly DeclassificationReceiptRef[];
	requestDigest: string;
}

export interface AgentMergeReceiptRef {
	receiptId: ReceiptId;
	requestId: CommandId;
	parentAgentId: AgentId;
	childAgentId: AgentId;
	targetWorkspaceId: WorkspaceId;
	artifactIds: readonly ArtifactRef["artifactId"][];
	outcome: "applied" | "conflict" | "rejected";
	resultArtifactRefs: readonly ArtifactRef[];
	preservedArtifactRefs: readonly ArtifactRef[];
	appliedAt: string;
	receiptDigest: string;
}

export interface DeclarativeMergePort {
	apply(request: DeclarativeMergeRequest, signal?: AbortSignal): Promise<AgentResult<AgentMergeReceiptRef>>;
}

export interface AgentSpawnIntent {
	requestId: CommandId;
	admissionRequestDigest: string;
	parentAgentId: AgentId;
	childAgentId: AgentId;
	childSessionId: SessionId;
	role: AgentRole;
	objectiveDigest: string;
	expectedArtifacts: readonly ExpectedAgentArtifact[];
	allowPartial: boolean;
	depth: number;
	budget: AgentBudgetRequest;
	parentGrant: ParentCapabilityGrantRef;
	requestedCapabilities: readonly AgentCapabilityRequestRef[];
	workspaceStrategy: AgentWorkspaceStrategyRef;
	inputSources: readonly InputSourceRef[];
	declassificationReceipts: readonly DeclassificationReceiptRef[];
	requestedAt: string;
}

export interface AgentGraphFailureRef {
	code: string;
	messageDigest: string;
	retryable: boolean;
	outcomeCertain: boolean;
	effect: "none" | "committed" | "uncertain";
}

export interface AgentGraphReconciliationFailure {
	operation: "spawn" | "handoff" | "merge";
	requestId: CommandId;
	agentId?: AgentId;
	error: AgentGraphFailureRef;
}

interface AgentGraphCommandBase {
	requestId: CommandId;
	idempotencyKey: IdempotencyKey;
	occurredAt: string;
}

/** Supervisor 只提交 canonical semantic command；不存在通用 record batch 或 JSON sidecar。 */
export type AgentGraphSemanticCommand =
	| (AgentGraphCommandBase & { type: "agent.root_registered"; node: AgentNode })
	| (AgentGraphCommandBase & {
			type: "agent.root_revalidated";
			agentId: AgentId;
			workspaceReceipt: AgentWorkspaceReceiptRef;
			capabilityGrant: ParentCapabilityGrantRef;
	  })
	| (AgentGraphCommandBase & { type: "agent.spawn_requested"; intent: AgentSpawnIntent })
	| (AgentGraphCommandBase & {
			type: "agent.spawned";
			intentRequestId: CommandId;
			node: AgentNode;
			edge: AgentGraphEdge;
	  })
	| (AgentGraphCommandBase & {
			type: "agent.spawn_failed";
			intentRequestId: CommandId;
			agentId: AgentId;
			error: AgentGraphFailureRef;
	  })
	| (AgentGraphCommandBase & {
			type: "agent.transitioned";
			agentId: AgentId;
			from: AgentState;
			to: "starting" | "running";
			reason?: AgentNode["stateReason"];
	  })
	| (AgentGraphCommandBase & {
			type: "agent.paused";
			agentId: AgentId;
			from: AgentState;
			reason: NonNullable<AgentNode["stateReason"]>;
	  })
	| (AgentGraphCommandBase & {
			type: "agent.stopped";
			agentId: AgentId;
			from: AgentState;
			reason: NonNullable<AgentNode["stateReason"]>;
	  })
	| (AgentGraphCommandBase & {
			type: "agent.partial_committed";
			agentId: AgentId;
			from: AgentState;
			reason: NonNullable<AgentNode["stateReason"]>;
	  })
	| (AgentGraphCommandBase & {
			type: "agent.finished";
			agentId: AgentId;
			from: AgentState;
	  })
	| (AgentGraphCommandBase & {
			type: "agent.failed";
			agentId: AgentId;
			from: AgentState;
			reason: NonNullable<AgentNode["stateReason"]>;
			error: AgentGraphFailureRef;
	  })
	| (AgentGraphCommandBase & {
			type: "agent.cursor_advanced";
			agentId: AgentId;
			cursor: EventCursor;
	  })
	| (AgentGraphCommandBase & { type: "agent.artifact_reported"; report: AgentArtifactReport })
	| (AgentGraphCommandBase & { type: "agent.residency_changed"; receipt: AgentResidencyReceiptRef })
	| (AgentGraphCommandBase & {
			type: "agent.budget_rebound";
			agentId: AgentId;
			previousReservationId: BudgetReservationId;
			reservation: AgentBudgetReservationRef;
	  })
	| (AgentGraphCommandBase & {
			type: "agent.turn_recorded";
			agentId: AgentId;
			turnId: TurnId;
			turnNumber: number;
	  })
	| (AgentGraphCommandBase & {
			type: "agent.launch_recorded";
			agentId: AgentId;
			launchReceipt: AgentLaunchReceiptRef;
			residencyReceipt: AgentResidencyReceiptRef;
	  })
	| (AgentGraphCommandBase & {
			type: "agent.resume_revalidated";
			agentId: AgentId;
			delegationReceipt: DelegationReceiptRef;
			workspaceReceipt: AgentWorkspaceReceiptRef;
			denialReceipt: AgentDenialReceiptRef;
	  })
	| (AgentGraphCommandBase & { type: "agent.handoff_requested"; handoff: AgentHandoffManifest })
	| (AgentGraphCommandBase & { type: "agent.handoff_committed"; handoff: AgentHandoffManifest })
	| (AgentGraphCommandBase & {
			type: "agent.handoff_failed";
			handoffId: CommandId;
			agentId: AgentId;
			error: AgentGraphFailureRef;
	  })
	| (AgentGraphCommandBase & { type: "agent.merge_requested"; request: DeclarativeMergeRequest })
	| (AgentGraphCommandBase & { type: "agent.merge_committed"; receipt: AgentMergeReceiptRef })
	| (AgentGraphCommandBase & { type: "agent.merge_conflicted"; receipt: AgentMergeReceiptRef })
	| (AgentGraphCommandBase & {
			type: "agent.merge_failed";
			parentAgentId: AgentId;
			childAgentId: AgentId;
			error: AgentGraphFailureRef;
	  });

export interface AgentGraphStoreHead {
	revision: number;
	cursor?: EventCursor;
	projection: AgentGraphProjection;
}

export type AgentGraphCommitOutcome =
	| { status: "committed" | "duplicate"; head: AgentGraphStoreHead }
	| { status: "conflict"; actualRevision: number };

export interface DurableAgentGraphStorePort {
	load(rootAgentId: AgentId): Promise<AgentResult<AgentGraphStoreHead>>;
	commit(
		rootAgentId: AgentId,
		expectedRevision: number,
		command: AgentGraphSemanticCommand,
	): Promise<AgentResult<AgentGraphCommitOutcome>>;
}

export interface AgentGraphProjection {
	rootAgentId?: AgentId;
	goalId?: GoalId;
	revision: number;
	nodes: ReadonlyMap<AgentId, AgentNode>;
	edges: readonly AgentGraphEdge[];
	handoffs: ReadonlyMap<CommandId, AgentHandoffManifest>;
	mergeReceipts: readonly AgentMergeReceiptRef[];
	pendingSpawns: ReadonlyMap<AgentId, AgentSpawnIntent>;
	pendingHandoffs: ReadonlyMap<CommandId, AgentHandoffManifest>;
	pendingMerges: ReadonlyMap<CommandId, DeclarativeMergeRequest>;
	reconciliationFailures: readonly AgentGraphReconciliationFailure[];
}

export const AGENT_ERROR_CODES = [
	"invalid_request",
	"invalid_graph",
	"graph_not_initialized",
	"agent_not_found",
	"agent_exists",
	"session_exists",
	"orphan_agent",
	"depth_limit",
	"children_limit",
	"total_limit",
	"spawn_denied",
	"delegation_denied",
	"delegation_invalid",
	"workspace_invalid",
	"workspace_shared",
	"budget_denied",
	"launch_failed",
	"invalid_transition",
	"artifact_contract_mismatch",
	"handoff_invalid",
	"merge_invalid",
	"resume_denied",
	"reference_unavailable",
	"revision_conflict",
	"idempotency_conflict",
	"store_unavailable",
] as const;

export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[number];

export interface AgentError {
	code: AgentErrorCode;
	message: string;
	retryable: boolean;
	details?: Readonly<Record<string, string | number | boolean>>;
}

export type AgentResult<T> = { ok: true; value: T } | { ok: false; error: AgentError };

export interface AgentSpawnOutcome {
	graph: AgentGraphProjection;
	node: AgentNode;
}

export interface AgentResumeOutcome {
	graph: AgentGraphProjection;
	node: AgentNode;
}

export interface AgentSupervisorPorts {
	graphStore: DurableAgentGraphStorePort;
	capabilitySubset: CapabilitySubsetEvaluatorPort;
	workspace: AgentWorkspacePort;
	deniedAgents: AgentDenialEvaluatorPort;
	budget: RootAgentBudgetPort;
	launcher: AgentLauncherPort;
	merge: DeclarativeMergePort;
}

export interface AgentSupervisorOptions {
	rootAgentId: AgentId;
	ports: AgentSupervisorPorts;
	limits?: Partial<AgentGraphLimits>;
	clock?: () => Date;
}

export interface AgentResumeRequest {
	requestId: CommandId;
	idempotencyKey: IdempotencyKey;
	agentId: AgentId;
}

export interface AgentMergeRequest {
	requestId: CommandId;
	idempotencyKey: IdempotencyKey;
	parentAgentId: AgentId;
	childAgentId: AgentId;
	handoffId: CommandId;
	logicalNames: readonly string[];
}

export interface AgentTerminalRequest {
	requestId: CommandId;
	idempotencyKey: IdempotencyKey;
	agentId: AgentId;
	outcome: "completed" | "failed" | "stopped";
	usage?: AgentBudgetUsage;
	reason?: AgentInterruptionCause;
}

export interface AgentCursorAdvanceRequest {
	requestId: CommandId;
	idempotencyKey: IdempotencyKey;
	agentId: AgentId;
	cursor: EventCursor;
}

export interface AgentTurnRecordRequest {
	requestId: CommandId;
	idempotencyKey: IdempotencyKey;
	agentId: AgentId;
	turnId: TurnId;
}

export interface AgentArtifactReportRequest {
	requestId: CommandId;
	idempotencyKey: IdempotencyKey;
	report: AgentArtifactReport;
}

export interface AgentHandoffRequest {
	requestId: CommandId;
	idempotencyKey: IdempotencyKey;
	agentId: AgentId;
	status: AgentHandoffManifest["status"];
}

export interface AgentRuntimeContextRef {
	principalId: PrincipalId;
	runtimeInstanceId: RuntimeInstanceId;
	traceId: TraceId;
}
