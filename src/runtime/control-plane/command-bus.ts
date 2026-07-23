/** exact mutation dispatch：state guard -> preflight/opaque adapter -> durable idempotency commit。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import { createRuntimeId, isRuntimeId, parseRuntimeId } from "../protocol/v3/ids.ts";
import type { SessionId } from "../protocol/v3/ids.ts";
import {
	isDraftPrProviderReceipt,
	isHumanGateDecision,
} from "../verification/change-proposal.ts";
import type { ControlPlaneResult } from "./errors.ts";
import { controlPlaneFailure } from "./errors.ts";
import type {
	CommandClaimOutcome,
	CommandClaimContext,
	CommandClaimRequest,
	CommandClaimToken,
	CommandIdempotencyRepository,
	CommittedCommandReceipt,
} from "./idempotency.ts";
import type { ShutdownCoordinator } from "./shutdown.ts";
import {
	adapterException,
	controlPlaneCommandDigest,
	type ApprovalResolutionCoordinatorPort,
	type ChangeProposalControlPlanePort,
	type ControlPlaneCommand,
	type ControlPlaneCommandEffect,
	type ControlPlaneCommandResponse,
	type ControlPlaneRequestContext,
	type HumanGateControlPlanePort,
	type MutationExecutorPort,
	type MutationStateGuardPort,
	type PromptEnqueuePort,
	type QueueControlPlanePort,
	isControlPlaneCommandEffect,
	validateControlPlaneCommand,
} from "./types.ts";

export interface ControlPlaneCommandBusOptions {
	idempotency: CommandIdempotencyRepository;
	stateGuard: MutationStateGuardPort;
	executor: MutationExecutorPort;
	prompts: PromptEnqueuePort;
	approvals: ApprovalResolutionCoordinatorPort;
	queues?: QueueControlPlanePort;
	changeProposals?: ChangeProposalControlPlanePort;
	humanGates?: HumanGateControlPlanePort;
	shutdown: ShutdownCoordinator;
	/** daemon generation；未提供时 isolated fixture 使用 session handle generation 或 1。 */
	runtimeGeneration?: (command: ControlPlaneCommand) => number;
	afterCommit?: (
		command: ControlPlaneCommand,
		effect: ControlPlaneCommandEffect,
		receipt: CommittedCommandReceipt,
	) => void;
}

export type SessionMutationRecoveryPhase =
	| "claim"
	| "in_flight"
	| "effect"
	| "commit"
	| "reject";

export interface SessionMutationRecoveryState {
	sessionId: SessionId;
	commandId: CommandClaimRequest["commandId"];
	requestDigest: string;
	phase: SessionMutationRecoveryPhase;
}

export type SessionMutationReconciliation =
	| {
			sessionId: SessionId;
			commandId: CommandClaimRequest["commandId"];
			requestDigest: string;
			outcome: "no_effect";
	  }
	| {
			sessionId: SessionId;
			commandId: CommandClaimRequest["commandId"];
			requestDigest: string;
			outcome: "committed";
			result: ControlPlaneCommandEffect;
	  };

interface BlockedSessionMutation extends SessionMutationRecoveryState {
	command: ControlPlaneCommand;
	request: CommandClaimRequest;
	claim?: CommandClaimToken;
}

function claimRequest(command: ControlPlaneCommand): CommandClaimRequest {
	return {
		commandId: command.commandId,
		idempotencyKey: command.idempotencyKey,
		commandType: command.type,
		requestDigest: controlPlaneCommandDigest(command),
	};
}

function committedEffect(
	command: ControlPlaneCommand,
	effect: unknown,
): ControlPlaneResult<ControlPlaneCommandEffect> {
	return isControlPlaneCommandEffect(effect) && effect.type === command.type
		? { ok: true, value: effect }
		: controlPlaneFailure(
				"recovery_required",
				"canonical command receipt does not match the schema v1 command",
			);
}

function claimContext(
	command: ControlPlaneCommand,
	context: ControlPlaneRequestContext,
	runtimeGeneration: (command: ControlPlaneCommand) => number,
): ControlPlaneResult<CommandClaimContext> {
	const runtimeId = parseRuntimeId("runtime", context.handshake.serverInstanceId);
	const generation = runtimeGeneration(command);
	if (!runtimeId || !Number.isSafeInteger(generation) || generation < 1) {
		return controlPlaneFailure("adapter_contract_violation", "daemon runtime generation identity is invalid");
	}
	return {
		ok: true,
		value: {
			authorityId: command.authorityId,
			tenantId: command.tenantId,
			principalId: command.principalId,
			runtimeId,
			runtimeGeneration: generation,
			domain: command.type === "shutdown" ? "daemon" : "session",
			subjectSessionId: commandSessionId(command) ?? null,
			domainExpectedRevision: command.expectedSessionRevision,
			traceId: createRuntimeId("trace"),
		},
	};
}

