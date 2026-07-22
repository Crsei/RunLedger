/** 有界 Agent supervisor：admission、receipt 协调、durable graph 与 resume。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import { createIdempotencyKey } from "../protocol/v3/coordination.ts";
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
	isAgentTerminal,
	normalizeAgentGraphLimits,
} from "./graph-store.ts";
import { createAgentHandoffManifest } from "./handoff.ts";
import { buildDeclarativeMergeRequest, executeDeclarativeMerge } from "./merge.ts";
import { createAgentInterruptionCommands, validateAgentResidencyReceipt } from "./residency.ts";
import type {
	AgentArtifactReportRequest,
	AgentBudgetUsage,
	AgentBudgetReservationRef,
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
	AgentSpawnOutcome,
	AgentSupervisorOptions,
	AgentTerminalRequest,
	AgentTurnRecordRequest,
	AgentWorkspaceReceiptRef,
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

	public async settle(request: RootAgentBudgetSettleRequest): Promise<AgentResult<void>> {
		if (!request.usage || request.outcome === "not_started") {
			const refunded = await this.guard.refund({
				reservationId: request.reservation.reservationId,
				idempotencyKey: request.idempotencyKey,
				reason: request.outcome === "not_started" ? "not_started" : "cancelled",
			});
			return refunded.ok ? { ok: true, value: undefined } : fromBudgetError(refunded.error);
		}
		const committed = await this.guard.commit({
			reservationId: request.reservation.reservationId,
			idempotencyKey: request.idempotencyKey,
			actual: createBudgetVector({
				inputTokens: request.usage.inputTokens,
				outputTokens: request.usage.outputTokens,
				usdMicros: request.usage.usdMicros,
				wallTimeMs: request.usage.wallTimeMs,
				toolCalls: request.usage.toolCalls,
				networkBytes: request.usage.networkBytes,
				storageBytes: request.usage.storageBytes,
				artifactCount: request.usage.artifactCount,
				verifications: request.usage.verifications,
			}),
			partialResults: request.partialResults,
		});
		return committed.ok ? { ok: true, value: undefined } : fromBudgetError(committed.error);
	}
}

function workspaceReceiptMatches(
	receipt: AgentWorkspaceReceiptRef,
	expected: {
		sessionId: AgentWorkspaceReceiptRef["sessionId"];
		strategy: AgentWorkspaceReceiptRef["strategy"];
	},
): boolean {
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
		DIGEST_PATTERN.test(receipt.receiptDigest) &&
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
	return (
		result.launchReceipt.agentId === node.agentId &&
		result.launchReceipt.sessionId === node.sessionId &&
		isRuntimeId(result.launchReceipt.receiptId, "receipt") &&
		DIGEST_PATTERN.test(result.launchReceipt.receiptDigest) &&
		result.residencyReceipt.state === "resident" &&
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

export class AgentSupervisor {
	private readonly rootAgentId: AgentSupervisorOptions["rootAgentId"];
	private readonly ports: AgentSupervisorOptions["ports"];
	private readonly limitsResult: AgentResult<AgentGraphLimits>;
	private readonly clock: () => Date;

	public constructor(options: AgentSupervisorOptions) {
		this.rootAgentId = options.rootAgentId;
		this.ports = options.ports;
		this.limitsResult = normalizeAgentGraphLimits(options.limits);
		this.clock = options.clock ?? (() => new Date());
	}

	private async load(): Promise<AgentResult<AgentGraphProjection>> {
		if (!this.limitsResult.ok) return this.limitsResult;
		try {
			const loaded = await this.ports.graphStore.load(this.rootAgentId);
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
				loaded = await this.ports.graphStore.load(this.rootAgentId);
			} catch {
				return fail("store_unavailable", "agent graph store is unavailable", true);
			}
			if (!loaded.ok) return loaded;
			let committed;
			try {
				committed = await this.ports.graphStore.commit(
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
			return root &&
				root.agentId === request.agentId &&
				root.sessionId === request.sessionId &&
				root.goalId === request.goalId &&
				root.role === request.role &&
				root.workspaceReceipt.receiptId === request.workspaceReceipt.receiptId &&
				root.workspaceReceipt.receiptDigest === request.workspaceReceipt.receiptDigest &&
				root.capabilityGrant?.receiptId === request.capabilityGrant.receiptId &&
				root.capabilityGrant.receiptDigest === request.capabilityGrant.receiptDigest &&
				canonicalDigest(root.inputSources) === canonicalDigest(request.inputSources) &&
				canonicalDigest(root.declassificationReceipts) === canonicalDigest(request.declassificationReceipts)
				? existing
				: fail("agent_exists", "agent graph root registration conflicts with durable state");
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
			const allocated = await this.ports.workspace.allocate(
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
			await this.ports.workspace.release({ ...body, requestDigest: canonicalDigest(body) });
		} catch {
			// 外部清理失败由 Workspace 专项 reconciliation；Runtime 不伪造 released receipt。
		}
	}

	private async settleNotStarted(node: AgentNode, baseKey: string): Promise<void> {
		if (!node.budgetReservation) return;
		await this.ports.budget.settle({
			idempotencyKey: derivedKey(baseKey, "budget-abort"),
			reservation: node.budgetReservation,
			outcome: "not_started",
			partialResults: [],
		});
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
			launched = await this.ports.launcher.launch(
				{ ...launchBody, requestDigest: canonicalDigest(launchBody) },
				signal,
			);
		} catch {
			launched = fail<AgentLaunchResult>("launch_failed", "agent launcher is unavailable", true);
		}
		if (!launched.ok) return this.rejectPendingLaunch(node, request, launched.error);
		if (launched.value.status !== "started") {
			return this.rejectPendingLaunch(node, request, {
				code: "launch_failed",
				message: "agent launcher rejected admission",
				retryable: launched.value.retryable,
			});
		}
		if (!launchReceiptsMatch(node, launched.value)) {
			return this.rejectPendingLaunch(node, request, {
				code: "launch_failed",
				message: "agent launcher returned uncorrelated launch receipts",
				retryable: false,
			});
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
		const failedGraph = await this.commit({
			type: "agent.failed",
			requestId: request.requestId,
			idempotencyKey: derivedKey(request.idempotencyKey, "launch-failed"),
			occurredAt: timestamp,
			agentId: node.agentId,
			from: node.state,
			reason: "launch_rejected",
			error: graphFailure(error),
		});
		await this.settleNotStarted(node, request.idempotencyKey);
		await this.releaseWorkspace(node, "spawn_aborted");
		return failedGraph.ok ? { ok: false, error } : failedGraph;
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
		const delegation = await evaluateSpawnDelegation(request, this.ports.capabilitySubset, signal, this.clock());
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
		const budget = await this.ports.budget.reserve({
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
		if (isAgentTerminal(node) && node.state !== "failed") return fail("invalid_transition", "terminal agent cannot report new artifacts");
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
		const commands = createAgentInterruptionCommands(node, cause, residencyReceipt, {
			requestId: createRuntimeIdForCompensation(node.agentId, `interrupt-${cause}-${idempotencyKey}`),
			idempotencyKey,
			occurredAt: this.clock().toISOString(),
		});
		if (!commands.ok) return commands;
		const committed = await this.commitSequence(commands.value);
		if (!committed.ok) return committed;
		if (node.budgetReservation) {
			const settled = await this.ports.budget.settle({
				idempotencyKey: derivedKey(idempotencyKey, "interrupt-budget"),
				reservation: node.budgetReservation,
				outcome: cause === "cancelled" ? "stopped" : "failed",
				...(usage ? { usage } : {}),
				partialResults: node.artifacts.map((report) => report.artifact),
			});
			if (!settled.ok) return settled;
		}
		return committed;
	}

	public async cancel(
		request: AgentResumeRequest,
		residencyReceipt: AgentResidencyReceiptRef,
		reasonDigest: string,
		signal?: AbortSignal,
	): Promise<AgentResult<AgentGraphProjection>> {
		const graph = await this.load();
		if (!graph.ok) return graph;
		const node = graph.value.nodes.get(request.agentId);
		if (!node) return fail("agent_not_found", "cancelled agent does not exist");
		try {
			const cancelled = await this.ports.launcher.cancel(
				{
					requestId: request.requestId,
					agentId: node.agentId,
					sessionId: node.sessionId,
					reasonDigest,
					requestDigest: canonicalDigest({
						requestId: request.requestId,
						agentId: node.agentId,
						sessionId: node.sessionId,
						reasonDigest,
					}),
				},
				signal,
			);
			if (!cancelled.ok) return cancelled;
		} catch {
			return fail("reference_unavailable", "agent launcher cancel is unavailable", true);
		}
		return this.interrupt(node.agentId, "cancelled", residencyReceipt, request.idempotencyKey);
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
		const delegation = await revalidateDelegation(node, parent, request.requestId, this.ports.capabilitySubset, signal, this.clock());
		if (!delegation.ok) return delegation;
		let denial;
		try {
			denial = await this.ports.deniedAgents.check(node.agentId, node.sessionId, signal);
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
			workspace = await this.ports.workspace.validate(
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
		const reboundBudget = await this.ports.budget.reserve({
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
			await this.ports.budget.settle({
				idempotencyKey: derivedKey(request.idempotencyKey, "resume-budget-abort"),
				reservation: reboundBudget.value,
				outcome: "not_started",
				partialResults: node.artifacts.map((report) => report.artifact),
			});
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
			launched = await this.ports.launcher.resume(
				{ ...resumeBody, requestDigest: canonicalDigest(resumeBody) },
				signal,
			);
		} catch {
			return fail("reference_unavailable", "agent launcher resume is unavailable", true);
		}
		if (!launched.ok) {
			await this.ports.budget.settle({
				idempotencyKey: derivedKey(request.idempotencyKey, "resume-launch-unavailable"),
				reservation: current.budgetReservation,
				outcome: "not_started",
				partialResults: current.artifacts.map((report) => report.artifact),
			});
			return launched;
		}
		if (launched.value.status !== "started") {
			await this.ports.budget.settle({
				idempotencyKey: derivedKey(request.idempotencyKey, "resume-launch-abort"),
				reservation: current.budgetReservation,
				outcome: "not_started",
				partialResults: current.artifacts.map((report) => report.artifact),
			});
			return fail("launch_failed", "agent launcher rejected resume", launched.value.retryable);
		}
		if (!launchReceiptsMatch(current, launched.value)) {
			await this.ports.budget.settle({
				idempotencyKey: derivedKey(request.idempotencyKey, "resume-launch-invalid"),
				reservation: current.budgetReservation,
				outcome: "not_started",
				partialResults: current.artifacts.map((report) => report.artifact),
			});
			return fail("launch_failed", "agent launcher returned uncorrelated resume receipts");
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

	public async finish(request: AgentTerminalRequest): Promise<AgentResult<AgentGraphProjection>> {
		const graph = await this.load();
		if (!graph.ok) return graph;
		const node = graph.value.nodes.get(request.agentId);
		if (!node) return fail("agent_not_found", "terminal agent does not exist");
		if (isAgentTerminal(node)) return node.state === request.outcome ? graph : fail("invalid_transition", "agent is already terminal");
		if (request.outcome === "completed" && !completionArtifactsSatisfied(node)) {
			return fail("artifact_contract_mismatch", "agent cannot complete without declared artifacts");
		}
		const occurredAt = this.clock().toISOString();
		const terminal: AgentGraphSemanticCommand = request.outcome === "completed"
			? {
					type: "agent.finished",
					requestId: request.requestId,
					idempotencyKey: request.idempotencyKey,
					occurredAt,
					agentId: node.agentId,
					from: node.state,
				}
			: request.outcome === "stopped"
				? {
						type: "agent.stopped",
						requestId: request.requestId,
						idempotencyKey: request.idempotencyKey,
						occurredAt,
						agentId: node.agentId,
						from: node.state,
						reason: request.reason ?? "cancelled",
					}
				: {
						type: "agent.failed",
						requestId: request.requestId,
						idempotencyKey: request.idempotencyKey,
						occurredAt,
						agentId: node.agentId,
						from: node.state,
						reason: request.reason ?? "crash",
						error: {
							code: request.reason ?? "agent_failed",
							messageDigest: canonicalDigest({ agentId: node.agentId, outcome: request.outcome, reason: request.reason }),
							retryable: false,
							outcomeCertain: true,
							effect: "none",
						},
					};
		const finished = await this.commit(terminal);
		if (!finished.ok) return finished;
		if (node.budgetReservation) {
			const settled = await this.ports.budget.settle({
				idempotencyKey: derivedKey(request.idempotencyKey, "terminal-budget"),
				reservation: node.budgetReservation,
				outcome: request.outcome,
				...(request.usage ? { usage: request.usage } : {}),
				partialResults: node.artifacts.map((report) => report.artifact),
			});
			if (!settled.ok) return settled;
		}
		if (finished.ok && node.parentAgentId) await this.releaseWorkspace(node, request.outcome);
		return finished;
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
		const merged = await executeDeclarativeMerge(built.value, this.ports.merge, signal);
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
