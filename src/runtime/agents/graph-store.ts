/** Agent graph semantic reducer 与内存 projection/head adapter。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import { parseIdempotencyKey } from "../protocol/v3/coordination.ts";
import { isRuntimeId } from "../protocol/v3/ids.ts";
import type { AgentId } from "../protocol/v3/ids.ts";
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
	AgentSpawnIntent,
	AgentState,
	DurableAgentGraphStorePort,
} from "./types.ts";
import { DEFAULT_AGENT_GRAPH_LIMITS } from "./types.ts";
import { AGENT_ROLES } from "./types.ts";

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const FINAL_STATES: ReadonlySet<AgentState> = new Set(["completed", "failed", "stopped"]);

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

function numberIsBounded(value: number, minimum: number, maximum = Number.MAX_SAFE_INTEGER): boolean {
	return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
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

function workspaceReceiptIsValid(node: AgentNode): boolean {
	const receipt = node.workspaceReceipt;
	return (
		isRuntimeId(receipt.receiptId, "receipt") &&
		isRuntimeId(receipt.sessionId, "session") &&
		isRuntimeId(receipt.workspaceId, "workspace") &&
		isRuntimeId(receipt.repositoryId, "repository") &&
		isRuntimeId(receipt.strategy.strategyId, "resource") &&
		digestIsValid(receipt.strategy.strategyDigest) &&
		digestIsValid(receipt.bindingDigest) &&
		digestIsValid(receipt.receiptDigest) &&
		Number.isSafeInteger(receipt.bindingRevision) &&
		receipt.bindingRevision >= 0
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
		budget: { ...node.budget },
		turnIds: [...node.turnIds],
		artifactContract: { ...node.artifactContract, expected: [...node.artifactContract.expected] },
		artifacts: node.artifacts.map((report) => ({
			...report,
			artifact: { ...report.artifact },
			inputSources: report.inputSources.map((source) => ({ ...source, taintLabels: [...source.taintLabels] })),
			declassificationReceipts: report.declassificationReceipts.map((receipt) => ({ ...receipt })),
		})),
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
): AgentResult<AgentGraphProjection> {
	const node = projection.nodes.get(agentId);
	if (!node) return fail("agent_not_found", "state event references a missing agent");
	if (node.state !== from || !AGENT_STATE_TRANSITIONS[from].includes(to)) {
		return fail("invalid_transition", "agent state transition is invalid");
	}
	if (to === "completed" && !completionContractSatisfied(node)) {
		return fail("artifact_contract_mismatch", "agent cannot complete without declared artifacts");
	}
	const { stateReason: _stateReason, ...nodeWithoutReason } = node;
	return withNodeResult(projection, {
		...nodeWithoutReason,
		state: to,
		...(reason ? { stateReason: reason } : {}),
		updatedAt: changedAt,
	});
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

	if (!projection.rootAgentId || !projection.goalId) return fail("orphan_agent", "agent event precedes its root");

	if (command.type === "agent.spawn_requested") {
		const parent = projection.nodes.get(command.intent.parentAgentId);
		if (!parent || !spawnIntentIsValid(command.intent, parent)) return fail("spawn_denied", "spawn intent is invalid");
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
		return applyStateTransition(projection, command.agentId, command.from, "stopped", command.reason, command.occurredAt);
	}
	if (command.type === "agent.partial_committed") {
		return applyStateTransition(projection, command.agentId, command.from, "partial", command.reason, command.occurredAt);
	}
	if (command.type === "agent.finished") {
		return applyStateTransition(projection, command.agentId, command.from, "completed", undefined, command.occurredAt);
	}
	if (command.type === "agent.failed") {
		if (!failureRefIsValid(command.error)) return fail("invalid_graph", "agent failure receipt is invalid");
		return applyStateTransition(projection, command.agentId, command.from, "failed", command.reason, command.occurredAt);
	}

	if (command.type === "agent.cursor_advanced") {
		const node = projection.nodes.get(command.agentId);
		if (!node) return fail("agent_not_found", "cursor record references a missing agent");
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
		if (node.residency && command.receipt.revision <= node.residency.revision) {
			return fail("invalid_graph", "residency revision must advance monotonically");
		}
		return withNodeResult(projection, { ...node, residency: { ...command.receipt }, updatedAt: command.receipt.observedAt });
	}

	if (command.type === "agent.budget_rebound") {
		const node = projection.nodes.get(command.agentId);
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
		if (
			!node ||
			command.launchReceipt.agentId !== node.agentId ||
			command.launchReceipt.sessionId !== node.sessionId ||
			command.residencyReceipt.agentId !== node.agentId ||
			command.residencyReceipt.sessionId !== node.sessionId ||
			command.residencyReceipt.state !== "resident"
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
