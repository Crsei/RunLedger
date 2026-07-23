/** Agent graph semantic reducer 与内存 projection/head adapter。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import { parseIdempotencyKey } from "../protocol/v3/coordination.ts";
import type { IdempotencyKey } from "../protocol/v3/coordination.ts";
import { isRuntimeId } from "../protocol/v3/ids.ts";
import type { AgentId } from "../protocol/v3/ids.ts";
import { isWorkspaceReleaseReceiptRef } from "../protocol/v3/workspace.ts";
import {
	capabilitySubsetRequestDigest,
	delegationReceiptMatches,
	inputLineageIsValid,
	inputLineagePreserves,
	isAgentCapabilityRequestRef,
} from "./delegation.ts";
import { validateAgentHandoffManifest } from "./handoff.ts";
import { declarativeMergeRequestDigest } from "./merge.ts";
import type {
	AgentArtifactContract,
	AgentArtifactReport,
	AgentBudgetSettlementReceiptRef,
	AgentCleanupKind,
	AgentCleanupReceiptBody,
	AgentCleanupReceiptRef,
	AgentCleanupRecord,
	AgentCleanupStage,
	AgentErrorCode,
	AgentGraphCommitOutcome,
	AgentGraphEdge,
	AgentGraphFailureRef,
	AgentGraphLimits,
	AgentGraphProjection,
	AgentGraphReconciliationFailure,
	AgentGraphSemanticCommand,
	AgentGraphStoreHead,
	AgentNode,
	AgentMergeReceiptRef,
	AgentResult,
	AgentRuntimeReleaseReceiptRef,
	AgentRuntimeReleaseRequest,
	AgentSemanticTerminalRecord,
	AgentSpawnIntent,
	AgentState,
	AgentWorkspaceReleaseRequest,
	AgentWorkspaceReleaseReceiptRef,
	AgentWorkspaceReceiptRef,
	DurableAgentGraphStorePort,
	RootAgentBudgetSettleRequest,
} from "./types.ts";
import { DEFAULT_AGENT_GRAPH_LIMITS } from "./types.ts";
import { AGENT_ROLES } from "./types.ts";

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const FINAL_STATES: ReadonlySet<AgentState> = new Set(["completed", "failed", "stopped"]);
const AGENT_BUDGET_USAGE_FIELDS = [
	"inputTokens",
	"outputTokens",
	"usdMicros",
	"wallTimeMs",
	"toolCalls",
	"networkBytes",
	"storageBytes",
	"artifactCount",
	"verifications",
] as const satisfies readonly (keyof NonNullable<AgentSemanticTerminalRecord["usage"]>)[];
const STOPPED_TERMINAL_REASONS: ReadonlySet<AgentSemanticTerminalRecord["reason"]> = new Set([
	"cancelled",
	"budget_exhausted",
	"delegation_revoked",
]);
const FAILED_TERMINAL_REASONS: ReadonlySet<AgentSemanticTerminalRecord["reason"]> = new Set([
	"timeout",
	"crash",
	"workspace_lost",
	"launch_rejected",
	"resume_rejected",
]);

export const AGENT_STATE_TRANSITIONS: Readonly<Record<AgentState, readonly AgentState[]>> = {
	pending: ["starting", "running", "paused", "failed", "stopped"],
	starting: ["running", "paused", "partial", "failed", "stopped"],
	running: ["paused", "partial", "completed", "failed", "stopped"],
	paused: ["running", "partial", "failed", "stopped"],
	partial: ["running", "completed", "failed", "stopped"],
	completed: [],
	failed: [],
	stopped: [],
};

function fail<T>(
	code: AgentErrorCode,
	message: string,
	retryable = false,
): AgentResult<T> {
	return { ok: false, error: { code, message, retryable } };
}

function digestIsValid(value: string): boolean {
	return DIGEST_PATTERN.test(value);
}

function timestampIsValid(value: string): boolean {
	return Number.isFinite(Date.parse(value));
}

function numberIsBounded(value: number, minimum: number, maximum = Number.MAX_SAFE_INTEGER): boolean {
	return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function cloneArtifactRef<T extends AgentSemanticTerminalRecord["partialResults"][number]>(artifact: T): T {
	return { ...artifact };
}

function cloneSemanticTerminalRecord(record: AgentSemanticTerminalRecord): AgentSemanticTerminalRecord {
	return {
		...record,
		...(record.usage ? { usage: { ...record.usage } } : {}),
		partialResults: record.partialResults.map(cloneArtifactRef),
	};
}

export function createAgentSemanticTerminalRecord(
	input: Omit<AgentSemanticTerminalRecord, "requestDigest" | "terminalDigest"> & {
		agentId: AgentId;
		idempotencyKey: IdempotencyKey;
	},
): AgentSemanticTerminalRecord {
	const requestBody = {
		requestId: input.requestId,
		idempotencyKey: input.idempotencyKey,
		agentId: input.agentId,
		outcome: input.outcome,
		...(input.reason ? { reason: input.reason } : {}),
		...(input.reasonEvidenceDigest !== undefined ? { reasonEvidenceDigest: input.reasonEvidenceDigest } : {}),
		...(input.usage ? { usage: { ...input.usage } } : {}),
		partialResults: input.partialResults.map(cloneArtifactRef),
	};
	const body = {
		requestId: input.requestId,
		requestDigest: canonicalDigest(requestBody),
		outcome: input.outcome,
		...(input.reason ? { reason: input.reason } : {}),
		...(input.reasonEvidenceDigest !== undefined ? { reasonEvidenceDigest: input.reasonEvidenceDigest } : {}),
		...(input.usage ? { usage: { ...input.usage } } : {}),
		partialResults: input.partialResults.map(cloneArtifactRef),
	};
	return { ...body, terminalDigest: canonicalDigest(body) };
}

export function agentCleanupRequestDigest(input: {
	requestId: AgentCleanupRecord["requestId"];
	agentId: AgentId;
	sessionId: AgentCleanupRecord["sessionId"];
	kind: AgentCleanupKind;
	terminalDigest: string;
}): string {
	return canonicalDigest(input);
}

export function agentRuntimeReleaseRequestDigest(
	request: Omit<AgentRuntimeReleaseRequest, "requestDigest">,
): string {
	return canonicalDigest(request);
}

export function agentWorkspaceReleaseRequestDigest(
	request: Omit<AgentWorkspaceReleaseRequest, "requestDigest">,
): string {
	return canonicalDigest(request);
}

export function agentBudgetSettlementRequestDigest(
	request: Omit<RootAgentBudgetSettleRequest, "requestDigest">,
): string {
	const { idempotencyKey: _idempotencyKey, ...semantic } = request;
	return canonicalDigest(semantic);
}

export function agentCleanupReceiptDigest(receipt: AgentCleanupReceiptBody): string {
	return canonicalDigest(receipt);
}

export function normalizeAgentGraphLimits(limits: Partial<AgentGraphLimits> = {}): AgentResult<AgentGraphLimits> {
	const candidate: AgentGraphLimits = {
		maxDepth: limits.maxDepth ?? DEFAULT_AGENT_GRAPH_LIMITS.maxDepth,
		maxChildrenPerAgent: limits.maxChildrenPerAgent ?? DEFAULT_AGENT_GRAPH_LIMITS.maxChildrenPerAgent,
		maxTotalAgents: limits.maxTotalAgents ?? DEFAULT_AGENT_GRAPH_LIMITS.maxTotalAgents,
	};
	if (
		!numberIsBounded(candidate.maxDepth, 0, DEFAULT_AGENT_GRAPH_LIMITS.maxDepth) ||
		!numberIsBounded(candidate.maxChildrenPerAgent, 1, DEFAULT_AGENT_GRAPH_LIMITS.maxChildrenPerAgent) ||
		!numberIsBounded(candidate.maxTotalAgents, 1, DEFAULT_AGENT_GRAPH_LIMITS.maxTotalAgents)
	) {
		return fail("invalid_request", "agent graph policy may only narrow the Runtime hard limits");
	}
	return { ok: true, value: candidate };
}

function artifactContractIsValid(contract: AgentArtifactContract, allowEmpty: boolean): boolean {
	if (!digestIsValid(contract.contractDigest)) return false;
	if ((!allowEmpty && contract.expected.length === 0) || contract.expected.length > 64) return false;
	const names = new Set<string>();
	for (const expected of contract.expected) {
		if (
			expected.logicalName.length === 0 ||
			expected.logicalName.length > 256 ||
			expected.mediaType.length === 0 ||
			expected.mediaType.length > 256 ||
			names.has(expected.logicalName)
		) {
			return false;
		}
		names.add(expected.logicalName);
	}
	return canonicalDigest({ expected: contract.expected, allowPartial: contract.allowPartial }) === contract.contractDigest;
}

function reportMatchesContract(report: AgentArtifactReport, node: AgentNode): boolean {
	const expected = node.artifactContract.expected.find((candidate) => candidate.logicalName === report.logicalName);
	return Boolean(
		expected &&
			isRuntimeId(report.artifact.authorityId, "authority") &&
			isRuntimeId(report.artifact.tenantId, "tenant") &&
			isRuntimeId(report.artifact.artifactId, "artifact") &&
			isRuntimeId(report.artifact.transformReceipt, "receipt") &&
			digestIsValid(report.artifact.storedDigest) &&
			Number.isSafeInteger(report.artifact.originalSize) &&
			report.artifact.originalSize >= 0 &&
			Number.isSafeInteger(report.artifact.storedSize) &&
			report.artifact.storedSize >= 0 &&
			expected.kind === report.artifact.kind &&
			expected.mediaType === report.artifact.mediaType &&
		report.agentId === node.agentId &&
		(!report.artifact.workspaceId || report.artifact.workspaceId === node.workspaceReceipt.workspaceId) &&
		inputLineagePreserves(
			node.inputSources,
			node.declassificationReceipts,
			report.inputSources,
			report.declassificationReceipts,
		) &&
		inputLineagePreserves(
			report.inputSources,
			report.declassificationReceipts,
			node.inputSources,
			node.declassificationReceipts,
		),
	);
}

function completionContractSatisfied(node: AgentNode): boolean {
	return node.artifactContract.expected.every((expected) =>
		node.artifacts.some(
			(report) =>
				report.logicalName === expected.logicalName &&
				report.artifact.kind === expected.kind &&
				report.artifact.mediaType === expected.mediaType &&
				report.integrity === "valid" &&
				report.verification === "verified",
		),
	);
}

function budgetIsValid(node: AgentNode, isRoot: boolean): boolean {
	const budget = node.budget;
	const values = [
		budget.maxTurns,
		budget.maxInputTokens,
		budget.maxOutputTokens,
		budget.maxUsdMicros,
		budget.maxWallTimeMs,
		budget.maxToolCalls,
		budget.maxNetworkBytes,
		budget.maxStorageBytes,
	];
	return (
		values.every((value) => Number.isSafeInteger(value) && value >= 0) &&
		(isRoot ? budget.maxTurns === 0 : budget.maxTurns >= 1) &&
		Number.isSafeInteger(node.turnsUsed) &&
		node.turnsUsed >= 0 &&
		node.turnsUsed === node.turnIds.length &&
		new Set(node.turnIds).size === node.turnIds.length &&
		node.turnIds.every((turnId) => isRuntimeId(turnId, "turn")) &&
		(isRoot || node.turnsUsed <= budget.maxTurns)
	);
}

function workspaceReceiptRefIsValid(receipt: AgentWorkspaceReceiptRef): boolean {
	const { receiptDigest, ...body } = receipt;
	return (
		isRuntimeId(receipt.receiptId, "receipt") &&
		isRuntimeId(receipt.sessionId, "session") &&
		isRuntimeId(receipt.workspaceId, "workspace") &&
		isRuntimeId(receipt.repositoryId, "repository") &&
		isRuntimeId(receipt.strategy.strategyId, "resource") &&
		digestIsValid(receipt.strategy.strategyDigest) &&
		digestIsValid(receipt.bindingDigest) &&
		digestIsValid(receiptDigest) &&
		receiptDigest === canonicalDigest(body) &&
		Number.isSafeInteger(receipt.bindingRevision) &&
		receipt.bindingRevision >= 0 &&
		timestampIsValid(receipt.issuedAt) &&
		(!receipt.expiresAt || timestampIsValid(receipt.expiresAt))
	);
}

function workspaceReceiptIsValid(node: AgentNode): boolean {
	return workspaceReceiptRefIsValid(node.workspaceReceipt);
}

function budgetUsageIsValid(usage: AgentSemanticTerminalRecord["usage"]): boolean {
	return Boolean(
		usage &&
			Object.keys(usage).length === AGENT_BUDGET_USAGE_FIELDS.length &&
			AGENT_BUDGET_USAGE_FIELDS.every((field) => Number.isSafeInteger(usage[field]) && usage[field] >= 0),
	);
}

function terminalOutcomeReasonIsValid(record: AgentSemanticTerminalRecord): boolean {
	if (record.outcome === "completed") return record.reason === undefined;
	if (record.outcome === "stopped") return STOPPED_TERMINAL_REASONS.has(record.reason);
	return FAILED_TERMINAL_REASONS.has(record.reason);
}

function terminalReasonEvidenceIsValid(record: AgentSemanticTerminalRecord): boolean {
	return (
		record.reasonEvidenceDigest === undefined ||
		(record.outcome === "stopped" && record.reason === "cancelled" && digestIsValid(record.reasonEvidenceDigest))
	);
}

function terminalUsageCoversGraphFacts(
	usage: NonNullable<AgentSemanticTerminalRecord["usage"]>,
	node: AgentNode,
): boolean {
	const verifiedArtifacts = node.artifacts.filter((report) => report.verification === "verified").length;
	// turn 数没有对应 usage 字段；verified 标签只作为 graph 内部下界，不证明外部验证真实性。
	return usage.artifactCount >= node.artifacts.length && usage.verifications >= verifiedArtifacts;
}

function semanticTerminalUsageIsValid(
	record: AgentSemanticTerminalRecord,
	node: AgentNode,
): boolean {
	if (record.usage !== undefined) {
		return budgetUsageIsValid(record.usage) && terminalUsageCoversGraphFacts(record.usage, node);
	}
	if (!node.parentAgentId) return true;
	return (
		record.reason === "launch_rejected" &&
		node.budgetReservation !== undefined &&
		node.launchReceipt === undefined &&
		node.residency === undefined
	);
}

function semanticTerminalIsValid(
	record: AgentSemanticTerminalRecord,
	node: AgentNode,
	requestId: AgentSemanticTerminalRecord["requestId"],
	idempotencyKey: IdempotencyKey,
	outcome: AgentSemanticTerminalRecord["outcome"],
	reason?: AgentSemanticTerminalRecord["reason"],
): boolean {
	if (
		record.requestId !== requestId ||
		record.outcome !== outcome ||
		record.reason !== reason ||
		!terminalOutcomeReasonIsValid(record) ||
		!terminalReasonEvidenceIsValid(record) ||
		!semanticTerminalUsageIsValid(record, node) ||
		canonicalDigest(record.partialResults) !== canonicalDigest(node.artifacts.map((report) => report.artifact))
	) return false;
	const expected = createAgentSemanticTerminalRecord({
		agentId: node.agentId,
		requestId: record.requestId,
		idempotencyKey,
		outcome: record.outcome,
		...(record.reason ? { reason: record.reason } : {}),
		...(record.reasonEvidenceDigest !== undefined ? { reasonEvidenceDigest: record.reasonEvidenceDigest } : {}),
		...(record.usage ? { usage: record.usage } : {}),
		partialResults: record.partialResults,
	});
	return (
		digestIsValid(record.requestDigest) &&
		digestIsValid(record.terminalDigest) &&
		record.requestDigest === expected.requestDigest &&
		record.terminalDigest === expected.terminalDigest
	);
}

function residencyReceiptIsValid(receipt: AgentRuntimeReleaseReceiptRef["residencyReceipt"]): boolean {
	const { receiptDigest, ...body } = receipt;
	return (
		isRuntimeId(receipt.receiptId, "receipt") &&
		isRuntimeId(receipt.agentId, "agent") &&
		isRuntimeId(receipt.sessionId, "session") &&
		isRuntimeId(receipt.runtimeInstanceId, "runtime") &&
		Number.isSafeInteger(receipt.revision) &&
		receipt.revision >= 0 &&
		timestampIsValid(receipt.observedAt) &&
		(!receipt.reasonDigest || digestIsValid(receipt.reasonDigest)) &&
		digestIsValid(receiptDigest) &&
		receiptDigest === canonicalDigest(body)
	);
}

function launchReceiptsAreValid(
	launchReceipt: NonNullable<AgentNode["launchReceipt"]>,
	residencyReceipt: NonNullable<AgentNode["residency"]>,
	node: AgentNode,
): boolean {
	const { receiptDigest, ...body } = launchReceipt;
	return (
		isRuntimeId(launchReceipt.receiptId, "receipt") &&
		launchReceipt.agentId === node.agentId &&
		launchReceipt.sessionId === node.sessionId &&
		Number.isSafeInteger(launchReceipt.launchRevision) &&
		launchReceipt.launchRevision >= 1 &&
		timestampIsValid(launchReceipt.launchedAt) &&
		digestIsValid(receiptDigest) &&
		receiptDigest === canonicalDigest(body) &&
		residencyReceipt.agentId === node.agentId &&
		residencyReceipt.sessionId === node.sessionId &&
		residencyReceipt.state === "resident" &&
		residencyReceipt.revision === launchReceipt.launchRevision &&
		Date.parse(residencyReceipt.observedAt) >= Date.parse(launchReceipt.launchedAt) &&
		residencyReceiptIsValid(residencyReceipt) &&
		(node.launchReceipt === undefined || launchReceipt.launchRevision > node.launchReceipt.launchRevision) &&
		(node.residency === undefined || residencyReceipt.revision > node.residency.revision)
	);
}

function finalCursorIsValidForNode(
	cursor: AgentRuntimeReleaseReceiptRef["finalCursor"],
	node: AgentNode,
): boolean {
	if (
		cursor.stream.scope !== "session" ||
		!isRuntimeId(cursor.stream.streamId, "eventStream") ||
		cursor.stream.sessionId !== node.sessionId ||
		!numberIsBounded(cursor.sequence, 0) ||
		!isRuntimeId(cursor.eventId, "event") ||
		!digestIsValid(cursor.eventHash)
	) return false;
	// cursor 缺失时 graph 没有 durable stream identity，只能约束 child session 与 cursor 形状。
	if (!node.cursor) return true;
	if (
		node.cursor.stream.scope !== "session" ||
		node.cursor.stream.sessionId !== node.sessionId ||
		cursor.stream.streamId !== node.cursor.stream.streamId ||
		cursor.sequence < node.cursor.sequence
	) return false;
	return cursor.sequence !== node.cursor.sequence || (
		cursor.eventId === node.cursor.eventId && cursor.eventHash === node.cursor.eventHash
	);
}

function runtimeReleaseReceiptIsValid(receipt: AgentRuntimeReleaseReceiptRef, node: AgentNode): boolean {
	if (!node.launchReceipt || !node.residency || !node.terminal) return false;
	const { receiptDigest, ...body } = receipt;
	const expectedRequestDigest = agentRuntimeReleaseRequestDigest({
		requestId: receipt.requestId,
		agentId: node.agentId,
		sessionId: node.sessionId,
		launchReceipt: node.launchReceipt,
		previousResidencyReceipt: node.residency,
		reason: node.terminal.outcome,
	});
	return (
		isRuntimeId(receipt.receiptId, "receipt") &&
		isRuntimeId(receipt.requestId, "command") &&
		receipt.agentId === node.agentId &&
		receipt.sessionId === node.sessionId &&
		receipt.runtimeInstanceId === node.residency.runtimeInstanceId &&
		receipt.launchReceiptId === node.launchReceipt.receiptId &&
		receipt.launchRevision === node.launchReceipt.launchRevision &&
		Number.isSafeInteger(receipt.launchRevision) &&
		receipt.launchRevision >= 0 &&
		isRuntimeId(receipt.writerFenceReceiptId, "receipt") &&
		digestIsValid(receipt.writerFenceReceiptDigest) &&
		receipt.requestDigest === expectedRequestDigest &&
		receipt.residencyReceipt.agentId === node.agentId &&
		receipt.residencyReceipt.sessionId === node.sessionId &&
		receipt.residencyReceipt.runtimeInstanceId === receipt.runtimeInstanceId &&
		receipt.residencyReceipt.state === "nonresident" &&
		receipt.residencyReceipt.revision > node.residency.revision &&
		residencyReceiptIsValid(receipt.residencyReceipt) &&
		timestampIsValid(receipt.releasedAt) &&
		receipt.residencyReceipt.observedAt === receipt.releasedAt &&
		finalCursorIsValidForNode(receipt.finalCursor, node) &&
		digestIsValid(receiptDigest) &&
		receiptDigest === canonicalDigest(body)
	);
}

function budgetSettlementReceiptIsValid(
	receipt: AgentBudgetSettlementReceiptRef,
	node: AgentNode,
	kind: AgentCleanupKind,
	authoritySettledAt: string,
): boolean {
	if (!node.budgetReservation || !node.terminal) return false;
	const { receiptDigest, ...body } = receipt;
	const outcome = kind === "not_started" ? "not_started" : node.terminal.outcome;
	const usage = kind === "not_started" ? undefined : node.terminal.usage;
	const partialResults = kind === "not_started" ? [] : node.terminal.partialResults;
	const semantic = {
		reservation: node.budgetReservation,
		outcome,
		...(usage ? { usage } : {}),
		partialResults,
		settledAt: authoritySettledAt,
	};
	return (
		isRuntimeId(receipt.receiptId, "receipt") &&
		receipt.reservationId === node.budgetReservation.reservationId &&
		receipt.outcome === outcome &&
		receipt.usageDigest === canonicalDigest(usage ?? null) &&
		receipt.partialResultsDigest === canonicalDigest(partialResults) &&
		receipt.settledAt === authoritySettledAt &&
		receipt.requestDigest === canonicalDigest(semantic) &&
		timestampIsValid(authoritySettledAt) &&
		digestIsValid(receiptDigest) &&
		receiptDigest === canonicalDigest(body)
	);
}

function rootNodeIsValid(node: AgentNode): boolean {
	return (
		isRuntimeId(node.agentId, "agent") &&
		isRuntimeId(node.sessionId, "session") &&
		isRuntimeId(node.goalId, "goal") &&
		AGENT_ROLES.includes(node.role) &&
		digestIsValid(node.objectiveDigest) &&
		node.rootAgentId === node.agentId &&
		node.parentAgentId === undefined &&
		node.depth === 0 &&
		node.state === "running" &&
		node.terminal === undefined &&
		node.capabilityGrant !== undefined &&
		node.delegationReceipt === undefined &&
		node.budgetReservation === undefined &&
		node.requestedCapabilities.length === 0 &&
		inputLineageIsValid(node.inputSources, node.declassificationReceipts) &&
		workspaceReceiptIsValid(node) &&
		node.workspaceReceipt.sessionId === node.sessionId &&
		(node.workspaceReceipt.status === "active" || node.workspaceReceipt.status === "readonly") &&
		artifactContractIsValid(node.artifactContract, true) &&
		budgetIsValid(node, true)
	);
}

function childNodeIsValid(node: AgentNode, parent: AgentNode): boolean {
	if (!node.delegationReceipt || !parent.capabilityGrant || !node.admissionRequestDigest) return false;
	const subsetDigest = capabilitySubsetRequestDigest(
		parent.agentId,
		node.agentId,
		parent.capabilityGrant,
		node.requestedCapabilities,
		node.inputSources,
		node.declassificationReceipts,
	);
	return (
		isRuntimeId(node.agentId, "agent") &&
		isRuntimeId(node.sessionId, "session") &&
		AGENT_ROLES.includes(node.role) &&
		digestIsValid(node.objectiveDigest) &&
		node.parentAgentId === parent.agentId &&
		node.rootAgentId === parent.rootAgentId &&
		node.terminal === undefined &&
		node.goalId === parent.goalId &&
		node.depth === parent.depth + 1 &&
		node.sessionId !== parent.sessionId &&
		node.workspaceReceipt.sessionId === node.sessionId &&
		node.workspaceReceipt.workspaceId !== parent.workspaceReceipt.workspaceId &&
		node.workspaceReceipt.repositoryId === parent.workspaceReceipt.repositoryId &&
		(node.workspaceReceipt.status === "active" || node.workspaceReceipt.status === "readonly") &&
		node.requestedCapabilities.length <= 64 &&
		node.requestedCapabilities.every(isAgentCapabilityRequestRef) &&
		inputLineagePreserves(
			parent.inputSources,
			parent.declassificationReceipts,
			node.inputSources,
			node.declassificationReceipts,
		) &&
		node.delegationReceipt.parentAgentId === parent.agentId &&
		node.delegationReceipt.childAgentId === node.agentId &&
		node.delegationReceipt.decision === "allowed" &&
		node.delegationReceipt.parentGrantReceiptId === parent.capabilityGrant?.receiptId &&
		digestIsValid(node.admissionRequestDigest) &&
		delegationReceiptMatches(
			node.delegationReceipt,
			{
				parentAgentId: parent.agentId,
				childAgentId: node.agentId,
				parentGrant: parent.capabilityGrant,
				requestDigest: subsetDigest,
			},
			new Date(node.createdAt),
		) &&
		node.budgetReservation !== undefined &&
		digestIsValid(node.budgetReservation.requestDigest) &&
		workspaceReceiptIsValid(node) &&
		(node.role !== "build" || node.workspaceReceipt.strategy.kind !== "readonly_checkout") &&
		artifactContractIsValid(node.artifactContract, false) &&
		budgetIsValid(node, false)
	);
}

function cloneNode(node: AgentNode): AgentNode {
	return {
		...node,
		requestedCapabilities: [...node.requestedCapabilities],
		inputSources: node.inputSources.map((source) => ({ ...source, taintLabels: [...source.taintLabels] })),
		declassificationReceipts: node.declassificationReceipts.map((receipt) => ({ ...receipt })),
		workspaceReceipt: {
			...node.workspaceReceipt,
			strategy: { ...node.workspaceReceipt.strategy },
		},
		budget: { ...node.budget },
		turnIds: [...node.turnIds],
		artifactContract: { ...node.artifactContract, expected: [...node.artifactContract.expected] },
		artifacts: node.artifacts.map((report) => ({
			...report,
			artifact: { ...report.artifact },
			inputSources: report.inputSources.map((source) => ({ ...source, taintLabels: [...source.taintLabels] })),
			declassificationReceipts: report.declassificationReceipts.map((receipt) => ({ ...receipt })),
		})),
		...(node.terminal ? { terminal: cloneSemanticTerminalRecord(node.terminal) } : {}),
	};
}

function cloneCleanupRecord(record: AgentCleanupRecord): AgentCleanupRecord {
	if (record.kind === "not_started") {
		return {
			...record,
			...(record.workspaceRelease
				? {
					workspaceRelease: {
						...record.workspaceRelease,
						receipt: {
							...record.workspaceRelease.receipt,
							releasedWorkspaceReceipt: {
								...record.workspaceRelease.receipt.releasedWorkspaceReceipt,
								strategy: {
									...record.workspaceRelease.receipt.releasedWorkspaceReceipt.strategy,
								},
							},
							authorityReceipt: { ...record.workspaceRelease.receipt.authorityReceipt },
						},
					},
				}
				: {}),
			...(record.budgetSettlement
				? { budgetSettlement: { ...record.budgetSettlement, receipt: { ...record.budgetSettlement.receipt } } }
				: {}),
			...(record.reconciliationRequired
				? {
					reconciliationRequired: {
						...record.reconciliationRequired,
						error: { ...record.reconciliationRequired.error },
					},
				}
				: {}),
			...(record.completionReceipt ? { completionReceipt: { ...record.completionReceipt } } : {}),
		};
	}
	return {
		...record,
		...(record.runtimeRelease
			? {
				runtimeRelease: {
					...record.runtimeRelease,
					receipt: {
						...record.runtimeRelease.receipt,
						finalCursor: {
							...record.runtimeRelease.receipt.finalCursor,
							stream: { ...record.runtimeRelease.receipt.finalCursor.stream },
						},
						residencyReceipt: { ...record.runtimeRelease.receipt.residencyReceipt },
					},
				},
				}
				: {}),
		...(record.workspaceRelease
			? {
				workspaceRelease: {
					...record.workspaceRelease,
					receipt: {
						...record.workspaceRelease.receipt,
						releasedWorkspaceReceipt: {
							...record.workspaceRelease.receipt.releasedWorkspaceReceipt,
							strategy: {
								...record.workspaceRelease.receipt.releasedWorkspaceReceipt.strategy,
							},
						},
						authorityReceipt: { ...record.workspaceRelease.receipt.authorityReceipt },
					},
				},
			}
			: {}),
		...(record.budgetSettlement
			? { budgetSettlement: { ...record.budgetSettlement, receipt: { ...record.budgetSettlement.receipt } } }
			: {}),
		...(record.reconciliationRequired
			? {
				reconciliationRequired: {
					...record.reconciliationRequired,
					error: { ...record.reconciliationRequired.error },
				},
			}
			: {}),
		...(record.completionReceipt ? { completionReceipt: { ...record.completionReceipt } } : {}),
	};
}

export function createEmptyAgentGraphProjection(): AgentGraphProjection {
	return {
		revision: 0,
		nodes: new Map(),
		edges: [],
		handoffs: new Map(),
		mergeReceipts: [],
		pendingSpawns: new Map(),
		pendingHandoffs: new Map(),
		pendingMerges: new Map(),
		cleanups: new Map(),
		reconciliationFailures: [],
	};
}

function withNode(projection: AgentGraphProjection, node: AgentNode): AgentGraphProjection {
	const nodes = new Map(projection.nodes);
	nodes.set(node.agentId, cloneNode(node));
	return { ...projection, nodes };
}

function failureRefIsValid(error: AgentGraphFailureRef): boolean {
	return (
		error.code.length > 0 &&
		error.code.length <= 128 &&
		digestIsValid(error.messageDigest) &&
		(error.effect === "none" || error.effect === "committed" || error.effect === "uncertain") &&
		(error.outcomeCertain || error.effect !== "committed")
	);
}

function spawnIntentIsValid(intent: AgentSpawnIntent, parent: AgentNode): boolean {
	const budget = intent.budget;
	const budgetValues = [
		budget.maxTurns,
		budget.maxInputTokens,
		budget.maxOutputTokens,
		budget.maxUsdMicros,
		budget.maxWallTimeMs,
		budget.maxToolCalls,
		budget.maxNetworkBytes,
		budget.maxStorageBytes,
	];
	return (
		isRuntimeId(intent.requestId, "command") &&
		digestIsValid(intent.admissionRequestDigest) &&
		intent.parentAgentId === parent.agentId &&
		isRuntimeId(intent.childAgentId, "agent") &&
		isRuntimeId(intent.childSessionId, "session") &&
		intent.childAgentId !== parent.agentId &&
		intent.childSessionId !== parent.sessionId &&
		AGENT_ROLES.includes(intent.role) &&
		digestIsValid(intent.objectiveDigest) &&
		intent.depth === parent.depth + 1 &&
		intent.expectedArtifacts.length > 0 &&
		intent.expectedArtifacts.length <= 64 &&
		intent.requestedCapabilities.length <= 64 &&
		intent.requestedCapabilities.every(isAgentCapabilityRequestRef) &&
		budgetValues.every((value) => Number.isSafeInteger(value) && value >= 0) &&
		budget.maxTurns >= 1 &&
		intent.parentGrant.receiptId === parent.capabilityGrant?.receiptId &&
		intent.parentGrant.receiptDigest === parent.capabilityGrant.receiptDigest &&
		intent.parentGrant.decisionRevision === parent.capabilityGrant.decisionRevision &&
		isRuntimeId(intent.workspaceStrategy.strategyId, "resource") &&
		digestIsValid(intent.workspaceStrategy.strategyDigest) &&
		inputLineagePreserves(
			parent.inputSources,
			parent.declassificationReceipts,
			intent.inputSources,
			intent.declassificationReceipts,
		)
	);
}

function applyStateTransition(
	projection: AgentGraphProjection,
	agentId: AgentId,
	from: AgentState,
	to: AgentState,
	reason: AgentNode["stateReason"] | undefined,
	changedAt: string,
	terminal?: AgentSemanticTerminalRecord,
): AgentResult<AgentGraphProjection> {
	const node = projection.nodes.get(agentId);
	if (!node) return fail("agent_not_found", "state event references a missing agent");
	if (node.terminal) return fail("invalid_transition", "semantic terminal forbids further Agent lifecycle transitions");
	if (node.state !== from || !AGENT_STATE_TRANSITIONS[from].includes(to)) {
		return fail("invalid_transition", "agent state transition is invalid");
	}
	if (to === "completed" && !completionContractSatisfied(node)) {
		return fail("artifact_contract_mismatch", "agent cannot complete without declared artifacts");
	}
	if ((FINAL_STATES.has(to) && !terminal) || (!FINAL_STATES.has(to) && terminal)) {
		return fail("invalid_transition", "agent terminal transition requires one semantic terminal record");
	}
	const { stateReason: _stateReason, ...nodeWithoutReason } = node;
	return withNodeResult(projection, {
		...nodeWithoutReason,
		state: to,
		...(reason ? { stateReason: reason } : {}),
		...(terminal ? { terminal: cloneSemanticTerminalRecord(terminal) } : {}),
		updatedAt: changedAt,
	});
}

function withCleanupRecord(projection: AgentGraphProjection, record: AgentCleanupRecord): AgentGraphProjection {
	const cleanups = new Map(projection.cleanups);
	cleanups.set(record.agentId, cloneCleanupRecord(record));
	return { ...projection, cleanups };
}

function nextCleanupStage(record: AgentCleanupRecord): AgentCleanupStage | undefined {
	if (record.kind === "started" && !record.runtimeRelease) return "runtime_release";
	if (!record.workspaceRelease) return "workspace_release";
	if (!record.budgetSettlement) return "budget_settlement";
	return undefined;
}

function cleanupKindForNode(node: AgentNode): AgentResult<AgentCleanupKind> {
	if (!node.parentAgentId || !node.terminal || !node.budgetReservation) {
		return fail("cleanup_invalid", "child cleanup lacks terminal or budget evidence");
	}
	const hasLaunch = node.launchReceipt !== undefined;
	const hasResidency = node.residency !== undefined;
	if (
		node.stateReason === "launch_rejected" &&
		node.terminal.reason === "launch_rejected" &&
		!hasLaunch &&
		!hasResidency
	) {
		return { ok: true, value: "not_started" };
	}
	if (
		node.stateReason !== "launch_rejected" &&
		node.terminal.reason !== "launch_rejected" &&
		hasLaunch &&
		hasResidency
	) {
		return { ok: true, value: "started" };
	}
	return fail("cleanup_invalid", "child cleanup start evidence is incomplete or contradictory");
}

function cleanupRecordFor(
	projection: AgentGraphProjection,
	agentId: AgentId,
	cleanupRequestId: AgentCleanupRecord["requestId"],
): AgentResult<{ node: AgentNode; cleanup: AgentCleanupRecord }> {
	const node = projection.nodes.get(agentId);
	const cleanup = projection.cleanups.get(agentId);
	if (!node || !node.terminal || !cleanup || cleanup.requestId !== cleanupRequestId) {
		return fail("cleanup_invalid", "cleanup stage has no correlated semantic terminal and durable intent");
	}
	const kind = cleanupKindForNode(node);
	if (
		!kind.ok ||
		cleanup.agentId !== node.agentId ||
		cleanup.sessionId !== node.sessionId ||
		cleanup.kind !== kind.value ||
		cleanup.terminalDigest !== node.terminal.terminalDigest ||
		cleanup.requestDigest !== agentCleanupRequestDigest({
			requestId: cleanup.requestId,
			agentId: node.agentId,
			sessionId: node.sessionId,
			kind: cleanup.kind,
			terminalDigest: node.terminal.terminalDigest,
		}) ||
		(cleanup.kind === "not_started" && "runtimeRelease" in cleanup)
	) {
		return fail("cleanup_invalid", "cleanup record is not correlated to durable child start evidence");
	}
	if (cleanup.completionReceipt) return fail("cleanup_invalid", "cleanup saga is already complete");
	return { ok: true, value: { node, cleanup } };
}

function releasedWorkspaceReceiptIsValid(
	receipt: AgentWorkspaceReleaseReceiptRef,
	previous: AgentNode["workspaceReceipt"],
	input: {
		requestId: AgentWorkspaceReleaseRequest["requestId"];
		requestDigest: AgentWorkspaceReleaseRequest["requestDigest"];
		agentId: AgentId;
		occurredAt: string;
	},
): boolean {
	const released = receipt.releasedWorkspaceReceipt;
	const authority = receipt.authorityReceipt;
	if (!released || !authority) return false;
	const { receiptDigest, ...body } = receipt;
	return (
		receipt.schemaVersion === 1 &&
		receipt.kind === "agent_workspace_release_receipt" &&
		isRuntimeId(receipt.receiptId, "receipt") &&
		receipt.receiptId !== previous.receiptId &&
		receipt.requestId === input.requestId &&
		receipt.requestDigest === input.requestDigest &&
		receipt.agentId === input.agentId &&
		receipt.sessionId === previous.sessionId &&
		receipt.workspaceId === previous.workspaceId &&
		receipt.repositoryId === previous.repositoryId &&
		receipt.previousReceiptId === previous.receiptId &&
		receipt.previousReceiptDigest === previous.receiptDigest &&
		receipt.bindingDigest === previous.bindingDigest &&
		previous.leaseId !== undefined &&
		previous.leaseRevision !== undefined &&
		receipt.leaseId === previous.leaseId &&
		receipt.leaseRevision === previous.leaseRevision &&
		receipt.releasedAt === input.occurredAt &&
		timestampIsValid(receipt.releasedAt) &&
		digestIsValid(receiptDigest) &&
		receiptDigest === canonicalDigest(body) &&
		released.receiptId === receipt.receiptId &&
		released.status === "released" &&
		released.sessionId === previous.sessionId &&
		released.workspaceId === previous.workspaceId &&
		released.repositoryId === previous.repositoryId &&
		released.strategy.strategyId === previous.strategy.strategyId &&
		released.strategy.kind === previous.strategy.kind &&
		released.strategy.strategyDigest === previous.strategy.strategyDigest &&
		released.bindingRevision === previous.bindingRevision &&
		released.bindingDigest === previous.bindingDigest &&
		released.leaseId === previous.leaseId &&
		released.leaseRevision === previous.leaseRevision &&
		released.issuedAt === receipt.releasedAt &&
		released.expiresAt === previous.expiresAt &&
		workspaceReceiptRefIsValid(released) &&
		isWorkspaceReleaseReceiptRef(authority) &&
		authority.receiptId === receipt.receiptId &&
		authority.requestId === input.requestId &&
		authority.callerRequestDigest === receipt.requestDigest &&
		authority.agentId === input.agentId &&
		authority.sessionId === previous.sessionId &&
		authority.workspaceId === previous.workspaceId &&
		authority.repositoryId === previous.repositoryId &&
		authority.leaseId === previous.leaseId &&
		authority.leaseRevision === previous.leaseRevision &&
		authority.releasedAt === receipt.releasedAt
	);
}

function cleanupReceiptIsValid(
	receipt: AgentCleanupReceiptRef,
	node: AgentNode,
	cleanup: AgentCleanupRecord,
): boolean {
	if (!cleanup.workspaceRelease || !cleanup.budgetSettlement) return false;
	if (receipt.schemaVersion !== 1 || receipt.kind !== cleanup.kind) return false;
	const { receiptDigest, ...body } = receipt;
	const completionTimes = [
		cleanup.workspaceRelease.receipt.releasedAt,
		cleanup.budgetSettlement.receipt.settledAt,
	];
	if (cleanup.kind === "started") {
		if (
			receipt.kind !== "started" ||
			!cleanup.runtimeRelease ||
			!("runtimeReleaseReceiptId" in receipt) ||
			!("runtimeReleaseReceiptDigest" in receipt)
		) return false;
		completionTimes.push(cleanup.runtimeRelease.receipt.releasedAt);
		if (
			receipt.runtimeReleaseReceiptId !== cleanup.runtimeRelease.receipt.receiptId ||
			receipt.runtimeReleaseReceiptDigest !== cleanup.runtimeRelease.receipt.receiptDigest
		) return false;
	} else if (
		receipt.kind !== "not_started" ||
		"runtimeReleaseReceiptId" in receipt ||
		"runtimeReleaseReceiptDigest" in receipt ||
		"runtimeRelease" in cleanup
	) {
		return false;
	}
	const expectedCompletedAt = completionTimes.reduce(
		(latest, value) => Date.parse(value) > Date.parse(latest) ? value : latest,
	);
	return (
		isRuntimeId(receipt.receiptId, "receipt") &&
		receipt.requestId === cleanup.requestId &&
		receipt.requestDigest === cleanup.requestDigest &&
		receipt.agentId === node.agentId &&
		receipt.sessionId === node.sessionId &&
		receipt.terminalDigest === node.terminal?.terminalDigest &&
		receipt.workspaceReleaseReceiptId === cleanup.workspaceRelease.receipt.receiptId &&
		receipt.workspaceReleaseReceiptDigest === cleanup.workspaceRelease.receipt.receiptDigest &&
		receipt.budgetSettlementReceiptId === cleanup.budgetSettlement.receipt.receiptId &&
		receipt.budgetSettlementReceiptDigest === cleanup.budgetSettlement.receipt.receiptDigest &&
		receipt.completedAt === expectedCompletedAt &&
		timestampIsValid(receipt.completedAt) &&
		digestIsValid(receiptDigest) &&
		receiptDigest === canonicalDigest(body)
	);
}

function applyMergeReceipt(
	projection: AgentGraphProjection,
	receipt: AgentMergeReceiptRef,
): AgentResult<AgentGraphProjection> {
	const child = projection.nodes.get(receipt.childAgentId);
	const parent = projection.nodes.get(receipt.parentAgentId);
	if (
		!child ||
		!parent ||
		child.parentAgentId !== parent.agentId ||
		receipt.targetWorkspaceId !== parent.workspaceReceipt.workspaceId ||
		!isRuntimeId(receipt.receiptId, "receipt") ||
		!isRuntimeId(receipt.requestId, "command") ||
		!digestIsValid(receipt.receiptDigest) ||
		receipt.receiptDigest !== mergeReceiptDigest(receipt) ||
		projection.mergeReceipts.some((candidate) => candidate.receiptId === receipt.receiptId) ||
		receipt.artifactIds.some(
			(artifactId) => !child.artifacts.some((report) => report.artifact.artifactId === artifactId),
		) ||
		(receipt.outcome === "conflict" &&
			(receipt.resultArtifactRefs.length === 0 ||
				receipt.artifactIds.some(
					(artifactId) =>
						!receipt.preservedArtifactRefs.some((artifact) => artifact.artifactId === artifactId),
				)))
	) {
		return fail("merge_invalid", "merge receipt is not correlated to a parent/child edge");
	}
	return { ok: true, value: { ...projection, mergeReceipts: [...projection.mergeReceipts, { ...receipt }] } };
}

export function applyAgentGraphCommand(
	projection: AgentGraphProjection,
	command: AgentGraphSemanticCommand,
	limits: AgentGraphLimits,
): AgentResult<AgentGraphProjection> {
	if (command.type === "agent.root_registered") {
		if (projection.rootAgentId || projection.nodes.size > 0) return fail("invalid_graph", "agent graph contains multiple roots");
		if (!rootNodeIsValid(command.node)) return fail("invalid_graph", "root agent event is invalid");
		return {
			ok: true,
			value: { ...withNode(projection, command.node), rootAgentId: command.node.agentId, goalId: command.node.goalId },
		};
	}
	if (command.type === "agent.root_revalidated") {
		const root = projection.rootAgentId ? projection.nodes.get(projection.rootAgentId) : undefined;
		if (
			!root ||
			root.terminal !== undefined ||
			root.agentId !== command.agentId ||
			root.parentAgentId !== undefined ||
			root.state !== "running" ||
			root.sessionId !== command.workspaceReceipt.sessionId ||
			root.workspaceReceipt.workspaceId !== command.workspaceReceipt.workspaceId ||
			root.workspaceReceipt.repositoryId !== command.workspaceReceipt.repositoryId ||
			root.workspaceReceipt.strategy.strategyId !== command.workspaceReceipt.strategy.strategyId ||
			root.workspaceReceipt.strategy.kind !== command.workspaceReceipt.strategy.kind ||
			root.workspaceReceipt.strategy.strategyDigest !== command.workspaceReceipt.strategy.strategyDigest ||
			root.workspaceReceipt.leaseId !== command.workspaceReceipt.leaseId ||
			command.workspaceReceipt.bindingRevision <= root.workspaceReceipt.bindingRevision ||
			(command.workspaceReceipt.leaseRevision ?? -1) <= (root.workspaceReceipt.leaseRevision ?? -1) ||
			(command.workspaceReceipt.strategy.kind === "readonly_checkout"
				? command.workspaceReceipt.status !== "readonly"
				: command.workspaceReceipt.status !== "active") ||
			!workspaceReceiptIsValid({ ...root, workspaceReceipt: command.workspaceReceipt }) ||
			!root.capabilityGrant ||
			root.capabilityGrant.receiptId !== command.capabilityGrant.receiptId ||
			root.capabilityGrant.receiptDigest !== command.capabilityGrant.receiptDigest ||
			root.capabilityGrant.decisionRevision !== command.capabilityGrant.decisionRevision ||
			root.capabilityGrant.expiresAt !== command.capabilityGrant.expiresAt
		) return fail("invalid_graph", "root Agent revalidation is stale or outside its durable scope");
		return withNodeResult(projection, {
			...root,
			workspaceReceipt: { ...command.workspaceReceipt },
			capabilityGrant: { ...command.capabilityGrant },
			updatedAt: command.occurredAt,
		});
	}

	if (!projection.rootAgentId || !projection.goalId) return fail("orphan_agent", "agent event precedes its root");

	if (command.type === "agent.spawn_requested") {
		const parent = projection.nodes.get(command.intent.parentAgentId);
		if (!parent || !spawnIntentIsValid(command.intent, parent)) return fail("spawn_denied", "spawn intent is invalid");
		if (parent.terminal) return fail("invalid_transition", "semantic terminal parent cannot request a child spawn");
		if (projection.nodes.has(command.intent.childAgentId) || projection.pendingSpawns.has(command.intent.childAgentId)) {
			return fail("agent_exists", "spawn intent reuses an agent identity");
		}
		if (command.intent.depth > limits.maxDepth) return fail("depth_limit", "spawn intent exceeds maxDepth");
		if (projection.edges.filter((edge) => edge.parentAgentId === parent.agentId).length >= limits.maxChildrenPerAgent) {
			return fail("children_limit", "spawn intent exceeds maxChildrenPerAgent");
		}
		if (projection.nodes.size + projection.pendingSpawns.size >= limits.maxTotalAgents) {
			return fail("total_limit", "spawn intent exceeds maxTotalAgents");
		}
		if ([...projection.nodes.values()].some((node) => node.sessionId === command.intent.childSessionId)) {
			return fail("session_exists", "spawn intent child session must be unique");
		}
		const pendingSpawns = new Map(projection.pendingSpawns);
		pendingSpawns.set(command.intent.childAgentId, command.intent);
		return { ok: true, value: { ...projection, pendingSpawns } };
	}

	if (command.type === "agent.spawned") {
		const intent = projection.pendingSpawns.get(command.node.agentId);
		if (!intent || intent.requestId !== command.intentRequestId) {
			return fail("invalid_graph", "spawn terminal has no correlated durable intent");
		}
		const parent = projection.nodes.get(command.edge.parentAgentId);
		if (!parent || parent.agentId !== command.node.parentAgentId) return fail("orphan_agent", "child parent is missing");
		if (parent.terminal) return fail("invalid_transition", "semantic terminal parent cannot accept a spawned child");
		if (
			command.edge.childAgentId !== command.node.agentId ||
			command.node.sessionId !== intent.childSessionId ||
			command.node.role !== intent.role ||
			command.node.objectiveDigest !== intent.objectiveDigest ||
			command.node.admissionRequestDigest !== intent.admissionRequestDigest ||
			command.node.depth !== intent.depth ||
			canonicalDigest(command.node.budget) !== canonicalDigest(intent.budget) ||
			canonicalDigest(command.node.requestedCapabilities) !== canonicalDigest(intent.requestedCapabilities) ||
			canonicalDigest(command.node.artifactContract.expected) !== canonicalDigest(intent.expectedArtifacts) ||
			command.node.artifactContract.allowPartial !== intent.allowPartial ||
			canonicalDigest(command.node.inputSources) !== canonicalDigest(intent.inputSources) ||
			canonicalDigest(command.node.declassificationReceipts) !== canonicalDigest(intent.declassificationReceipts) ||
			projection.nodes.has(command.node.agentId) ||
			projection.edges.some((edge) => edge.childAgentId === command.node.agentId)
		) {
			return fail("invalid_graph", "child edge is duplicate or inconsistent");
		}
		if (command.node.depth > limits.maxDepth) return fail("depth_limit", "agent graph exceeds maxDepth");
		const children = projection.edges.filter((edge) => edge.parentAgentId === parent.agentId).length;
		if (children >= limits.maxChildrenPerAgent) return fail("children_limit", "agent graph exceeds maxChildrenPerAgent");
		if (projection.nodes.size >= limits.maxTotalAgents) return fail("total_limit", "agent graph exceeds maxTotalAgents");
		if ([...projection.nodes.values()].some((node) => node.sessionId === command.node.sessionId)) {
			return fail("session_exists", "child session must be unique");
		}
		if (
			[...projection.nodes.values()].some(
				(node) => node.workspaceReceipt.workspaceId === command.node.workspaceReceipt.workspaceId,
			)
		) {
			return fail("workspace_shared", "child workspace identity must be unique");
		}
		if (!childNodeIsValid(command.node, parent)) return fail("invalid_graph", "child agent event is invalid");
		const pendingSpawns = new Map(projection.pendingSpawns);
		pendingSpawns.delete(command.node.agentId);
		const next = withNode(projection, command.node);
		return { ok: true, value: { ...next, pendingSpawns, edges: [...projection.edges, { ...command.edge }] } };
	}

	if (command.type === "agent.spawn_failed") {
		const intent = projection.pendingSpawns.get(command.agentId);
		if (!intent || intent.requestId !== command.intentRequestId || !failureRefIsValid(command.error)) {
			return fail("invalid_graph", "spawn failure has no correlated durable intent");
		}
		const pendingSpawns = new Map(projection.pendingSpawns);
		if (command.error.outcomeCertain) pendingSpawns.delete(command.agentId);
		return {
			ok: true,
			value: {
				...projection,
				pendingSpawns,
				reconciliationFailures: [
					...projection.reconciliationFailures,
					{
						operation: "spawn",
						requestId: command.intentRequestId,
						agentId: command.agentId,
						error: command.error,
					},
				],
			},
		};
	}

	if (command.type === "agent.transitioned") {
		return applyStateTransition(projection, command.agentId, command.from, command.to, command.reason, command.occurredAt);
	}
	if (command.type === "agent.paused") {
		return applyStateTransition(projection, command.agentId, command.from, "paused", command.reason, command.occurredAt);
	}
	if (command.type === "agent.stopped") {
		const node = projection.nodes.get(command.agentId);
		if (!node || !semanticTerminalIsValid(command.terminal, node, command.requestId, command.idempotencyKey, "stopped", command.reason)) {
			return fail("invalid_transition", "stopped terminal record is invalid or uncorrelated");
		}
		return applyStateTransition(
			projection,
			command.agentId,
			command.from,
			"stopped",
			command.reason,
			command.occurredAt,
			command.terminal,
		);
	}
	if (command.type === "agent.partial_committed") {
		return applyStateTransition(projection, command.agentId, command.from, "partial", command.reason, command.occurredAt);
	}
	if (command.type === "agent.finished") {
		const node = projection.nodes.get(command.agentId);
		if (!node || !semanticTerminalIsValid(command.terminal, node, command.requestId, command.idempotencyKey, "completed")) {
			return fail("invalid_transition", "completed terminal record is invalid or uncorrelated");
		}
		return applyStateTransition(
			projection,
			command.agentId,
			command.from,
			"completed",
			undefined,
			command.occurredAt,
			command.terminal,
		);
	}
	if (command.type === "agent.failed") {
		if (!failureRefIsValid(command.error)) return fail("invalid_graph", "agent failure receipt is invalid");
		const node = projection.nodes.get(command.agentId);
		if (!node || !semanticTerminalIsValid(command.terminal, node, command.requestId, command.idempotencyKey, "failed", command.reason)) {
			return fail("invalid_transition", "failed terminal record is invalid or uncorrelated");
		}
		return applyStateTransition(
			projection,
			command.agentId,
			command.from,
			"failed",
			command.reason,
			command.occurredAt,
			command.terminal,
		);
	}

	if (command.type === "agent.cleanup_requested") {
		const node = projection.nodes.get(command.agentId);
		if (!node) return fail("cleanup_invalid", "cleanup intent references a missing child");
		const kind = cleanupKindForNode(node);
		if (
			!kind.ok ||
			!node.terminal ||
			command.kind !== kind.value ||
			projection.cleanups.has(node.agentId) ||
			command.terminalDigest !== node.terminal.terminalDigest ||
			command.requestDigest !== agentCleanupRequestDigest({
				requestId: command.requestId,
				agentId: node.agentId,
				sessionId: node.sessionId,
				kind: command.kind,
				terminalDigest: node.terminal.terminalDigest,
			})
		) return fail("cleanup_invalid", "cleanup intent is not correlated to durable child start evidence");
		return {
			ok: true,
			value: withCleanupRecord(projection, {
				kind: command.kind,
				agentId: node.agentId,
				sessionId: node.sessionId,
				requestId: command.requestId,
				requestDigest: command.requestDigest,
				terminalDigest: command.terminalDigest,
				requestedAt: command.occurredAt,
				updatedAt: command.occurredAt,
			}),
		};
	}

	if (command.type === "agent.runtime_released") {
		const current = cleanupRecordFor(projection, command.agentId, command.cleanupRequestId);
		if (!current.ok) return current;
		const { node, cleanup } = current.value;
		if (
			cleanup.kind !== "started" ||
			nextCleanupStage(cleanup) !== "runtime_release" ||
			command.receipt.requestId !== command.requestId ||
			command.receipt.releasedAt !== command.occurredAt ||
			!runtimeReleaseReceiptIsValid(command.receipt, node)
		) return fail("cleanup_invalid", "runtime release receipt is invalid, stale, or out of order");
		const { reconciliationRequired: _reconciliationRequired, ...withoutFailure } = cleanup;
		const nextCleanup = withCleanupRecord(projection, {
			...withoutFailure,
			runtimeRelease: {
				requestId: command.requestId,
				requestDigest: command.receipt.requestDigest,
				receipt: command.receipt,
			},
			updatedAt: command.occurredAt,
		});
		return withNodeResult(nextCleanup, {
			...node,
			residency: { ...command.receipt.residencyReceipt },
			updatedAt: command.occurredAt,
		});
	}

	if (command.type === "agent.workspace_released") {
		const current = cleanupRecordFor(projection, command.agentId, command.cleanupRequestId);
		if (!current.ok) return current;
		const { node, cleanup } = current.value;
		if (!node.terminal) return fail("cleanup_invalid", "workspace release lacks semantic terminal");
		const reason = cleanup.kind === "not_started" ? "spawn_aborted" : node.terminal.outcome;
		const expectedRequestDigest = agentWorkspaceReleaseRequestDigest({
			requestId: command.requestId,
			agentId: node.agentId,
			sessionId: node.sessionId,
			previousReceipt: node.workspaceReceipt,
			reason,
		});
		if (
			nextCleanupStage(cleanup) !== "workspace_release" ||
			command.requestDigest !== expectedRequestDigest ||
			command.receipt.requestDigest !== command.requestDigest ||
			command.receipt.releasedAt !== command.occurredAt ||
			!releasedWorkspaceReceiptIsValid(command.receipt, node.workspaceReceipt, {
				requestId: command.requestId,
				requestDigest: expectedRequestDigest,
				agentId: node.agentId,
				occurredAt: command.occurredAt,
			})
		) return fail("cleanup_invalid", "Workspace release receipt is invalid, stale, or out of order");
		const { reconciliationRequired: _reconciliationRequired, ...withoutFailure } = cleanup;
		const nextCleanup = withCleanupRecord(projection, {
			...withoutFailure,
			workspaceRelease: {
				requestId: command.requestId,
				requestDigest: command.requestDigest,
				receipt: command.receipt,
			},
			updatedAt: command.occurredAt,
		});
		return withNodeResult(nextCleanup, {
			...node,
			workspaceReceipt: {
				...command.receipt.releasedWorkspaceReceipt,
				strategy: { ...command.receipt.releasedWorkspaceReceipt.strategy },
			},
			updatedAt: command.occurredAt,
		});
	}

	if (command.type === "agent.budget_settled") {
		const current = cleanupRecordFor(projection, command.agentId, command.cleanupRequestId);
		if (!current.ok) return current;
		const { node, cleanup } = current.value;
		if (
			nextCleanupStage(cleanup) !== "budget_settlement" ||
			command.occurredAt !== cleanup.requestedAt ||
			!budgetSettlementReceiptIsValid(command.receipt, node, cleanup.kind, cleanup.requestedAt)
		) return fail("cleanup_invalid", "budget settlement receipt is invalid, stale, or out of order");
		const { reconciliationRequired: _reconciliationRequired, ...withoutFailure } = cleanup;
		return {
			ok: true,
			value: withCleanupRecord(projection, {
				...withoutFailure,
				budgetSettlement: {
					requestId: command.requestId,
					requestDigest: command.receipt.requestDigest,
					receipt: command.receipt,
				},
				updatedAt: command.occurredAt,
			}),
		};
	}

	if (command.type === "agent.cleanup_reconciliation_required") {
		const current = cleanupRecordFor(projection, command.agentId, command.cleanupRequestId);
		if (!current.ok) return current;
		const { cleanup } = current.value;
		if (
			nextCleanupStage(cleanup) !== command.stage ||
			!failureRefIsValid(command.error) ||
			command.error.outcomeCertain ||
			command.error.effect !== "uncertain"
		) {
			return fail("cleanup_invalid", "cleanup reconciliation stage is invalid or already passed");
		}
		if (cleanup.kind === "not_started" && command.stage === "runtime_release") {
			return fail("cleanup_invalid", "not-started cleanup forbids a runtime release stage");
		}
		if (cleanup.kind === "not_started") {
			if (command.stage !== "workspace_release" && command.stage !== "budget_settlement") {
				return fail("cleanup_invalid", "not-started cleanup stage is invalid");
			}
			return {
				ok: true,
				value: withCleanupRecord(projection, {
					...cleanup,
					reconciliationRequired: {
						requestId: command.requestId,
						stage: command.stage,
						error: { ...command.error },
						recordedAt: command.occurredAt,
					},
					updatedAt: command.occurredAt,
				}),
			};
		}
		return {
			ok: true,
			value: withCleanupRecord(projection, {
				...cleanup,
				reconciliationRequired: {
					requestId: command.requestId,
					stage: command.stage,
					error: { ...command.error },
					recordedAt: command.occurredAt,
				},
				updatedAt: command.occurredAt,
			}),
		};
	}

	if (command.type === "agent.cleanup_completed") {
		const current = cleanupRecordFor(projection, command.agentId, command.cleanupRequestId);
		if (!current.ok) return current;
		const { node, cleanup } = current.value;
		if (
			nextCleanupStage(cleanup) !== undefined ||
			cleanup.reconciliationRequired !== undefined ||
			command.receipt.completedAt !== command.occurredAt ||
			!cleanupReceiptIsValid(command.receipt, node, cleanup)
		) return fail("cleanup_invalid", "cleanup completion receipt is invalid or precedes a required stage");
		if (cleanup.kind === "started" && command.receipt.kind !== "started") {
			return fail("cleanup_invalid", "started cleanup completion kind is invalid");
		}
		if (cleanup.kind === "not_started" && command.receipt.kind !== "not_started") {
			return fail("cleanup_invalid", "not-started cleanup completion kind is invalid");
		}
		if (cleanup.kind === "started" && command.receipt.kind === "started") {
			return {
				ok: true,
				value: withCleanupRecord(projection, {
					...cleanup,
					completionReceipt: { ...command.receipt },
					updatedAt: command.occurredAt,
				}),
			};
		}
		if (cleanup.kind !== "not_started" || command.receipt.kind !== "not_started") {
			return fail("cleanup_invalid", "cleanup completion kind is invalid");
		}
		return {
			ok: true,
			value: withCleanupRecord(projection, {
				...cleanup,
				completionReceipt: { ...command.receipt },
				updatedAt: command.occurredAt,
			}),
		};
	}

	if (command.type === "agent.cursor_advanced") {
		const node = projection.nodes.get(command.agentId);
		if (!node) return fail("agent_not_found", "cursor record references a missing agent");
		if (node.terminal) return fail("invalid_transition", "semantic terminal forbids cursor advancement");
		if (
			command.cursor.stream.scope !== "session" ||
			command.cursor.stream.sessionId !== node.sessionId ||
			(node.cursor && command.cursor.sequence <= node.cursor.sequence) ||
			!numberIsBounded(command.cursor.sequence, 0) ||
			!digestIsValid(command.cursor.eventHash)
		) {
			return fail("invalid_graph", "agent cursor is stale or belongs to another session");
		}
		return withNodeResult(projection, { ...node, cursor: { ...command.cursor }, updatedAt: command.occurredAt });
	}

	if (command.type === "agent.artifact_reported") {
		const node = projection.nodes.get(command.report.agentId);
		if (!node) return fail("agent_not_found", "artifact record references a missing agent");
		if (node.terminal) return fail("invalid_transition", "semantic terminal forbids new Artifact reports");
		if (!reportMatchesContract(command.report, node)) {
			return fail("artifact_contract_mismatch", "reported artifact was not declared by the child contract");
		}
		if (node.artifacts.some((report) => report.artifact.artifactId === command.report.artifact.artifactId)) {
			return fail("artifact_contract_mismatch", "ArtifactRef was already reported");
		}
		return withNodeResult(projection, {
			...node,
			artifacts: [...node.artifacts, { ...command.report }],
			updatedAt: command.report.reportedAt,
		});
	}

	if (command.type === "agent.residency_changed") {
		const node = projection.nodes.get(command.receipt.agentId);
		if (!node || command.receipt.sessionId !== node.sessionId) {
			return fail("agent_not_found", "residency receipt does not match an agent session");
		}
		if (node.terminal) {
			return fail("invalid_transition", "semantic terminal residency may only change through cleanup release");
		}
		if (node.residency && command.receipt.revision <= node.residency.revision) {
			return fail("invalid_graph", "residency revision must advance monotonically");
		}
		return withNodeResult(projection, { ...node, residency: { ...command.receipt }, updatedAt: command.receipt.observedAt });
	}

	if (command.type === "agent.budget_rebound") {
		const node = projection.nodes.get(command.agentId);
		if (node?.terminal) return fail("invalid_transition", "semantic terminal forbids budget rebound");
		if (
			!node?.budgetReservation ||
			node.budgetReservation.reservationId !== command.previousReservationId ||
			command.reservation.operationId === node.budgetReservation.operationId ||
			!digestIsValid(command.reservation.requestDigest)
		) {
			return fail("invalid_graph", "budget rebound does not match the previous child reservation");
		}
		return withNodeResult(projection, {
			...node,
			budgetReservation: { ...command.reservation },
			updatedAt: command.occurredAt,
		});
	}

	if (command.type === "agent.turn_recorded") {
		const node = projection.nodes.get(command.agentId);
		if (node?.terminal) return fail("invalid_transition", "semantic terminal forbids new turns");
		if (
			!node ||
			node.state !== "running" ||
			!isRuntimeId(command.turnId, "turn") ||
			node.turnIds.includes(command.turnId) ||
			command.turnNumber !== node.turnsUsed + 1 ||
			command.turnNumber > node.budget.maxTurns
		) {
			return fail("budget_denied", "agent turn exceeds its durable maxTurns bound");
		}
		return withNodeResult(projection, {
			...node,
			turnsUsed: command.turnNumber,
			turnIds: [...node.turnIds, command.turnId],
			updatedAt: command.occurredAt,
		});
	}

	if (command.type === "agent.launch_recorded") {
		const node = projection.nodes.get(command.agentId);
		if (node?.terminal) return fail("invalid_transition", "semantic terminal forbids launch receipt mutation");
		if (
			!node ||
			!launchReceiptsAreValid(command.launchReceipt, command.residencyReceipt, node)
		) {
			return fail("invalid_graph", "launch receipt is not correlated to the child");
		}
		return withNodeResult(projection, {
			...node,
			launchReceipt: { ...command.launchReceipt },
			residency: { ...command.residencyReceipt },
			updatedAt: command.occurredAt,
		});
	}

	if (command.type === "agent.resume_revalidated") {
		const node = projection.nodes.get(command.agentId);
		if (node?.terminal) return fail("invalid_transition", "semantic terminal forbids resume revalidation");
		const parent = node?.parentAgentId ? projection.nodes.get(node.parentAgentId) : undefined;
		const subsetDigest =
			node && parent?.capabilityGrant
				? capabilitySubsetRequestDigest(
						parent.agentId,
						node.agentId,
						parent.capabilityGrant,
						node.requestedCapabilities,
						node.inputSources,
						node.declassificationReceipts,
					)
				: undefined;
		if (
			!node ||
			!node.parentAgentId ||
			!parent?.capabilityGrant ||
			!subsetDigest ||
			command.delegationReceipt.parentAgentId !== node.parentAgentId ||
			command.delegationReceipt.childAgentId !== node.agentId ||
			command.delegationReceipt.decision !== "allowed" ||
			!delegationReceiptMatches(
				command.delegationReceipt,
				{
					parentAgentId: parent.agentId,
					childAgentId: node.agentId,
					parentGrant: parent.capabilityGrant,
					requestDigest: subsetDigest,
				},
				new Date(command.occurredAt),
			) ||
			command.workspaceReceipt.sessionId !== node.sessionId ||
			command.workspaceReceipt.workspaceId !== node.workspaceReceipt.workspaceId ||
			command.workspaceReceipt.repositoryId !== node.workspaceReceipt.repositoryId ||
			command.workspaceReceipt.bindingRevision < node.workspaceReceipt.bindingRevision ||
			(command.workspaceReceipt.status !== "active" && command.workspaceReceipt.status !== "readonly") ||
			!workspaceReceiptIsValid({ ...node, workspaceReceipt: command.workspaceReceipt }) ||
			command.denialReceipt.agentId !== node.agentId ||
			command.denialReceipt.sessionId !== node.sessionId ||
			command.denialReceipt.status !== "allowed" ||
			!isRuntimeId(command.denialReceipt.receiptId, "receipt") ||
			!digestIsValid(command.denialReceipt.receiptDigest)
		) {
			return fail("resume_denied", "resume receipts are missing, stale, or inconsistent");
		}
		return withNodeResult(projection, {
			...node,
			delegationReceipt: { ...command.delegationReceipt },
			workspaceReceipt: { ...command.workspaceReceipt },
			updatedAt: command.occurredAt,
		});
	}

	if (command.type === "agent.handoff_requested") {
		const node = projection.nodes.get(command.handoff.agentId);
		if (
			!node ||
			!validateAgentHandoffManifest(command.handoff, node).ok ||
			projection.handoffs.has(command.handoff.handoffId) ||
			projection.pendingHandoffs.has(command.handoff.handoffId)
		) {
			return fail("handoff_invalid", "handoff manifest is not correlated to the child");
		}
		const pendingHandoffs = new Map(projection.pendingHandoffs);
		pendingHandoffs.set(command.handoff.handoffId, command.handoff);
		return { ok: true, value: { ...projection, pendingHandoffs } };
	}

	if (command.type === "agent.handoff_committed") {
		const pending = projection.pendingHandoffs.get(command.handoff.handoffId);
		if (!pending || pending.manifestDigest !== command.handoff.manifestDigest) {
			return fail("handoff_invalid", "handoff terminal has no correlated durable intent");
		}
		const pendingHandoffs = new Map(projection.pendingHandoffs);
		pendingHandoffs.delete(command.handoff.handoffId);
		const handoffs = new Map(projection.handoffs);
		handoffs.set(command.handoff.handoffId, command.handoff);
		return { ok: true, value: { ...projection, pendingHandoffs, handoffs } };
	}

	if (command.type === "agent.handoff_failed") {
		const pending = projection.pendingHandoffs.get(command.handoffId);
		if (!pending || pending.agentId !== command.agentId || !failureRefIsValid(command.error)) {
			return fail("handoff_invalid", "handoff failure has no correlated durable intent");
		}
		const pendingHandoffs = new Map(projection.pendingHandoffs);
		if (command.error.outcomeCertain) pendingHandoffs.delete(command.handoffId);
		return {
			ok: true,
			value: {
				...projection,
				pendingHandoffs,
				reconciliationFailures: [
					...projection.reconciliationFailures,
					{
						operation: "handoff",
						requestId: command.handoffId,
						agentId: command.agentId,
						error: command.error,
					},
				],
			},
		};
	}

	if (command.type === "agent.merge_requested") {
		const parent = projection.nodes.get(command.request.parentAgentId);
		const child = projection.nodes.get(command.request.childAgentId);
		if (
			!parent ||
			!child ||
			child.parentAgentId !== parent.agentId ||
			command.request.sourceHandoff.agentId !== child.agentId ||
			command.request.targetWorkspace.workspaceId !== parent.workspaceReceipt.workspaceId ||
			projection.pendingMerges.has(command.request.requestId)
		) return fail("merge_invalid", "merge intent is not correlated to a parent/child edge");
		const { requestDigest } = command.request;
		if (!digestIsValid(requestDigest) || requestDigest !== declarativeMergeRequestDigest(command.request)) {
			return fail("merge_invalid", "merge intent digest is invalid");
		}
		const pendingMerges = new Map(projection.pendingMerges);
		pendingMerges.set(command.request.requestId, command.request);
		return { ok: true, value: { ...projection, pendingMerges } };
	}

	if (command.type === "agent.merge_committed" || command.type === "agent.merge_conflicted") {
		const pending = projection.pendingMerges.get(command.receipt.requestId);
		if (!pending || pending.parentAgentId !== command.receipt.parentAgentId || pending.childAgentId !== command.receipt.childAgentId) {
			return fail("merge_invalid", "merge terminal has no correlated durable intent");
		}
		if (
			(command.type === "agent.merge_committed" && command.receipt.outcome !== "applied") ||
			(command.type === "agent.merge_conflicted" && command.receipt.outcome !== "conflict")
		) return fail("merge_invalid", "merge terminal type does not match its receipt outcome");
		const applied = applyMergeReceipt(projection, command.receipt);
		if (!applied.ok) return applied;
		const pendingMerges = new Map(applied.value.pendingMerges);
		pendingMerges.delete(command.receipt.requestId);
		return { ok: true, value: { ...applied.value, pendingMerges } };
	}

	const pending = projection.pendingMerges.get(command.requestId);
	if (
		!pending ||
		pending.parentAgentId !== command.parentAgentId ||
		pending.childAgentId !== command.childAgentId ||
		!failureRefIsValid(command.error)
	) return fail("merge_invalid", "merge failure has no correlated durable intent");
	const pendingMerges = new Map(projection.pendingMerges);
	if (command.error.outcomeCertain) pendingMerges.delete(command.requestId);
	return {
		ok: true,
		value: {
			...projection,
			pendingMerges,
			reconciliationFailures: [
				...projection.reconciliationFailures,
				{
					operation: "merge",
					requestId: command.requestId,
					agentId: command.childAgentId,
					error: command.error,
				},
			],
		},
	};
}

function mergeReceiptDigest(receipt: AgentGraphProjection["mergeReceipts"][number]): string {
	const { receiptDigest: _receiptDigest, ...body } = receipt;
	return canonicalDigest(body);
}

function withNodeResult(projection: AgentGraphProjection, node: AgentNode): AgentResult<AgentGraphProjection> {
	return { ok: true, value: withNode(projection, node) };
}

export function agentGraphSemanticCommandDigest(command: AgentGraphSemanticCommand): string {
	const { occurredAt: _occurredAt, ...semantic } = command;
	return canonicalDigest(semantic);
}

function cloneProjection(projection: AgentGraphProjection): AgentGraphProjection {
	return {
		...projection,
		nodes: new Map([...projection.nodes].map(([agentId, node]) => [agentId, cloneNode(node)])),
		edges: projection.edges.map((edge) => ({ ...edge })),
		handoffs: new Map([...projection.handoffs].map(([handoffId, handoff]) => [handoffId, { ...handoff }])),
		mergeReceipts: projection.mergeReceipts.map((receipt) => ({ ...receipt })),
		pendingSpawns: new Map([...projection.pendingSpawns].map(([agentId, intent]) => [agentId, { ...intent }])),
		pendingHandoffs: new Map([...projection.pendingHandoffs].map(([handoffId, handoff]) => [handoffId, { ...handoff }])),
		pendingMerges: new Map([...projection.pendingMerges].map(([requestId, request]) => [requestId, { ...request }])),
		cleanups: new Map([...projection.cleanups].map(([agentId, cleanup]) => [agentId, cloneCleanupRecord(cleanup)])),
		reconciliationFailures: projection.reconciliationFailures.map(cloneReconciliationFailure),
	};
}

function cloneReconciliationFailure(failure: AgentGraphReconciliationFailure): AgentGraphReconciliationFailure {
	return { ...failure, error: { ...failure.error } };
}

export function cloneAgentGraphStoreHead(head: AgentGraphStoreHead): AgentGraphStoreHead {
	return {
		revision: head.revision,
		...(head.cursor ? { cursor: { ...head.cursor } } : {}),
		projection: cloneProjection(head.projection),
	};
}

interface MemoryGraphState {
	head: AgentGraphStoreHead;
	idempotency: Map<string, string>;
}

export class InMemoryAgentGraphStore implements DurableAgentGraphStorePort {
	private readonly graphs = new Map<AgentId, MemoryGraphState>();
	private readonly limits: AgentGraphLimits;

	public constructor(limits: AgentGraphLimits = DEFAULT_AGENT_GRAPH_LIMITS) {
		this.limits = limits;
	}

	public load(rootAgentId: AgentId): Promise<AgentResult<AgentGraphStoreHead>> {
		if (!isRuntimeId(rootAgentId, "agent")) return Promise.resolve(fail("invalid_request", "rootAgentId is invalid"));
		const state = this.graphs.get(rootAgentId);
		return Promise.resolve({
			ok: true,
			value: cloneAgentGraphStoreHead(state?.head ?? { revision: 0, projection: createEmptyAgentGraphProjection() }),
		});
	}

	public commit(
		rootAgentId: AgentId,
		expectedRevision: number,
		command: AgentGraphSemanticCommand,
	): Promise<AgentResult<AgentGraphCommitOutcome>> {
		if (!isRuntimeId(rootAgentId, "agent") || !numberIsBounded(expectedRevision, 0)) {
			return Promise.resolve(fail("invalid_request", "graph append identity or revision is invalid"));
		}
		if (
			!isRuntimeId(command.requestId, "command") ||
			!parseIdempotencyKey(command.idempotencyKey) ||
			!Number.isFinite(Date.parse(command.occurredAt))
		) return Promise.resolve(fail("invalid_request", "graph semantic command is invalid"));
		const current = this.graphs.get(rootAgentId) ?? {
			head: { revision: 0, projection: createEmptyAgentGraphProjection() },
			idempotency: new Map<string, string>(),
		};
		let digest: string;
		try {
			digest = agentGraphSemanticCommandDigest(command);
		} catch {
			return Promise.resolve(fail("invalid_graph", "graph semantic command is not canonical"));
		}
		const previous = current.idempotency.get(command.idempotencyKey);
		if (previous) {
			if (previous !== digest) {
				return Promise.resolve(fail("idempotency_conflict", "graph idempotency key was reused"));
			}
			return Promise.resolve({ ok: true, value: { status: "duplicate", head: cloneAgentGraphStoreHead(current.head) } });
		}
		if (current.head.revision !== expectedRevision) {
			return Promise.resolve({ ok: true, value: { status: "conflict", actualRevision: current.head.revision } });
		}
		try {
			const applied = applyAgentGraphCommand(current.head.projection, command, this.limits);
			if (!applied.ok) return Promise.resolve(applied);
			const projection = { ...applied.value, revision: expectedRevision + 1 };
			const head: AgentGraphStoreHead = { revision: expectedRevision + 1, projection };
			const idempotency = new Map(current.idempotency);
			idempotency.set(command.idempotencyKey, digest);
			this.graphs.set(rootAgentId, { head, idempotency });
			return Promise.resolve({ ok: true, value: { status: "committed", head: cloneAgentGraphStoreHead(head) } });
		} catch {
			return Promise.resolve(fail("invalid_graph", "graph semantic command contains a malformed value"));
		}
	}
}

export function isAgentTerminal(node: AgentNode): boolean {
	return FINAL_STATES.has(node.state);
}
