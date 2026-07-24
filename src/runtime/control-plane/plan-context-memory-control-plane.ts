/** Plan/Context/Memory schema-v2 adapter：复用 daemon canonical command journal。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import { createRuntimeId, parseRuntimeId } from "../protocol/v3/ids.ts";
import type { ControlPlaneResult } from "./errors.ts";
import { controlPlaneFailure } from "./errors.ts";
import type {
	CommandClaimContext,
	CommandClaimOutcome,
	CommandClaimToken,
	CommandIdempotencyRepository,
} from "./idempotency.ts";
import type {
	ControlPlaneRequestContext,
	ControlPlaneSessionHandle,
} from "./types.ts";
import {
	PlanContextMemoryMutationEffectV2Schema,
	type ControlPlaneV2PlanContextMemoryCommand,
	type ControlPlaneV2PlanContextMemoryCommandResponse,
	type ControlPlaneV2PlanContextMemoryQuery,
	type ControlPlaneV2PlanContextMemoryQueryResponse,
	type PlanContextMemoryControlPlanePort,
	type PlanContextMemoryMutationEffectV2,
} from "./plan-context-memory-contracts.ts";
import { Check } from "typebox/value";

export interface PlanContextMemorySessionHandleValidatorPort {
	validate(handle: ControlPlaneSessionHandle): ControlPlaneResult<void>;
}

export interface PlanContextMemoryMutationGatePort {
	assertMutationOpen(): ControlPlaneResult<void>;
}

export interface PlanContextMemoryMutationExecutorPort {
	execute(
		command: ControlPlaneV2PlanContextMemoryCommand,
		context: ControlPlaneRequestContext,
	): Promise<ControlPlaneResult<PlanContextMemoryMutationEffectV2>>;
}

export interface PlanContextMemoryQueryExecutorPort {
	query(
		query: ControlPlaneV2PlanContextMemoryQuery,
		context: ControlPlaneRequestContext,
	): Promise<ControlPlaneResult<ControlPlaneV2PlanContextMemoryQueryResponse>>;
}

function validEffect(
	command: ControlPlaneV2PlanContextMemoryCommand,
	effect: unknown,
): effect is PlanContextMemoryMutationEffectV2 {
	if (!Check(PlanContextMemoryMutationEffectV2Schema, effect)) return false;
	const candidate = effect as PlanContextMemoryMutationEffectV2;
	if (candidate.type !== command.type || candidate.sessionId !== command.payload.sessionId) return false;
	const { receiptDigest, ...body } = candidate;
	return receiptDigest === canonicalDigest(body);
}

export class JournaledPlanContextMemoryControlPlaneAdapter
	implements PlanContextMemoryControlPlanePort {
	readonly #handles: PlanContextMemorySessionHandleValidatorPort;
	readonly #mutationGate: PlanContextMemoryMutationGatePort;
	readonly #mutations: PlanContextMemoryMutationExecutorPort;
	readonly #queries: PlanContextMemoryQueryExecutorPort;
	readonly #idempotency: CommandIdempotencyRepository;
	readonly #runtimeGeneration: () => number;

	public constructor(options: {
		handles: PlanContextMemorySessionHandleValidatorPort;
		mutationGate: PlanContextMemoryMutationGatePort;
		mutations: PlanContextMemoryMutationExecutorPort;
		queries: PlanContextMemoryQueryExecutorPort;
		idempotency: CommandIdempotencyRepository;
		runtimeGeneration: () => number;
	}) {
		this.#handles = options.handles;
		this.#mutationGate = options.mutationGate;
		this.#mutations = options.mutations;
		this.#queries = options.queries;
		this.#idempotency = options.idempotency;
		this.#runtimeGeneration = options.runtimeGeneration;
	}

	public matchesProductionBinding(options: {
		idempotency: CommandIdempotencyRepository;
		mutationGate: PlanContextMemoryMutationGatePort;
		runtimeGeneration: number;
	}): boolean {
		return this.#idempotency === options.idempotency &&
			this.#mutationGate === options.mutationGate &&
			this.#runtimeGeneration() === options.runtimeGeneration;
	}

	#claimContext(
		command: ControlPlaneV2PlanContextMemoryCommand,
		context: ControlPlaneRequestContext,
	): ControlPlaneResult<CommandClaimContext> {
		const runtimeId = parseRuntimeId("runtime", context.handshake.serverInstanceId);
		const runtimeGeneration = this.#runtimeGeneration();
		if (!runtimeId || !Number.isSafeInteger(runtimeGeneration) || runtimeGeneration < 1) {
			return controlPlaneFailure(
				"adapter_contract_violation",
				"Plan/Context/Memory runtime generation identity is invalid",
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

	#response(
		command: ControlPlaneV2PlanContextMemoryCommand,
		status: "executed" | "duplicate",
		effect: PlanContextMemoryMutationEffectV2,
	): ControlPlaneV2PlanContextMemoryCommandResponse {
		return {
			kind: "command_result",
			commandId: command.commandId,
			type: command.type,
			status,
			result: structuredClone(effect),
		};
	}

	#duplicate(
		command: ControlPlaneV2PlanContextMemoryCommand,
		outcome: Extract<CommandClaimOutcome, { status: "duplicate" }>,
	): ControlPlaneResult<ControlPlaneV2PlanContextMemoryCommandResponse> {
		const effect = outcome.receipt.result;
		return validEffect(command, effect)
			? { ok: true, value: this.#response(command, "duplicate", effect) }
			: controlPlaneFailure(
					"recovery_required",
					"canonical Plan/Context/Memory command receipt is malformed",
					false,
					undefined,
					"uncertain",
				);
	}

	async #settleFailure<T>(
		claim: CommandClaimToken,
		failure: Extract<ControlPlaneResult<T>, { ok: false }>,
	): Promise<ControlPlaneResult<never>> {
		if (failure.effect === "uncertain") {
			const marked = await this.#idempotency.markReconciliationRequired(
				claim,
				canonicalDigest({ commandId: claim.commandId, error: failure.error }),
			);
			return marked.ok
				? failure
				: controlPlaneFailure(
						"recovery_required",
						"Plan/Context/Memory reconciliation marker was not confirmed",
						false,
						undefined,
						"uncertain",
					);
		}
		const rejected = await this.#idempotency.reject(claim, failure.error);
		return rejected.ok
			? failure
			: controlPlaneFailure(
					"recovery_required",
					"Plan/Context/Memory rejection was not confirmed",
					false,
					undefined,
					"uncertain",
				);
	}

	public async execute(
		command: ControlPlaneV2PlanContextMemoryCommand,
		context: ControlPlaneRequestContext,
	): Promise<ControlPlaneResult<ControlPlaneV2PlanContextMemoryCommandResponse>> {
		const handle = this.#handles.validate(command.sessionHandle);
		if (!handle.ok) return handle;
		const open = this.#mutationGate.assertMutationOpen();
		if (!open.ok) return open;
		const claimContext = this.#claimContext(command, context);
		if (!claimContext.ok) return claimContext;
		const request = {
			commandId: command.commandId,
			idempotencyKey: command.idempotencyKey,
			commandType: command.type,
			requestDigest: canonicalDigest(command),
		};
		let claimed;
		try {
			claimed = await this.#idempotency.claim(request, claimContext.value);
		} catch {
			return controlPlaneFailure(
				"recovery_required",
				"Plan/Context/Memory command claim failed",
				false,
				undefined,
				"uncertain",
			);
		}
		if (!claimed.ok) return claimed;
		switch (claimed.value.status) {
			case "duplicate":
				return this.#duplicate(command, claimed.value);
			case "rejected":
				return { ok: false, error: claimed.value.receipt.error, effect: "none" };
			case "conflict":
				return controlPlaneFailure(
					"idempotency_conflict",
					"Plan/Context/Memory command identity was reused with different input",
				);
			case "in_flight":
				return controlPlaneFailure(
					"command_in_flight",
					"Plan/Context/Memory command outcome is not durably known",
					true,
					undefined,
					"uncertain",
				);
			case "claimed":
				break;
		}
		const claim = claimed.value.claim;
		let executed: ControlPlaneResult<PlanContextMemoryMutationEffectV2>;
		try {
			executed = await this.#mutations.execute(command, context);
		} catch {
			executed = controlPlaneFailure(
				"adapter_unavailable",
				"Plan/Context/Memory mutation adapter threw",
				true,
				undefined,
				"uncertain",
			);
		}
		if (!executed.ok) return this.#settleFailure(claim, executed);
		if (
			!validEffect(command, executed.value) ||
			executed.value.domainRevision < command.expectedDomainRevision
		) {
			return this.#settleFailure(
				claim,
				controlPlaneFailure(
					"adapter_contract_violation",
					"Plan/Context/Memory mutation effect is invalid",
					false,
					undefined,
					"uncertain",
				),
			);
		}
		const committed = await this.#idempotency.commit(claim, executed.value);
		if (!committed.ok) {
			await this.#idempotency.markReconciliationRequired(
				claim,
				canonicalDigest({ commandId: command.commandId, effect: executed.value }),
			);
			return controlPlaneFailure(
				"recovery_required",
				"Plan/Context/Memory effect was not durably committed",
				false,
				undefined,
				"uncertain",
			);
		}
		return { ok: true, value: this.#response(command, "executed", executed.value) };
	}

	public async query(
		query: ControlPlaneV2PlanContextMemoryQuery,
		context: ControlPlaneRequestContext,
	): Promise<ControlPlaneResult<ControlPlaneV2PlanContextMemoryQueryResponse>> {
		const handle = this.#handles.validate(query.payload.sessionHandle);
		if (!handle.ok) return handle;
		let result: ControlPlaneResult<ControlPlaneV2PlanContextMemoryQueryResponse>;
		try {
			result = await this.#queries.query(query, context);
		} catch {
			return controlPlaneFailure("adapter_unavailable", "Plan/Context/Memory query adapter threw", true);
		}
		if (!result.ok) return result;
		if (
			result.value.queryId !== query.queryId ||
			result.value.type !== query.type ||
			result.value.result.type !== query.type ||
			result.value.result.sessionId !== query.payload.sessionId
		) return controlPlaneFailure("adapter_contract_violation", "specialty query response correlation is invalid");
		return result;
	}
}
