/** Spawn/delegation 的结构校验与 CapabilitySubsetEvaluator 协调。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import { CAPABILITY_NAMES } from "../protocol/v3/capability.ts";
import { parseIdempotencyKey } from "../protocol/v3/coordination.ts";
import { isRuntimeId } from "../protocol/v3/ids.ts";
import {
	isDeclassificationReceiptRef,
	isInputSourceRef,
	propagateInputSources,
} from "../protocol/v3/taint.ts";
import type { DeclassificationReceiptRef, InputSourceRef } from "../protocol/v3/taint.ts";
import type {
	AgentArtifactContract,
	AgentCapabilityRequestRef,
	AgentErrorCode,
	AgentNode,
	AgentResult,
	CapabilitySubsetEvaluatorPort,
	DelegationReceiptRef,
	ExpectedAgentArtifact,
	ParentCapabilityGrantRef,
	SpawnAgentRequest,
} from "./types.ts";
import { AGENT_ROLES, AGENT_WORKSPACE_STRATEGIES } from "./types.ts";

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const MAX_OBJECTIVE_LENGTH = 16_384;
const MAX_CAPABILITY_REQUESTS = 64;
const MAX_EXPECTED_ARTIFACTS = 64;
const MAX_TURNS = 10_000;
const SPAWN_REQUEST_KEYS: ReadonlySet<string> = new Set([
	"requestId",
	"idempotencyKey",
	"parentAgentId",
	"childAgentId",
	"childSessionId",
	"role",
	"objective",
	"expectedArtifacts",
	"allowPartial",
	"depth",
	"budget",
	"parentGrant",
	"requestedCapabilities",
	"workspaceStrategy",
	"inputSources",
	"declassificationReceipts",
]);

function fail<T>(code: AgentErrorCode, message: string, retryable = false): AgentResult<T> {
	return { ok: false, error: { code, message, retryable } };
}

function digestIsValid(value: string): boolean {
	return DIGEST_PATTERN.test(value);
}

function timestampIsExpired(value: string | undefined, now: Date): boolean {
	if (!value) return false;
	const parsed = Date.parse(value);
	return !Number.isFinite(parsed) || parsed <= now.getTime();
}

function safeNonNegative(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0;
}

function sourceIdentity(source: InputSourceRef): string {
	return `${source.authorityId}/${source.tenantId}/${source.sourceId}/${source.sourceDigest}`;
}

/** 委派边界只接受可验证且去重的 lineage；过期 receipt 仍保留作审计，但不能再授权 sink。 */
export function inputLineageIsValid(
	inputSources: readonly InputSourceRef[],
	declassificationReceipts: readonly DeclassificationReceiptRef[],
): boolean {
	if (inputSources.length > 256 || declassificationReceipts.length > 256) return false;
	const propagated = propagateInputSources(inputSources);
	if (!propagated || propagated.length !== inputSources.length) return false;
	const sourceKeys = new Set(inputSources.map(sourceIdentity));
	const receiptIds = new Set<string>();
	for (const receipt of declassificationReceipts) {
		if (
			!isDeclassificationReceiptRef(receipt) ||
			receiptIds.has(receipt.receiptId) ||
			!sourceKeys.has(`${receipt.authorityId}/${receipt.tenantId}/${receipt.sourceId}/${receipt.sourceDigest}`)
		) {
			return false;
		}
		receiptIds.add(receipt.receiptId);
	}
	return inputSources.every(isInputSourceRef);
}

/** child/handoff 必须包含 parent/node 的每个 exact source 与 receipt，不能靠摘要清除 taint。 */
export function inputLineagePreserves(
	requiredSources: readonly InputSourceRef[],
	requiredReceipts: readonly DeclassificationReceiptRef[],
	actualSources: readonly InputSourceRef[],
	actualReceipts: readonly DeclassificationReceiptRef[],
): boolean {
	if (!inputLineageIsValid(requiredSources, requiredReceipts) || !inputLineageIsValid(actualSources, actualReceipts)) {
		return false;
	}
	const sourceDigests = new Set(actualSources.map((source) => canonicalDigest(source)));
	const receiptDigests = new Set(actualReceipts.map((receipt) => canonicalDigest(receipt)));
	return (
		requiredSources.every((source) => sourceDigests.has(canonicalDigest(source))) &&
		requiredReceipts.every((receipt) => receiptDigests.has(canonicalDigest(receipt)))
	);
}

