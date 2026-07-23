/** Schema v2 adapter：Control Plane与daemon复用同一Supervisor/graph store。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import { createRuntimeId, parseRuntimeId } from "../protocol/v3/ids.ts";
import { spawnAgentRequestDigest } from "../agents/delegation.ts";
import type { ControlPlaneResult } from "./errors.ts";
import { controlPlaneFailure } from "./errors.ts";
import type {
	AgentInspectQueryV2,
	AgentInspectionV2,
	ControlPlaneAgentMutationEffectV2,
	ControlPlaneAgentSummary,
	ControlPlaneV2AgentCommand,
	ControlPlaneV2AgentCommandResponse,
	ControlPlaneV2AgentQueryResponse,
	MultiAgentControlPlanePort,
} from "./multi-agent-contracts.ts";
import { isControlPlaneAgentMutationEffectV2 } from "./canonical-command.ts";
import type {
	CommandClaimContext,
	CommandClaimOutcome,
	CommandClaimRequest,
	CommandClaimToken,
	CommandIdempotencyRepository,
} from "./idempotency.ts";
import type {
	AgentBudgetUsage,
	AgentGraphProjection,
	AgentGraphStoreHead,
	AgentNode,
	AgentResult,
	DurableAgentGraphStorePort,
	SpawnAgentRequest,
} from "../agents/types.ts";
import type { AgentSupervisor } from "../agents/supervisor.ts";
import type { AgentId } from "../protocol/v3/ids.ts";
import type {
	ControlPlaneRequestContext,
	ControlPlaneSessionHandle,
} from "./types.ts";

export interface AgentSpawnSpecResolverPort {
	resolve(
		command: Extract<ControlPlaneV2AgentCommand, { type: "agent:spawn" }>,
		context: ControlPlaneRequestContext,
	): Promise<ControlPlaneResult<ResolvedAgentSpawnSpec>>;
}

export interface ResolvedAgentSpawnSpec {
	request: SpawnAgentRequest;
	resolutionDigest: string;
}

export interface AgentCancellationUsageResolverPort {
	resolve(
		command: Extract<ControlPlaneV2AgentCommand, { type: "agent:cancel" }>,
		context: ControlPlaneRequestContext,
	): Promise<ControlPlaneResult<AgentBudgetUsage | undefined>>;
}

export interface AgentSessionHandleValidatorPort {
	validate(handle: ControlPlaneSessionHandle): ControlPlaneResult<void>;
}

export interface AgentControlPlaneMutationGatePort {
	assertMutationOpen(): ControlPlaneResult<void>;
}

function mapAgentFailure<T>(result: AgentResult<T>): ControlPlaneResult<T> {
	if (result.ok) return result;
	const code = result.error.code === "revision_conflict"
		? "expected_revision_conflict"
		: result.error.code === "idempotency_conflict"
			? "idempotency_conflict"
			: result.error.code === "store_unavailable" ||
					result.error.code === "reference_unavailable"
				? "adapter_unavailable"
				: "invalid_request";
	const uncertain = result.error.code === "store_unavailable" ||
		result.error.code === "reference_unavailable";
	return controlPlaneFailure(
		code,
		`Agent Supervisor rejected ${result.error.code}`,
		result.error.retryable,
		undefined,
		uncertain ? "uncertain" : "none",
	);
}

function summary(node: AgentNode): ControlPlaneAgentSummary {
	return {
		agentId: node.agentId,
		parentAgentId: node.parentAgentId ?? null,
		sessionId: node.sessionId,
		role: node.role,
		state: node.state,
		residency: node.residency?.state ?? "nonresident",
		artifactCount: node.artifacts.length,
	};
}

export class SupervisorMultiAgentControlPlaneAdapter
	implements MultiAgentControlPlanePort {
	readonly #supervisor: AgentSupervisor;
	readonly #graphStore: DurableAgentGraphStorePort;
	readonly #rootAgentId: AgentId;
	readonly #parentSessionId: ControlPlaneSessionHandle["sessionId"];
	readonly #handles: AgentSessionHandleValidatorPort;
	readonly #spawns: AgentSpawnSpecResolverPort;
	readonly #cancellationUsage: AgentCancellationUsageResolverPort | undefined;
	readonly #idempotency: CommandIdempotencyRepository;
	readonly #mutationGate: AgentControlPlaneMutationGatePort;
	readonly #runtimeGeneration: () => number;

	public constructor(options: {
		supervisor: AgentSupervisor;
		graphStore: DurableAgentGraphStorePort;
		rootAgentId: AgentId;
		parentSessionId: ControlPlaneSessionHandle["sessionId"];
		handles: AgentSessionHandleValidatorPort;
		spawns: AgentSpawnSpecResolverPort;
		cancellationUsage?: AgentCancellationUsageResolverPort;
		idempotency: CommandIdempotencyRepository;
		mutationGate: AgentControlPlaneMutationGatePort;
		runtimeGeneration: () => number;
	}) {
		this.#supervisor = options.supervisor;
		this.#graphStore = options.graphStore;
		this.#rootAgentId = options.rootAgentId;
		this.#parentSessionId = options.parentSessionId;
		this.#handles = options.handles;
		this.#spawns = options.spawns;
		this.#cancellationUsage = options.cancellationUsage;
		this.#idempotency = options.idempotency;
		this.#mutationGate = options.mutationGate;
		this.#runtimeGeneration = options.runtimeGeneration;
	}

	/** production composition 用对象身份证明 command journal 与 shutdown gate 没有旁路。 */
	public matchesProductionBinding(options: {
		idempotency: CommandIdempotencyRepository;
		mutationGate: AgentControlPlaneMutationGatePort;
		runtimeGeneration: number;
	}): boolean {
		return (
			this.#idempotency === options.idempotency &&
			this.#mutationGate === options.mutationGate &&
			this.#runtimeGeneration() === options.runtimeGeneration
		);
	}

	#claimRequest(command: ControlPlaneV2AgentCommand): CommandClaimRequest {
		return {
			commandId: command.commandId,
			idempotencyKey: command.idempotencyKey,
			commandType: command.type,
			requestDigest: canonicalDigest(command),
		};
	}

	#claimContext(
		command: ControlPlaneV2AgentCommand,
		context: ControlPlaneRequestContext,
	): ControlPlaneResult<CommandClaimContext> {
		const runtimeId = parseRuntimeId("runtime", context.handshake.serverInstanceId);
		const runtimeGeneration = this.#runtimeGeneration();
		if (!runtimeId || !Number.isSafeInteger(runtimeGeneration) || runtimeGeneration < 1) {
			return controlPlaneFailure(
				"adapter_contract_violation",
				"multi-agent daemon runtime generation identity is invalid",
			);
		}
		return {
			ok: true,
			value: {
				authorityId: command.authorityId,
				tenantId: command.tenantId,
				principalId: command.principalId,
				runtimeId,
				runtimeGeneration,
				domain: "session",
				subjectSessionId: command.payload.sessionId,
				domainExpectedRevision: command.expectedSessionRevision,
				traceId: createRuntimeId("trace"),
			},
		};
	}

	#duplicate(
		command: ControlPlaneV2AgentCommand,
		outcome: Extract<CommandClaimOutcome, { status: "duplicate" }>,
	): ControlPlaneResult<ControlPlaneV2AgentCommandResponse> {
		const effect = outcome.receipt.result;
		if (
			!isControlPlaneAgentMutationEffectV2(effect) ||
			effect.type !== command.type ||
			effect.receiptDigest !== canonicalDigest({
				type: effect.type,
				sessionId: effect.sessionId,
				agent: effect.agent,
				graphRevision: effect.graphRevision,
				durableCursor: effect.durableCursor,
			})
		) {
			return controlPlaneFailure(
				"recovery_required",
				"canonical multi-agent command receipt is malformed",
			);
		}
		return {
			ok: true,
			value: {
				kind: "command_result",
				commandId: command.commandId,
				type: command.type,
				status: "duplicate",
				result: effect,
			},
		};
	}

	async #rejectClaim<T>(
		claim: CommandClaimToken,
		failure: Extract<ControlPlaneResult<T>, { ok: false }>,
	): Promise<ControlPlaneResult<never>> {
		if (failure.effect === "uncertain") {
			let marked: ControlPlaneResult<void>;
			try {
				marked = await this.#idempotency.markReconciliationRequired(
					claim,
					canonicalDigest({
						commandId: claim.commandId,
						requestDigest: claim.requestDigest,
						error: failure.error,
					}),
				);
			} catch {
				return controlPlaneFailure(
					"recovery_required",
					"multi-agent reconciliation marker failed",
					false,
					{ commandId: claim.commandId },
					"uncertain",
				);
			}
			return marked.ok
				? failure
				: controlPlaneFailure(
						"recovery_required",
						"multi-agent reconciliation marker was not confirmed durable",
						false,
						{ commandId: claim.commandId },
						"uncertain",
					);
		}
		let rejected;
		try {
			rejected = await this.#idempotency.reject(claim, failure.error);
		} catch {
			return controlPlaneFailure(
				"recovery_required",
				"multi-agent command rejection failed",
				false,
				{ commandId: claim.commandId },
				"uncertain",
			);
		}
		return rejected.ok
			? failure
			: controlPlaneFailure(
					"recovery_required",
					"multi-agent command rejection was not confirmed durable",
					false,
					{ commandId: claim.commandId },
					"uncertain",
				);
	}

	async #lookup(
		command: ControlPlaneV2AgentCommand,
		request: CommandClaimRequest,
		context: CommandClaimContext,
	): Promise<ControlPlaneResult<ControlPlaneV2AgentCommandResponse | null>> {
		const previous = await this.#idempotency.lookup(request, context);
		if (!previous.ok) return previous;
		if (!previous.value) return { ok: true, value: null };
		switch (previous.value.status) {
			case "duplicate":
				return this.#duplicate(command, previous.value);
			case "rejected":
				return {
					ok: false,
					error: previous.value.receipt.error,
					effect: "none",
				};
			case "conflict":
				return controlPlaneFailure(
					"idempotency_conflict",
					"multi-agent command identity was reused with different input",
				);
			case "claimed":
				return controlPlaneFailure(
					"recovery_required",
					"unexpected claimed lookup outcome",
					false,
					undefined,
					"uncertain",
				);
			case "in_flight":
				return controlPlaneFailure(
					"command_in_flight",
					"multi-agent command outcome is not durably known",
					true,
					undefined,
					"uncertain",
				);
		}
	}

	async #head(
		handle: ControlPlaneSessionHandle,
		expectedGraphRevision?: number,
	): Promise<ControlPlaneResult<AgentGraphStoreHead>> {
		const valid = this.#handles.validate(handle);
		if (!valid.ok) return valid;
		if (handle.sessionId !== this.#parentSessionId) {
			return controlPlaneFailure("stale_session_handle", "Agent graph belongs to another parent session");
		}
		const loaded = mapAgentFailure(await this.#graphStore.load(this.#rootAgentId));
		if (!loaded.ok) return loaded;
		if (
			expectedGraphRevision !== undefined &&
			loaded.value.revision !== expectedGraphRevision
		) {
			return controlPlaneFailure(
				"expected_revision_conflict",
				"expected Agent graph revision is stale",
				true,
				{ actualRevision: loaded.value.revision },
			);
		}
		return loaded;
	}

	#effect(
		type: ControlPlaneV2AgentCommand["type"],
		head: AgentGraphStoreHead,
		agentId: AgentId,
	): ControlPlaneResult<ControlPlaneAgentMutationEffectV2> {
		const node = head.projection.nodes.get(agentId);
		if (!node || !head.cursor) {
			return controlPlaneFailure(
				"recovery_required",
				"Agent mutation lacks a durable graph node or cursor",
			);
		}
		const body = {
			type,
			sessionId: this.#parentSessionId,
			agent: summary(node),
			graphRevision: head.revision,
			durableCursor: head.cursor,
		};
		return {
			ok: true,
			value: {
				...body,
				receiptDigest: canonicalDigest(body),
			},
		};
	}

	public async execute(
		command: ControlPlaneV2AgentCommand,
		context: ControlPlaneRequestContext,
	): Promise<ControlPlaneResult<ControlPlaneV2AgentCommandResponse>> {
		if (
			command.payload.sessionId !== this.#parentSessionId ||
			command.sessionHandle.sessionId !== this.#parentSessionId
		) {
			return controlPlaneFailure(
				"stale_session_handle",
				"multi-agent command belongs to another parent session",
			);
		}
		const request = this.#claimRequest(command);
		const claimContext = this.#claimContext(command, context);
		if (!claimContext.ok) return claimContext;
		let previous: ControlPlaneResult<ControlPlaneV2AgentCommandResponse | null>;
		try {
			previous = await this.#lookup(command, request, claimContext.value);
		} catch {
			return controlPlaneFailure(
				"adapter_unavailable",
				"multi-agent command lookup failed",
				true,
			);
		}
		if (!previous.ok) return previous;
		if (previous.value) return { ok: true, value: previous.value };
		const before = await this.#head(
			command.sessionHandle,
			command.expectedAgentGraphRevision,
		);
		if (!before.ok) return before;
		const mutationOpen = this.#mutationGate.assertMutationOpen();
		if (!mutationOpen.ok) return mutationOpen;
		let claimed: ControlPlaneResult<CommandClaimOutcome>;
		try {
			claimed = await this.#idempotency.claim(request, claimContext.value);
		} catch {
			return controlPlaneFailure(
				"recovery_required",
				"multi-agent command claim outcome is uncertain",
				false,
				{ commandId: command.commandId },
				"uncertain",
			);
		}
		if (!claimed.ok) return claimed;
		if (claimed.value.status === "duplicate") return this.#duplicate(command, claimed.value);
		if (claimed.value.status === "rejected") {
			return { ok: false, error: claimed.value.receipt.error, effect: "none" };
		}
		if (claimed.value.status === "conflict") {
			return controlPlaneFailure(
				"idempotency_conflict",
				"multi-agent command claim conflicts with durable evidence",
			);
		}
		if (claimed.value.status === "in_flight") {
			return controlPlaneFailure(
				"command_in_flight",
				"multi-agent command is already in flight",
				true,
				undefined,
				"uncertain",
			);
		}
		const claim = claimed.value.claim;
		let mutation: AgentResult<unknown>;
		let agentId: AgentId;
		try {
			switch (command.type) {
			case "agent:spawn": {
				let resolved: ControlPlaneResult<ResolvedAgentSpawnSpec>;
				try {
					resolved = await this.#spawns.resolve(command, context);
				} catch {
					return this.#rejectClaim(
						claim,
						controlPlaneFailure(
							"adapter_unavailable",
							"spawn specification resolver failed",
							true,
						),
					);
				}
				if (!resolved.ok) return this.#rejectClaim(claim, resolved);
				const spawnRequest = resolved.value.request;
				const expectedResolutionDigest = canonicalDigest({
					commandId: command.commandId,
					launchSpecArtifact: command.payload.spec.launchSpecArtifact,
					promptArtifact: command.payload.spec.promptArtifact,
					spawnRequestDigest: spawnAgentRequestDigest(spawnRequest),
				});
				if (
					resolved.value.resolutionDigest !== expectedResolutionDigest ||
					spawnRequest.requestId !== command.commandId ||
					spawnRequest.idempotencyKey !== command.idempotencyKey ||
					spawnRequest.parentAgentId !== command.payload.spec.parentAgentId ||
					spawnRequest.childAgentId !== command.payload.spec.childAgentId ||
					spawnRequest.childSessionId !== command.payload.spec.childSessionId ||
					spawnRequest.role !== command.payload.spec.role
				) {
					return this.#rejectClaim(
						claim,
						controlPlaneFailure(
							"adapter_contract_violation",
							"spawn resolver changed immutable Control Plane evidence",
						),
					);
				}
				agentId = spawnRequest.childAgentId;
				mutation = await this.#supervisor.spawn(spawnRequest);
				break;
			}
			case "agent:cancel": {
				agentId = command.payload.agentId;
				const usage = this.#cancellationUsage
					? await this.#cancellationUsage.resolve(command, context)
					: { ok: true as const, value: undefined };
				if (!usage.ok) return this.#rejectClaim(claim, usage);
				mutation = await this.#supervisor.cancel(
					{
						requestId: command.commandId,
						idempotencyKey: command.idempotencyKey,
						agentId,
					},
					command.payload.reasonDigest,
					usage.value,
				);
				break;
			}
			case "agent:resume":
				agentId = command.payload.agentId;
				{
					const node = before.value.projection.nodes.get(agentId);
					const revalidationDigest = node
						? canonicalDigest({
								agentId: node.agentId,
								parentAgentId: node.parentAgentId,
								delegationReceiptDigest: node.delegationReceipt?.receiptDigest ?? null,
								workspaceReceiptDigest: node.workspaceReceipt.receiptDigest,
								requestedCapabilities: node.requestedCapabilities,
							})
						: "";
					if (revalidationDigest !== command.payload.revalidationDigest) {
						return this.#rejectClaim(
							claim,
							controlPlaneFailure(
								"preflight_rejected",
								"resume revalidation digest does not match durable Agent evidence",
							),
						);
					}
				}
				mutation = await this.#supervisor.resume({
					requestId: command.commandId,
					idempotencyKey: command.idempotencyKey,
					agentId,
				});
				break;
			case "agent:handoff": {
				agentId = command.payload.childAgentId;
				const node = before.value.projection.nodes.get(agentId);
				if (
					!node ||
					node.parentAgentId !== command.payload.parentAgentId ||
					canonicalDigest(node.artifacts.map((entry) => entry.artifact)) !==
						canonicalDigest(command.payload.artifactRefs) ||
					command.payload.handoffDigest !== canonicalDigest({
						parentAgentId: command.payload.parentAgentId,
						childAgentId: command.payload.childAgentId,
						artifactRefs: command.payload.artifactRefs,
					})
				) {
					return this.#rejectClaim(
						claim,
						controlPlaneFailure(
							"invalid_request",
							"handoff Artifact refs do not match durable child results",
						),
					);
				}
				const status = node.state === "completed"
					? "complete"
					: node.artifacts.length > 0
						? "partial"
						: "failed";
				mutation = await this.#supervisor.handoff({
					requestId: command.commandId,
					idempotencyKey: command.idempotencyKey,
					agentId,
					status,
				});
				break;
			}
			}
		} catch {
			return this.#rejectClaim(
				claim,
				controlPlaneFailure(
					"adapter_unavailable",
					"multi-agent Supervisor operation raised an exception",
					false,
					{ commandId: command.commandId },
					"uncertain",
				),
			);
		}
		const mapped = mapAgentFailure(mutation);
		if (!mapped.ok) return this.#rejectClaim(claim, mapped);
		const after = await this.#head(command.sessionHandle);
		if (!after.ok) {
			return this.#rejectClaim(claim, {
				ok: false,
				error: after.error,
				effect: "uncertain",
			});
		}
		const effect = this.#effect(command.type, after.value, agentId);
		if (!effect.ok) {
			return this.#rejectClaim(claim, {
				ok: false,
				error: effect.error,
				effect: "uncertain",
			});
		}
		let committed;
		try {
			committed = await this.#idempotency.commit(claim, effect.value);
		} catch {
			return this.#rejectClaim(
				claim,
				controlPlaneFailure(
					"recovery_required",
					"multi-agent command effect commit failed",
					false,
					{ commandId: command.commandId },
					"uncertain",
				),
			);
		}
		if (!committed.ok) {
			return this.#rejectClaim(
				claim,
				controlPlaneFailure(
					"recovery_required",
					"multi-agent command effect is not durably terminal",
					false,
					{ commandId: command.commandId },
					"uncertain",
				),
			);
		}
		return {
			ok: true,
			value: {
				kind: "command_result",
				commandId: command.commandId,
				type: command.type,
				status: "executed",
				result: effect.value,
			},
		};
	}

	public async inspect(
		query: AgentInspectQueryV2,
		_context: ControlPlaneRequestContext,
	): Promise<ControlPlaneResult<ControlPlaneV2AgentQueryResponse>> {
		const head = await this.#head(query.payload.sessionHandle);
		if (!head.ok) return head;
		if (!head.value.cursor) {
			return controlPlaneFailure("recovery_required", "Agent graph lacks a durable cursor");
		}
		const nodes = query.payload.agentId
			? [head.value.projection.nodes.get(query.payload.agentId)].filter(
					(node): node is AgentNode => node !== undefined,
				)
			: [...head.value.projection.nodes.values()];
		if (query.payload.agentId && nodes.length === 0) {
			return controlPlaneFailure("invalid_request", "Agent does not exist");
		}
		const body: AgentInspectionV2 = {
			type: "agent:inspect",
			sessionId: this.#parentSessionId,
			graphRevision: head.value.revision,
			durableCursor: head.value.cursor,
			agents: nodes.map(summary),
			projectionDigest: canonicalDigest({
				graphRevision: head.value.revision,
				agents: nodes.map(summary),
			}),
		};
		return {
			ok: true,
			value: {
				kind: "query_result",
				queryId: query.queryId,
				type: "agent:inspect",
				result: body,
			},
		};
	}
}