function commandSessionId(command: ControlPlaneCommand): SessionId | undefined {
	switch (command.type) {
		case "session:resume":
		case "session:stop":
		case "turn:start":
		case "turn:steer":
		case "turn:followUp":
		case "turn:interrupt":
		case "queue:cancel":
			case "approval:resolve":
		case "changeProposal:requestDraftPr":
		case "humanGate:resolve":
			return command.payload.sessionId;
		case "session:fork":
			return command.payload.parentSessionId;
		case "session:start":
		case "shutdown":
			return undefined;
	}
}

function validateEffect(command: ControlPlaneCommand, effect: ControlPlaneCommandEffect): ControlPlaneResult<void> {
	if (!isControlPlaneCommandEffect(effect)) {
		return controlPlaneFailure("adapter_contract_violation", "mutation adapter returned a malformed exact result");
	}
	if (effect.type !== command.type) {
		return controlPlaneFailure("adapter_contract_violation", "mutation adapter returned the wrong result type");
	}
	switch (command.type) {
		case "session:start":
		case "session:resume":
		case "session:fork":
			if (effect.type !== command.type) return controlPlaneFailure("adapter_contract_violation", "session result type is inconsistent");
			if (effect.bootstrap.recovery !== (effect.type === "session:start" ? "new" : effect.type === "session:resume" ? "resumed" : "forked")) {
				return controlPlaneFailure("adapter_contract_violation", "session bootstrap recovery kind is inconsistent");
			}
			if (
				effect.bootstrap.handle.sessionId !== effect.bootstrap.sessionId ||
				effect.bootstrap.head === null ||
				effect.bootstrap.head.stream.scope !== "session" ||
				effect.bootstrap.head.stream.sessionId !== effect.bootstrap.sessionId ||
				(command.type === "session:resume" && effect.bootstrap.sessionId !== command.payload.sessionId) ||
				(command.type === "session:fork" && effect.bootstrap.sessionId === command.payload.parentSessionId)
			) {
				return controlPlaneFailure("adapter_contract_violation", "session bootstrap handle is inconsistent");
			}
			return { ok: true, value: undefined };
		case "session:stop":
			if (effect.type !== "session:stop") return controlPlaneFailure("adapter_contract_violation", "stop result type is inconsistent");
			return effect.sessionId === command.payload.sessionId
				? { ok: true, value: undefined }
				: controlPlaneFailure("adapter_contract_violation", "mutation result session correlation is invalid");
		case "turn:interrupt":
			if (effect.type !== "turn:interrupt") return controlPlaneFailure("adapter_contract_violation", "interrupt result type is inconsistent");
			return effect.sessionId === command.payload.sessionId &&
				effect.durableCursor.stream.scope === "session" &&
				effect.durableCursor.stream.sessionId === command.payload.sessionId
				? { ok: true, value: undefined }
				: controlPlaneFailure("adapter_contract_violation", "mutation result session correlation is invalid");
		case "turn:start":
		case "turn:steer":
		case "turn:followUp":
			if (effect.type !== command.type) return controlPlaneFailure("adapter_contract_violation", "prompt result type is inconsistent");
			if (
				effect.sessionId !== command.payload.sessionId ||
				!isRuntimeId(effect.queueItemId, "queueItem") ||
				effect.durableCursor.stream.scope !== "session" ||
				effect.durableCursor.stream.sessionId !== command.payload.sessionId ||
				!/^[a-f0-9]{64}$/.test(effect.preflightDigest)
				) return controlPlaneFailure("adapter_contract_violation", "durable prompt acceptance is invalid");
			return { ok: true, value: undefined };
		case "queue:cancel": {
			if (effect.type !== "queue:cancel") return controlPlaneFailure("adapter_contract_violation", "queue cancel result type is inconsistent");
			const expectedItems = command.payload.items;
			if (
				effect.sessionId !== command.payload.sessionId ||
				effect.previousQueueRevision !== command.payload.expectedQueueRevision ||
				effect.queueRevision === effect.previousQueueRevision ||
				effect.receipts.length !== expectedItems.length ||
				effect.receipts.some((receipt, index) => (
					receipt.queueItemId !== expectedItems[index]?.queueItemId ||
					receipt.kind !== expectedItems[index]?.kind
				)) ||
				effect.receipts.some((receipt, index) => (
					receipt.durableCursor.stream.scope !== "session" ||
					receipt.durableCursor.stream.sessionId !== command.payload.sessionId ||
					(index > 0 && receipt.durableCursor.sequence <= effect.receipts[index - 1]!.durableCursor.sequence)
				))
			) return controlPlaneFailure("adapter_contract_violation", "queue cancellation receipt correlation is invalid");
			return { ok: true, value: undefined };
		}
		case "approval:resolve":
			if (effect.type !== "approval:resolve") return controlPlaneFailure("adapter_contract_violation", "approval result type is inconsistent");
			if (
				effect.approvalId !== command.payload.approvalId ||
				effect.requestId !== command.payload.requestId ||
					effect.ticketDigest !== command.payload.ticketDigest ||
					effect.decisionRevision <= command.payload.expectedDecisionRevision ||
					effect.decisionRevision !== command.payload.resolutionReceipt.decisionRevision ||
					effect.receiptDigest !== command.payload.resolutionReceipt.receiptDigest
				) return controlPlaneFailure("adapter_contract_violation", "approval coordinator returned mismatched correlation");
			return { ok: true, value: undefined };
		case "changeProposal:requestDraftPr":
			if (effect.type !== "changeProposal:requestDraftPr") {
				return controlPlaneFailure("adapter_contract_violation", "Draft PR result type is inconsistent");
			}
			return isDraftPrProviderReceipt(effect.receipt) &&
				effect.receipt.requestId === command.commandId &&
				effect.receipt.providerId === command.payload.providerId &&
				effect.receipt.proposalId === command.payload.proposal.proposalId &&
				effect.receipt.proposalDigest === command.payload.proposal.proposalDigest &&
				effect.receipt.sealId === command.payload.proposal.episodeSeal.sealId &&
				effect.receipt.sealDigest === command.payload.proposal.episodeSeal.sealDigest &&
				effect.receipt.authorityId === command.authorityId &&
				effect.receipt.tenantId === command.tenantId
				? { ok: true, value: undefined }
				: controlPlaneFailure("adapter_contract_violation", "Draft PR provider receipt correlation is invalid");
		case "humanGate:resolve":
			if (effect.type !== "humanGate:resolve") {
				return controlPlaneFailure("adapter_contract_violation", "human gate result type is inconsistent");
			}
			return isHumanGateDecision(effect.decision) &&
				effect.decision.humanGateId === command.payload.request.humanGateId &&
				effect.decision.requestId === command.payload.request.requestId &&
				effect.decision.proposalId === command.payload.request.proposal.proposalId &&
				effect.decision.proposalDigest === command.payload.request.proposal.proposalDigest &&
				effect.decision.action === command.payload.request.action &&
				effect.decision.authorityId === command.authorityId &&
				effect.decision.tenantId === command.tenantId &&
				effect.decision.decidedBy !== command.principalId &&
				effect.decision.decidedBy !== command.payload.request.proposal.createdBy
				? { ok: true, value: undefined }
				: controlPlaneFailure("adapter_contract_violation", "human gate decision correlation is invalid");
		case "shutdown":
			if (effect.type !== "shutdown") return controlPlaneFailure("adapter_contract_violation", "shutdown result type is inconsistent");
			return Number.isFinite(Date.parse(effect.acceptedAt)) && Number.isFinite(Date.parse(effect.drainDeadline))
				? { ok: true, value: undefined }
				: controlPlaneFailure("adapter_contract_violation", "shutdown receipt timestamps are invalid");
	}
}