export function isParentCapabilityGrantRef(value: ParentCapabilityGrantRef, now = new Date()): boolean {
	return (
		isRuntimeId(value.receiptId, "receipt") &&
		digestIsValid(value.receiptDigest) &&
		Number.isSafeInteger(value.decisionRevision) &&
		value.decisionRevision >= 0 &&
		!timestampIsExpired(value.expiresAt, now)
	);
}

export function isAgentCapabilityRequestRef(value: AgentCapabilityRequestRef): boolean {
	if (!isRuntimeId(value.requestId, "command")) return false;
	if (value.kind === "capability") return CAPABILITY_NAMES.includes(value.capability) && digestIsValid(value.requestDigest);
	return (
		["builtin", "mcp", "custom", "unknown"].includes(value.toolKind) &&
		isRuntimeId(value.resourceId, "resource") &&
		digestIsValid(value.manifestDigest) &&
		digestIsValid(value.requiredClaimsDigest)
	);
}

function expectedArtifactsAreValid(expected: readonly ExpectedAgentArtifact[]): boolean {
	if (expected.length === 0 || expected.length > MAX_EXPECTED_ARTIFACTS) return false;
	const names = new Set<string>();
	for (const artifact of expected) {
		if (
			artifact.logicalName.length === 0 ||
			artifact.logicalName.length > 256 ||
			artifact.mediaType.length === 0 ||
			artifact.mediaType.length > 256 ||
			names.has(artifact.logicalName)
		) {
			return false;
		}
		names.add(artifact.logicalName);
	}
	return true;
}

export function createAgentArtifactContract(
	expected: readonly ExpectedAgentArtifact[],
	allowPartial: boolean,
): AgentResult<AgentArtifactContract> {
	if (!expectedArtifactsAreValid(expected)) {
		return fail("invalid_request", "spawn must declare a bounded, unique expected Artifact contract");
	}
	const body = { expected: [...expected], allowPartial };
	return { ok: true, value: { ...body, contractDigest: canonicalDigest(body) } };
}

export function validateSpawnAgentRequest(request: SpawnAgentRequest, now = new Date()): AgentResult<void> {
	if (Object.keys(request).some((key) => !SPAWN_REQUEST_KEYS.has(key))) {
		return fail("invalid_request", "spawn request contains an unsupported or unsafe field");
	}
	if (
		!isRuntimeId(request.requestId, "command") ||
		!parseIdempotencyKey(request.idempotencyKey) ||
		!isRuntimeId(request.parentAgentId, "agent") ||
		!isRuntimeId(request.childAgentId, "agent") ||
		!isRuntimeId(request.childSessionId, "session") ||
		request.parentAgentId === request.childAgentId ||
		!AGENT_ROLES.includes(request.role) ||
		!Number.isSafeInteger(request.depth) ||
		request.depth < 1
	) {
		return fail("invalid_request", "spawn identity, role, or depth is invalid");
	}
	if (
		request.objective.trim().length === 0 ||
		request.objective.length > MAX_OBJECTIVE_LENGTH ||
		!expectedArtifactsAreValid(request.expectedArtifacts)
	) {
		return fail("invalid_request", "spawn objective or expected Artifact contract is invalid");
	}
	if (
		!safeNonNegative(request.budget.maxInputTokens) ||
		!safeNonNegative(request.budget.maxOutputTokens) ||
		!safeNonNegative(request.budget.maxUsdMicros) ||
		!safeNonNegative(request.budget.maxWallTimeMs) ||
		!safeNonNegative(request.budget.maxToolCalls) ||
		!safeNonNegative(request.budget.maxNetworkBytes) ||
		!safeNonNegative(request.budget.maxStorageBytes) ||
		!Number.isSafeInteger(request.budget.maxTurns) ||
		request.budget.maxTurns < 1 ||
		request.budget.maxTurns > MAX_TURNS
	) {
		return fail("invalid_request", "spawn budget must be finite, non-negative, and turn bounded");
	}
	if (!isParentCapabilityGrantRef(request.parentGrant, now)) {
		return fail("delegation_invalid", "parent grant is missing, malformed, or expired");
	}
	if (request.requestedCapabilities.length > MAX_CAPABILITY_REQUESTS) {
		return fail("invalid_request", "requested capability reference count exceeds the bound");
	}
	const requestIds = new Set<string>();
	for (const capability of request.requestedCapabilities) {
		if (!isAgentCapabilityRequestRef(capability) || requestIds.has(capability.requestId)) {
			return fail("invalid_request", "requested capability references are malformed or duplicated");
		}
		requestIds.add(capability.requestId);
	}
	if (
		!isRuntimeId(request.workspaceStrategy.strategyId, "resource") ||
		!AGENT_WORKSPACE_STRATEGIES.includes(request.workspaceStrategy.kind) ||
		!digestIsValid(request.workspaceStrategy.strategyDigest)
	) {
		return fail("workspace_invalid", "workspace strategy reference is invalid");
	}
	if (!inputLineageIsValid(request.inputSources, request.declassificationReceipts)) {
		return fail("invalid_request", "spawn input source or declassification lineage is invalid");
	}
	return { ok: true, value: undefined };
}

