/** Session Kernel v3 的 Result、writer fence、draft 与验证结果。 */

import type { RuntimeEventPayloadMap } from "../protocol/v3/event-payloads.ts";
import type { RuntimeEventType } from "../protocol/v3/event-catalog.ts";
import type {
	AttestationStatus,
	EventCursor,
	IntegrityStatus,
	RuntimeEventEnvelopeV3,
	RuntimeEventStreamRef,
} from "../protocol/v3/events.ts";
import type {
	AuthorityId,
	EventStreamId,
	LeaseId,
	PrincipalId,
	RuntimeInstanceId,
	SessionId,
	TenantId,
	TraceId,
} from "../protocol/v3/ids.ts";

export const SESSION_KERNEL_ERROR_CODES = [
	"invalid_event",
	"oversized_event",
	"sequence_conflict",
	"hash_mismatch",
	"identity_mismatch",
	"writer_fenced",
	"durable_write_failed",
	"corrupted_log",
	"torn_tail",
	"store_closed",
	"stopped",
	"legacy_read_only",
] as const;

export type SessionKernelErrorCode = (typeof SESSION_KERNEL_ERROR_CODES)[number];

export interface SessionKernelError {
	code: SessionKernelErrorCode;
	message: string;
	retryable: boolean;
	effect?: MutationEffect;
	details?: Readonly<Record<string, string | number | boolean>>;
}

export type SessionResult<T> = { ok: true; value: T } | { ok: false; error: SessionKernelError };

export type MutationEffect = "none" | "committed" | "uncertain";

export interface WriterFence {
	authorityId: AuthorityId;
	tenantId: TenantId;
	stream: RuntimeEventStreamRef;
	leaseId: LeaseId;
	ownerRuntimeId: RuntimeInstanceId;
	writerEpoch: number;
	fencingToken: string;
}

export interface AcceptedEventCursor extends EventCursor {
	writerEpoch: number;
}

export interface DurableEventReceipt {
	streamScope: RuntimeEventStreamRef["scope"];
	streamId: EventStreamId;
	cursor: EventCursor;
	sequence: number;
	eventHash: string;
	writerEpoch: number;
	durableAt: string;
}

export interface RuntimeEventDraft<TType extends RuntimeEventType = RuntimeEventType> {
	type: TType;
	principalId: PrincipalId;
	traceId: TraceId;
	payload: RuntimeEventPayloadMap[TType];
	timestamp?: string;
}

export interface AcceptedRuntimeEvent<TType extends RuntimeEventType = RuntimeEventType> {
	event: RuntimeEventEnvelopeV3<TType>;
	cursor: AcceptedEventCursor;
	durableReceipt?: DurableEventReceipt;
}

export interface EventLogVerification {
	authorityId: AuthorityId;
	tenantId: TenantId;
	stream: RuntimeEventStreamRef;
	integrity: IntegrityStatus;
	attestation: AttestationStatus;
	eventCount: number;
	head?: EventCursor;
	firstBadSequence?: number;
	error?: SessionKernelError;
}

export interface EventPageQuery {
	afterSequence?: number;
	limit: number;
}

export interface EventPage {
	events: readonly RuntimeEventEnvelopeV3[];
	nextCursor?: EventCursor;
	hasMore: boolean;
}
