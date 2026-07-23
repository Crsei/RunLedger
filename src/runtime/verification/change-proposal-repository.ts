/** ChangeProposal canonical projection；Artifact 保持正文真源，event 只记录有界 ref。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import { sameRuntimeEventStream, type EventCursor, type ExpectedRevision, type RuntimeEventV3 } from "../protocol/v3/events.ts";
import type { ChangeProposalId, PrincipalId, TraceId } from "../protocol/v3/ids.ts";
import { validateRuntimeEvent } from "../protocol/v3/schemas.ts";
import type { RuntimeEventStore } from "../session/event-store.ts";
import type { EventWriter } from "../session/event-writer.ts";
import type { DurableEventReceipt, SessionResult } from "../session/types.ts";
import { isChangeProposalRef } from "./change-proposal.ts";
import type { ChangeProposalRef } from "./types.ts";

export interface ChangeProposalProjection {
	readonly proposals: ReadonlyMap<ChangeProposalId, ChangeProposalRef>;
	readonly events: ReadonlyMap<ChangeProposalId, Extract<RuntimeEventV3, { type: "change_proposal.recorded" }>>;
	readonly head: EventCursor | null;
	readonly projectionDigest: string;
}

export interface RecordChangeProposalRequest {
	proposal: ChangeProposalRef;
	expectedRevision: ExpectedRevision;
	principalId: PrincipalId;
	traceId: TraceId;
}

export interface RecordChangeProposalResult {
	disposition: "committed" | "replayed";
	event: Extract<RuntimeEventV3, { type: "change_proposal.recorded" }>;
	cursor: EventCursor;
	durableReceipt?: DurableEventReceipt;
}

function invalid<T>(message: string): SessionResult<T> {
	return { ok: false, error: { code: "invalid_event", message, retryable: false, effect: "none" } };
}

function cursorOf(event: RuntimeEventV3): EventCursor {
	return {
		stream: event.stream,
		sequence: event.sequence,
		eventId: event.eventId,
		eventHash: event.currentEventHash,
	};
}

function sameRevision(left: ExpectedRevision, right: EventCursor | null): boolean {
	return right !== null &&
		sameRuntimeEventStream(left.stream, right.stream) &&
		left.sequence === right.sequence &&
		left.eventHash === right.eventHash;
}

async function readAll(store: RuntimeEventStore): Promise<SessionResult<readonly RuntimeEventV3[]>> {
	const events: RuntimeEventV3[] = [];
	let afterSequence: number | undefined;
	for (;;) {
		const page = await store.readPage(store.streamRef(), {
			...(afterSequence === undefined ? {} : { afterSequence }),
			limit: 1000,
		});
		if (!page.ok) return page;
		for (const candidate of page.value.events) {
			const validated = validateRuntimeEvent(candidate);
			if (!validated.ok) {
				return { ok: false, error: { code: "corrupted_log", message: "proposal replay contains an invalid event", retryable: false } };
			}
			events.push(validated.value);
		}
		if (!page.value.hasMore) return { ok: true, value: events };
		const last = page.value.events.at(-1);
		if (!last || last.sequence === afterSequence) {
			return { ok: false, error: { code: "corrupted_log", message: "proposal replay pagination did not advance", retryable: false } };
		}
		afterSequence = last.sequence;
		if (events.length > 1_000_000) {
			return { ok: false, error: { code: "corrupted_log", message: "proposal replay exceeds event limit", retryable: false } };
		}
	}
}

export function projectChangeProposals(events: readonly RuntimeEventV3[]): SessionResult<ChangeProposalProjection> {
	const proposals = new Map<ChangeProposalId, ChangeProposalRef>();
	const proposalEvents = new Map<ChangeProposalId, Extract<RuntimeEventV3, { type: "change_proposal.recorded" }>>();
	let head: EventCursor | null = null;
	for (const event of events) {
		head = cursorOf(event);
		if (event.type !== "change_proposal.recorded") continue;
		const proposal = event.payload.proposal as ChangeProposalRef;
		if (!isChangeProposalRef(proposal)) return invalid("change proposal event contains an invalid ref");
		const existing = proposals.get(proposal.proposalId);
		if (existing && existing.proposalDigest !== proposal.proposalDigest) {
			return invalid("change proposal id has conflicting canonical refs");
		}
		proposals.set(proposal.proposalId, proposal);
		proposalEvents.set(proposal.proposalId, event);
	}
	const body = {
		proposals: [...proposals.entries()].map(([proposalId, proposal]) => ({
			proposalId,
			proposalDigest: proposal.proposalDigest,
		})),
		head,
	};
	return {
		ok: true,
		value: {
			proposals,
			events: proposalEvents,
			head,
			projectionDigest: canonicalDigest(body),
		},
	};
}

export class ChangeProposalRepository {
	readonly #store: RuntimeEventStore;
	readonly #writer: EventWriter;

	public constructor(store: RuntimeEventStore, writer: EventWriter) {
		if (!sameRuntimeEventStream(store.streamRef(), writer.streamRef())) {
			throw new TypeError("ChangeProposal repository store/writer stream mismatch");
		}
		this.#store = store;
		this.#writer = writer;
	}

	public async replay(): Promise<SessionResult<ChangeProposalProjection>> {
		const events = await readAll(this.#store);
		return events.ok ? projectChangeProposals(events.value) : events;
	}

	public async inspect(proposalId: ChangeProposalId): Promise<SessionResult<ChangeProposalRef>> {
		const replay = await this.replay();
		if (!replay.ok) return replay;
		const proposal = replay.value.proposals.get(proposalId);
		return proposal ? { ok: true, value: proposal } : invalid("change proposal was not found");
	}

	public async record(
		request: RecordChangeProposalRequest,
	): Promise<SessionResult<RecordChangeProposalResult>> {
		if (!isChangeProposalRef(request.proposal)) return invalid("change proposal ref is invalid");
		const replay = await this.replay();
		if (!replay.ok) return replay;
		const existing = replay.value.events.get(request.proposal.proposalId);
		if (existing) {
			if (existing.payload.proposal.proposalDigest !== request.proposal.proposalDigest) {
				return invalid("change proposal id was reused with changed input");
			}
			return {
				ok: true,
				value: {
					disposition: "replayed",
					event: existing,
					cursor: cursorOf(existing),
				},
			};
		}
		if (!sameRevision(request.expectedRevision, replay.value.head)) {
			return invalid("change proposal expected revision is stale");
		}
		const appended = await this.#writer.append({
			type: "change_proposal.recorded",
			principalId: request.principalId,
			traceId: request.traceId,
			payload: {
				proposal: request.proposal,
				expectedRevision: {
					stream: request.expectedRevision.stream,
					sequence: request.expectedRevision.sequence,
					eventHash: request.expectedRevision.eventHash,
				},
			},
		});
		return appended.ok
			? {
				ok: true,
				value: {
					disposition: "committed",
					event: appended.value.event,
					cursor: appended.value.cursor,
					...(appended.value.durableReceipt ? { durableReceipt: appended.value.durableReceipt } : {}),
				},
			}
			: appended;
	}
}
