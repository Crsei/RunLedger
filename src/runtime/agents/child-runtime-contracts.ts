/** Cold-recoverable child runtime 的稳定 v2 合同；不包含 provider credential 或进程 handle。 */

import type { ArtifactRef } from "../protocol/v3/capability.ts";
import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
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
import { isRuntimeId } from "../protocol/v3/ids.ts";
import {
	isChildRuntimeAuthorityRecord,
	type ChildRuntimeAuthorityRecord,
	type ReleasedChildRuntimeAuthorityRecord,
} from "./child-runtime-authority.ts";
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
	  }
	| {
			kind: "replay_legacy_released";
			record: ReleasedChildRuntimeAuthorityRecord;
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

const DIGEST = /^[a-f0-9]{64}$/u;

function validCursor(cursor: EventCursor): boolean {
	return (
		cursor.stream.scope === "session" &&
		isRuntimeId(cursor.stream.streamId, "eventStream") &&
		isRuntimeId(cursor.stream.sessionId, "session") &&
		Number.isSafeInteger(cursor.sequence) &&
		cursor.sequence >= 0 &&
		isRuntimeId(cursor.eventId, "event") &&
		DIGEST.test(cursor.eventHash)
	);
}

export function childRuntimeDescriptorV2Digest(
	descriptor: Omit<ChildRuntimeDescriptorV2, "descriptorDigest">,
): string {
	return canonicalDigest(descriptor);
}

export function isChildRuntimeDescriptorV2(
	value: unknown,
): value is ChildRuntimeDescriptorV2 {
	if (!value || typeof value !== "object") return false;
	const descriptor = value as ChildRuntimeDescriptorV2;
	const { descriptorDigest, ...body } = descriptor;
	return (
		descriptor.schemaVersion === 2 &&
		isRuntimeId(descriptor.descriptorId, "resource") &&
		isRuntimeId(descriptor.runtimeId, "runtime") &&
		descriptor.providerId.length > 0 &&
		descriptor.providerId.length <= 512 &&
		descriptor.modelId.length > 0 &&
		descriptor.modelId.length <= 512 &&
		DIGEST.test(descriptor.profileDigest) &&
		Number.isSafeInteger(descriptor.resourceGeneration) &&
		descriptor.resourceGeneration >= 1 &&
		DIGEST.test(descriptor.resourceManifestDigest) &&
		Number.isSafeInteger(descriptor.toolGeneration) &&
		descriptor.toolGeneration >= 1 &&
		DIGEST.test(descriptor.toolManifestDigest) &&
		Number.isSafeInteger(descriptor.factoryGeneration) &&
		descriptor.factoryGeneration >= 1 &&
		descriptorDigest === childRuntimeDescriptorV2Digest(body)
	);
}

export function childRuntimeExecutionRecordV2Digest(
	record: Omit<ChildRuntimeExecutionRecordV2, "recordDigest">,
): string {
	return canonicalDigest(record);
}

export function isChildRuntimeExecutionRecordV2(
	value: unknown,
): value is ChildRuntimeExecutionRecordV2 {
	if (!value || typeof value !== "object") return false;
	const record = value as ChildRuntimeExecutionRecordV2;
	const { recordDigest, ...body } = record;
	if (
		record.schemaVersion !== 2 ||
		record.kind !== "child_runtime_execution" ||
		!(CHILD_RUNTIME_EXECUTION_STATES_V2 as readonly string[]).includes(record.state) ||
		!Number.isSafeInteger(record.revision) ||
		record.revision < 0 ||
		!isRuntimeId(record.authorityId, "authority") ||
		!isRuntimeId(record.tenantId, "tenant") ||
		!isRuntimeId(record.principalId, "principal") ||
		!isRuntimeId(record.parentSessionId, "session") ||
		!isRuntimeId(record.parentAgentId, "agent") ||
		!isRuntimeId(record.agentId, "agent") ||
		!isRuntimeId(record.sessionId, "session") ||
		!isRuntimeId(record.workspaceId, "workspace") ||
		record.parentAgentId === record.agentId ||
		!DIGEST.test(record.objectiveDigest) ||
		!DIGEST.test(record.promptDigest) ||
		record.promptArtifact.storedDigest !== record.promptDigest ||
		record.promptArtifact.authorityId !== record.authorityId ||
		record.promptArtifact.tenantId !== record.tenantId ||
		!isChildRuntimeDescriptorV2(record.runtimeDescriptor) ||
		record.recordDigest !== childRuntimeExecutionRecordV2Digest(body)
	) return false;
	if (
		record.activationReceipt &&
		(record.activationReceipt.requestId !== record.activationRequestId ||
			record.activationReceipt.requestDigest !== record.activationRequestDigest ||
			record.activationReceipt.runtimeDescriptorDigest !== record.runtimeDescriptor.descriptorDigest ||
			!DIGEST.test(record.activationReceipt.receiptDigest))
	) return false;
	if (
		record.completionReceipt &&
		(!validCursor(record.completionReceipt.finalCursor) ||
			record.completionReceipt.finalCursor.stream.scope !== "session" ||
			record.completionReceipt.finalCursor.stream.sessionId !== record.sessionId ||
			!DIGEST.test(record.completionReceipt.receiptDigest))
	) return false;
	return true;
}

export interface ChildRuntimeColdRecoveryEvidence {
	/** false 表示 provider/tool 副作用可能已发生；Runtime不得自动重发。 */
	outcomeKnown: boolean;
	writerEvidenceComplete: boolean;
	stopEvidenceComplete: boolean;
	finalCursorComplete: boolean;
	reconciliationEvidenceDigest?: string;
}

function quarantine(
	recordVersion: 1 | 2,
	agentId: AgentId,
	reason: string,
): ChildRuntimeRecoveryDecision {
	return {
		kind: "quarantine",
		recordVersion,
		agentId,
		operatorResolution: "supply_evidence",
		reasonDigest: canonicalDigest(reason),
	};
}

/**
 * Cold recovery只读取持久证据。任何 caller cache/host residency 都不能改变判定。
 */
export function assessChildRuntimeColdRecovery(
	value: unknown,
	evidence: ChildRuntimeColdRecoveryEvidence,
): AgentResult<ChildRuntimeRecoveryDecision> {
	if (isChildRuntimeAuthorityRecord(value)) {
		return value.state === "released"
			? { ok: true, value: { kind: "replay_legacy_released", record: value } }
			: {
					ok: true,
					value: quarantine(
						1,
						value.agentId,
						"legacy child runtime authority is not terminal released evidence",
					),
				};
	}
	if (!isChildRuntimeExecutionRecordV2(value)) {
		return {
			ok: false,
			error: {
				code: "invalid_request",
				message: "child runtime execution record is invalid or corrupted",
				retryable: false,
			},
		};
	}
	const record = value;
	if (
		!evidence.writerEvidenceComplete ||
		!evidence.stopEvidenceComplete ||
		((record.state === "completed" || record.state === "stopped") &&
			!evidence.finalCursorComplete)
	) {
		return {
			ok: true,
			value: quarantine(
				2,
				record.agentId,
				"child runtime writer, stop, or final cursor evidence is incomplete",
			),
		};
	}
	if (!evidence.outcomeKnown || record.state === "stop_uncertain") {
		return {
			ok: true,
			value: {
				kind: "stop_uncertain",
				record,
				reasonDigest: canonicalDigest({
					reason: "child provider or tool outcome is unknown",
					reconciliationEvidenceDigest:
						evidence.reconciliationEvidenceDigest ?? null,
				}),
			},
		};
	}
	if (record.state === "completed" || record.state === "stopped") {
		return record.completionReceipt
			? {
					ok: true,
					value: {
						kind: "replay_terminal",
						record,
						completion: record.completionReceipt,
					},
				}
			: {
					ok: true,
					value: quarantine(2, record.agentId, "terminal child record lacks completion receipt"),
				};
	}
	if (
		(record.state === "active" || record.state === "completion_pending") &&
		record.activationReceipt
	) {
		return {
			ok: true,
			value: {
				kind: "restore_exact",
				record,
				descriptor: record.runtimeDescriptor,
			},
		};
	}
	return {
		ok: true,
		value: quarantine(2, record.agentId, "child runtime has not crossed a durable activation barrier"),
	};
}
