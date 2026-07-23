/** 有界 Agent supervisor：admission、receipt 协调、durable graph 与 resume。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import { createIdempotencyKey, parseIdempotencyKey } from "../protocol/v3/coordination.ts";
import { createRuntimeId, isRuntimeId } from "../protocol/v3/ids.ts";
import { createBudgetVector } from "../orchestrator/budget-guard.ts";
import type { BudgetGuard as BudgetGuardType } from "../orchestrator/budget-guard.ts";
import {
	childMaySpawn,
	createAgentArtifactContract,
	evaluateSpawnDelegation,
	inputLineageIsValid,
	inputLineagePreserves,
	isParentCapabilityGrantRef,
	revalidateDelegation,
	spawnAgentRequestDigest,
	validateSpawnAgentRequest,
} from "./delegation.ts";
import {
	agentBudgetSettlementRequestDigest,
	agentCleanupReceiptDigest,
	agentCleanupRequestDigest,
	agentRuntimeReleaseRequestDigest,
	agentWorkspaceReleaseRequestDigest,
	createAgentSemanticTerminalRecord,
	isAgentTerminal,
	normalizeAgentGraphLimits,
} from "./graph-store.ts";
import { createAgentHandoffManifest } from "./handoff.ts";
import { buildDeclarativeMergeRequest, executeDeclarativeMerge } from "./merge.ts";
import {
	createAgentInterruptionCommands,
	stateForAgentInterruption,
	validateAgentResidencyReceipt,
} from "./residency.ts";
import type {
	AgentArtifactReportRequest,
	AgentBudgetSettlementReceiptRef,
	AgentBudgetUsage,
	AgentBudgetReservationRef,
	AgentCleanupKind,
	AgentNotStartedCleanupReceiptBody,
	AgentCleanupRecord,
	AgentCleanupStage,
	AgentStartedCleanupReceiptBody,
	AgentCursorAdvanceRequest,
	AgentDenialReceiptRef,
	AgentError,
	AgentErrorCode,
	AgentGraphLimits,
	AgentGraphProjection,
	AgentGraphFailureRef,
	AgentGraphSemanticCommand,
	AgentHandoffRequest,
	AgentLaunchResult,
	AgentMergeRequest,
	AgentNode,
	AgentResidencyReceiptRef,
	AgentResult,
	AgentResumeOutcome,
	AgentResumeRequest,
	AgentRuntimeReleaseReceiptRef,
	AgentSpawnOutcome,
	AgentSupervisorOptions,
	AgentTerminalRequest,
	AgentTurnRecordRequest,
	AgentWorkspaceReceiptRef,
	AgentWorkspaceReleaseRequest,
	AgentWorkspaceReleaseReceiptRef,
	RegisterRootAgentRequest,
	RootAgentBudgetPort,
	RootAgentBudgetReserveRequest,
	RootAgentBudgetSettleRequest,
	SpawnAgentRequest,
} from "./types.ts";

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const MAX_GRAPH_CAS_ATTEMPTS = 32;

function fail<T>(code: AgentErrorCode, message: string, retryable = false): AgentResult<T> {
	return { ok: false, error: { code, message, retryable } };
}

function terminalReasonMatchesOutcome(request: AgentTerminalRequest): boolean {
	if (request.outcome === "completed") return request.reason === undefined;
	if (request.outcome === "stopped") {
		return request.reason === undefined || ["cancelled", "budget_exhausted", "delegation_revoked"].includes(request.reason);
	}
	return request.reason === undefined || ["timeout", "crash", "workspace_lost"].includes(request.reason);
}

function fromBudgetError<T>(error: {
	code: string;
	message: string;
	retryable: boolean;
}): AgentResult<T> {
	const code: AgentErrorCode =
		error.code === "budget_exhausted" || error.code === "budget_stopped"
			? "budget_denied"
			: error.code === "idempotency_conflict"
				? "idempotency_conflict"
				: error.code === "journal_conflict"
					? "revision_conflict"
					: "store_unavailable";
	return fail(code, error.message, error.retryable);
}

function derivedKey(base: string, purpose: string) {
	return createIdempotencyKey(`agent-${purpose}-${canonicalDigest(base).slice(0, 48)}`);
}

function budgetRequestDigest(agentId: RootAgentBudgetReserveRequest["agentId"], budget: RootAgentBudgetReserveRequest["budget"]): string {
	return canonicalDigest({ agentId, budget });
}

function budgetSettlementRequest(
	request: Omit<RootAgentBudgetSettleRequest, "requestDigest">,
): RootAgentBudgetSettleRequest {
	return { ...request, requestDigest: agentBudgetSettlementRequestDigest(request) };
}

/** 把 Phase 7 root BudgetGuard 收敛为 Multi-Agent 只需的 reserve/settle 端口。 */
export class RootBudgetGuardAdapter implements RootAgentBudgetPort {
	private readonly guard: BudgetGuardType;

	public constructor(guard: BudgetGuardType) {
		this.guard = guard;
	}

	public async reserve(request: RootAgentBudgetReserveRequest): Promise<AgentResult<AgentBudgetReservationRef>> {
		if (request.requestDigest !== budgetRequestDigest(request.agentId, request.budget)) {
			return fail("invalid_request", "root budget reservation digest is invalid");
		}
		const reservationId = createRuntimeId(
			"budgetReservation",
			canonicalDigest({ requestId: request.requestId, agentId: request.agentId }).slice(0, 48),
		);
		const reserved = await this.guard.reserve({
			reservationId,
			operationId: request.requestId,
			idempotencyKey: request.idempotencyKey,
			estimatedUpperBound: createBudgetVector({
				inputTokens: request.budget.maxInputTokens,
				outputTokens: request.budget.maxOutputTokens,
				usdMicros: request.budget.maxUsdMicros,
				wallTimeMs: request.budget.maxWallTimeMs,
				toolCalls: request.budget.maxToolCalls,
				networkBytes: request.budget.maxNetworkBytes,
				storageBytes: request.budget.maxStorageBytes,
				activeAgents: 1,
			}),
		});
		if (!reserved.ok) return fromBudgetError(reserved.error);
		if (reserved.value.status === "denied") return fail("budget_denied", "root BudgetGuard denied child admission");
		return {
			ok: true,
			value: {
				reservationId: reserved.value.reservation.reservationId,
				operationId: request.requestId,
				requestDigest: request.requestDigest,
			},
		};
	}

	public async settle(request: RootAgentBudgetSettleRequest): Promise<AgentResult<AgentBudgetSettlementReceiptRef>> {
		const { requestDigest, ...requestBody } = request;
		if (
			requestDigest !== agentBudgetSettlementRequestDigest(requestBody) ||
			!Number.isFinite(Date.parse(request.settledAt))
		) return fail("invalid_request", "root budget settlement request is invalid");
		if (request.outcome !== "not_started" && !request.usage) {
			return fail("invalid_request", "started child budget settlement requires exact usage");
		}
		if (request.outcome === "not_started") {
			const refunded = await this.guard.refund({
				reservationId: request.reservation.reservationId,
				idempotencyKey: request.idempotencyKey,
				reason: "not_started",
			});
			if (!refunded.ok) return fromBudgetError(refunded.error);
		} else {
			const usage = request.usage;
			if (!usage) return fail("invalid_request", "started child budget settlement requires exact usage");
			const committed = await this.guard.commit({
				reservationId: request.reservation.reservationId,
				idempotencyKey: request.idempotencyKey,
				actual: createBudgetVector({
					inputTokens: usage.inputTokens,
					outputTokens: usage.outputTokens,
					usdMicros: usage.usdMicros,
					wallTimeMs: usage.wallTimeMs,
					toolCalls: usage.toolCalls,
					networkBytes: usage.networkBytes,
					storageBytes: usage.storageBytes,
					artifactCount: usage.artifactCount,
					verifications: usage.verifications,
				}),
				partialResults: request.partialResults,
			});
			if (!committed.ok) return fromBudgetError(committed.error);
		}
		const body: Omit<AgentBudgetSettlementReceiptRef, "receiptDigest"> = {
			receiptId: createRuntimeId(
				"receipt",
				`agent-budget-settlement-${canonicalDigest({ reservationId: request.reservation.reservationId, requestDigest: request.requestDigest }).slice(0, 40)}`,
			),
			reservationId: request.reservation.reservationId,
			outcome: request.outcome,
			usageDigest: canonicalDigest(request.usage ?? null),
			partialResultsDigest: canonicalDigest(request.partialResults),
			requestDigest: request.requestDigest,
			settledAt: request.settledAt,
		};
		return { ok: true, value: { ...body, receiptDigest: canonicalDigest(body) } };
	}
}

function workspaceReceiptMatches(
	receipt: AgentWorkspaceReceiptRef,
	expected: {
		sessionId: AgentWorkspaceReceiptRef["sessionId"];
		strategy: AgentWorkspaceReceiptRef["strategy"];
	},
): boolean {
	const { receiptDigest, ...body } = receipt;
	return (
		isRuntimeId(receipt.receiptId, "receipt") &&
		isRuntimeId(receipt.workspaceId, "workspace") &&
		isRuntimeId(receipt.repositoryId, "repository") &&
		receipt.sessionId === expected.sessionId &&
		receipt.strategy.strategyId === expected.strategy.strategyId &&
		receipt.strategy.kind === expected.strategy.kind &&
		receipt.strategy.strategyDigest === expected.strategy.strategyDigest &&
		(receipt.status === "active" || receipt.status === "readonly") &&
		Number.isSafeInteger(receipt.bindingRevision) &&
		receipt.bindingRevision >= 0 &&
		DIGEST_PATTERN.test(receipt.bindingDigest) &&
		DIGEST_PATTERN.test(receiptDigest) &&
		receiptDigest === canonicalDigest(body) &&
		(receipt.strategy.kind !== "isolated_lease" ||
			(Boolean(receipt.leaseId) && Number.isSafeInteger(receipt.leaseRevision) && (receipt.leaseRevision ?? -1) >= 0))
	);
}

