/** 单 writer queue：唯一分配 sequence/hash，并在 durable append 后推进 head。 */

import { computeRuntimeEventHash, computeRuntimeEventPayloadDigest } from "../protocol/v3/event-hash.ts";
import type { RuntimeEventType } from "../protocol/v3/event-catalog.ts";
import {
	RUNTIME_SCHEMA_VERSION,
	type EventCursor,
	type ExpectedRevision,
	type RuntimeEventEnvelopeV3,
	type RuntimeEventStreamRef,
	type RuntimeEventV3,
} from "../protocol/v3/events.ts";
import { createRuntimeId, type AuthorityId, type TenantId } from "../protocol/v3/ids.ts";
import { validateRuntimeEvent } from "../protocol/v3/schemas.ts";
import type { RuntimeEventStore } from "./event-store.ts";
import type {
	AcceptedEventCursor,
	AcceptedRuntimeEvent,
	DurableEventReceipt,
	RuntimeEventDraft,
	SessionKernelError,
	SessionResult,
	WriterFence,
} from "./types.ts";

export const MANDATORY_FLUSH_EVENT_TYPES: ReadonlySet<RuntimeEventType> = new Set([
	"permission.requested",
	"permission.decided",
	"permission.expired",
	"permission.revoked",
	"tool.started",
	"tool.finished",
	"tool.interrupted",
	"tool.failed",
	"queue.enqueued",
	"queue.claimed",
	"queue.consumed",
	"queue.cancelled",
	"checkpoint.created",
	"checkpoint.rewound",
	"artifact.aborted",
	"artifact.committed",
	"resource.snapshot",
	"resource.lifecycle_recorded",
	"resource.approved",
	"resource.revoked",
	"orchestrator.journal_committed",
	"goal.created",
	"goal.transitioned",
	"task.created",
	"task.definition_revised",
	"task.transitioned",
	"task.output_bound",
	"budget.transaction_committed",
	"session.migration_committed",
	"session.migration_failed",
	"session.stop_requested",
	"session.stopped",
	"session.closed",
	"session.handoff_requested",
	"session.handoff_committed",
	"session.handoff_failed",
	"session.deletion_planned",
	"session.deletion_tombstoned",
	"session.deletion_committed",
	"session.deletion_failed",
	"command.claimed",
	"command.applied",
	"command.rejected",
	"command.reconciliation_required",
	"runtime.replacement_prepared",
	"runtime.generation_activated",
	"runtime.replacement_failed",
	"daemon.shutdown_requested",
	"daemon.shutdown_completed",
	"daemon.shutdown_failed",
	"policy.effective_recorded",
	"policy.normalization_recorded",
	"verification.finished",
	"episode.manifest_committed",
	"episode.seal_recorded",
	"draft_pr.requested",
	"draft_pr.created",
	"draft_pr.failed",
	"human_gate.requested",
	"human_gate.decided",
	"agent.spawned",
	"agent.transitioned",
	"agent.stopped",
	"agent.finished",
	"agent.failed",
	"agent.cleanup_requested",
	"agent.runtime_released",
	"agent.workspace_released",
	"agent.budget_settled",
	"agent.cleanup_reconciliation_required",
	"agent.cleanup_completed",
]);

export interface EventWriterOptions {
	authorityId: AuthorityId;
	tenantId: TenantId;
	stream: RuntimeEventStreamRef;
	store: RuntimeEventStore;
	fence: WriterFence;
	initialHead?: EventCursor;
	clock?: () => Date;
}

export async function openEventWriter(options: Omit<EventWriterOptions, "initialHead">): Promise<SessionResult<EventWriter>> {
	let verified;
	try {
		verified = await options.store.verify(options.stream);
	} catch (error) {
		return failure({
			code: "durable_write_failed",
			message: "event store verification failed",
			retryable: false,
			details: { errorName: error instanceof Error ? error.name : "UnknownError" },
		});
	}
	if (!verified.ok) return verified;
	if (verified.value.integrity === "corrupted") {
		return failure(
			verified.value.error ?? {
				code: "corrupted_log",
				message: "event log is corrupted",
				retryable: false,
			},
		);
	}
	return { ok: true, value: new EventWriter({ ...options, initialHead: verified.value.head }) };
}

function failure<T>(error: SessionKernelError): SessionResult<T> {
	return { ok: false, error };
}

export class EventWriter {
	private readonly authorityId: AuthorityId;
	private readonly tenantId: TenantId;
	private readonly stream: RuntimeEventStreamRef;
	private readonly store: RuntimeEventStore;
	private readonly fence: WriterFence;
	private readonly clock: () => Date;
	private head: EventCursor | undefined;
	private lastAcceptedCursor: AcceptedEventCursor | undefined;
	private terminalError: SessionKernelError | undefined;
	private queue: Promise<void> = Promise.resolve();

	public constructor(options: EventWriterOptions) {
		this.authorityId = options.authorityId;
		this.tenantId = options.tenantId;
		this.stream = options.stream;
		this.store = options.store;
		this.fence = options.fence;
		this.head = options.initialHead;
		this.clock = options.clock ?? (() => new Date());
	}

