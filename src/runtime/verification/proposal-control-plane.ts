/** Durable ChangeProposal/HumanGate services 到 Control Plane 的唯一生产适配器。 */

import { controlPlaneFailure, type ControlPlaneResult } from "../control-plane/errors.ts";
import type { CommandIdempotencyRepository } from "../control-plane/idempotency.ts";
import { ShutdownCoordinator } from "../control-plane/shutdown.ts";
import type {
	ChangeProposalControlPlanePort,
	ChangeProposalInspectQuery,
	ChangeProposalInspection,
	ChangeProposalRequestDraftPrCommand,
	ControlPlaneCommand,
	ControlPlaneCommandEffect,
	ControlPlaneRequestContext,
	HumanGateControlPlanePort,
	HumanGateResolveCommand,
} from "../control-plane/types.ts";
import type { ChangeProposalRepository } from "./change-proposal-repository.ts";
import type {
	DurableDraftPrService,
	DurableHumanGateService,
} from "./proposal-effects.ts";
import type { VerificationCoreResult } from "./types.ts";

function verificationFailure<T>(
	result: Extract<VerificationCoreResult<unknown>, { ok: false }>,
): ControlPlaneResult<T> {
	switch (result.error.code) {
		case "reconciliation_required":
			return controlPlaneFailure(
				"recovery_required",
				"Phase 11 external effect requires reconciliation",
				false,
				undefined,
				"uncertain",
			);
		case "durable_write_failed":
		case "provider_unavailable":
			return controlPlaneFailure(
				"adapter_unavailable",
				"Phase 11 durable effect authority is unavailable",
				result.error.retryable,
				undefined,
				result.error.code === "provider_unavailable" ? "uncertain" : "none",
			);
		case "conflict":
			return controlPlaneFailure("idempotency_conflict", "Phase 11 request conflicts with durable evidence");
		case "human_gate_required":
		case "authorization_denied":
		case "authorization_required":
			return controlPlaneFailure("preflight_rejected", "Phase 11 authorization or separation-of-duty gate denied");
		default:
			return controlPlaneFailure("invalid_request", "Phase 11 request failed contract validation");
	}
}

function validContext(
	request: { authorityId: string; tenantId: string; principalId: string },
	context: ControlPlaneRequestContext,
): boolean {
	return request.principalId === context.peer.principalId &&
		context.handshake.remoteAccess === "disabled" &&
		// server handshake 已绑定 authority/tenant；adapter 再拒绝明显的交叉 scope。
		request.authorityId.length > 0 &&
		request.tenantId.length > 0;
}

export class RuntimeChangeProposalControlPlaneAdapter implements ChangeProposalControlPlanePort {
	readonly #repository: Pick<ChangeProposalRepository, "inspect">;
	readonly #drafts: Pick<DurableDraftPrService, "request">;

	public constructor(options: {
		repository: Pick<ChangeProposalRepository, "inspect">;
		drafts: Pick<DurableDraftPrService, "request">;
	}) {
		this.#repository = options.repository;
		this.#drafts = options.drafts;
	}

	public async inspect(
		query: ChangeProposalInspectQuery,
		context: ControlPlaneRequestContext,
	): Promise<ControlPlaneResult<ChangeProposalInspection>> {
		if (!validContext(query, context)) return controlPlaneFailure("unauthorized_peer", "proposal query scope is not authorized");
		const inspected = await this.#repository.inspect(query.payload.proposalId);
		if (!inspected.ok || inspected.value.sessionId !== query.payload.sessionId ||
			inspected.value.authorityId !== query.authorityId || inspected.value.tenantId !== query.tenantId) {
			return controlPlaneFailure("invalid_request", "recorded ChangeProposal was not found in the requested scope");
		}
		return { ok: true, value: { type: "changeProposal:inspect", proposal: inspected.value } };
	}

