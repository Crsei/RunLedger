/** canonical authority Event Store-backed command idempotency repository。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import {
	createAuthorityTenantEventStreamRef,
	createSessionEventStreamRef,
	sameRuntimeEventStream,
	type EventCursor,
	type RuntimeEventV3,
} from "../protocol/v3/events.ts";
import { createRuntimeId, type CommandId } from "../protocol/v3/ids.ts";
import { isEventCursor } from "../protocol/v3/schemas.ts";
import {
	AuthorityLifecycleRepository,
	type AuthorityEventCommit,
} from "../session/authority-lifecycle-repository.ts";
import type { SessionResult } from "../session/types.ts";
import {
	reduceControlPlaneEvents,
	type CanonicalCommandProjection,
	type ControlPlaneProjection,
} from "./command-projection.ts";
import {
	controlPlaneFailure,
	isControlPlaneError,
	type ControlPlaneErrorShape,
	type ControlPlaneResult,
} from "./errors.ts";
import type {
	CommandClaimContext,
	CommandClaimOutcome,
	CommandClaimRequest,
	CommandClaimToken,
	CommandIdempotencyRepository,
	CommittedCommandReceipt,
	RejectedCommandReceipt,
} from "./idempotency.ts";
import {
	isControlPlaneCommandEffect,
	type ControlPlaneCommandEffect,
} from "./types.ts";

type MaybePromise<T> = T | Promise<T>;

export interface AuthorityCommandReplay {
	readonly events: readonly RuntimeEventV3[];
	readonly projection: ControlPlaneProjection | null;
}

export interface AuthorityCommandCommitCursorInput {
	readonly claim: CanonicalCommandProjection["claim"];
	readonly result: ControlPlaneCommandEffect;
	readonly events: readonly RuntimeEventV3[];
}

export interface AuthorityCommandAppliedResolutionInput {
	readonly command: CanonicalCommandProjection;
	readonly events: readonly RuntimeEventV3[];
}

export interface AuthorityCommandRejectedResolutionInput {
	readonly command: CanonicalCommandProjection;
	readonly events: readonly RuntimeEventV3[];
}

/** resolver/cache 仅可加速读取；canonical terminal 自包含值始终是唯一事实源。 */
export interface AuthorityCommandIdempotencyOptions {
	readonly clock?: () => Date;
	readonly resolveAppliedCursor?: (
		input: AuthorityCommandCommitCursorInput,
	) => MaybePromise<EventCursor | null>;
	readonly resolveAppliedEffect?: (
		input: AuthorityCommandAppliedResolutionInput,
	) => MaybePromise<ControlPlaneCommandEffect | null>;
	readonly resolveRejectedError?: (
		input: AuthorityCommandRejectedResolutionInput,
	) => MaybePromise<ControlPlaneErrorShape | null>;
}

type CommandMatch =
	| { readonly status: "absent" }
	| { readonly status: "conflict" }
	| { readonly status: "matched"; readonly command: CanonicalCommandProjection };

interface MatchedClaim {
	readonly command: CanonicalCommandProjection;
	readonly claim: CommandClaimToken;
	readonly claimEvent: Extract<RuntimeEventV3, { type: "command.claimed" }>;
}

function authorityFailure<T>(result: Extract<SessionResult<T>, { ok: false }>): ControlPlaneResult<never> {
	return controlPlaneFailure(
		"recovery_required",
		"canonical authority command repository is unavailable or inconsistent",
		false,
		{ sessionErrorCode: result.error.code },
		result.error.effect === "uncertain" ? "uncertain" : "none",
	);
}

function terminalAuthorityFailure<T>(result: Extract<SessionResult<T>, { ok: false }>): ControlPlaneResult<never> {
	return controlPlaneFailure(
		"recovery_required",
		"canonical command terminal event was not confirmed durable",
		false,
		{ sessionErrorCode: result.error.code },
		"uncertain",
	);
}