export function spawnAgentRequestDigest(request: SpawnAgentRequest): string {
	return canonicalDigest({
		requestId: request.requestId,
		parentAgentId: request.parentAgentId,
		childAgentId: request.childAgentId,
		childSessionId: request.childSessionId,
		role: request.role,
		objectiveDigest: canonicalDigest(request.objective),
		expectedArtifacts: request.expectedArtifacts,
		allowPartial: request.allowPartial,
		depth: request.depth,
		budget: request.budget,
		parentGrant: canonicalParentGrant(request.parentGrant),
		requestedCapabilities: request.requestedCapabilities,
		workspaceStrategy: request.workspaceStrategy,
		inputSources: request.inputSources,
		declassificationReceipts: request.declassificationReceipts,
	});
}

export function capabilitySubsetRequestDigest(
	parentAgentId: SpawnAgentRequest["parentAgentId"],
	childAgentId: SpawnAgentRequest["childAgentId"],
	parentGrant: ParentCapabilityGrantRef,
	requestedCapabilities: readonly AgentCapabilityRequestRef[],
	inputSources: readonly InputSourceRef[],
	declassificationReceipts: readonly DeclassificationReceiptRef[],
): string {
	return canonicalDigest({
		parentAgentId,
		childAgentId,
		parentGrant: canonicalParentGrant(parentGrant),
		requestedCapabilities,
		inputSources,
		declassificationReceipts,
	});
}

function delegationReceiptDigest(receipt: DelegationReceiptRef): string {
	const body = {
		receiptId: receipt.receiptId,
		parentAgentId: receipt.parentAgentId,
		childAgentId: receipt.childAgentId,
		parentGrantReceiptId: receipt.parentGrantReceiptId,
		parentGrantDigest: receipt.parentGrantDigest,
		requestDigest: receipt.requestDigest,
		decision: receipt.decision,
		childSpawnAllowed: receipt.childSpawnAllowed,
		decisionRevision: receipt.decisionRevision,
		evaluatorId: receipt.evaluatorId,
		evaluatedAt: receipt.evaluatedAt,
		...(receipt.expiresAt ? { expiresAt: receipt.expiresAt } : {}),
	};
	return canonicalDigest(body);
}

function canonicalParentGrant(grant: ParentCapabilityGrantRef) {
	return {
		receiptId: grant.receiptId,
		receiptDigest: grant.receiptDigest,
		decisionRevision: grant.decisionRevision,
		...(grant.expiresAt ? { expiresAt: grant.expiresAt } : {}),
	};
}

export function delegationReceiptMatches(
	receipt: DelegationReceiptRef,
	request: {
		parentAgentId: SpawnAgentRequest["parentAgentId"];
		childAgentId: SpawnAgentRequest["childAgentId"];
		parentGrant: ParentCapabilityGrantRef;
		requestDigest: string;
	},
	now = new Date(),
): boolean {
	let expectedDigest: string;
	try {
		expectedDigest = delegationReceiptDigest(receipt);
	} catch {
		return false;
	}
	return (
		isRuntimeId(receipt.receiptId, "receipt") &&
		isRuntimeId(receipt.evaluatorId, "principal") &&
		receipt.parentAgentId === request.parentAgentId &&
		receipt.childAgentId === request.childAgentId &&
		receipt.parentGrantReceiptId === request.parentGrant.receiptId &&
		receipt.parentGrantDigest === request.parentGrant.receiptDigest &&
		receipt.requestDigest === request.requestDigest &&
		receipt.decision === "allowed" &&
		Number.isSafeInteger(receipt.decisionRevision) &&
		receipt.decisionRevision >= request.parentGrant.decisionRevision &&
		!timestampIsExpired(receipt.expiresAt, now) &&
		digestIsValid(receipt.receiptDigest) &&
		receipt.receiptDigest === expectedDigest
	);
}