	public async requestDraftPr(
		command: ChangeProposalRequestDraftPrCommand,
		context: ControlPlaneRequestContext,
	): Promise<ControlPlaneResult<Extract<ControlPlaneCommandEffect, { type: "changeProposal:requestDraftPr" }>>> {
		if (!validContext(command, context)) return controlPlaneFailure("unauthorized_peer", "Draft PR command scope is not authorized");
		const created = await this.#drafts.request({
			authorityId: command.authorityId,
			tenantId: command.tenantId,
			requestId: command.commandId,
			idempotencyKey: command.commandId,
			requestedBy: command.principalId,
			providerId: command.payload.providerId,
			authorizationReceiptId: command.payload.authorizationReceiptId,
			authorizationReceiptDigest: command.payload.authorizationReceiptDigest,
			proposal: command.payload.proposal,
		});
		return created.ok
			? { ok: true, value: { type: "changeProposal:requestDraftPr", receipt: created.value } }
			: verificationFailure(created);
	}
}

export class RuntimeHumanGateControlPlaneAdapter implements HumanGateControlPlanePort {
	readonly #humanGates: Pick<DurableHumanGateService, "resolve">;

	public constructor(humanGates: Pick<DurableHumanGateService, "resolve">) {
		this.#humanGates = humanGates;
	}

	public async resolve(
		command: HumanGateResolveCommand,
		context: ControlPlaneRequestContext,
	): Promise<ControlPlaneResult<Extract<ControlPlaneCommandEffect, { type: "humanGate:resolve" }>>> {
		if (!validContext(command, context) || command.payload.request.requestedBy !== command.principalId) {
			return controlPlaneFailure("unauthorized_peer", "HumanGate command scope is not authorized");
		}
		const decided = await this.#humanGates.resolve(command.payload.request);
		return decided.ok
			? { ok: true, value: { type: "humanGate:resolve", decision: decided.value } }
			: verificationFailure(decided);
	}
}

/**
 * 对象身份是 join gate：transport、command bus 与 Phase 11 services 必须共享同一
 * journal、generation reader 和 shutdown mutation gate。
 */
export class RuntimePhase11ProductionBinding {
	readonly #idempotency: CommandIdempotencyRepository;
	readonly #mutationGate: ShutdownCoordinator;
	readonly #runtimeGeneration: (command: ControlPlaneCommand) => number;
	readonly #expectedRuntimeGeneration: number;
	readonly #changeProposals: ChangeProposalControlPlanePort;
	readonly #humanGates: HumanGateControlPlanePort | undefined;

	public constructor(options: {
		idempotency: CommandIdempotencyRepository;
		mutationGate: ShutdownCoordinator;
		runtimeGeneration: (command: ControlPlaneCommand) => number;
		expectedRuntimeGeneration: number;
		changeProposals: ChangeProposalControlPlanePort;
		humanGates?: HumanGateControlPlanePort;
	}) {
		this.#idempotency = options.idempotency;
		this.#mutationGate = options.mutationGate;
		this.#runtimeGeneration = options.runtimeGeneration;
		this.#expectedRuntimeGeneration = options.expectedRuntimeGeneration;
		this.#changeProposals = options.changeProposals;
		this.#humanGates = options.humanGates;
	}

	public matchesProductionBinding(options: {
		idempotency: CommandIdempotencyRepository;
		mutationGate: ShutdownCoordinator;
		runtimeGeneration: (command: ControlPlaneCommand) => number;
		expectedRuntimeGeneration: number;
		changeProposals: ChangeProposalControlPlanePort;
		humanGates?: HumanGateControlPlanePort;
	}): boolean {
		return this.#idempotency === options.idempotency &&
			this.#mutationGate === options.mutationGate &&
			this.#runtimeGeneration === options.runtimeGeneration &&
			this.#expectedRuntimeGeneration === options.expectedRuntimeGeneration &&
			this.#changeProposals === options.changeProposals &&
			this.#humanGates === options.humanGates;
	}
}