function denialReceiptMatches(receipt: AgentDenialReceiptRef, node: AgentNode): boolean {
	return (
		isRuntimeId(receipt.receiptId, "receipt") &&
		receipt.agentId === node.agentId &&
		receipt.sessionId === node.sessionId &&
		receipt.status === "allowed" &&
		Number.isSafeInteger(receipt.decisionRevision) &&
		receipt.decisionRevision >= 0 &&
		DIGEST_PATTERN.test(receipt.receiptDigest)
	);
}

function launchReceiptsMatch(
	node: AgentNode,
	result: AgentLaunchResult,
): boolean {
	if (result.status !== "started") return false;
	const { receiptDigest, ...launchBody } = result.launchReceipt;
	const launchedAt = Date.parse(result.launchReceipt.launchedAt);
	return (
		result.launchReceipt.agentId === node.agentId &&
		result.launchReceipt.sessionId === node.sessionId &&
		isRuntimeId(result.launchReceipt.receiptId, "receipt") &&
		Number.isSafeInteger(result.launchReceipt.launchRevision) &&
		result.launchReceipt.launchRevision >= 1 &&
		Number.isFinite(launchedAt) &&
		DIGEST_PATTERN.test(receiptDigest) &&
		receiptDigest === canonicalDigest(launchBody) &&
		result.residencyReceipt.state === "resident" &&
		result.residencyReceipt.revision === result.launchReceipt.launchRevision &&
		Date.parse(result.residencyReceipt.observedAt) >= launchedAt &&
		validateAgentResidencyReceipt(result.residencyReceipt, node).ok
	);
}

function rootArtifactContract() {
	const body = { expected: [], allowPartial: false } as const;
	return { ...body, contractDigest: canonicalDigest(body) };
}

function rootBudget() {
	return {
		maxTurns: 0,
		maxInputTokens: 0,
		maxOutputTokens: 0,
		maxUsdMicros: 0,
		maxWallTimeMs: 0,
		maxToolCalls: 0,
		maxNetworkBytes: 0,
		maxStorageBytes: 0,
	};
}