function sameRequest(left: CommandClaimRequest, right: CommandClaimRequest): boolean {
	return left.commandId === right.commandId &&
		left.idempotencyKey === right.idempotencyKey &&
		left.commandType === right.commandType &&
		left.requestDigest === right.requestDigest;
}

function sameCursor(left: EventCursor, right: EventCursor): boolean {
	return sameRuntimeEventStream(left.stream, right.stream) &&
		left.sequence === right.sequence && left.eventId === right.eventId && left.eventHash === right.eventHash;
}

function sameOptionalRevision(
	left: CommandClaimContext["domainExpectedRevision"],
	right: CanonicalCommandProjection["claim"]["domainExpectedRevision"],
): boolean {
	return canonicalDigest(left) === canonicalDigest(right);
}

function sameRetryContext(
	context: CommandClaimContext,
	projection: ControlPlaneProjection,
	command: CanonicalCommandProjection,
): boolean {
	return context.authorityId === projection.authorityId &&
		context.tenantId === projection.tenantId &&
		context.principalId === command.claim.requestedBy &&
		context.domain === command.claim.domain &&
		context.subjectSessionId === command.claim.subjectSessionId &&
		sameOptionalRevision(context.domainExpectedRevision, command.claim.domainExpectedRevision);
}

function matchRequest(
	projection: ControlPlaneProjection | null,
	request: CommandClaimRequest,
	context?: CommandClaimContext,
): CommandMatch {
	if (!projection) return { status: "absent" };
	const byCommandId = projection.commands.find((candidate) => candidate.claim.commandId === request.commandId);
	const byKey = projection.commands.find((candidate) => candidate.claim.idempotencyKey === request.idempotencyKey);
	if (!byCommandId && !byKey) return { status: "absent" };
	if (
		!byCommandId || !byKey || byCommandId !== byKey ||
		!sameRequest(byCommandId.claim, request) ||
		(context !== undefined && !sameRetryContext(context, projection, byCommandId))
	) return { status: "conflict" };
	return { status: "matched", command: byCommandId };
}

function inferAppliedCursor(result: ControlPlaneCommandEffect): EventCursor | null {
	switch (result.type) {
		case "session:start":
		case "session:resume":
		case "session:fork":
			return result.bootstrap.head;
		case "session:stop":
			return result.terminalCursor;
		case "turn:start":
		case "turn:steer":
		case "turn:followUp":
			return result.durableCursor;
		case "turn:interrupt":
			return result.durableCursor;
		case "queue:cancel":
			return result.receipts.at(-1)?.durableCursor ?? null;
		case "approval:resolve":
		case "changeProposal:requestDraftPr":
		case "humanGate:resolve":
		case "shutdown":
			return null;
	}
}

function terminalEvent(
	replay: AuthorityCommandReplay,
	command: CanonicalCommandProjection,
): RuntimeEventV3 | undefined {
	const cursor = command.outcome.terminalCursor;
	if (!cursor) return undefined;
	const event = replay.events[cursor.sequence];
	return event && event.eventId === cursor.eventId && event.currentEventHash === cursor.eventHash
		? event
		: undefined;
}

function cloneEvents(events: readonly RuntimeEventV3[]): readonly RuntimeEventV3[] {
	return events.map((event) => structuredClone(event));
}

export class AuthorityCommandIdempotencyRepository implements CommandIdempotencyRepository {
	readonly #authority: AuthorityLifecycleRepository;
	readonly #clock: () => Date;
	readonly #resolveAppliedCursor: AuthorityCommandIdempotencyOptions["resolveAppliedCursor"];
	readonly #resolveAppliedEffect: AuthorityCommandIdempotencyOptions["resolveAppliedEffect"];
	readonly #resolveRejectedError: AuthorityCommandIdempotencyOptions["resolveRejectedError"];
	readonly #appliedCache = new Map<CommandId, ControlPlaneCommandEffect>();
	readonly #rejectedCache = new Map<CommandId, ControlPlaneErrorShape>();
	#serial: Promise<void> = Promise.resolve();

