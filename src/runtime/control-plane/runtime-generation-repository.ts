/** Runtime generation 的 authority-stream intent/activate/fail repository。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import type { RuntimeEventPayloadMap } from "../protocol/v3/event-payloads.ts";
import type { EventCursor, RuntimeEventEnvelopeV3, RuntimeEventV3 } from "../protocol/v3/events.ts";
import type { RuntimeEventDraft, SessionResult } from "../session/types.ts";
import {
	AuthorityLifecycleRepository,
	type AuthorityEventCommit,
} from "../session/authority-lifecycle-repository.ts";
import { controlPlaneFailure, type ControlPlaneResult } from "./errors.ts";
import {
	reduceRuntimeGenerationEvents,
	type RuntimeGenerationProjection,
} from "./runtime-generation.ts";

export const RUNTIME_GENERATION_EVENT_TYPES = [
	"runtime.replacement_prepared",
	"runtime.generation_activated",
	"runtime.replacement_failed",
] as const;

export type RuntimeGenerationEventType = (typeof RUNTIME_GENERATION_EVENT_TYPES)[number];

export type RuntimeGenerationEventContext<TType extends RuntimeGenerationEventType> = Omit<
	RuntimeEventDraft<TType>,
	"type" | "payload"
>;

export interface RuntimeGenerationMutation<TType extends RuntimeGenerationEventType> {
	disposition: "committed" | "replayed";
	event: RuntimeEventEnvelopeV3<TType>;
	cursor: EventCursor;
	projection: RuntimeGenerationProjection;
}

export interface RuntimeGenerationReplay {
	events: readonly RuntimeEventV3[];
	projection: RuntimeGenerationProjection | null;
}

function repositoryFailure<T>(result: Extract<SessionResult<T>, { ok: false }>): ControlPlaneResult<never> {
	return controlPlaneFailure(
		"recovery_required",
		"authority runtime generation repository is unavailable or inconsistent",
		false,
		{ sessionErrorCode: result.error.code },
		result.error.effect === "uncertain" ? "uncertain" : "none",
	);
}

function samePayload<TType extends RuntimeGenerationEventType>(
	left: RuntimeEventPayloadMap[TType],
	right: RuntimeEventPayloadMap[TType],
): boolean {
	return canonicalDigest(left) === canonicalDigest(right);
}

function eventCursor<TType extends RuntimeGenerationEventType>(event: RuntimeEventEnvelopeV3<TType>): EventCursor {
	return {
		stream: event.stream,
		sequence: event.sequence,
		eventId: event.eventId,
		eventHash: event.currentEventHash,
	};
}

function matchingEvent(
	events: readonly RuntimeEventV3[],
	type: RuntimeGenerationEventType,
	replacementId: string,
): RuntimeEventV3 | undefined {
	return events.find((candidate) => (
		candidate.type === type &&
		"replacementId" in candidate.payload &&
		candidate.payload.replacementId === replacementId
	));
}

/**
 * 所有 mutation 都通过同一个 AuthorityLifecycleRepository 串行 append，因此不会
 * 产生独立 generation sidecar。调用方仍负责取得真实 composition/fencing receipt。
 */
export class RuntimeGenerationRepository {
	readonly #authority: AuthorityLifecycleRepository;

	public constructor(authority: AuthorityLifecycleRepository) {
		this.#authority = authority;
	}

	public async replay(): Promise<ControlPlaneResult<RuntimeGenerationReplay>> {
		const replay = await this.#authority.replay();
		if (!replay.ok) return repositoryFailure(replay);
		const projection = reduceRuntimeGenerationEvents(replay.value.events);
		if (!projection.ok) return projection;
		return {
			ok: true,
			value: { events: replay.value.events, projection: projection.value },
		};
	}