	public append<TType extends RuntimeEventType>(
		draft: RuntimeEventDraft<TType>,
	): Promise<SessionResult<AcceptedRuntimeEvent<TType>>> {
		const operation = this.queue.then(() => this.appendSafely(draft));
		this.queue = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	private async appendSafely<TType extends RuntimeEventType>(
		draft: RuntimeEventDraft<TType>,
	): Promise<SessionResult<AcceptedRuntimeEvent<TType>>> {
		try {
			return await this.appendOne(draft);
		} catch (error) {
			const terminalError: SessionKernelError = {
				code: "durable_write_failed",
				message: "event writer failed before confirming a durable append",
				retryable: false,
				effect: "uncertain",
				details: { errorName: error instanceof Error ? error.name : "UnknownError" },
			};
			this.terminalError = terminalError;
			return failure(terminalError);
		}
	}

	private async appendOne<TType extends RuntimeEventType>(
		draft: RuntimeEventDraft<TType>,
	): Promise<SessionResult<AcceptedRuntimeEvent<TType>>> {
		if (this.terminalError) return failure(this.terminalError);
		const now = draft.timestamp ?? this.clock().toISOString();
		const sequence = this.head ? this.head.sequence + 1 : 0;
		const previousEventHash = this.head?.eventHash ?? null;
		const payloadDigest = computeRuntimeEventPayloadDigest(draft.payload);
		const eventWithoutHash = {
			schemaVersion: RUNTIME_SCHEMA_VERSION,
			authorityId: this.authorityId,
			tenantId: this.tenantId,
			principalId: draft.principalId,
			eventId: createRuntimeId("event"),
			stream: this.stream,
			sequence,
			timestamp: now,
			type: draft.type,
			previousEventHash,
			payloadDigest,
			traceId: draft.traceId,
		};
		const event: RuntimeEventEnvelopeV3<TType> = {
			...eventWithoutHash,
			currentEventHash: computeRuntimeEventHash(eventWithoutHash),
			payload: draft.payload,
		};
		const schema = validateRuntimeEvent(event);
		if (!schema.ok) {
			return failure({
				code: schema.code === "oversized_payload" ? "oversized_event" : "invalid_event",
				message: schema.message,
				retryable: false,
			});
		}
		const expected: ExpectedRevision | null = this.head
			? { stream: this.head.stream, sequence: this.head.sequence, eventHash: this.head.eventHash }
			: null;
		const appended = await this.store.append(this.stream, event as unknown as RuntimeEventV3, expected, this.fence);
		if (!appended.ok) {
			this.terminalError = appended.error;
			return appended;
		}
		this.head = {
			stream: appended.value.stream,
			sequence: appended.value.sequence,
			eventId: appended.value.eventId,
			eventHash: appended.value.eventHash,
		};
		this.lastAcceptedCursor = appended.value;
		let durableReceipt: DurableEventReceipt | undefined;
		if (MANDATORY_FLUSH_EVENT_TYPES.has(draft.type)) {
			const flushed = await this.store.flushThrough(this.stream, appended.value, this.fence);
			if (!flushed.ok) {
				this.terminalError = flushed.error;
				return flushed;
			}
			durableReceipt = flushed.value;
			this.lastAcceptedCursor = undefined;
		}
		return {
			ok: true,
			value: { event, cursor: appended.value, ...(durableReceipt ? { durableReceipt } : {}) },
		};
	}

	public async flush(): Promise<SessionResult<DurableEventReceipt | undefined>> {
		await this.queue;
		if (this.terminalError) return failure(this.terminalError);
		const cursor = this.lastAcceptedCursor;
		if (!cursor) return { ok: true, value: undefined };
		let result;
		try {
			result = await this.store.flushThrough(this.stream, cursor, this.fence);
		} catch (error) {
			const terminalError: SessionKernelError = {
				code: "durable_write_failed",
				message: "event store flush failed without a receipt",
				retryable: false,
				effect: "uncertain",
				details: { errorName: error instanceof Error ? error.name : "UnknownError" },
			};
			this.terminalError = terminalError;
			return failure(terminalError);
		}
		if (!result.ok) {
			this.terminalError = result.error;
			return result;
		}
		this.lastAcceptedCursor = undefined;
		return { ok: true, value: result.value };
	}

	public currentHead(): EventCursor | undefined {
		return this.head;
	}

	public streamRef(): RuntimeEventStreamRef {
		return { ...this.stream };
	}

	public async close(): Promise<SessionResult<void>> {
		await this.queue;
		const flushed = await this.flush();
		let closed: SessionResult<void>;
		try {
			closed = await this.store.close();
		} catch (error) {
			closed = {
				ok: false,
				error: {
					code: "durable_write_failed",
					message: "event store close failed",
					retryable: false,
					details: { errorName: error instanceof Error ? error.name : "UnknownError" },
				},
			};
		}
		return flushed.ok ? closed : flushed;
	}
}