export async function evaluateSpawnDelegation(
	request: SpawnAgentRequest,
	evaluator: CapabilitySubsetEvaluatorPort,
	signal?: AbortSignal,
	now = new Date(),
): Promise<AgentResult<DelegationReceiptRef>> {
	const validated = validateSpawnAgentRequest(request, now);
	if (!validated.ok) return validated;
	const requestDigest = capabilitySubsetRequestDigest(
		request.parentAgentId,
		request.childAgentId,
		request.parentGrant,
		request.requestedCapabilities,
		request.inputSources,
		request.declassificationReceipts,
	);
	try {
		const evaluated = await evaluator.evaluate(
			{
				requestId: request.requestId,
				parentAgentId: request.parentAgentId,
				childAgentId: request.childAgentId,
				parentGrant: request.parentGrant,
				requestedCapabilities: [...request.requestedCapabilities],
				inputSources: [...request.inputSources],
				declassificationReceipts: [...request.declassificationReceipts],
				requestDigest,
			},
			signal,
		);
		if (!evaluated.ok) return evaluated;
		if (
			!delegationReceiptMatches(
				evaluated.value,
				{
					parentAgentId: request.parentAgentId,
					childAgentId: request.childAgentId,
					parentGrant: request.parentGrant,
					requestDigest,
				},
				now,
			)
		) {
			return fail("delegation_denied", "CapabilitySubsetEvaluator returned an invalid or denied receipt");
		}
		return evaluated;
	} catch {
		return fail("reference_unavailable", "CapabilitySubsetEvaluator is unavailable", true);
	}
}

export async function revalidateDelegation(
	node: AgentNode,
	parent: AgentNode,
	requestId: SpawnAgentRequest["requestId"],
	evaluator: CapabilitySubsetEvaluatorPort,
	signal?: AbortSignal,
	now = new Date(),
): Promise<AgentResult<DelegationReceiptRef>> {
	if (!node.parentAgentId || !node.delegationReceipt || !parent.capabilityGrant) {
		return fail("delegation_invalid", "agent does not have a replayable delegation receipt");
	}
	if (!isParentCapabilityGrantRef(parent.capabilityGrant, now)) {
		return fail("resume_denied", "parent capability grant is expired or invalid");
	}
	const requestDigest = capabilitySubsetRequestDigest(
		parent.agentId,
		node.agentId,
		parent.capabilityGrant,
		node.requestedCapabilities,
		node.inputSources,
		node.declassificationReceipts,
	);
	try {
		const revalidated = await evaluator.revalidate(
			{
				requestId,
				agentId: node.agentId,
				parentAgentId: parent.agentId,
				parentGrant: parent.capabilityGrant,
				requestedCapabilities: [...node.requestedCapabilities],
				inputSources: [...node.inputSources],
				declassificationReceipts: [...node.declassificationReceipts],
				previousReceipt: node.delegationReceipt,
				requestDigest,
			},
			signal,
		);
		if (!revalidated.ok) return revalidated;
		return delegationReceiptMatches(
			revalidated.value,
			{
				parentAgentId: parent.agentId,
				childAgentId: node.agentId,
				parentGrant: parent.capabilityGrant,
				requestDigest,
			},
			now,
		)
			? revalidated
			: fail("resume_denied", "delegation receipt failed resume revalidation");
	} catch {
		return fail("reference_unavailable", "CapabilitySubsetEvaluator is unavailable during resume", true);
	}
}

export function childMaySpawn(parent: AgentNode, now = new Date()): boolean {
	if (parent.depth === 0) return true;
	return Boolean(
		parent.delegationReceipt?.decision === "allowed" &&
		parent.delegationReceipt.childSpawnAllowed &&
		!timestampIsExpired(parent.delegationReceipt.expiresAt, now),
	);
}
