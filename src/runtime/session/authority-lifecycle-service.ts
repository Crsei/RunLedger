/** authority lifecycle intent/commit service；崩溃后未决 intent 必须显式 reconcile。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import type { IdempotencyKey } from "../protocol/v3/coordination.ts";
import type { RuntimeEventPayloadMap } from "../protocol/v3/event-payloads.ts";
import type { EventCursor, RuntimeEventEnvelopeV3, RuntimeEventV3 } from "../protocol/v3/events.ts";
import { parseRuntimeId, type CommandId, type SessionId } from "../protocol/v3/ids.ts";
import {
	authoritySessionLifecycle,
	type AuthorityLifecycleEventType,
	type AuthorityLifecycleProjection,
	type AuthoritySessionLifecycleProjection,
} from "./authority-lifecycle-projection.ts";
import {
	AuthorityLifecycleRepository,
	type AuthorityLifecycleCommit,
	type AuthorityLifecycleReplay,
} from "./authority-lifecycle-repository.ts";
import type { DurableEventReceipt, RuntimeEventDraft, SessionResult } from "./types.ts";

export type AuthorityLifecycleEventContext<TType extends AuthorityLifecycleEventType> = Omit<
	RuntimeEventDraft<TType>,
	"type" | "payload"
>;

export interface AuthorityLifecycleMutation<TType extends AuthorityLifecycleEventType> {
	readonly disposition: "committed" | "replayed";
	readonly event: RuntimeEventEnvelopeV3<TType>;
	readonly cursor: EventCursor;
	readonly durableReceipt?: DurableEventReceipt;
	readonly projection: AuthorityLifecycleProjection;
}

export type AuthorityLifecycleRecoveryDecision =
	| { readonly kind: "ready"; readonly sessionId: SessionId }
	| {
			readonly kind: "reconciliation_required";
			readonly sessionId: SessionId;
			readonly lifecycle: "handoff" | "deletion";
			readonly operationId: CommandId;
			readonly intentCursor: EventCursor;
	  };

function invalid<T>(message: string, details?: Readonly<Record<string, string | number | boolean>>): SessionResult<T> {
	return {
		ok: false,
		error: { code: "invalid_event", message, retryable: false, effect: "none", ...(details ? { details } : {}) },
	};
}

function cursorFor<TType extends AuthorityLifecycleEventType>(event: RuntimeEventEnvelopeV3<TType>): EventCursor {
	return {
		stream: event.stream,
		sequence: event.sequence,
		eventId: event.eventId,
		eventHash: event.currentEventHash,
	};
}

function samePayload(left: unknown, right: unknown): boolean {
	try {
		return canonicalDigest(left) === canonicalDigest(right);
	} catch {
		return false;
	}
}

function unresolved(
	lifecycle: AuthoritySessionLifecycleProjection | undefined,
): Extract<AuthorityLifecycleRecoveryDecision, { kind: "reconciliation_required" }> | undefined {
	if (lifecycle?.deletion &&
		(lifecycle.deletion.state === "planned" || lifecycle.deletion.state === "tombstoned")) {
		return {
			kind: "reconciliation_required",
			sessionId: lifecycle.sessionId,
			lifecycle: "deletion",
			operationId: lifecycle.deletion.deletionId,
			intentCursor: lifecycle.deletion.lastLifecycleCursor,
		};
	}
	if (lifecycle?.handoff?.state === "requested") {
		return {
			kind: "reconciliation_required",
			sessionId: lifecycle.sessionId,
			lifecycle: "handoff",
			operationId: lifecycle.handoff.handoffId,
			intentCursor: lifecycle.handoff.lastLifecycleCursor,
		};
	}
	return undefined;
}

function parseSubjectSessionId(value: string): SessionResult<SessionId> {
	const sessionId = parseRuntimeId("session", value);
	return sessionId ? { ok: true, value: sessionId } : invalid<SessionId>("authority lifecycle subjectSessionId is invalid");
}

function reconciliationFailure<T>(decision: Extract<AuthorityLifecycleRecoveryDecision, { kind: "reconciliation_required" }>): SessionResult<T> {
	return invalid("authority lifecycle has an unresolved durable intent; reconciliation is required", {
		lifecycle: decision.lifecycle,
		operationId: decision.operationId,
		sequence: decision.intentCursor.sequence,
	});
}

export class AuthorityLifecycleService {
	readonly #repository: AuthorityLifecycleRepository;

	public constructor(repository: AuthorityLifecycleRepository) {
		this.#repository = repository;
	}

	public async recoveryDecision(sessionId: SessionId): Promise<SessionResult<AuthorityLifecycleRecoveryDecision>> {
		const replay = await this.#repository.replay();
		if (!replay.ok) return replay;
		return {
			ok: true,
			value: unresolved(authoritySessionLifecycle(replay.value.projection, sessionId)) ?? { kind: "ready", sessionId },
		};
	}

	private async append<TType extends AuthorityLifecycleEventType>(
		type: TType,
		context: AuthorityLifecycleEventContext<TType>,
		payload: RuntimeEventPayloadMap[TType],
	): Promise<SessionResult<AuthorityLifecycleMutation<TType>>> {
		const committed = await this.#repository.append({ ...context, type, payload });
		if (!committed.ok) return committed;
		return this.committedMutation(committed.value);
	}

	private committedMutation<TType extends AuthorityLifecycleEventType>(
		commit: AuthorityLifecycleCommit<TType>,
	): SessionResult<AuthorityLifecycleMutation<TType>> {
		return {
			ok: true,
			value: {
				disposition: "committed",
				event: commit.accepted.event,
				cursor: commit.durableReceipt.cursor,
				durableReceipt: commit.durableReceipt,
				projection: commit.projection,
			},
		};
	}

	private replayedMutation<TType extends AuthorityLifecycleEventType>(
		event: RuntimeEventEnvelopeV3<TType>,
		projection: AuthorityLifecycleProjection,
	): SessionResult<AuthorityLifecycleMutation<TType>> {
		return {
			ok: true,
			value: { disposition: "replayed", event, cursor: cursorFor(event), projection },
		};
	}

	private intentCollision(
		replay: AuthorityLifecycleReplay,
		idempotencyKey: IdempotencyKey,
	): RuntimeEventV3 | undefined {
		return replay.events.find((event) =>
			(event.type === "session.handoff_requested" || event.type === "session.deletion_planned") &&
			event.payload.idempotencyKey === idempotencyKey,
		);
	}

	public async requestHandoff(
		context: AuthorityLifecycleEventContext<"session.handoff_requested">,
		payload: RuntimeEventPayloadMap["session.handoff_requested"],
	): Promise<SessionResult<AuthorityLifecycleMutation<"session.handoff_requested">>> {
		const replay = await this.#repository.replay();
		if (!replay.ok) return replay;
		const sessionId = parseSubjectSessionId(payload.subjectSessionId);
		if (!sessionId.ok) return sessionId;
		const lifecycle = authoritySessionLifecycle(replay.value.projection, sessionId.value);
		const pending = unresolved(lifecycle);
		if (pending) return reconciliationFailure(pending);
		const collision = this.intentCollision(replay.value, payload.idempotencyKey);
		if (collision) {
			if (collision.type !== "session.handoff_requested" || !samePayload(collision.payload, payload)) {
				return invalid("idempotency key is already bound to a different authority lifecycle intent");
			}
			return this.replayedMutation(collision, replay.value.projection);
		}
		const reusedOperation = replay.value.events.find((event) =>
			event.type === "session.handoff_requested" && event.payload.handoffId === payload.handoffId,
		);
		if (reusedOperation) return invalid("handoffId is already bound to an earlier lifecycle intent");
		return this.append("session.handoff_requested", context, payload);
	}

	public async commitHandoff(
		context: AuthorityLifecycleEventContext<"session.handoff_committed">,
		payload: RuntimeEventPayloadMap["session.handoff_committed"],
	): Promise<SessionResult<AuthorityLifecycleMutation<"session.handoff_committed">>> {
		const replay = await this.#repository.replay();
		if (!replay.ok) return replay;
		const sessionId = parseSubjectSessionId(payload.subjectSessionId);
		if (!sessionId.ok) return sessionId;
		const existing = replay.value.events.find((event): event is RuntimeEventEnvelopeV3<"session.handoff_committed"> =>
			event.type === "session.handoff_committed" && event.payload.handoffId === payload.handoffId);
		if (existing) {
			return samePayload(existing.payload, payload)
				? this.replayedMutation(existing, replay.value.projection)
				: invalid("handoff commit payload conflicts with its durable terminal event");
		}
		const lifecycle = authoritySessionLifecycle(replay.value.projection, sessionId.value);
		if (!lifecycle?.handoff || lifecycle.handoff.state !== "requested" ||
			lifecycle.handoff.handoffId !== payload.handoffId) {
			return invalid("handoff commit requires one correlated unresolved request");
		}
		return this.append("session.handoff_committed", context, payload);
	}

	public async failHandoff(
		context: AuthorityLifecycleEventContext<"session.handoff_failed">,
		payload: RuntimeEventPayloadMap["session.handoff_failed"],
	): Promise<SessionResult<AuthorityLifecycleMutation<"session.handoff_failed">>> {
		const replay = await this.#repository.replay();
		if (!replay.ok) return replay;
		const sessionId = parseSubjectSessionId(payload.subjectSessionId);
		if (!sessionId.ok) return sessionId;
		const existing = replay.value.events.find((event): event is RuntimeEventEnvelopeV3<"session.handoff_failed"> =>
			event.type === "session.handoff_failed" && event.payload.handoffId === payload.handoffId);
		if (existing) {
			return samePayload(existing.payload, payload)
				? this.replayedMutation(existing, replay.value.projection)
				: invalid("handoff failure payload conflicts with its durable terminal event");
		}
		const lifecycle = authoritySessionLifecycle(replay.value.projection, sessionId.value);
		if (!lifecycle?.handoff || lifecycle.handoff.state !== "requested" ||
			lifecycle.handoff.handoffId !== payload.handoffId) {
			return invalid("handoff failure requires one correlated unresolved request");
		}
		return this.append("session.handoff_failed", context, payload);
	}

	public async planDeletion(
		context: AuthorityLifecycleEventContext<"session.deletion_planned">,
		payload: RuntimeEventPayloadMap["session.deletion_planned"],
	): Promise<SessionResult<AuthorityLifecycleMutation<"session.deletion_planned">>> {
		const replay = await this.#repository.replay();
		if (!replay.ok) return replay;
		const sessionId = parseSubjectSessionId(payload.subjectSessionId);
		if (!sessionId.ok) return sessionId;
		const lifecycle = authoritySessionLifecycle(replay.value.projection, sessionId.value);
		const pending = unresolved(lifecycle);
		if (pending) return reconciliationFailure(pending);
		const collision = this.intentCollision(replay.value, payload.idempotencyKey);
		if (collision) {
			if (collision.type !== "session.deletion_planned" || !samePayload(collision.payload, payload)) {
				return invalid("idempotency key is already bound to a different authority lifecycle intent");
			}
			return this.replayedMutation(collision, replay.value.projection);
		}
		const reusedOperation = replay.value.events.find((event) =>
			event.type === "session.deletion_planned" && event.payload.deletionId === payload.deletionId,
		);
		if (reusedOperation) return invalid("deletionId is already bound to an earlier lifecycle intent");
		return this.append("session.deletion_planned", context, payload);
	}

	public async tombstoneDeletion(
		context: AuthorityLifecycleEventContext<"session.deletion_tombstoned">,
		payload: RuntimeEventPayloadMap["session.deletion_tombstoned"],
	): Promise<SessionResult<AuthorityLifecycleMutation<"session.deletion_tombstoned">>> {
		const replay = await this.#repository.replay();
		if (!replay.ok) return replay;
		const sessionId = parseSubjectSessionId(payload.subjectSessionId);
		if (!sessionId.ok) return sessionId;
		const existing = replay.value.events.find((event): event is RuntimeEventEnvelopeV3<"session.deletion_tombstoned"> =>
			event.type === "session.deletion_tombstoned" && event.payload.deletionId === payload.deletionId);
		if (existing) {
			return samePayload(existing.payload, payload)
				? this.replayedMutation(existing, replay.value.projection)
				: invalid("deletion tombstone payload conflicts with its durable event");
		}
		const lifecycle = authoritySessionLifecycle(replay.value.projection, sessionId.value);
		if (!lifecycle?.deletion || lifecycle.deletion.state !== "planned" ||
			lifecycle.deletion.legalHoldDecision !== "clear" || lifecycle.deletion.deletionId !== payload.deletionId) {
			return invalid("deletion tombstone requires one correlated clear deletion plan");
		}
		return this.append("session.deletion_tombstoned", context, payload);
	}

	public async commitDeletion(
		context: AuthorityLifecycleEventContext<"session.deletion_committed">,
		payload: RuntimeEventPayloadMap["session.deletion_committed"],
	): Promise<SessionResult<AuthorityLifecycleMutation<"session.deletion_committed">>> {
		const replay = await this.#repository.replay();
		if (!replay.ok) return replay;
		const sessionId = parseSubjectSessionId(payload.subjectSessionId);
		if (!sessionId.ok) return sessionId;
		const existing = replay.value.events.find((event): event is RuntimeEventEnvelopeV3<"session.deletion_committed"> =>
			event.type === "session.deletion_committed" && event.payload.deletionId === payload.deletionId);
		if (existing) {
			return samePayload(existing.payload, payload)
				? this.replayedMutation(existing, replay.value.projection)
				: invalid("deletion commit payload conflicts with its durable terminal event");
		}
		const lifecycle = authoritySessionLifecycle(replay.value.projection, sessionId.value);
		if (!lifecycle?.deletion || lifecycle.deletion.state !== "tombstoned" ||
			lifecycle.deletion.deletionId !== payload.deletionId) {
			return invalid("deletion commit requires one correlated durable tombstone");
		}
		return this.append("session.deletion_committed", context, payload);
	}

	public async failDeletion(
		context: AuthorityLifecycleEventContext<"session.deletion_failed">,
		payload: RuntimeEventPayloadMap["session.deletion_failed"],
	): Promise<SessionResult<AuthorityLifecycleMutation<"session.deletion_failed">>> {
		const replay = await this.#repository.replay();
		if (!replay.ok) return replay;
		const sessionId = parseSubjectSessionId(payload.subjectSessionId);
		if (!sessionId.ok) return sessionId;
		const existing = replay.value.events.find((event): event is RuntimeEventEnvelopeV3<"session.deletion_failed"> =>
			event.type === "session.deletion_failed" && event.payload.deletionId === payload.deletionId);
		if (existing) {
			return samePayload(existing.payload, payload)
				? this.replayedMutation(existing, replay.value.projection)
				: invalid("deletion failure payload conflicts with its durable terminal event");
		}
		const lifecycle = authoritySessionLifecycle(replay.value.projection, sessionId.value);
		if (!lifecycle?.deletion ||
			(lifecycle.deletion.state !== "planned" && lifecycle.deletion.state !== "tombstoned") ||
			lifecycle.deletion.deletionId !== payload.deletionId) {
			return invalid("deletion failure requires one correlated unresolved deletion");
		}
		return this.append("session.deletion_failed", context, payload);
	}
}