	async #append<TType extends RuntimeGenerationEventType>(
		type: TType,
		context: RuntimeGenerationEventContext<TType>,
		payload: RuntimeEventPayloadMap[TType],
	): Promise<ControlPlaneResult<RuntimeGenerationMutation<TType>>> {
		const appended = await this.#authority.append({ ...context, type, payload });
		if (!appended.ok) return repositoryFailure(appended);
		return this.#committedMutation(appended.value);
	}

	async #committedMutation<TType extends RuntimeGenerationEventType>(
		commit: AuthorityEventCommit<TType>,
	): Promise<ControlPlaneResult<RuntimeGenerationMutation<TType>>> {
		const replay = await this.replay();
		if (!replay.ok) return replay;
		if (!replay.value.projection) {
			return controlPlaneFailure("recovery_required", "runtime generation append produced no projection");
		}
		return {
			ok: true,
			value: {
				disposition: "committed",
				event: commit.accepted.event,
				cursor: eventCursor(commit.accepted.event),
				projection: replay.value.projection,
			},
		};
	}

	#replayedMutation<TType extends RuntimeGenerationEventType>(
		event: RuntimeEventEnvelopeV3<TType>,
		projection: RuntimeGenerationProjection,
	): ControlPlaneResult<RuntimeGenerationMutation<TType>> {
		return {
			ok: true,
			value: {
				disposition: "replayed",
				event,
				cursor: eventCursor(event),
				projection,
			},
		};
	}

	public async prepare(
		context: RuntimeGenerationEventContext<"runtime.replacement_prepared">,
		payload: RuntimeEventPayloadMap["runtime.replacement_prepared"],
	): Promise<ControlPlaneResult<RuntimeGenerationMutation<"runtime.replacement_prepared">>> {
		const replay = await this.replay();
		if (!replay.ok) return replay;
		const existing = matchingEvent(
			replay.value.events,
			"runtime.replacement_prepared",
			payload.replacementId,
		);
		if (existing?.type === "runtime.replacement_prepared") {
			return samePayload(existing.payload, payload) && replay.value.projection
				? this.#replayedMutation(existing, replay.value.projection)
				: controlPlaneFailure("idempotency_conflict", "runtime replacement preparation conflicts with canonical evidence");
		}
		if (replay.value.projection?.reconciliationRequired) {
			return controlPlaneFailure("recovery_required", "an uncertain runtime replacement must be reconciled first");
		}
		return this.#append("runtime.replacement_prepared", context, payload);
	}

	public async activate(
		context: RuntimeGenerationEventContext<"runtime.generation_activated">,
		payload: RuntimeEventPayloadMap["runtime.generation_activated"],
	): Promise<ControlPlaneResult<RuntimeGenerationMutation<"runtime.generation_activated">>> {
		const replay = await this.replay();
		if (!replay.ok) return replay;
		const existing = matchingEvent(
			replay.value.events,
			"runtime.generation_activated",
			payload.replacementId,
		);
		if (existing?.type === "runtime.generation_activated") {
			return samePayload(existing.payload, payload) && replay.value.projection
				? this.#replayedMutation(existing, replay.value.projection)
				: controlPlaneFailure("idempotency_conflict", "runtime activation conflicts with canonical evidence");
		}
		const prepared = replay.value.projection?.replacements.find((candidate) => (
			candidate.replacementId === payload.replacementId &&
			candidate.candidateRuntimeId === payload.activeRuntimeId &&
			candidate.candidateGeneration === payload.activeGeneration
		));
		if (!prepared || (prepared.status !== "prepared" && prepared.status !== "reconciliation_required")) {
			return controlPlaneFailure("expected_revision_conflict", "runtime activation has no matching prepared candidate");
		}
		return this.#append("runtime.generation_activated", context, payload);
	}

	public async fail(
		context: RuntimeGenerationEventContext<"runtime.replacement_failed">,
		payload: RuntimeEventPayloadMap["runtime.replacement_failed"],
	): Promise<ControlPlaneResult<RuntimeGenerationMutation<"runtime.replacement_failed">>> {
		const replay = await this.replay();
		if (!replay.ok) return replay;
		const existing = matchingEvent(
			replay.value.events,
			"runtime.replacement_failed",
			payload.replacementId,
		);
		if (existing?.type === "runtime.replacement_failed") {
			return samePayload(existing.payload, payload) && replay.value.projection
				? this.#replayedMutation(existing, replay.value.projection)
				: controlPlaneFailure("idempotency_conflict", "runtime replacement failure conflicts with canonical evidence");
		}
		const prepared = replay.value.projection?.replacements.find((candidate) => (
			candidate.replacementId === payload.replacementId &&
			candidate.candidateRuntimeId === payload.candidateRuntimeId &&
			candidate.candidateGeneration === payload.candidateGeneration
		));
		if (!prepared || (prepared.status !== "prepared" && prepared.status !== "activated" &&
			prepared.status !== "reconciliation_required")) {
			return controlPlaneFailure("expected_revision_conflict", "runtime failure has no matching candidate");
		}
		return this.#append("runtime.replacement_failed", context, payload);
	}
}