	public constructor(
		authority: AuthorityLifecycleRepository,
		options: AuthorityCommandIdempotencyOptions = {},
	) {
		this.#authority = authority;
		this.#clock = options.clock ?? (() => new Date());
		this.#resolveAppliedCursor = options.resolveAppliedCursor;
		this.#resolveAppliedEffect = options.resolveAppliedEffect;
		this.#resolveRejectedError = options.resolveRejectedError;
	}

	#exclusive<T>(operation: () => Promise<ControlPlaneResult<T>>): Promise<ControlPlaneResult<T>> {
		const result = this.#serial.then(operation);
		this.#serial = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	async #replay(): Promise<ControlPlaneResult<AuthorityCommandReplay>> {
		const authority = await this.#authority.replay();
		if (!authority.ok) return authorityFailure(authority);
		const projection = reduceControlPlaneEvents(authority.value.events);
		if (!projection.ok) return projection;
		return {
			ok: true,
			value: { events: authority.value.events, projection: projection.value },
		};
	}

	public replay(): Promise<ControlPlaneResult<AuthorityCommandReplay>> {
		return this.#exclusive(() => this.#replay());
	}

	#claimFromProjection(
		replay: AuthorityCommandReplay,
		command: CanonicalCommandProjection,
	): ControlPlaneResult<MatchedClaim> {
		const claimEvent = replay.events[command.claim.claimCursor.sequence];
		if (
			claimEvent?.type !== "command.claimed" ||
			claimEvent.eventId !== command.claim.claimEventId ||
			claimEvent.currentEventHash !== command.claim.claimCursor.eventHash
		) return controlPlaneFailure("recovery_required", "canonical command claim event cannot be reconstructed");
		return {
			ok: true,
			value: {
				command,
				claimEvent,
				claim: {
					commandId: command.claim.commandId,
					idempotencyKey: command.claim.idempotencyKey,
					commandType: command.claim.commandType,
					requestDigest: command.claim.requestDigest,
					claimToken: command.claim.claimEventId,
					claimedAt: claimEvent.timestamp,
				},
			},
		};
	}

	#matchClaim(
		replay: AuthorityCommandReplay,
		claim: CommandClaimToken,
	): ControlPlaneResult<MatchedClaim> {
		const matched = matchRequest(replay.projection, claim);
		if (matched.status !== "matched") {
			return controlPlaneFailure("idempotency_conflict", "command claim is absent or conflicts with canonical evidence");
		}
		const reconstructed = this.#claimFromProjection(replay, matched.command);
		if (!reconstructed.ok) return reconstructed;
		if (
			reconstructed.value.claim.claimToken !== claim.claimToken ||
			reconstructed.value.claim.claimedAt !== claim.claimedAt
		) return controlPlaneFailure("idempotency_conflict", "command claim token is stale or forged");
		return reconstructed;
	}

	async #restoreApplied(
		replay: AuthorityCommandReplay,
		command: CanonicalCommandProjection,
	): Promise<ControlPlaneResult<CommittedCommandReceipt>> {
		if (command.outcome.status !== "applied") {
			return controlPlaneFailure("recovery_required", "canonical command is not applied");
		}
		const terminal = terminalEvent(replay, command);
		if (terminal?.type !== "command.applied") {
			return controlPlaneFailure("recovery_required", "canonical command applied event is missing");
		}
		if (
			!isControlPlaneCommandEffect(command.outcome.result) ||
			command.outcome.result.type !== command.claim.commandType ||
			canonicalDigest(command.outcome.result) !== command.outcome.resultDigest ||
			canonicalDigest(terminal.payload.result) !== command.outcome.resultDigest
		) return controlPlaneFailure("recovery_required", "canonical command effect conflicts with terminal evidence");
		let accelerated = this.#appliedCache.get(command.claim.commandId);
		if (!accelerated && this.#resolveAppliedEffect) {
			try {
				accelerated = (await this.#resolveAppliedEffect({
					command: structuredClone(command),
					events: cloneEvents(replay.events),
				})) ?? undefined;
			} catch {
				// advisory resolver 失败不能遮蔽 canonical terminal。
			}
		}
		const result = accelerated && isControlPlaneCommandEffect(accelerated) &&
			accelerated.type === command.claim.commandType &&
			canonicalDigest(accelerated) === command.outcome.resultDigest
			? accelerated
			: command.outcome.result;
		this.#appliedCache.set(command.claim.commandId, structuredClone(result));
		return {
			ok: true,
			value: {
				commandId: command.claim.commandId,
				idempotencyKey: command.claim.idempotencyKey,
				commandType: command.claim.commandType,
				requestDigest: command.claim.requestDigest,
				result: structuredClone(result),
				committedAt: terminal.timestamp,
				appliedCursor: structuredClone(command.outcome.appliedCursor),
			},
		};
	}

	async #restoreRejected(
		replay: AuthorityCommandReplay,
		command: CanonicalCommandProjection,
	): Promise<ControlPlaneResult<RejectedCommandReceipt>> {
		if (command.outcome.status !== "rejected") {
			return controlPlaneFailure("recovery_required", "canonical command is not rejected");
		}
		const terminal = terminalEvent(replay, command);
		if (terminal?.type !== "command.rejected") {
			return controlPlaneFailure("recovery_required", "canonical command rejection event is missing");
		}
		if (
			!isControlPlaneError(command.outcome.error) || command.outcome.error.code !== command.outcome.code ||
			command.outcome.error.retryable !== command.outcome.retryable ||
			canonicalDigest(command.outcome.error) !== command.outcome.reasonDigest ||
			canonicalDigest(terminal.payload.error) !== command.outcome.reasonDigest
		) return controlPlaneFailure("recovery_required", "canonical command rejection conflicts with terminal evidence");
		let accelerated = this.#rejectedCache.get(command.claim.commandId);
		if (!accelerated && this.#resolveRejectedError) {
			try {
				accelerated = (await this.#resolveRejectedError({
					command: structuredClone(command),
					events: cloneEvents(replay.events),
				})) ?? undefined;
			} catch {
				// advisory resolver 失败不能遮蔽 canonical terminal。
			}
		}
		const error = accelerated && isControlPlaneError(accelerated) &&
			accelerated.code === command.outcome.code && accelerated.retryable === command.outcome.retryable &&
			canonicalDigest(accelerated) === command.outcome.reasonDigest
			? accelerated
			: command.outcome.error;
		this.#rejectedCache.set(command.claim.commandId, structuredClone(error));
		return {
			ok: true,
			value: {
				commandId: command.claim.commandId,
				idempotencyKey: command.claim.idempotencyKey,
				commandType: command.claim.commandType,
				requestDigest: command.claim.requestDigest,
				error: structuredClone(error),
				rejectedAt: terminal.timestamp,
			},
		};
	}

	async #outcome(
		replay: AuthorityCommandReplay,
		command: CanonicalCommandProjection,
	): Promise<ControlPlaneResult<CommandClaimOutcome>> {
		if (command.outcome.status === "applied") {
			const restored = await this.#restoreApplied(replay, command);
			return restored.ok ? { ok: true, value: { status: "duplicate", receipt: restored.value } } : restored;
		}
		if (command.outcome.status === "rejected") {
			const restored = await this.#restoreRejected(replay, command);
			return restored.ok ? { ok: true, value: { status: "rejected", receipt: restored.value } } : restored;
		}
		const claim = this.#claimFromProjection(replay, command);
		return claim.ok ? { ok: true, value: { status: "in_flight", claim: claim.value.claim } } : claim;
	}

	public lookup(
		request: CommandClaimRequest,
		context?: CommandClaimContext,
	): Promise<ControlPlaneResult<CommandClaimOutcome | null>> {
		return this.#exclusive<CommandClaimOutcome | null>(async () => {
			const replay = await this.#replay();
			if (!replay.ok) return replay;
			const matched = matchRequest(replay.value.projection, request, context);
			if (matched.status === "absent") return { ok: true, value: null };
			if (matched.status === "conflict") return { ok: true, value: { status: "conflict" } };
			return this.#outcome(replay.value, matched.command);
		});
	}

	public claim(
		request: CommandClaimRequest,
		context?: CommandClaimContext,
	): Promise<ControlPlaneResult<CommandClaimOutcome>> {
		return this.#exclusive(async () => {
			const replay = await this.#replay();
			if (!replay.ok) return replay;
			const matched = matchRequest(replay.value.projection, request, context);
			if (matched.status === "conflict") return { ok: true, value: { status: "conflict" } };
			if (matched.status === "matched") return this.#outcome(replay.value, matched.command);
			if (!context) {
				return controlPlaneFailure("adapter_contract_violation", "canonical command claim context is required");
			}
			const expectedStream = createAuthorityTenantEventStreamRef(context);
			if (!sameRuntimeEventStream(expectedStream, this.#authority.streamRef())) {
				return controlPlaneFailure("idempotency_conflict", "command claim authority scope does not match the canonical stream");
			}
			if (!Number.isSafeInteger(context.runtimeGeneration) || context.runtimeGeneration < 1) {
				return controlPlaneFailure("adapter_contract_violation", "command claim runtime generation is invalid");
			}
			const appended = await this.#authority.append({
				type: "command.claimed",
				principalId: context.principalId,
				traceId: context.traceId,
				timestamp: this.#clock().toISOString(),
				payload: {
					commandId: request.commandId,
					commandType: request.commandType,
					idempotencyKey: request.idempotencyKey,
					requestDigest: request.requestDigest,
					requestedBy: context.principalId,
					runtimeId: context.runtimeId,
					runtimeGeneration: context.runtimeGeneration,
					domain: context.domain,
					...(context.subjectSessionId ? { subjectSessionId: context.subjectSessionId } : {}),
					domainExpectedRevision: context.domainExpectedRevision,
				},
			});
			if (!appended.ok) return authorityFailure(appended);
			const after = await this.#replay();
			if (!after.ok) return after;
			const command = after.value.projection?.commands.find((candidate) => (
				candidate.claim.commandId === request.commandId &&
				candidate.claim.claimEventId === appended.value.accepted.event.eventId
			));
			if (!command) {
				return controlPlaneFailure("recovery_required", "durable command claim is absent from canonical projection", false, undefined, "uncertain");
			}
			const claim = this.#claimFromProjection(after.value, command);
			return claim.ok ? { ok: true, value: { status: "claimed", claim: claim.value.claim } } : claim;
		});
	}

	async #resolveCommitCursor(
		replay: AuthorityCommandReplay,
		matched: MatchedClaim,
		result: ControlPlaneCommandEffect,
	): Promise<ControlPlaneResult<EventCursor>> {
		let cursor = inferAppliedCursor(result);
		if (!cursor && this.#resolveAppliedCursor) {
			try {
				cursor = await this.#resolveAppliedCursor({
					claim: structuredClone(matched.command.claim),
					result: structuredClone(result),
					events: cloneEvents(replay.events),
				});
			} catch (error) {
				return controlPlaneFailure("adapter_unavailable", "canonical command cursor resolver failed", false, {
					errorName: error instanceof Error ? error.name : "UnknownError",
				}, "uncertain");
			}
		}
		if (!cursor || !isEventCursor(cursor)) {
			return controlPlaneFailure(
				"recovery_required",
				"command effect has no canonical domain cursor",
				false,
				{ commandId: matched.claim.commandId },
				"uncertain",
			);
		}
		const projection = replay.projection;
		if (!projection) return controlPlaneFailure("recovery_required", "command projection disappeared", false, undefined, "uncertain");
		if (cursor.stream.scope === "authority_tenant") {
			if (!sameRuntimeEventStream(cursor.stream, projection.stream)) {
				return controlPlaneFailure("recovery_required", "command applied cursor crossed its authority stream", false, undefined, "uncertain");
			}
			const domainEvent = replay.events[cursor.sequence];
			if (
				!domainEvent || cursor.sequence <= matched.command.claim.claimCursor.sequence ||
				domainEvent.eventId !== cursor.eventId || domainEvent.currentEventHash !== cursor.eventHash
			) return controlPlaneFailure("recovery_required", "command applied cursor has no matching earlier domain event", false, undefined, "uncertain");
		} else {
			const expected = createSessionEventStreamRef(projection, cursor.stream.sessionId);
			const expectedSessionId = matched.command.claim.commandType === "session:fork" && result.type === "session:fork"
				? result.bootstrap.sessionId
				: matched.command.claim.subjectSessionId;
			if (
				!sameRuntimeEventStream(cursor.stream, expected) ||
				(expectedSessionId !== null && cursor.stream.sessionId !== expectedSessionId)
			) return controlPlaneFailure("recovery_required", "command applied cursor crossed its session domain", false, undefined, "uncertain");
		}
		return { ok: true, value: structuredClone(cursor) };
	}

	#terminalContext(matched: MatchedClaim) {
		return {
			principalId: matched.command.claim.requestedBy,
			traceId: matched.claimEvent.traceId,
			timestamp: this.#clock().toISOString(),
		};
	}

	#claimRef(matched: MatchedClaim) {
		return {
			commandId: matched.claim.commandId,
			claimEventId: matched.command.claim.claimEventId,
			requestDigest: matched.claim.requestDigest,
		};
	}

	#receiptFromKnownEffect(
		replay: AuthorityCommandReplay,
		command: CanonicalCommandProjection,
		result: ControlPlaneCommandEffect,
	): ControlPlaneResult<CommittedCommandReceipt> {
		if (command.outcome.status !== "applied") {
			return controlPlaneFailure("idempotency_conflict", "command is not durably applied");
		}
		const terminal = terminalEvent(replay, command);
		if (terminal?.type !== "command.applied") {
			return controlPlaneFailure("recovery_required", "canonical command applied event is missing");
		}
		return {
			ok: true,
			value: {
				commandId: command.claim.commandId,
				idempotencyKey: command.claim.idempotencyKey,
				commandType: command.claim.commandType,
				requestDigest: command.claim.requestDigest,
				result: structuredClone(result),
				committedAt: terminal.timestamp,
				appliedCursor: structuredClone(command.outcome.appliedCursor),
			},
		};
	}

	public commit(
		claim: CommandClaimToken,
		result: ControlPlaneCommandEffect,
	): Promise<ControlPlaneResult<CommittedCommandReceipt>> {
		return this.#exclusive(async () => {
			if (!isControlPlaneCommandEffect(result) || result.type !== claim.commandType) {
				return controlPlaneFailure("adapter_contract_violation", "command result type does not match claim", false, undefined, "uncertain");
			}
			const replay = await this.#replay();
			if (!replay.ok) return replay;
			const matched = this.#matchClaim(replay.value, claim);
			if (!matched.ok) return matched;
			if (matched.value.command.outcome.status === "rejected") {
				return controlPlaneFailure("idempotency_conflict", "a rejected command cannot become applied");
			}
			const resultDigest = canonicalDigest(result);
			if (matched.value.command.outcome.status === "applied") {
				if (matched.value.command.outcome.resultDigest !== resultDigest) {
					return controlPlaneFailure("idempotency_conflict", "command result conflicts with its canonical receipt");
				}
				this.#appliedCache.set(claim.commandId, structuredClone(result));
				return this.#receiptFromKnownEffect(replay.value, matched.value.command, result);
			}
			const appliedCursor = await this.#resolveCommitCursor(replay.value, matched.value, result);
			if (!appliedCursor.ok) return appliedCursor;
			const appended = await this.#authority.append({
				...this.#terminalContext(matched.value),
				type: "command.applied",
				payload: {
					claim: this.#claimRef(matched.value),
					runtimeId: matched.value.command.claim.runtimeId,
					runtimeGeneration: matched.value.command.claim.runtimeGeneration,
					appliedCursor: appliedCursor.value,
					result: structuredClone(result),
					resultDigest,
					effect: "committed",
				},
			});
			if (!appended.ok) return terminalAuthorityFailure(appended);
			const after = await this.#replay();
			if (!after.ok) return controlPlaneFailure("recovery_required", "canonical command commit cannot be verified", false, undefined, "uncertain");
			const command = after.value.projection?.commands.find((candidate) => candidate.claim.commandId === claim.commandId);
			if (
				command?.outcome.status !== "applied" || command.outcome.resultDigest !== resultDigest ||
				!sameCursor(command.outcome.appliedCursor, appliedCursor.value)
			) return controlPlaneFailure("recovery_required", "canonical command commit projection is inconsistent", false, undefined, "uncertain");
			this.#appliedCache.set(claim.commandId, structuredClone(result));
			return this.#receiptFromKnownEffect(after.value, command, result);
		});
	}

	async #rejectFromReplay(
		replay: AuthorityCommandReplay,
		matched: MatchedClaim,
		error: ControlPlaneErrorShape,
	): Promise<ControlPlaneResult<RejectedCommandReceipt>> {
		const reasonDigest = canonicalDigest(error);
		if (matched.command.outcome.status === "applied") {
			return controlPlaneFailure("idempotency_conflict", "an applied command cannot become rejected");
		}
		if (matched.command.outcome.status === "rejected") {
			if (
				matched.command.outcome.code !== error.code ||
				matched.command.outcome.retryable !== error.retryable ||
				matched.command.outcome.reasonDigest !== reasonDigest
			) return controlPlaneFailure("idempotency_conflict", "command rejection conflicts with its canonical receipt");
			this.#rejectedCache.set(matched.claim.commandId, structuredClone(error));
			return this.#restoreRejected(replay, matched.command);
		}
		const appended = await this.#authority.append({
			...this.#terminalContext(matched),
			type: "command.rejected",
			payload: {
				claim: this.#claimRef(matched),
				runtimeId: matched.command.claim.runtimeId,
				runtimeGeneration: matched.command.claim.runtimeGeneration,
				code: error.code,
				error: structuredClone(error),
				reasonDigest,
				retryable: error.retryable,
				effect: "none",
			},
		});
		if (!appended.ok) return terminalAuthorityFailure(appended);
		const after = await this.#replay();
		if (!after.ok) return controlPlaneFailure("recovery_required", "canonical command rejection cannot be verified", false, undefined, "uncertain");
		const command = after.value.projection?.commands.find((candidate) => candidate.claim.commandId === matched.claim.commandId);
		if (
			command?.outcome.status !== "rejected" || command.outcome.reasonDigest !== reasonDigest ||
			command.outcome.code !== error.code || command.outcome.retryable !== error.retryable
		) return controlPlaneFailure("recovery_required", "canonical command rejection projection is inconsistent", false, undefined, "uncertain");
		this.#rejectedCache.set(matched.claim.commandId, structuredClone(error));
		return this.#restoreRejected(after.value, command);
	}

	public reject(
		claim: CommandClaimToken,
		error: ControlPlaneErrorShape,
	): Promise<ControlPlaneResult<RejectedCommandReceipt>> {
		return this.#exclusive(async () => {
			if (!isControlPlaneError(error)) {
				return controlPlaneFailure("adapter_contract_violation", "command rejection is malformed");
			}
			const replay = await this.#replay();
			if (!replay.ok) return replay;
			const matched = this.#matchClaim(replay.value, claim);
			return matched.ok ? this.#rejectFromReplay(replay.value, matched.value, error) : matched;
		});
	}

	public markReconciliationRequired(
		claim: CommandClaimToken,
		reasonDigest: string,
	): Promise<ControlPlaneResult<void>> {
		return this.#exclusive(async () => {
			if (!/^[a-f0-9]{64}$/.test(reasonDigest)) {
				return controlPlaneFailure("adapter_contract_violation", "command reconciliation digest is invalid", false, undefined, "uncertain");
			}
			const replay = await this.#replay();
			if (!replay.ok) return replay;
			const matched = this.#matchClaim(replay.value, claim);
			if (!matched.ok) return matched;
			if (matched.value.command.outcome.status === "reconciliation_required") {
				return matched.value.command.outcome.reconciliationDigest === reasonDigest
					? { ok: true, value: undefined }
					: controlPlaneFailure("idempotency_conflict", "command reconciliation marker conflicts with canonical evidence");
			}
			if (matched.value.command.outcome.status !== "claimed") {
				return controlPlaneFailure("idempotency_conflict", "terminal command cannot require reconciliation");
			}
			const appended = await this.#authority.append({
				...this.#terminalContext(matched.value),
				type: "command.reconciliation_required",
				payload: {
					claim: this.#claimRef(matched.value),
					runtimeId: matched.value.command.claim.runtimeId,
					runtimeGeneration: matched.value.command.claim.runtimeGeneration,
					effect: "uncertain",
					reconciliationReceiptId: createRuntimeId("receipt"),
					reconciliationDigest: reasonDigest,
				},
			});
			if (!appended.ok) return terminalAuthorityFailure(appended);
			const after = await this.#replay();
			if (!after.ok) return controlPlaneFailure("recovery_required", "canonical reconciliation marker cannot be verified", false, undefined, "uncertain");
			const command = after.value.projection?.commands.find((candidate) => candidate.claim.commandId === claim.commandId);
			return command?.outcome.status === "reconciliation_required" &&
				command.outcome.reconciliationDigest === reasonDigest
				? { ok: true, value: undefined }
				: controlPlaneFailure("recovery_required", "canonical reconciliation projection is inconsistent", false, undefined, "uncertain");
		});
	}

	public abort(claim: CommandClaimToken): Promise<ControlPlaneResult<void>> {
		return this.#exclusive(async () => {
			const replay = await this.#replay();
			if (!replay.ok) return replay;
			const matched = this.#matchClaim(replay.value, claim);
			if (!matched.ok) return matched;
			if (matched.value.command.outcome.status === "applied" || matched.value.command.outcome.status === "rejected") {
				return { ok: true, value: undefined };
			}
			const rejected = await this.#rejectFromReplay(replay.value, matched.value, {
				code: "recovery_required",
				message: "legacy command abort was converted to a durable canonical rejection",
				retryable: false,
			});
			return rejected.ok ? { ok: true, value: undefined } : rejected;
		});
	}

	public listInFlight(): Promise<ControlPlaneResult<readonly CommandClaimToken[]>> {
		return this.#exclusive(async () => {
			const replay = await this.#replay();
			if (!replay.ok) return replay;
			const claims: CommandClaimToken[] = [];
			for (const command of replay.value.projection?.commands ?? []) {
				if (command.outcome.status !== "claimed" && command.outcome.status !== "reconciliation_required") continue;
				const claim = this.#claimFromProjection(replay.value, command);
				if (!claim.ok) return claim;
				claims.push(claim.value.claim);
			}
			return { ok: true, value: claims };
		});
	}
}