export class ControlPlaneCommandBus {
	readonly #idempotency: CommandIdempotencyRepository;
	readonly #stateGuard: MutationStateGuardPort;
	readonly #executor: MutationExecutorPort;
	readonly #prompts: PromptEnqueuePort;
	readonly #approvals: ApprovalResolutionCoordinatorPort;
	readonly #queues: QueueControlPlanePort | undefined;
	readonly #changeProposals: ChangeProposalControlPlanePort | undefined;
	readonly #humanGates: HumanGateControlPlanePort | undefined;
	readonly #shutdown: ShutdownCoordinator;
	readonly #runtimeGeneration: (command: ControlPlaneCommand) => number;
	readonly #afterCommit: ControlPlaneCommandBusOptions["afterCommit"];
	readonly #blockedSessions = new Map<SessionId, BlockedSessionMutation>();
	readonly #sessionSerial = new Map<SessionId, Promise<void>>();

	public constructor(options: ControlPlaneCommandBusOptions) {
		this.#idempotency = options.idempotency;
		this.#stateGuard = options.stateGuard;
		this.#executor = options.executor;
		this.#prompts = options.prompts;
		this.#approvals = options.approvals;
		this.#queues = options.queues;
		this.#changeProposals = options.changeProposals;
		this.#humanGates = options.humanGates;
		this.#shutdown = options.shutdown;
		this.#runtimeGeneration = options.runtimeGeneration ?? ((command) => command.sessionHandle?.generation ?? 1);
		this.#afterCommit = options.afterCommit;
	}