function completionArtifactsSatisfied(node: AgentNode): boolean {
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

function graphFailure(
	error: AgentError,
	options: { outcomeCertain?: boolean; effect?: AgentGraphFailureRef["effect"] } = {},
): AgentGraphFailureRef {
	return {
		code: error.code,
		messageDigest: canonicalDigest({ code: error.code, message: error.message }),
		retryable: error.retryable,
		outcomeCertain: options.outcomeCertain ?? !error.retryable,
		effect: options.effect ?? (error.retryable ? "uncertain" : "none"),
	};
}

function residencyReceiptsAreExact(
	left: AgentResidencyReceiptRef,
	right: AgentResidencyReceiptRef | undefined,
): boolean {
	if (!right) return false;
	try {
		return canonicalDigest(left) === canonicalDigest(right);
	} catch {
		return false;
	}
}

function interruptionResidencyMatches(
	projection: AgentGraphProjection,
	node: AgentNode,
	receipt: AgentResidencyReceiptRef,
): boolean {
	if (residencyReceiptsAreExact(receipt, node.residency)) return true;
	const cleanup = projection.cleanups.get(node.agentId);
	const runtimeRelease = cleanup?.kind === "started" ? cleanup.runtimeRelease : undefined;
	if (!runtimeRelease || !node.launchReceipt || !node.terminal) return false;
	const expected = agentRuntimeReleaseRequestDigest({
		requestId: runtimeRelease.receipt.requestId,
		agentId: node.agentId,
		sessionId: node.sessionId,
		launchReceipt: node.launchReceipt,
		previousResidencyReceipt: receipt,
		reason: node.terminal.outcome,
	});
	return expected === runtimeRelease.requestDigest;
}

function cleanupKindForNode(node: AgentNode): AgentCleanupKind | undefined {
	if (!node.parentAgentId || !node.terminal || !node.budgetReservation) return undefined;
	if (
		node.stateReason === "launch_rejected" &&
		node.terminal.reason === "launch_rejected" &&
		!node.launchReceipt &&
		!node.residency
	) {
		return "not_started";
	}
	if (
		node.stateReason !== "launch_rejected" &&
		node.terminal.reason !== "launch_rejected" &&
		node.launchReceipt &&
		node.residency
	) {
		return "started";
	}
	return undefined;
}

function cleanupRequestId(node: AgentNode) {
	if (!node.terminal) throw new TypeError("cleanup identity requires a semantic terminal");
	return createRuntimeId(
		"command",
		`agent-cleanup-${canonicalDigest({ agentId: node.agentId, terminalDigest: node.terminal.terminalDigest }).slice(0, 40)}`,
	);
}

function cleanupIdempotencyKey(node: AgentNode, purpose: string) {
	if (!node.terminal) throw new TypeError("cleanup identity requires a semantic terminal");
	return createIdempotencyKey(
		`agent-cleanup-${purpose}-${canonicalDigest({ agentId: node.agentId, terminalDigest: node.terminal.terminalDigest }).slice(0, 40)}`,
	);
}

function cleanupStageRequestId(node: AgentNode, stage: AgentCleanupStage | "completed") {
	if (!node.terminal) throw new TypeError("cleanup stage identity requires a semantic terminal");
	return createRuntimeId(
		"command",
		`agent-cleanup-${stage}-${canonicalDigest({ agentId: node.agentId, terminalDigest: node.terminal.terminalDigest }).slice(0, 32)}`,
	);
}

function latestTimestamp(values: readonly string[]): string {
	return values.reduce((latest, value) => Date.parse(value) > Date.parse(latest) ? value : latest);
}

interface ActiveCleanupOperation {
	requestDigest: string;
	promise: Promise<AgentResult<AgentGraphProjection>>;
}

export class AgentSupervisor {
	private readonly rootAgentId: AgentSupervisorOptions["rootAgentId"];
	readonly #ports: AgentSupervisorOptions["ports"];
	private readonly limitsResult: AgentResult<AgentGraphLimits>;
	private readonly clock: () => Date;
	private readonly cleanupOperations = new Map<AgentNode["agentId"], ActiveCleanupOperation>();

	public constructor(options: AgentSupervisorOptions) {
		this.rootAgentId = options.rootAgentId;
		this.#ports = options.ports;
		this.limitsResult = normalizeAgentGraphLimits(options.limits);
		this.clock = options.clock ?? (() => new Date());
	}

	private async load(): Promise<AgentResult<AgentGraphProjection>> {
		if (!this.limitsResult.ok) return this.limitsResult;
		try {
			const loaded = await this.#ports.graphStore.load(this.rootAgentId);
			if (!loaded.ok) return loaded;
			return { ok: true, value: loaded.value.projection };
		} catch {
			return fail("store_unavailable", "agent graph store is unavailable", true);
		}
	}

	private async commit(command: AgentGraphSemanticCommand): Promise<AgentResult<AgentGraphProjection>> {
		if (!this.limitsResult.ok) return this.limitsResult;
		for (let attempt = 0; attempt < MAX_GRAPH_CAS_ATTEMPTS; attempt += 1) {
			let loaded;
			try {
				loaded = await this.#ports.graphStore.load(this.rootAgentId);
			} catch {
				return fail("store_unavailable", "agent graph store is unavailable", true);
			}
			if (!loaded.ok) return loaded;
			let committed;
			try {
				committed = await this.#ports.graphStore.commit(
					this.rootAgentId,
					loaded.value.revision,
					command,
				);
			} catch {
				return fail("store_unavailable", "agent graph store commit failed", true);
			}
			if (!committed.ok) return committed;
			if (committed.value.status === "conflict") continue;
			return { ok: true, value: committed.value.head.projection };
		}
		return fail("revision_conflict", "agent graph CAS did not converge", true);
	}

	private async commitSequence(
		commands: readonly AgentGraphSemanticCommand[],
	): Promise<AgentResult<AgentGraphProjection>> {
		let projection: AgentResult<AgentGraphProjection> | undefined;
		for (const command of commands) {
			projection = await this.commit(command);
			if (!projection.ok) return projection;
		}
		return projection ?? this.load();
	}

	public graph(): Promise<AgentResult<AgentGraphProjection>> {
		return this.load();
	}

	public async registerRoot(request: RegisterRootAgentRequest): Promise<AgentResult<AgentGraphProjection>> {
		if (
			request.agentId !== this.rootAgentId ||
			!isRuntimeId(request.requestId, "command") ||
			!isRuntimeId(request.agentId, "agent") ||
			!isRuntimeId(request.sessionId, "session") ||
			!isRuntimeId(request.goalId, "goal") ||
			!isParentCapabilityGrantRef(request.capabilityGrant, this.clock()) ||
			!inputLineageIsValid(request.inputSources, request.declassificationReceipts) ||
			!workspaceReceiptMatches(request.workspaceReceipt, {
				sessionId: request.sessionId,
				strategy: request.workspaceReceipt.strategy,
			})
		) {
			return fail("invalid_request", "root agent registration is invalid");
		}
		const existing = await this.load();
		if (!existing.ok) return existing;
		if (existing.value.rootAgentId) {
			const root = existing.value.nodes.get(existing.value.rootAgentId);
			if (root &&
				root.agentId === request.agentId &&
				root.sessionId === request.sessionId &&
				root.goalId === request.goalId &&
				root.role === request.role &&
				canonicalDigest(root.workspaceReceipt) === canonicalDigest(request.workspaceReceipt) &&
				root.capabilityGrant !== undefined &&
				canonicalDigest(root.capabilityGrant) === canonicalDigest(request.capabilityGrant) &&
				canonicalDigest(root.inputSources) === canonicalDigest(request.inputSources) &&
				canonicalDigest(root.declassificationReceipts) === canonicalDigest(request.declassificationReceipts)
			) return existing;
			if (
				!root ||
				root.agentId !== request.agentId ||
				root.state !== "running" ||
				root.sessionId !== request.sessionId ||
				root.goalId !== request.goalId ||
				root.role !== request.role ||
				root.workspaceReceipt.workspaceId !== request.workspaceReceipt.workspaceId ||
				root.workspaceReceipt.repositoryId !== request.workspaceReceipt.repositoryId ||
				root.workspaceReceipt.strategy.strategyId !== request.workspaceReceipt.strategy.strategyId ||
				root.workspaceReceipt.strategy.kind !== request.workspaceReceipt.strategy.kind ||
				root.workspaceReceipt.strategy.strategyDigest !== request.workspaceReceipt.strategy.strategyDigest ||
				root.workspaceReceipt.leaseId !== request.workspaceReceipt.leaseId ||
				root.workspaceReceipt.status !== request.workspaceReceipt.status ||
				request.workspaceReceipt.bindingRevision <= root.workspaceReceipt.bindingRevision ||
				(request.workspaceReceipt.leaseRevision ?? -1) <= (root.workspaceReceipt.leaseRevision ?? -1) ||
				root.capabilityGrant?.receiptId !== request.capabilityGrant.receiptId ||
				root.capabilityGrant.receiptDigest !== request.capabilityGrant.receiptDigest ||
				root.capabilityGrant.decisionRevision !== request.capabilityGrant.decisionRevision ||
				root.capabilityGrant.expiresAt !== request.capabilityGrant.expiresAt ||
				canonicalDigest(root.inputSources) !== canonicalDigest(request.inputSources) ||
				canonicalDigest(root.declassificationReceipts) !== canonicalDigest(request.declassificationReceipts)
			) return fail("agent_exists", "agent graph root registration conflicts with durable state");
			return this.commit({
				type: "agent.root_revalidated",
				requestId: request.requestId,
				idempotencyKey: request.idempotencyKey,
				occurredAt: request.registeredAt ?? this.clock().toISOString(),
				agentId: root.agentId,
				workspaceReceipt: { ...request.workspaceReceipt },
				capabilityGrant: { ...request.capabilityGrant },
			});
		}
		const timestamp = request.registeredAt ?? this.clock().toISOString();
		const node: AgentNode = {
			agentId: request.agentId,
			rootAgentId: request.agentId,
			sessionId: request.sessionId,
			goalId: request.goalId,
			role: request.role,
			objectiveDigest: canonicalDigest("root"),
			depth: 0,
			state: "running",
			capabilityGrant: { ...request.capabilityGrant },
			requestedCapabilities: [],
			workspaceReceipt: { ...request.workspaceReceipt },
			budget: rootBudget(),
			turnsUsed: 0,
			turnIds: [],
			artifactContract: rootArtifactContract(),
			artifacts: [],
			inputSources: request.inputSources.map((source) => ({ ...source, taintLabels: [...source.taintLabels] })),
			declassificationReceipts: request.declassificationReceipts.map((receipt) => ({ ...receipt })),
			createdAt: timestamp,
			updatedAt: timestamp,
		};
			return this.commit({
				type: "agent.root_registered",
				requestId: request.requestId,
				idempotencyKey: request.idempotencyKey,
				occurredAt: timestamp,
				node,
			});
		}

	private preflightSpawn(graph: AgentGraphProjection, request: SpawnAgentRequest): AgentResult<AgentNode> {
		if (!graph.rootAgentId) return fail("graph_not_initialized", "root agent must be registered before spawn");
		const parent = graph.nodes.get(request.parentAgentId);
		if (!parent) return fail("agent_not_found", "spawn parent does not exist");
		if (parent.state !== "running") return fail("spawn_denied", "only a running parent may spawn");
		if (
			!inputLineagePreserves(
				parent.inputSources,
				parent.declassificationReceipts,
				request.inputSources,
				request.declassificationReceipts,
			)
		) {
			return fail("spawn_denied", "child input lineage would drop parent taint or declassification receipts");
		}
		if (!childMaySpawn(parent, this.clock())) return fail("spawn_denied", "child delegation does not permit nested spawn");
		if (request.depth !== parent.depth + 1) return fail("invalid_request", "spawn depth must equal parent depth plus one");
		if (!this.limitsResult.ok) return this.limitsResult;
		if (request.depth > this.limitsResult.value.maxDepth) return fail("depth_limit", "spawn exceeds maxDepth");
		if (graph.edges.filter((edge) => edge.parentAgentId === parent.agentId).length >= this.limitsResult.value.maxChildrenPerAgent) {
			return fail("children_limit", "spawn exceeds maxChildrenPerAgent");
		}
		if (graph.nodes.size >= this.limitsResult.value.maxTotalAgents) return fail("total_limit", "spawn exceeds maxTotalAgents");
		if (
			!parent.capabilityGrant ||
			request.parentGrant.receiptId !== parent.capabilityGrant.receiptId ||
			request.parentGrant.receiptDigest !== parent.capabilityGrant.receiptDigest ||
			request.parentGrant.decisionRevision !== parent.capabilityGrant.decisionRevision
		) {
			return fail("delegation_invalid", "spawn parent grant does not match durable parent state");
		}
		if ([...graph.nodes.values()].some((node) => node.sessionId === request.childSessionId)) {
			return fail("session_exists", "spawn childSessionId is already used");
		}
		return { ok: true, value: parent };
	}

	private async allocateWorkspace(
		parent: AgentNode,
		request: SpawnAgentRequest,
		signal?: AbortSignal,
	): Promise<AgentResult<AgentWorkspaceReceiptRef>> {
		if (request.role === "build" && request.workspaceStrategy.kind === "readonly_checkout") {
			return fail("workspace_invalid", "builder child requires an isolated writable workspace strategy");
		}
		const body = {
			requestId: request.requestId,
			parentAgentId: parent.agentId,
			parentSessionId: parent.sessionId,
			parentWorkspaceId: parent.workspaceReceipt.workspaceId,
			childAgentId: request.childAgentId,
			childSessionId: request.childSessionId,
			role: request.role,
			strategy: request.workspaceStrategy,
		};
		try {
			const allocated = await this.#ports.workspace.allocate(
				{ ...body, requestDigest: canonicalDigest(body) },
				signal,
			);
			if (!allocated.ok) return allocated;
			if (
				!workspaceReceiptMatches(allocated.value, {
					sessionId: request.childSessionId,
					strategy: request.workspaceStrategy,
				}) ||
				allocated.value.repositoryId !== parent.workspaceReceipt.repositoryId
			) {
				return fail("workspace_invalid", "Workspace adapter returned an invalid workspace receipt");
			}
			return allocated;
		} catch {
			return fail("reference_unavailable", "Workspace adapter is unavailable", true);
		}
	}

	private async releaseWorkspace(node: AgentNode, reason: "spawn_aborted" | "completed" | "failed" | "stopped"): Promise<void> {
		const requestId = createRuntimeIdForCompensation(node.agentId, reason);
		const body = {
			requestId,
			agentId: node.agentId,
			sessionId: node.sessionId,
			previousReceipt: node.workspaceReceipt,
			reason,
		};
		try {
			await this.#ports.workspace.release({ ...body, requestDigest: canonicalDigest(body) });
		} catch {
			// 外部清理失败由 Workspace 专项 reconciliation；Runtime 不伪造 released receipt。
		}
	}

	private async settleNotStarted(node: AgentNode, baseKey: string): Promise<void> {
		if (!node.budgetReservation) return;
		await this.#ports.budget.settle(budgetSettlementRequest({
			idempotencyKey: derivedKey(baseKey, "budget-abort"),
			reservation: node.budgetReservation,
			outcome: "not_started",
			partialResults: [],
			settledAt: this.clock().toISOString(),
		}));
	}

	private async continueLaunch(
		node: AgentNode,
		request: SpawnAgentRequest,
		signal?: AbortSignal,
	): Promise<AgentResult<AgentSpawnOutcome>> {
		if (!node.parentAgentId || !node.delegationReceipt || !node.budgetReservation) {
			return fail("invalid_graph", "pending child lacks launch receipts");
		}
		if (node.launchReceipt && node.residency) {
			const resumed = await this.commitSequence([
				{
					type: "agent.launch_recorded",
					requestId: request.requestId,
					idempotencyKey: derivedKey(request.idempotencyKey, "launch-recorded"),
					occurredAt: node.launchReceipt.launchedAt,
					agentId: node.agentId,
					launchReceipt: node.launchReceipt,
					residencyReceipt: node.residency,
				},
				{
					type: "agent.transitioned",
					requestId: request.requestId,
					idempotencyKey: derivedKey(request.idempotencyKey, "launch-transitioned"),
					occurredAt: node.launchReceipt.launchedAt,
					agentId: node.agentId,
					from: node.state,
					to: "running",
				},
			]);
			if (!resumed.ok) return resumed;
			const current = resumed.value.nodes.get(node.agentId);
			return current
				? { ok: true, value: { graph: resumed.value, node: current } }
				: fail("invalid_graph", "launched child vanished from graph");
		}
		const launchBody = {
			requestId: request.requestId,
			agentId: node.agentId,
			sessionId: node.sessionId,
			parentAgentId: node.parentAgentId,
			role: node.role,
			objective: request.objective,
			delegationReceipt: node.delegationReceipt,
			workspaceReceipt: node.workspaceReceipt,
			budgetReservation: node.budgetReservation,
			artifactContract: node.artifactContract,
			inputSources: node.inputSources,
			declassificationReceipts: node.declassificationReceipts,
		};
		let launched: AgentResult<AgentLaunchResult>;
		try {
			launched = await this.#ports.launcher.launch(
				{ ...launchBody, requestDigest: canonicalDigest(launchBody) },
				signal,
			);
			} catch {
				launched = fail<AgentLaunchResult>("launch_failed", "agent launcher is unavailable", true);
			}
			if (!launched.ok) {
				return launched.error.retryable
					? launched
					: this.rejectPendingLaunch(node, request, launched.error);
			}
			if (launched.value.status !== "started") {
				const error: AgentError = {
					code: "launch_failed",
					message: "agent launcher rejected admission",
					retryable: launched.value.retryable,
				};
				return error.retryable
					? { ok: false, error }
					: this.rejectPendingLaunch(node, request, error);
			}
			if (!launchReceiptsMatch(node, launched.value)) {
				return {
					ok: false,
					error: {
					code: "launch_failed",
						message:
							"agent launcher returned uncorrelated launch receipts; runtime outcome requires reconciliation",
						retryable: true,
					},
				};
			}
		const timestamp = this.clock().toISOString();
		const graph = await this.commitSequence([
			{
				type: "agent.launch_recorded",
				requestId: request.requestId,
				idempotencyKey: derivedKey(request.idempotencyKey, "launch-recorded"),
				occurredAt: timestamp,
				agentId: node.agentId,
				launchReceipt: launched.value.launchReceipt,
				residencyReceipt: launched.value.residencyReceipt,
			},
			{
				type: "agent.transitioned",
				requestId: request.requestId,
				idempotencyKey: derivedKey(request.idempotencyKey, "launch-transitioned"),
				occurredAt: timestamp,
				agentId: node.agentId,
				from: node.state,
				to: "running",
			},
		]);
		if (!graph.ok) return graph;
		const updated = graph.value.nodes.get(node.agentId);
		return updated ? { ok: true, value: { graph: graph.value, node: updated } } : fail("invalid_graph", "launched child vanished from graph");
	}

	private async rejectPendingLaunch(
		node: AgentNode,
		request: SpawnAgentRequest,
		error: AgentError,
	): Promise<AgentResult<AgentSpawnOutcome>> {
		const timestamp = this.clock().toISOString();
		const launchFailedKey = derivedKey(request.idempotencyKey, "launch-failed");
		const terminal = createAgentSemanticTerminalRecord({
			agentId: node.agentId,
			requestId: request.requestId,
			idempotencyKey: launchFailedKey,
			outcome: "failed",
			reason: "launch_rejected",
			partialResults: node.artifacts.map((report) => report.artifact),
		});
		const failedGraph = await this.commit({
				type: "agent.failed",
				requestId: request.requestId,
				idempotencyKey: launchFailedKey,
			occurredAt: timestamp,
			agentId: node.agentId,
			from: node.state,
			reason: "launch_rejected",
			error: graphFailure(error),
			terminal,
		});
		if (!failedGraph.ok) return failedGraph;
		const failedNode = failedGraph.value.nodes.get(node.agentId);
		if (!failedNode) return fail("invalid_graph", "launch-rejected child vanished after semantic terminal");
		const requested = await this.ensureCleanupRequested(failedGraph.value, failedNode);
		if (!requested.ok) return requested;
		const cleaned = await this.continueCleanup(requested.value, failedNode.agentId);
		return cleaned.ok ? { ok: false, error } : cleaned;
	}

	private async failSpawnIntent<T>(
		request: SpawnAgentRequest,
		error: AgentError,
		options: { outcomeCertain?: boolean; effect?: AgentGraphFailureRef["effect"] } = {},
	): Promise<AgentResult<T>> {
		const recorded = await this.commit({
			type: "agent.spawn_failed",
			requestId: request.requestId,
			idempotencyKey: derivedKey(request.idempotencyKey, "spawn-failed"),
			occurredAt: this.clock().toISOString(),
			intentRequestId: request.requestId,
			agentId: request.childAgentId,
			error: graphFailure(error, options),
		});
		return recorded.ok ? { ok: false, error } : recorded;
	}

	public async spawn(request: SpawnAgentRequest, signal?: AbortSignal): Promise<AgentResult<AgentSpawnOutcome>> {
		const validated = validateSpawnAgentRequest(request, this.clock());
		if (!validated.ok) return validated;
		const contract = createAgentArtifactContract(request.expectedArtifacts, request.allowPartial);
		if (!contract.ok) return contract;
		const admissionDigest = spawnAgentRequestDigest(request);
		const graph = await this.load();
		if (!graph.ok) return graph;
		const existing = graph.value.nodes.get(request.childAgentId);
		if (existing) {
			if (existing.admissionRequestDigest !== admissionDigest) {
				return fail("agent_exists", "childAgentId belongs to another spawn request");
			}
			if (existing.state === "pending") return this.continueLaunch(existing, request, signal);
			return { ok: true, value: { graph: graph.value, node: existing } };
		}
		const pending = graph.value.pendingSpawns.get(request.childAgentId);
		if (pending && pending.admissionRequestDigest !== admissionDigest) {
			return fail("agent_exists", "childAgentId belongs to another durable spawn intent");
		}
		const parentResult = this.preflightSpawn(graph.value, request);
		if (!parentResult.ok) return parentResult;
		const parent = parentResult.value;
		if (!pending) {
			const intentAt = this.clock().toISOString();
			const intent = await this.commit({
				type: "agent.spawn_requested",
				requestId: request.requestId,
				idempotencyKey: request.idempotencyKey,
				occurredAt: intentAt,
				intent: {
					requestId: request.requestId,
					admissionRequestDigest: admissionDigest,
					parentAgentId: request.parentAgentId,
					childAgentId: request.childAgentId,
					childSessionId: request.childSessionId,
					role: request.role,
					objectiveDigest: canonicalDigest(request.objective),
					expectedArtifacts: [...request.expectedArtifacts],
					allowPartial: request.allowPartial,
					depth: request.depth,
					budget: { ...request.budget },
					parentGrant: { ...request.parentGrant },
					requestedCapabilities: [...request.requestedCapabilities],
					workspaceStrategy: { ...request.workspaceStrategy },
					inputSources: request.inputSources.map((source) => ({ ...source, taintLabels: [...source.taintLabels] })),
					declassificationReceipts: request.declassificationReceipts.map((receipt) => ({ ...receipt })),
					requestedAt: intentAt,
				},
			});
			if (!intent.ok) return intent;
		}
		const delegation = await evaluateSpawnDelegation(request, this.#ports.capabilitySubset, signal, this.clock());
		if (!delegation.ok) return this.failSpawnIntent(request, delegation.error);
		const workspace = await this.allocateWorkspace(parent, request, signal);
		if (!workspace.ok) return this.failSpawnIntent(request, workspace.error);
		if ([...graph.value.nodes.values()].some((node) => node.workspaceReceipt.workspaceId === workspace.value.workspaceId)) {
			const temporaryNode = this.temporaryNodeForRelease(
				parent,
				request,
				delegation.value,
				workspace.value,
				admissionDigest,
			);
			await this.releaseWorkspace(temporaryNode, "spawn_aborted");
			return this.failSpawnIntent(
				request,
				{ code: "workspace_shared", message: "Workspace adapter reused an existing graph workspace identity", retryable: false },
				{ outcomeCertain: false, effect: "uncertain" },
			);
		}
		const budgetDigest = budgetRequestDigest(request.childAgentId, request.budget);
		const budget = await this.#ports.budget.reserve({
			requestId: request.requestId,
			idempotencyKey: derivedKey(request.idempotencyKey, "budget-reserve"),
			agentId: request.childAgentId,
			budget: request.budget,
			requestDigest: budgetDigest,
		});
		if (!budget.ok) {
			const temporaryNode = this.temporaryNodeForRelease(parent, request, delegation.value, workspace.value, admissionDigest);
			await this.releaseWorkspace(temporaryNode, "spawn_aborted");
			return this.failSpawnIntent(request, budget.error, { outcomeCertain: false, effect: "uncertain" });
		}
		const timestamp = this.clock().toISOString();
		const node: AgentNode = {
			agentId: request.childAgentId,
			rootAgentId: parent.rootAgentId,
			parentAgentId: parent.agentId,
			sessionId: request.childSessionId,
			goalId: parent.goalId,
			role: request.role,
			objectiveDigest: canonicalDigest(request.objective),
			admissionRequestDigest: admissionDigest,
			depth: request.depth,
			state: "pending",
			capabilityGrant: {
				receiptId: delegation.value.receiptId,
				receiptDigest: delegation.value.receiptDigest,
				decisionRevision: delegation.value.decisionRevision,
				...(delegation.value.expiresAt ? { expiresAt: delegation.value.expiresAt } : {}),
			},
			requestedCapabilities: [...request.requestedCapabilities],
			delegationReceipt: { ...delegation.value },
			workspaceReceipt: { ...workspace.value },
			budget: { ...request.budget },
			budgetReservation: { ...budget.value },
			turnsUsed: 0,
			turnIds: [],
			artifactContract: contract.value,
			artifacts: [],
			inputSources: request.inputSources.map((source) => ({ ...source, taintLabels: [...source.taintLabels] })),
			declassificationReceipts: request.declassificationReceipts.map((receipt) => ({ ...receipt })),
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		const admitted = await this.commit({
			type: "agent.spawned",
			requestId: request.requestId,
			idempotencyKey: derivedKey(request.idempotencyKey, "admission"),
			occurredAt: timestamp,
			intentRequestId: request.requestId,
			node,
			edge: { parentAgentId: parent.agentId, childAgentId: node.agentId, createdAt: timestamp },
		});
		if (!admitted.ok) {
			await this.settleNotStarted(node, request.idempotencyKey);
			await this.releaseWorkspace(node, "spawn_aborted");
			return admitted;
		}
		const admittedNode = admitted.value.nodes.get(node.agentId);
		return admittedNode
			? this.continueLaunch(admittedNode, request, signal)
			: fail("invalid_graph", "admitted child vanished from graph");
	}

	private temporaryNodeForRelease(
		parent: AgentNode,
		request: SpawnAgentRequest,
		delegation: AgentNode["delegationReceipt"] & {},
		workspace: AgentWorkspaceReceiptRef,
		admissionDigest: string,
	): AgentNode {
		const timestamp = this.clock().toISOString();
		return {
			agentId: request.childAgentId,
			rootAgentId: parent.rootAgentId,
			parentAgentId: parent.agentId,
			sessionId: request.childSessionId,
			goalId: parent.goalId,
			role: request.role,
			objectiveDigest: canonicalDigest(request.objective),
			admissionRequestDigest: admissionDigest,
			depth: request.depth,
			state: "pending",
			requestedCapabilities: [...request.requestedCapabilities],
			delegationReceipt: delegation,
			workspaceReceipt: workspace,
			budget: request.budget,
			turnsUsed: 0,
			turnIds: [],
			artifactContract: {
				expected: [...request.expectedArtifacts],
				allowPartial: request.allowPartial,
				contractDigest: canonicalDigest({ expected: request.expectedArtifacts, allowPartial: request.allowPartial }),
			},
			artifacts: [],
			inputSources: request.inputSources.map((source) => ({ ...source, taintLabels: [...source.taintLabels] })),
			declassificationReceipts: request.declassificationReceipts.map((receipt) => ({ ...receipt })),
			createdAt: timestamp,
			updatedAt: timestamp,
		};
	}

	public async advanceCursor(request: AgentCursorAdvanceRequest): Promise<AgentResult<AgentGraphProjection>> {
		const graph = await this.load();
		if (!graph.ok) return graph;
		if (!graph.value.nodes.has(request.agentId)) return fail("agent_not_found", "cursor agent does not exist");
		return this.commit({
			type: "agent.cursor_advanced",
			requestId: request.requestId,
			idempotencyKey: request.idempotencyKey,
			occurredAt: this.clock().toISOString(),
			agentId: request.agentId,
			cursor: request.cursor,
		});
	}

	public async recordTurn(request: AgentTurnRecordRequest): Promise<AgentResult<AgentGraphProjection>> {
		const graph = await this.load();
		if (!graph.ok) return graph;
		const node = graph.value.nodes.get(request.agentId);
		if (!node) return fail("agent_not_found", "turn agent does not exist");
		return this.commit({
			type: "agent.turn_recorded",
			requestId: request.requestId,
			idempotencyKey: request.idempotencyKey,
			occurredAt: this.clock().toISOString(),
			agentId: node.agentId,
			turnId: request.turnId,
			turnNumber: node.turnsUsed + 1,
		});
	}

	public async reportArtifact(request: AgentArtifactReportRequest): Promise<AgentResult<AgentGraphProjection>> {
		const graph = await this.load();
		if (!graph.ok) return graph;
		const node = graph.value.nodes.get(request.report.agentId);
		if (!node) return fail("agent_not_found", "artifact agent does not exist");
		if (isAgentTerminal(node)) return fail("invalid_transition", "terminal agent cannot report new artifacts");
		return this.commit({
			type: "agent.artifact_reported",
			requestId: request.requestId,
			idempotencyKey: request.idempotencyKey,
			occurredAt: request.report.reportedAt,
			report: request.report,
		});
	}

	public async interrupt(
		agentId: AgentNode["agentId"],
		cause: Parameters<typeof createAgentInterruptionCommands>[1],
		residencyReceipt: AgentResidencyReceiptRef,
		idempotencyKey: AgentGraphTransactionKey,
		usage?: AgentBudgetUsage,
	): Promise<AgentResult<AgentGraphProjection>> {
		const graph = await this.load();
		if (!graph.ok) return graph;
		const node = graph.value.nodes.get(agentId);
		if (!node) return fail("agent_not_found", "interrupted agent does not exist");
		if (node.budgetReservation && !usage) {
			return fail("invalid_request", "interrupted child requires exact budget usage before state mutation");
		}
		const interruptionRequestId = createRuntimeIdForCompensation(
			node.agentId,
			`interrupt-${cause}-${idempotencyKey}`,
		);
		if (isAgentTerminal(node)) {
			const expectedState = stateForAgentInterruption(node, cause);
			if (expectedState !== "stopped" && expectedState !== "failed") {
				return fail("invalid_transition", "terminal interruption retry conflicts with durable state");
			}
			const expectedTerminal = createAgentSemanticTerminalRecord({
				agentId: node.agentId,
				requestId: interruptionRequestId,
				idempotencyKey: createIdempotencyKey(
					`agent-interruption-${canonicalDigest(idempotencyKey).slice(0, 48)}`,
				),
				outcome: expectedState,
				reason: cause,
				...(usage ? { usage } : {}),
				partialResults: node.artifacts.map((report) => report.artifact),
			});
			if (
				node.state !== expectedState ||
				node.terminal?.terminalDigest !== expectedTerminal.terminalDigest ||
				!interruptionResidencyMatches(graph.value, node, residencyReceipt)
			) {
				return fail("invalid_transition", "terminal interruption retry conflicts with durable state");
			}
			if (!node.parentAgentId) return graph;
			const requested = await this.ensureCleanupRequested(graph.value, node);
			return requested.ok ? this.continueCleanup(requested.value, node.agentId) : requested;
		}
		const commands = createAgentInterruptionCommands(node, cause, residencyReceipt, {
			requestId: interruptionRequestId,
			idempotencyKey,
			occurredAt: this.clock().toISOString(),
			...(usage ? { usage } : {}),
		});
		if (!commands.ok) return commands;
		const committed = await this.commitSequence(commands.value);
		if (!committed.ok) return committed;
		const current = committed.value.nodes.get(node.agentId);
		if (!current) return fail("invalid_graph", "interrupted Agent vanished from durable graph");
		if (isAgentTerminal(current)) {
			const requested = await this.ensureCleanupRequested(committed.value, current);
			return requested.ok ? this.continueCleanup(requested.value, current.agentId) : requested;
		}
		if (node.budgetReservation) {
			const settled = await this.#ports.budget.settle(budgetSettlementRequest({
				idempotencyKey: derivedKey(idempotencyKey, "interrupt-budget"),
				reservation: node.budgetReservation,
				outcome: cause === "cancelled" ? "stopped" : "failed",
				...(usage ? { usage } : {}),
				partialResults: node.artifacts.map((report) => report.artifact),
				settledAt: this.clock().toISOString(),
			}));
			if (!settled.ok) return settled;
		}
		return committed;
	}

	public async cancel(
		request: AgentResumeRequest,
		reasonEvidenceDigest: string,
		usage?: AgentBudgetUsage,
		signal?: AbortSignal,
	): Promise<AgentResult<AgentGraphProjection>> {
		if (!DIGEST_PATTERN.test(reasonEvidenceDigest)) return fail("invalid_request", "cancel reason digest is invalid");
		return this.finish(
			{
				requestId: request.requestId,
				idempotencyKey: request.idempotencyKey,
				agentId: request.agentId,
				outcome: "stopped",
				reason: "cancelled",
				reasonEvidenceDigest,
				...(usage ? { usage } : {}),
			},
			signal,
		);
	}

	public async resume(request: AgentResumeRequest, signal?: AbortSignal): Promise<AgentResult<AgentResumeOutcome>> {
		const graph = await this.load();
		if (!graph.ok) return graph;
		const node = graph.value.nodes.get(request.agentId);
		if (!node || !node.parentAgentId || !node.budgetReservation) return fail("agent_not_found", "resumable child does not exist");
		if (node.state !== "paused" && node.state !== "partial") return fail("invalid_transition", "only paused or partial child may resume");
		const parent = graph.value.nodes.get(node.parentAgentId);
		if (!parent) return fail("orphan_agent", "resumable child parent is missing");
		if (parent.state !== "running") return fail("resume_denied", "child cannot resume under a non-running parent");
		const delegation = await revalidateDelegation(node, parent, request.requestId, this.#ports.capabilitySubset, signal, this.clock());
		if (!delegation.ok) return delegation;
		let denial;
		try {
			denial = await this.#ports.deniedAgents.check(node.agentId, node.sessionId, signal);
		} catch {
			return fail("reference_unavailable", "denied-agent evaluator is unavailable", true);
		}
		if (!denial.ok) return denial;
		if (!denialReceiptMatches(denial.value, node)) return fail("resume_denied", "agent is denied or denial receipt is invalid");
		const workspaceBody = {
			requestId: request.requestId,
			agentId: node.agentId,
			sessionId: node.sessionId,
			previousReceipt: node.workspaceReceipt,
		};
		let workspace;
		try {
			workspace = await this.#ports.workspace.validate(
				{ ...workspaceBody, requestDigest: canonicalDigest(workspaceBody) },
				signal,
			);
		} catch {
			return fail("reference_unavailable", "Workspace adapter is unavailable during resume", true);
		}
		if (!workspace.ok) return workspace;
		if (
			!workspaceReceiptMatches(workspace.value, { sessionId: node.sessionId, strategy: node.workspaceReceipt.strategy }) ||
			workspace.value.workspaceId !== node.workspaceReceipt.workspaceId ||
			workspace.value.repositoryId !== node.workspaceReceipt.repositoryId ||
			workspace.value.bindingRevision < node.workspaceReceipt.bindingRevision
		) {
			return fail("resume_denied", "resume cannot replace a missing workspace or fall back to parent cwd");
		}
		const reboundBudgetDigest = budgetRequestDigest(node.agentId, node.budget);
		const reboundBudget = await this.#ports.budget.reserve({
			requestId: request.requestId,
			idempotencyKey: derivedKey(request.idempotencyKey, "resume-budget-reserve"),
			agentId: node.agentId,
			budget: node.budget,
			requestDigest: reboundBudgetDigest,
		});
		if (!reboundBudget.ok) return reboundBudget;
		const revalidatedAt = this.clock().toISOString();
		const revalidated = await this.commitSequence([
			{
				type: "agent.resume_revalidated",
				requestId: request.requestId,
				idempotencyKey: derivedKey(request.idempotencyKey, "resume-validation"),
				occurredAt: revalidatedAt,
				agentId: node.agentId,
				delegationReceipt: delegation.value,
				workspaceReceipt: workspace.value,
				denialReceipt: denial.value,
			},
			{
				type: "agent.budget_rebound",
				requestId: request.requestId,
				idempotencyKey: derivedKey(request.idempotencyKey, "resume-budget-rebound"),
				occurredAt: revalidatedAt,
				agentId: node.agentId,
				previousReservationId: node.budgetReservation.reservationId,
				reservation: reboundBudget.value,
			},
		]);
		if (!revalidated.ok) {
			await this.#ports.budget.settle(budgetSettlementRequest({
				idempotencyKey: derivedKey(request.idempotencyKey, "resume-budget-abort"),
				reservation: reboundBudget.value,
				outcome: "not_started",
				partialResults: node.artifacts.map((report) => report.artifact),
				settledAt: revalidatedAt,
			}));
			return revalidated;
		}
		const current = revalidated.value.nodes.get(node.agentId);
		if (!current?.parentAgentId || !current.delegationReceipt || !current.budgetReservation) {
			return fail("invalid_graph", "revalidated child vanished from graph");
		}
		const resumeBody = {
			requestId: request.requestId,
			agentId: current.agentId,
			sessionId: current.sessionId,
			parentAgentId: current.parentAgentId,
			delegationReceipt: current.delegationReceipt,
			workspaceReceipt: current.workspaceReceipt,
			budgetReservation: current.budgetReservation,
			inputSources: current.inputSources,
			declassificationReceipts: current.declassificationReceipts,
		};
		let launched: AgentResult<AgentLaunchResult>;
		try {
			launched = await this.#ports.launcher.resume(
				{ ...resumeBody, requestDigest: canonicalDigest(resumeBody) },
				signal,
			);
			} catch {
				return fail("reference_unavailable", "agent launcher resume is unavailable", true);
			}
			if (!launched.ok) {
				if (launched.error.retryable) return launched;
				await this.#ports.budget.settle(budgetSettlementRequest({
					idempotencyKey: derivedKey(request.idempotencyKey, "resume-launch-unavailable"),
					reservation: current.budgetReservation,
				outcome: "not_started",
				partialResults: current.artifacts.map((report) => report.artifact),
				settledAt: revalidatedAt,
			}));
			return launched;
			}
			if (launched.value.status !== "started") {
				if (launched.value.retryable) {
					return fail(
						"launch_failed",
						"agent launcher resume outcome requires reconciliation",
						true,
					);
				}
				await this.#ports.budget.settle(budgetSettlementRequest({
					idempotencyKey: derivedKey(request.idempotencyKey, "resume-launch-abort"),
					reservation: current.budgetReservation,
				outcome: "not_started",
				partialResults: current.artifacts.map((report) => report.artifact),
				settledAt: revalidatedAt,
			}));
				return fail("launch_failed", "agent launcher rejected resume", launched.value.retryable);
			}
			if (!launchReceiptsMatch(current, launched.value)) {
				return fail(
					"launch_failed",
					"agent launcher returned uncorrelated resume receipts; runtime outcome requires reconciliation",
					true,
				);
			}
		const timestamp = this.clock().toISOString();
		const resumed = await this.commitSequence([
			{
				type: "agent.launch_recorded",
				requestId: request.requestId,
				idempotencyKey: derivedKey(request.idempotencyKey, "resume-launch-recorded"),
				occurredAt: timestamp,
				agentId: current.agentId,
				launchReceipt: launched.value.launchReceipt,
				residencyReceipt: launched.value.residencyReceipt,
			},
			{
				type: "agent.transitioned",
				requestId: request.requestId,
				idempotencyKey: derivedKey(request.idempotencyKey, "resume-launched"),
				occurredAt: timestamp,
				agentId: current.agentId,
				from: current.state,
				to: "running",
			},
		]);
		if (!resumed.ok) return resumed;
		const resumedNode = resumed.value.nodes.get(current.agentId);
		return resumedNode
			? { ok: true, value: { graph: resumed.value, node: resumedNode } }
			: fail("invalid_graph", "resumed child vanished from graph");
	}

	private async recordCleanupFailure(
		node: AgentNode,
		cleanup: AgentCleanupRecord,
		stage: AgentCleanupStage,
		error: AgentError,
	): Promise<AgentResult<AgentGraphProjection>> {
		if (cleanup.reconciliationRequired?.stage === stage) return { ok: false, error };
		const recorded = await this.commit({
			type: "agent.cleanup_reconciliation_required",
			requestId: cleanupStageRequestId(node, stage),
			idempotencyKey: cleanupIdempotencyKey(node, `${stage}-reconciliation`),
			occurredAt: cleanup.requestedAt,
			agentId: node.agentId,
			cleanupRequestId: cleanup.requestId,
			stage,
			error: graphFailure(error, { outcomeCertain: false, effect: "uncertain" }),
		});
		return recorded.ok ? { ok: false, error } : recorded;
	}

	private async ensureCleanupRequested(
		projection: AgentGraphProjection,
		node: AgentNode,
	): Promise<AgentResult<AgentGraphProjection>> {
		if (!node.parentAgentId) return { ok: true, value: projection };
		if (!node.terminal) return fail("cleanup_invalid", "child cleanup requires a semantic terminal");
		const kind = cleanupKindForNode(node);
		if (!kind) return fail("cleanup_invalid", "child cleanup start evidence is incomplete or contradictory");
		const requestId = cleanupRequestId(node);
		const requestDigest = agentCleanupRequestDigest({
			requestId,
			agentId: node.agentId,
			sessionId: node.sessionId,
			kind,
			terminalDigest: node.terminal.terminalDigest,
		});
		const existing = projection.cleanups.get(node.agentId);
		if (existing) {
			return existing.requestId === requestId &&
				existing.requestDigest === requestDigest &&
				existing.kind === kind &&
				existing.terminalDigest === node.terminal.terminalDigest
				? { ok: true, value: projection }
				: fail("cleanup_invalid", "child cleanup identity conflicts with durable state");
		}
		return this.commit({
			type: "agent.cleanup_requested",
			requestId,
			idempotencyKey: cleanupIdempotencyKey(node, "requested"),
			occurredAt: node.updatedAt,
			agentId: node.agentId,
			kind,
			terminalDigest: node.terminal.terminalDigest,
			requestDigest,
		});
	}

	private async continueCleanup(
		initial: AgentGraphProjection,
		agentId: AgentNode["agentId"],
		signal?: AbortSignal,
	): Promise<AgentResult<AgentGraphProjection>> {
		let projection = initial;
		let node = projection.nodes.get(agentId);
		let cleanup = projection.cleanups.get(agentId);
		if (!node?.terminal || !node.parentAgentId || !cleanup) {
			return fail("cleanup_invalid", "child cleanup projection is incomplete");
		}
		if (cleanup.kind !== cleanupKindForNode(node)) {
			return fail("cleanup_invalid", "child cleanup kind conflicts with durable start evidence");
		}
		if (cleanup.completionReceipt) return { ok: true, value: projection };

		if (cleanup.kind === "started" && !cleanup.runtimeRelease) {
			if (!node.launchReceipt || !node.residency) {
				return fail("cleanup_invalid", "child runtime release lacks launch or residency evidence");
			}
			const requestBody = {
				requestId: cleanupStageRequestId(node, "runtime_release"),
				agentId: node.agentId,
				sessionId: node.sessionId,
				launchReceipt: node.launchReceipt,
				previousResidencyReceipt: node.residency,
				reason: node.terminal.outcome,
			};
			let released: AgentResult<AgentRuntimeReleaseReceiptRef>;
			try {
				released = await this.#ports.launcher.release(
					{ ...requestBody, requestDigest: agentRuntimeReleaseRequestDigest(requestBody) },
					signal,
				);
			} catch {
				released = fail("reference_unavailable", "child runtime release adapter is unavailable", true);
			}
			if (!released.ok) return this.recordCleanupFailure(node, cleanup, "runtime_release", released.error);
			const committed = await this.commit({
				type: "agent.runtime_released",
				requestId: requestBody.requestId,
				idempotencyKey: cleanupIdempotencyKey(node, "runtime-released"),
				occurredAt: released.value.releasedAt,
				agentId: node.agentId,
				cleanupRequestId: cleanup.requestId,
				receipt: released.value,
			});
			if (!committed.ok) return committed;
			projection = committed.value;
			node = projection.nodes.get(agentId);
			cleanup = projection.cleanups.get(agentId);
			if (!node?.terminal || !cleanup || cleanup.kind !== "started") {
				return fail("cleanup_invalid", "runtime release vanished from projection");
			}
		}

		if (!cleanup.workspaceRelease) {
			const reason: AgentWorkspaceReleaseRequest["reason"] =
				cleanup.kind === "not_started" ? "spawn_aborted" : node.terminal.outcome;
			const requestBody = {
				requestId: cleanupStageRequestId(node, "workspace_release"),
				agentId: node.agentId,
				sessionId: node.sessionId,
				previousReceipt: node.workspaceReceipt,
				reason,
			};
			const requestDigest = agentWorkspaceReleaseRequestDigest(requestBody);
			let released: AgentResult<AgentWorkspaceReleaseReceiptRef>;
			try {
				released = await this.#ports.workspace.release({ ...requestBody, requestDigest }, signal);
			} catch {
				released = fail("reference_unavailable", "Workspace release adapter is unavailable", true);
			}
			if (!released.ok) return this.recordCleanupFailure(node, cleanup, "workspace_release", released.error);
			const committed = await this.commit({
				type: "agent.workspace_released",
				requestId: requestBody.requestId,
				idempotencyKey: cleanupIdempotencyKey(node, "workspace-released"),
				occurredAt: released.value.releasedAt,
				agentId: node.agentId,
				cleanupRequestId: cleanup.requestId,
				requestDigest,
				receipt: released.value,
			});
			if (!committed.ok) return committed;
			projection = committed.value;
			node = projection.nodes.get(agentId);
			cleanup = projection.cleanups.get(agentId);
			if (!node?.terminal || !cleanup) return fail("cleanup_invalid", "Workspace release vanished from projection");
		}

		if (!cleanup.budgetSettlement) {
			if (!node.budgetReservation) return fail("cleanup_invalid", "child cleanup lacks a budget reservation");
			const outcome = cleanup.kind === "not_started" ? "not_started" : node.terminal.outcome;
			const usage = cleanup.kind === "started" ? node.terminal.usage : undefined;
			const partialResults = cleanup.kind === "started" ? node.terminal.partialResults : [];
			const settlement = budgetSettlementRequest({
				idempotencyKey: cleanupIdempotencyKey(node, "budget-settlement-adapter"),
				reservation: node.budgetReservation,
				outcome,
				...(usage ? { usage } : {}),
				partialResults,
				settledAt: cleanup.requestedAt,
			});
			let settled: AgentResult<AgentBudgetSettlementReceiptRef>;
			try {
				settled = await this.#ports.budget.settle(settlement);
			} catch {
				settled = fail("reference_unavailable", "budget settlement adapter is unavailable", true);
			}
			if (!settled.ok) return this.recordCleanupFailure(node, cleanup, "budget_settlement", settled.error);
			const committed = await this.commit({
				type: "agent.budget_settled",
				requestId: cleanupStageRequestId(node, "budget_settlement"),
				idempotencyKey: cleanupIdempotencyKey(node, "budget-settled"),
				occurredAt: settled.value.settledAt,
				agentId: node.agentId,
				cleanupRequestId: cleanup.requestId,
				receipt: settled.value,
			});
			if (!committed.ok) return committed;
			projection = committed.value;
			node = projection.nodes.get(agentId);
			cleanup = projection.cleanups.get(agentId);
			if (!node?.terminal || !cleanup) return fail("cleanup_invalid", "budget settlement vanished from projection");
		}

		if (!cleanup.workspaceRelease || !cleanup.budgetSettlement) {
			return fail("cleanup_invalid", "cleanup completion is missing a required release receipt");
		}
		if (cleanup.completionReceipt) return { ok: true, value: projection };
		const completionTimes = [
			cleanup.workspaceRelease.receipt.releasedAt,
			cleanup.budgetSettlement.receipt.settledAt,
		];
		const commonReceiptBody = {
			schemaVersion: 1 as const,
			receiptId: createRuntimeId(
				"receipt",
				`agent-cleanup-${canonicalDigest({ requestDigest: cleanup.requestDigest, agentId: node.agentId }).slice(0, 40)}`,
			),
			requestId: cleanup.requestId,
			requestDigest: cleanup.requestDigest,
			agentId: node.agentId,
			sessionId: node.sessionId,
			terminalDigest: node.terminal.terminalDigest,
			workspaceReleaseReceiptId: cleanup.workspaceRelease.receipt.receiptId,
			workspaceReleaseReceiptDigest: cleanup.workspaceRelease.receipt.receiptDigest,
			budgetSettlementReceiptId: cleanup.budgetSettlement.receipt.receiptId,
			budgetSettlementReceiptDigest: cleanup.budgetSettlement.receipt.receiptDigest,
		};
		if (cleanup.kind === "started") {
			if (!cleanup.runtimeRelease) {
				return fail("cleanup_invalid", "started cleanup completion lacks runtime release evidence");
			}
			completionTimes.push(cleanup.runtimeRelease.receipt.releasedAt);
			const receiptBody: AgentStartedCleanupReceiptBody = {
				...commonReceiptBody,
				kind: "started",
				runtimeReleaseReceiptId: cleanup.runtimeRelease.receipt.receiptId,
				runtimeReleaseReceiptDigest: cleanup.runtimeRelease.receipt.receiptDigest,
				completedAt: latestTimestamp(completionTimes),
			};
			const receipt = { ...receiptBody, receiptDigest: agentCleanupReceiptDigest(receiptBody) };
			return this.commit({
				type: "agent.cleanup_completed",
				requestId: cleanupStageRequestId(node, "completed"),
				idempotencyKey: cleanupIdempotencyKey(node, "completed"),
				occurredAt: receipt.completedAt,
				agentId: node.agentId,
				cleanupRequestId: cleanup.requestId,
				receipt,
			});
		}
		const receiptBody: AgentNotStartedCleanupReceiptBody = {
			...commonReceiptBody,
			kind: "not_started",
			completedAt: latestTimestamp(completionTimes),
		};
		const receipt = { ...receiptBody, receiptDigest: agentCleanupReceiptDigest(receiptBody) };
		return this.commit({
			type: "agent.cleanup_completed",
			requestId: cleanupStageRequestId(node, "completed"),
			idempotencyKey: cleanupIdempotencyKey(node, "completed"),
			occurredAt: receipt.completedAt,
			agentId: node.agentId,
			cleanupRequestId: cleanup.requestId,
			receipt,
		});
	}

	public async reconcilePendingCleanups(signal?: AbortSignal): Promise<AgentResult<AgentGraphProjection>> {
		let graph = await this.load();
		if (!graph.ok) return graph;
		const candidateIds = [...graph.value.nodes.keys()];
		let firstFailure: AgentError | undefined;
		for (const agentId of candidateIds) {
			const candidate = graph.value.nodes.get(agentId);
			if (!candidate) continue;
			if (!candidate.parentAgentId || !candidate.terminal) continue;
			const requested = await this.ensureCleanupRequested(graph.value, candidate);
			if (!requested.ok) {
				firstFailure ??= requested.error;
				if (signal?.aborted) break;
				const reloaded = await this.load();
				if (!reloaded.ok) {
					firstFailure ??= reloaded.error;
					break;
				}
				graph = reloaded;
				continue;
			}
			const cleaned = await this.continueCleanup(requested.value, candidate.agentId, signal);
			if (!cleaned.ok) {
				firstFailure ??= cleaned.error;
				if (signal?.aborted) break;
				const reloaded = await this.load();
				if (!reloaded.ok) {
					firstFailure ??= reloaded.error;
					break;
				}
				graph = reloaded;
				continue;
			}
			graph = cleaned;
		}
		return firstFailure ? { ok: false, error: firstFailure } : graph;
	}

	public finish(
		request: AgentTerminalRequest,
		signal?: AbortSignal,
	): Promise<AgentResult<AgentGraphProjection>> {
		const requestDigest = canonicalDigest(request);
		const active = this.cleanupOperations.get(request.agentId);
		if (active) {
			return active.requestDigest === requestDigest
				? active.promise
				: Promise.resolve(fail("idempotency_conflict", "another terminal cleanup is already active for this Agent"));
		}
		const promise = this.finishOnce(request, signal);
		this.cleanupOperations.set(request.agentId, { requestDigest, promise });
		const clear = () => {
			if (this.cleanupOperations.get(request.agentId)?.promise === promise) {
				this.cleanupOperations.delete(request.agentId);
			}
		};
		void promise.then(clear, clear);
		return promise;
	}

	private async finishOnce(
		request: AgentTerminalRequest,
		signal?: AbortSignal,
	): Promise<AgentResult<AgentGraphProjection>> {
		if (!isRuntimeId(request.requestId, "command") || !parseIdempotencyKey(request.idempotencyKey)) {
			return fail("invalid_request", "terminal command identity is invalid");
		}
		if (
			request.reasonEvidenceDigest !== undefined &&
			(
				!DIGEST_PATTERN.test(request.reasonEvidenceDigest) ||
				request.outcome !== "stopped" ||
				(request.reason !== undefined && request.reason !== "cancelled")
			)
		) {
			return fail("invalid_request", "terminal reason evidence is invalid or inapplicable");
		}
		const graph = await this.load();
		if (!graph.ok) return graph;
		const node = graph.value.nodes.get(request.agentId);
		if (!node) return fail("agent_not_found", "terminal agent does not exist");
		if (!terminalReasonMatchesOutcome(request)) {
			return fail("invalid_request", "terminal outcome and reason are contradictory");
		}
		if (node.parentAgentId && node.budgetReservation && !request.usage) {
			return fail("invalid_request", "terminal child requires exact budget usage before semantic terminal");
		}
		if (request.outcome === "completed" && !completionArtifactsSatisfied(node)) {
			return fail("artifact_contract_mismatch", "agent cannot complete without declared artifacts");
		}
		const reason = request.outcome === "completed"
			? undefined
			: request.reason ?? (request.outcome === "stopped" ? "cancelled" : "crash");
		const terminalRecord = createAgentSemanticTerminalRecord({
			agentId: node.agentId,
			requestId: request.requestId,
			idempotencyKey: request.idempotencyKey,
			outcome: request.outcome,
			...(reason ? { reason } : {}),
			...(request.reasonEvidenceDigest !== undefined
				? { reasonEvidenceDigest: request.reasonEvidenceDigest }
				: {}),
			...(request.usage ? { usage: request.usage } : {}),
			partialResults: node.artifacts.map((report) => report.artifact),
		});
		let finished: AgentResult<AgentGraphProjection> = graph;
		if (isAgentTerminal(node)) {
			if (node.state !== request.outcome || node.terminal?.terminalDigest !== terminalRecord.terminalDigest) {
				const existingEvidenceRetry = node.terminal &&
					node.state === request.outcome &&
					node.terminal.reasonEvidenceDigest !== terminalRecord.reasonEvidenceDigest
					? createAgentSemanticTerminalRecord({
							agentId: node.agentId,
							requestId: request.requestId,
							idempotencyKey: request.idempotencyKey,
							outcome: request.outcome,
							...(reason ? { reason } : {}),
							...(node.terminal.reasonEvidenceDigest !== undefined
								? { reasonEvidenceDigest: node.terminal.reasonEvidenceDigest }
								: {}),
							...(request.usage ? { usage: request.usage } : {}),
							partialResults: node.artifacts.map((report) => report.artifact),
						})
					: undefined;
				if (existingEvidenceRetry?.terminalDigest === node.terminal?.terminalDigest) {
					return fail("idempotency_conflict", "cancel reason evidence conflicts with durable semantic outcome");
				}
				return fail("invalid_transition", "agent terminal retry conflicts with durable semantic outcome");
			}
		} else {
			const occurredAt = this.clock().toISOString();
			const terminal: AgentGraphSemanticCommand = request.outcome === "completed"
				? {
						type: "agent.finished",
						requestId: request.requestId,
						idempotencyKey: request.idempotencyKey,
						occurredAt,
						agentId: node.agentId,
						from: node.state,
						terminal: terminalRecord,
					}
				: request.outcome === "stopped"
					? {
							type: "agent.stopped",
							requestId: request.requestId,
							idempotencyKey: request.idempotencyKey,
							occurredAt,
							agentId: node.agentId,
							from: node.state,
							reason: reason ?? "cancelled",
							terminal: terminalRecord,
						}
					: {
							type: "agent.failed",
							requestId: request.requestId,
							idempotencyKey: request.idempotencyKey,
							occurredAt,
							agentId: node.agentId,
							from: node.state,
							reason: reason ?? "crash",
							error: {
								code: reason ?? "agent_failed",
								messageDigest: canonicalDigest({ agentId: node.agentId, outcome: request.outcome, reason }),
								retryable: false,
								outcomeCertain: true,
								effect: "none",
							},
							terminal: terminalRecord,
						};
			finished = await this.commit(terminal);
			if (!finished.ok) return finished;
		}
		const current = finished.value.nodes.get(node.agentId);
		if (!current) return fail("cleanup_invalid", "terminal Agent vanished from durable graph");
		if (!current.parentAgentId) return finished;
		const requested = await this.ensureCleanupRequested(finished.value, current);
		return requested.ok ? this.continueCleanup(requested.value, current.agentId, signal) : requested;
	}

	public async handoff(request: AgentHandoffRequest): Promise<AgentResult<AgentGraphProjection>> {
		const graph = await this.load();
		if (!graph.ok) return graph;
		const node = graph.value.nodes.get(request.agentId);
		if (!node) return fail("agent_not_found", "handoff agent does not exist");
		const handoff = createAgentHandoffManifest(node, request.requestId, request.status, this.clock().toISOString());
		if (!handoff.ok) return handoff;
		return this.commitSequence([
			{
				type: "agent.handoff_requested",
				requestId: request.requestId,
				idempotencyKey: request.idempotencyKey,
				occurredAt: handoff.value.createdAt,
				handoff: handoff.value,
			},
			{
				type: "agent.handoff_committed",
				requestId: request.requestId,
				idempotencyKey: derivedKey(request.idempotencyKey, "handoff-committed"),
				occurredAt: handoff.value.createdAt,
				handoff: handoff.value,
			},
		]);
	}

	public async merge(request: AgentMergeRequest, signal?: AbortSignal): Promise<AgentResult<AgentGraphProjection>> {
		const graph = await this.load();
		if (!graph.ok) return graph;
		const parent = graph.value.nodes.get(request.parentAgentId);
		const child = graph.value.nodes.get(request.childAgentId);
		const handoff = graph.value.handoffs.get(request.handoffId);
		if (!parent || !child || !handoff) return fail("merge_invalid", "merge parent, child, or handoff is missing");
		const built = buildDeclarativeMergeRequest({
			requestId: request.requestId,
			idempotencyKey: request.idempotencyKey,
			parent,
			child,
			handoff,
			logicalNames: request.logicalNames,
		});
		if (!built.ok) return built;
		const requested = await this.commit({
			type: "agent.merge_requested",
			requestId: request.requestId,
			idempotencyKey: request.idempotencyKey,
			occurredAt: this.clock().toISOString(),
			request: built.value,
		});
		if (!requested.ok) return requested;
		const merged = await executeDeclarativeMerge(built.value, this.#ports.merge, signal);
		if (!merged.ok) {
			const failed = await this.commit({
				type: "agent.merge_failed",
				requestId: request.requestId,
				idempotencyKey: derivedKey(request.idempotencyKey, "merge-failed"),
				occurredAt: this.clock().toISOString(),
				parentAgentId: request.parentAgentId,
				childAgentId: request.childAgentId,
				error: graphFailure(merged.error),
			});
			return failed.ok ? merged : failed;
		}
		if (merged.value.outcome === "rejected") {
			return this.commit({
				type: "agent.merge_failed",
				requestId: request.requestId,
				idempotencyKey: derivedKey(request.idempotencyKey, "merge-rejected"),
				occurredAt: merged.value.appliedAt,
				parentAgentId: request.parentAgentId,
				childAgentId: request.childAgentId,
				error: {
					code: "merge_rejected",
					messageDigest: canonicalDigest(merged.value),
					retryable: false,
					outcomeCertain: true,
					effect: "none",
				},
			});
		}
		return this.commit({
			type: merged.value.outcome === "applied" ? "agent.merge_committed" : "agent.merge_conflicted",
			requestId: request.requestId,
			idempotencyKey: derivedKey(request.idempotencyKey, "merge-receipt"),
			occurredAt: merged.value.appliedAt,
			receipt: merged.value,
		});
	}
}

type AgentGraphTransactionKey = RegisterRootAgentRequest["idempotencyKey"];

function createRuntimeIdForCompensation(agentId: AgentNode["agentId"], reason: string) {
	const seed = canonicalDigest({ agentId, reason }).slice(0, 48);
	return createRuntimeId("command", `compensate-${seed}`);
}
