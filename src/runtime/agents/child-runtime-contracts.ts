/** Cold-recoverable child runtime 的稳定 v2 合同；不包含 provider credential 或进程 handle。 */

import type { ArtifactRef } from "../protocol/v3/capability.ts";
import type { EventCursor } from "../protocol/v3/events.ts";
import type {
	AgentId,
	AuthorityId,
	CommandId,
	PrincipalId,
	ReceiptId,
	ResourceId,
	RuntimeInstanceId,
	SessionId,
	TenantId,
	WorkspaceId,
} from "../protocol/v3/ids.ts";
import type { AgentResult, AgentRole } from "./types.ts";
import type { HeadlessChildRuntimeFactoryPort } from "./headless-child-runtime.ts";

export const CHILD_RUNTIME_EXECUTION_STATES_V2 = [
	"prepared",
	"activation_pending",
	"active",
	"completion_pending",
	"completed",
	"stop_uncertain",
	"stopped",
	"quarantined",
] as const;

export type ChildRuntimeExecutionStateV2 =
	(typeof CHILD_RUNTIME_EXECUTION_STATES_V2)[number];

export interface ChildRuntimeDescriptorV2 {
	schemaVersion: 2;
	descriptorId: ResourceId;
	runtimeId: RuntimeInstanceId;
	providerId: string;
	modelId: string;
	profileDigest: string;
	resourceGeneration: number;
	resourceManifestDigest: string;
	toolGeneration: number;
	toolManifestDigest: string;
	factoryGeneration: number;
	descriptorDigest: string;
}

export interface ChildRuntimeActivationReceiptV2 {
	receiptId: ReceiptId;
	requestId: CommandId;
	requestDigest: string;
	runtimeDescriptorDigest: string;
	activatedAt: string;
	receiptDigest: string;
}

export interface ChildRuntimeCompletionReceiptV2 {
	receiptId: ReceiptId;
	requestId: CommandId;
	requestDigest: string;
	outcome: "completed" | "stopped" | "failed";
	finalCursor: EventCursor;
	artifactRefs: readonly ArtifactRef[];
	completedAt: string;
	receiptDigest: string;
}

export interface ChildRuntimeExecutionRecordV2 {
	schemaVersion: 2;
	kind: "child_runtime_execution";
	state: ChildRuntimeExecutionStateV2;
	revision: number;
	authorityId: AuthorityId;
	tenantId: TenantId;
	principalId: PrincipalId;
	parentSessionId: SessionId;
	parentAgentId: AgentId;
	agentId: AgentId;
	sessionId: SessionId;
	workspaceId: WorkspaceId;
	role: AgentRole;
	objectiveDigest: string;
	promptArtifact: ArtifactRef;
	promptDigest: string;
	runtimeDescriptor: ChildRuntimeDescriptorV2;
	activationRequestId?: CommandId;
	activationRequestDigest?: string;
	activationReceipt?: ChildRuntimeActivationReceiptV2;
	completionReceipt?: ChildRuntimeCompletionReceiptV2;
	reconciliationEvidenceDigest?: string;
	operatorResolutionDigest?: string;
	updatedAt: string;
	recordDigest: string;
}

export type ChildRuntimeRecoveryDecision =
	| {
			kind: "restore_exact";
			record: ChildRuntimeExecutionRecordV2;
			descriptor: ChildRuntimeDescriptorV2;
	  }
	| {
			kind: "stop_uncertain";
			record: ChildRuntimeExecutionRecordV2;
			reasonDigest: string;
	  }
	| {
			kind: "quarantine";
			recordVersion: 1 | 2;
			agentId: AgentId;
			operatorResolution: "discard" | "adopt_stopped" | "supply_evidence";
			reasonDigest: string;
	  }
	| {
			kind: "replay_terminal";
			record: ChildRuntimeExecutionRecordV2;
			completion: ChildRuntimeCompletionReceiptV2;
	  };

export interface ChildRuntimeRecoverySnapshot {
	agentId: AgentId;
	sessionId: SessionId;
	state: ChildRuntimeExecutionStateV2;
	finalCursor: EventCursor | null;
	descriptorDigest: string;
	reconciliationEvidenceDigest: string | null;
	decision: ChildRuntimeRecoveryDecision["kind"];
}

export interface ChildRuntimeReplacementReceipt {
	receiptId: ReceiptId;
	agentId: AgentId;
	sessionId: SessionId;
	previousRuntimeId: RuntimeInstanceId;
	replacementRuntimeId: RuntimeInstanceId;
	previousGeneration: number;
	replacementGeneration: number;
	authorityCommitCursor: EventCursor;
	drainStatus: "completed" | "reconciliation_required";
	committedAt: string;
	receiptDigest: string;
}

export type ChildGovernedOperationKind =
	| "provider"
	| "tool"
	| "isolated_command"
	| "resume"
	| "cancel";

export interface ChildGovernedOperationAdmissionRequest {
	requestId: CommandId;
	agentId: AgentId;
	sessionId: SessionId;
	workspaceId: WorkspaceId;
	operation: ChildGovernedOperationKind;
	capabilityReceiptDigest: string;
	workspaceReceiptDigest: string;
	resourceGeneration: number;
	resourceManifestDigest: string;
	operationDigest: string;
}

export interface ChildGovernedOperationAdmissionReceipt {
	receiptId: ReceiptId;
	requestId: CommandId;
	agentId: AgentId;
	sessionId: SessionId;
	operation: ChildGovernedOperationKind;
	decision: "allowed" | "denied" | "stale";
	resourceGeneration: number;
	checkedAt: string;
	receiptDigest: string;
}

export interface ChildGovernedOperationAdmissionPort {
	admit(
		request: ChildGovernedOperationAdmissionRequest,
		signal?: AbortSignal,
	): Promise<AgentResult<ChildGovernedOperationAdmissionReceipt>>;
}

export interface ProductionHeadlessChildRuntimeFactoryPort
	extends HeadlessChildRuntimeFactoryPort {
	readonly environment: "production";
	readonly descriptor: ChildRuntimeDescriptorV2;
	preflight(): Promise<AgentResult<{ descriptorDigest: string; recoveryEvidenceDigest: string }>>;
	recover(
		record: ChildRuntimeExecutionRecordV2,
		signal?: AbortSignal,
	): Promise<AgentResult<ChildRuntimeRecoveryDecision>>;
}