	public async execute(input: unknown, context: ControlPlaneRequestContext): Promise<ControlPlaneResult<ControlPlaneCommandResponse>> {
		const validated = validateControlPlaneCommand(input);
		if (!validated.ok) return { ok: false, error: validated.error, effect: "none" };
		const command = validated.value;
		return this.#serializeSession(command, () => this.#executeValidated(command, context));
	}

	async #executeValidated(
		command: ControlPlaneCommand,
		context: ControlPlaneRequestContext,
	): Promise<ControlPlaneResult<ControlPlaneCommandResponse>> {
		const request = claimRequest(command);
		const canonicalContext = claimContext(command, context, this.#runtimeGeneration);
		if (!canonicalContext.ok) return canonicalContext;
		let previous: ControlPlaneResult<CommandClaimOutcome | null>;
		try {
			previous = await this.#idempotency.lookup(request, canonicalContext.value);
		} catch (error) {
			return controlPlaneFailure("adapter_unavailable", "command lookup adapter failed", true, {
				errorName: error instanceof Error ? error.name : "UnknownError",
			});
		}
		if (!previous.ok) {
			if (previous.effect === "uncertain") this.#blockSession(command, request, "in_flight");
			return previous;
		}
		if (previous.value?.status === "duplicate") {
			const effect = committedEffect(command, previous.value.receipt.result);
			if (!effect.ok) return effect;
			return {
				ok: true,
				value: {
					kind: "command_result",
					commandId: command.commandId,
					type: command.type,
					status: "duplicate",
					result: effect.value,
				},
			};
		}
		if (previous.value?.status === "rejected") {
			return { ok: false, error: previous.value.receipt.error, effect: "none" };
		}
		if (previous.value?.status === "conflict") {
			return controlPlaneFailure("idempotency_conflict", "commandId or idempotency key was reused with different input");
		}
		if (previous.value?.status === "in_flight") {
			this.#blockSession(command, request, "in_flight", previous.value.claim);
			return controlPlaneFailure("command_in_flight", "command outcome is not yet durably known", true, undefined, "uncertain");
		}
		const sessionGate = this.#assertSessionMutationOpen(command);
		if (!sessionGate.ok) return sessionGate;
		const gate = this.#shutdown.assertMutationOpen();
		if (!gate.ok) return gate;
		let claimed: ControlPlaneResult<CommandClaimOutcome>;
		try {
			claimed = await this.#idempotency.claim(request, canonicalContext.value);
		} catch (error) {
			const failure = controlPlaneFailure<never>("adapter_unavailable", "command claim adapter failed", false, {
				errorName: error instanceof Error ? error.name : "UnknownError",
			}, "uncertain");
			this.#blockSession(command, request, "claim");
			return failure;
		}
		if (!claimed.ok) {
			if (claimed.effect === "uncertain") this.#blockSession(command, request, "claim");
			return claimed;
		}
		if (claimed.value.status === "duplicate") {
			const effect = committedEffect(command, claimed.value.receipt.result);
			if (!effect.ok) return effect;
			return {
				ok: true,
				value: {
					kind: "command_result",
					commandId: command.commandId,
					type: command.type,
					status: "duplicate",
					result: effect.value,
				},
			};
		}
		if (claimed.value.status === "rejected") {
			return { ok: false, error: claimed.value.receipt.error, effect: "none" };
		}
		if (claimed.value.status === "conflict") {
			return controlPlaneFailure("idempotency_conflict", "command claim conflicts with a durable command");
		}
		if (claimed.value.status === "in_flight") {
			this.#blockSession(command, request, "in_flight", claimed.value.claim);
			return controlPlaneFailure("command_in_flight", "command is already in flight", true, undefined, "uncertain");
		}
		const claim = claimed.value.claim;
		const guarded = await this.#safeGuard(command, context);
		if (!guarded.ok) return this.#failClaim(command, request, claim, guarded);
		const executed = await this.#executeClaimed(command, context);
		if (!executed.ok) return this.#failClaim(command, request, claim, executed);
		const effectValidation = validateEffect(command, executed.value);
		if (!effectValidation.ok) {
			const uncertain = controlPlaneFailure<never>(
				effectValidation.error.code,
				effectValidation.error.message,
				effectValidation.error.retryable,
				effectValidation.error.details,
				"uncertain",
			);
			return this.#markClaimUncertain(command, request, claim, uncertain);
		}
		let committed: ControlPlaneResult<CommittedCommandReceipt>;
		try {
			committed = await this.#idempotency.commit(claim, executed.value);
		} catch (error) {
			return this.#markClaimUncertain(command, request, claim, controlPlaneFailure("recovery_required", "command receipt commit adapter failed", false, {
				commandId: command.commandId,
				errorName: error instanceof Error ? error.name : "UnknownError",
			}, "uncertain"), "commit");
		}
		if (!committed.ok) {
			return this.#markClaimUncertain(command, request, claim, controlPlaneFailure(
				"recovery_required",
				"command effect completed but its idempotency receipt was not confirmed durable",
				false,
				{ commandId: command.commandId },
				"uncertain",
			), "commit");
		}
		this.#afterCommit?.(command, executed.value, committed.value);
		const committedResult = committedEffect(command, committed.value.result);
		if (!committedResult.ok) {
			return this.#markClaimUncertain(command, request, claim, {
				ok: false,
				error: committedResult.error,
				effect: "uncertain",
			}, "commit");
		}
		return {
			ok: true,
			value: {
				kind: "command_result",
				commandId: command.commandId,
				type: command.type,
				status: "executed",
				result: committedResult.value,
			},
		};
	}

	public sessionRecoveryState(sessionId: SessionId): SessionMutationRecoveryState | undefined {
		const blocked = this.#blockedSessions.get(sessionId);
		if (!blocked) return undefined;
		return {
			sessionId: blocked.sessionId,
			commandId: blocked.commandId,
			requestDigest: blocked.requestDigest,
			phase: blocked.phase,
		};
	}

	/**
	 * 调用方必须先从 canonical session journal 判定原 mutation 的真实结果。
	 * 这里再把该结果写入 idempotency journal；未完成 terminal write 前不会重开 gate。
	 */
	public async reconcileSession(reconciliation: SessionMutationReconciliation): Promise<ControlPlaneResult<void>> {
		return this.#serializeSessionId(reconciliation.sessionId, async () => {
			const blocked = this.#blockedSessions.get(reconciliation.sessionId);
			if (!blocked) return { ok: true, value: undefined };
			if (
				blocked.commandId !== reconciliation.commandId ||
				blocked.requestDigest !== reconciliation.requestDigest
			) {
				return controlPlaneFailure("idempotency_conflict", "reconciliation does not match the blocked command");
			}
			if (blocked.phase === "claim" || blocked.phase === "commit" || blocked.phase === "reject") {
				return controlPlaneFailure(
					"recovery_required",
					"the command journal terminal state is uncertain and must be reopened before reconciliation",
					false,
					{ commandId: blocked.commandId, phase: blocked.phase },
					"uncertain",
				);
			}

			let inFlight: ControlPlaneResult<readonly CommandClaimToken[]>;
			try {
				inFlight = await this.#idempotency.listInFlight();
			} catch (error) {
				return controlPlaneFailure("adapter_unavailable", "command reconciliation lookup failed", false, {
					errorName: error instanceof Error ? error.name : "UnknownError",
				}, "uncertain");
			}
			if (!inFlight.ok) return inFlight;
			const claim = inFlight.value.find((candidate) => (
				candidate.commandId === blocked.commandId &&
				candidate.requestDigest === blocked.requestDigest
			));
			if (!claim) {
				return controlPlaneFailure(
					"recovery_required",
					"blocked command claim is absent from the current journal view",
					false,
					{ commandId: blocked.commandId },
					"uncertain",
				);
			}

			let terminal: ControlPlaneResult<unknown>;
			if (reconciliation.outcome === "committed") {
				const validation = validateEffect(blocked.command, reconciliation.result);
				if (!validation.ok) return validation;
				try {
					terminal = await this.#idempotency.commit(claim, reconciliation.result);
				} catch (error) {
					this.#blockSession(blocked.command, blocked.request, "commit", claim, true);
					return controlPlaneFailure("recovery_required", "reconciled command receipt commit failed", false, {
						commandId: blocked.commandId,
						errorName: error instanceof Error ? error.name : "UnknownError",
					}, "uncertain");
				}
			} else {
				try {
					terminal = await this.#idempotency.reject(claim, {
						code: "recovery_required",
						message: "reconciliation confirmed that the command had no effect",
						retryable: true,
					});
				} catch (error) {
					this.#blockSession(blocked.command, blocked.request, "reject", claim, true);
					return controlPlaneFailure("recovery_required", "reconciled command rejection failed", false, {
						commandId: blocked.commandId,
						errorName: error instanceof Error ? error.name : "UnknownError",
					}, "uncertain");
				}
			}
			if (!terminal.ok) {
				this.#blockSession(
					blocked.command,
					blocked.request,
					reconciliation.outcome === "committed" ? "commit" : "reject",
					claim,
					true,
				);
				return controlPlaneFailure(
					"recovery_required",
					"reconciled command terminal receipt was not confirmed durable",
					false,
					{ commandId: blocked.commandId },
					"uncertain",
				);
			}
			if (this.#blockedSessions.get(reconciliation.sessionId) === blocked) {
				this.#blockedSessions.delete(reconciliation.sessionId);
			}
			return { ok: true, value: undefined };
		});
	}

	async #safeGuard(command: ControlPlaneCommand, context: ControlPlaneRequestContext): Promise<ControlPlaneResult<void>> {
		try {
			return await this.#stateGuard.validate(command, context);
		} catch (error) {
			return adapterException("mutation state guard", error);
		}
	}

	async #executeClaimed(
		command: ControlPlaneCommand,
		context: ControlPlaneRequestContext,
	): Promise<ControlPlaneResult<ControlPlaneCommandEffect>> {
		try {
			switch (command.type) {
				case "turn:start":
				case "turn:steer":
				case "turn:followUp": {
					const preflight = await this.#prompts.preflight(command, context);
					if (!preflight.ok) return preflight;
					if (
						preflight.value.commandId !== command.commandId ||
						preflight.value.promptDigest !== command.payload.prompt.contentDigest ||
						!/^[a-f0-9]{64}$/.test(preflight.value.preflightDigest)
					) return controlPlaneFailure("adapter_contract_violation", "prompt preflight receipt is invalid");
					const enqueued = await this.#prompts.enqueueDurable(command, preflight.value, context);
					if (!enqueued.ok) return enqueued;
					return { ok: true, value: enqueued.value };
				}
					case "approval:resolve":
					return await this.#approvals.resolve({
						commandId: command.commandId,
						idempotencyKey: command.idempotencyKey,
						authorityId: command.authorityId,
						tenantId: command.tenantId,
						principalId: command.principalId,
						sessionId: command.payload.sessionId,
						approvalId: command.payload.approvalId,
						requestId: command.payload.requestId,
						ticketDigest: command.payload.ticketDigest,
						expectedDecisionRevision: command.payload.expectedDecisionRevision,
								decision: command.payload.resolutionReceipt.decision === "allowed"
									? "allowed"
									: command.payload.resolutionReceipt.decision === "denied"
										? "denied"
										: "cancelled",
								resolutionReceipt: command.payload.resolutionReceipt,
						});
					case "queue:cancel":
						return this.#queues
							? await this.#queues.cancel(command, context)
							: controlPlaneFailure("unsupported_feature", "durable queue control is not wired");
					case "changeProposal:requestDraftPr":
						return this.#changeProposals
							? await this.#changeProposals.requestDraftPr(command, context)
							: controlPlaneFailure("unsupported_feature", "Draft PR provider is not wired");
					case "humanGate:resolve":
						return this.#humanGates
							? await this.#humanGates.resolve(command, context)
							: controlPlaneFailure("unsupported_feature", "human gate coordinator is not wired");
				default:
					return await this.#executor.execute(command, context);
			}
		} catch (error) {
			return adapterException("mutation", error);
		}
	}

	async #failClaim<T>(
		command: ControlPlaneCommand,
		request: CommandClaimRequest,
		claim: CommandClaimToken,
		failure: Extract<ControlPlaneResult<T>, { ok: false }>,
	): Promise<ControlPlaneResult<never>> {
		if (failure.effect === "uncertain") {
			return this.#markClaimUncertain(command, request, claim, failure);
		}
		let rejected: ControlPlaneResult<unknown>;
		try {
			rejected = await this.#idempotency.reject(claim, failure.error);
		} catch (error) {
			this.#blockSession(command, request, "reject", claim);
			return controlPlaneFailure("recovery_required", "failed command rejection adapter failed", false, {
				commandId: claim.commandId,
				errorName: error instanceof Error ? error.name : "UnknownError",
			}, "uncertain");
		}
		if (!rejected.ok) {
			this.#blockSession(command, request, "reject", claim);
			return controlPlaneFailure("recovery_required", "failed command could not be durably rejected", false, {
				commandId: claim.commandId,
			}, "uncertain");
		}
		return failure;
	}

	async #markClaimUncertain<T>(
		command: ControlPlaneCommand,
		request: CommandClaimRequest,
		claim: CommandClaimToken,
		failure: Extract<ControlPlaneResult<T>, { ok: false }>,
		phase: SessionMutationRecoveryPhase = "effect",
	): Promise<ControlPlaneResult<never>> {
		const reasonDigest = canonicalDigest({
			commandId: claim.commandId,
			requestDigest: claim.requestDigest,
			code: failure.error.code,
			message: failure.error.message,
			retryable: failure.error.retryable,
			details: failure.error.details ?? null,
		});
		let marked: ControlPlaneResult<void>;
		try {
			marked = await this.#idempotency.markReconciliationRequired(claim, reasonDigest);
		} catch (error) {
			this.#blockSession(command, request, phase, claim);
			return controlPlaneFailure("recovery_required", "command reconciliation marker failed", false, {
				commandId: claim.commandId,
				errorName: error instanceof Error ? error.name : "UnknownError",
			}, "uncertain");
		}
		this.#blockSession(command, request, phase, claim);
		if (!marked.ok) {
			return controlPlaneFailure("recovery_required", "command reconciliation marker was not confirmed durable", false, {
				commandId: claim.commandId,
			}, "uncertain");
		}
		return { ok: false, error: failure.error, effect: "uncertain" };
	}

	#assertSessionMutationOpen(command: ControlPlaneCommand): ControlPlaneResult<void> {
		const sessionId = commandSessionId(command);
		if (!sessionId) return { ok: true, value: undefined };
		const blocked = this.#blockedSessions.get(sessionId);
		if (!blocked) return { ok: true, value: undefined };
		return controlPlaneFailure(
			"recovery_required",
			"session mutation gate is closed pending command reconciliation",
			false,
			{ sessionId, commandId: blocked.commandId, phase: blocked.phase },
		);
	}

	#blockSession(
		command: ControlPlaneCommand,
		request: CommandClaimRequest,
		phase: SessionMutationRecoveryPhase,
		claim?: CommandClaimToken,
		replace = false,
	): void {
		const sessionId = commandSessionId(command);
		if (!sessionId) return;
		if (!replace && this.#blockedSessions.has(sessionId)) return;
		this.#blockedSessions.set(sessionId, {
			sessionId,
			commandId: request.commandId,
			requestDigest: request.requestDigest,
			phase,
			command,
			request,
			...(claim ? { claim } : {}),
		});
	}

	#serializeSession<T>(command: ControlPlaneCommand, operation: () => Promise<T>): Promise<T> {
		const sessionId = commandSessionId(command);
		return sessionId ? this.#serializeSessionId(sessionId, operation) : operation();
	}

	#serializeSessionId<T>(sessionId: SessionId, operation: () => Promise<T>): Promise<T> {
		const previous = this.#sessionSerial.get(sessionId) ?? Promise.resolve();
		const result = previous.then(operation);
		const barrier = result.then(
			() => undefined,
			() => undefined,
		);
		this.#sessionSerial.set(sessionId, barrier);
		void barrier.finally(() => {
			if (this.#sessionSerial.get(sessionId) === barrier) this.#sessionSerial.delete(sessionId);
		});
		return result;
	}
}
