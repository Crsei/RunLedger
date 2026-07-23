/** authority/tenant lifecycle stream 的纯 reducer；session stream 不复制 handoff/deletion 真源。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import type { IdempotencyKey } from "../protocol/v3/coordination.ts";
import {
	createAuthorityTenantEventStreamRef,
	createSessionEventStreamRef,
	sameRuntimeEventStream,
	type AuthorityTenantEventStreamRef,
	type EventCursor,
	type RuntimeEventV3,
} from "../protocol/v3/events.ts";
import {
	parseRuntimeId,
	type AuthorityId,
	type CommandId,
	type EventId,
	type ReceiptId,
	type RuntimeInstanceId,
	type SessionId,
	type TenantId,
} from "../protocol/v3/ids.ts";
import { isEventCursor } from "../protocol/v3/schemas.ts";
import { verifyRuntimeEventChain } from "./chain-verification.ts";
import type {
	SessionLifecycleHeadRef,
	SessionProjection,
	SessionProjectionState,
} from "./projections.ts";
import type { SessionResult } from "./types.ts";

export const AUTHORITY_LIFECYCLE_EVENT_TYPES = [
	"session.handoff_requested",
	"session.handoff_committed",
	"session.handoff_failed",
	"session.deletion_planned",
	"session.deletion_tombstoned",
	"session.deletion_committed",
	"session.deletion_failed",
] as const;

export type AuthorityLifecycleEventType = (typeof AUTHORITY_LIFECYCLE_EVENT_TYPES)[number];
export type AuthorityLifecycleRuntimeEvent = Extract<RuntimeEventV3, { type: AuthorityLifecycleEventType }>;

const LIFECYCLE_EVENT_TYPE_SET: ReadonlySet<string> = new Set(AUTHORITY_LIFECYCLE_EVENT_TYPES);

export interface CanonicalSessionHeadRef {
	readonly authorityId: AuthorityId;
	readonly tenantId: TenantId;
	readonly sessionId: SessionId;
	readonly cursor: EventCursor;
}

export interface SessionHandoffLifecycleProjection {
	readonly handoffId: CommandId;
	readonly idempotencyKey: IdempotencyKey;
	readonly state: "requested" | "committed" | "failed";
	readonly finalSessionHead: CanonicalSessionHeadRef;
	readonly sourceAuthorityId: AuthorityId;
	readonly sourceTenantId: TenantId;
	readonly targetAuthorityId: AuthorityId;
	readonly targetTenantId: TenantId;
	readonly referenceGraphDigest: string;
	readonly leaseTransferIntentDigest: string;
	readonly requestedEventId: EventId;
	readonly terminalEventId: EventId | null;
	readonly targetRuntimeId: RuntimeInstanceId | null;
	readonly leaseTransferReceiptId: ReceiptId | null;
	readonly leaseTransferReceiptDigest: string | null;
	readonly failure: AuthorityLifecycleFailure | null;
	readonly lastLifecycleCursor: EventCursor;
}

export interface SessionDeletionLifecycleProjection {
	readonly deletionId: CommandId;
	readonly idempotencyKey: IdempotencyKey;
	readonly state: "planned" | "tombstoned" | "committed" | "failed";
	readonly finalSessionHead: CanonicalSessionHeadRef;
	readonly referenceGraphDigest: string;
	readonly legalHoldDecision: "clear" | "blocked";
	readonly legalHoldReceiptId: ReceiptId;
	readonly legalHoldReceiptDigest: string;
	readonly plannedEventId: EventId;
	readonly tombstoneEventId: EventId | null;
	readonly terminalEventId: EventId | null;
	readonly tombstoneReceiptId: ReceiptId | null;
	readonly tombstoneReceiptDigest: string | null;
	readonly deletionReceiptId: ReceiptId | null;
	readonly deletionReceiptDigest: string | null;
	readonly failure: AuthorityLifecycleFailure | null;
	readonly lastLifecycleCursor: EventCursor;
}

export interface AuthorityLifecycleFailure {
	readonly code: string;
	readonly messageDigest: string;
	readonly retryable: boolean;
	readonly outcomeCertain: boolean;
}

export interface AuthoritySessionLifecycleProjection {
	readonly sessionId: SessionId;
	readonly finalSessionHead: CanonicalSessionHeadRef;
	readonly referenceGraphDigest: string;
	readonly handoff: SessionHandoffLifecycleProjection | null;
	readonly deletion: SessionDeletionLifecycleProjection | null;
	readonly lastLifecycleCursor: EventCursor;
}

export interface AuthorityLifecycleProjectionState {
	readonly authorityId: AuthorityId;
	readonly tenantId: TenantId;
	readonly stream: AuthorityTenantEventStreamRef;
	readonly sessions: readonly AuthoritySessionLifecycleProjection[];
	readonly head: EventCursor | null;
}

export interface AuthorityLifecycleProjection extends AuthorityLifecycleProjectionState {
	readonly projectionDigest: string;
}

function failure<T>(message: string, sequence?: number): SessionResult<T> {
	return {
		ok: false,
		error: {
			code: "invalid_event",
			message,
			retryable: false,
			...(sequence === undefined ? {} : { details: { sequence } }),
		},
	};
}

function cursorFor(event: RuntimeEventV3): EventCursor {
	return {
		stream: event.stream,
		sequence: event.sequence,
		eventId: event.eventId,
		eventHash: event.currentEventHash,
	};
}

function sameCursor(left: EventCursor, right: EventCursor): boolean {
	return (
		sameRuntimeEventStream(left.stream, right.stream) &&
		left.sequence === right.sequence &&
		left.eventId === right.eventId &&
		left.eventHash === right.eventHash
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const sorted = [...expected].sort();
	return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

export function isSessionLifecycleHeadRef(value: unknown): value is SessionLifecycleHeadRef {
	if (!isRecord(value) || !hasExactKeys(value, [
		"authorityId",
		"tenantId",
		"subjectSessionId",
		"stream",
		"cursor",
		"finalSessionHead",
		"lifecycle",
		"state",
		"referenceGraphDigest",
	])) return false;
	const authorityId = typeof value.authorityId === "string" ? parseRuntimeId("authority", value.authorityId) : undefined;
	const tenantId = typeof value.tenantId === "string" ? parseRuntimeId("tenant", value.tenantId) : undefined;
	const sessionId = typeof value.subjectSessionId === "string" ? parseRuntimeId("session", value.subjectSessionId) : undefined;
	if (!authorityId || !tenantId || !sessionId || !isRecord(value.stream) || !isEventCursor(value.cursor) ||
		!isEventCursor(value.finalSessionHead) || typeof value.referenceGraphDigest !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.referenceGraphDigest)) return false;
	const streamId = typeof value.stream.streamId === "string"
		? parseRuntimeId("eventStream", value.stream.streamId)
		: undefined;
	if (value.stream.scope !== "authority_tenant" || !streamId ||
		!hasExactKeys(value.stream, ["scope", "streamId"])) return false;
	const stream: AuthorityTenantEventStreamRef = { scope: "authority_tenant", streamId };
	const canonicalAuthorityStream = createAuthorityTenantEventStreamRef({ authorityId, tenantId });
	const canonicalSessionStream = createSessionEventStreamRef({ authorityId, tenantId }, sessionId);
	if (!sameRuntimeEventStream(stream, canonicalAuthorityStream) ||
		!sameRuntimeEventStream(value.cursor.stream, canonicalAuthorityStream) ||
		!sameRuntimeEventStream(value.finalSessionHead.stream, canonicalSessionStream)) return false;
	if (value.lifecycle === "handoff") {
		return value.state === "requested" || value.state === "committed" || value.state === "failed";
	}
	return value.lifecycle === "deletion" &&
		(value.state === "planned" || value.state === "tombstoned" || value.state === "committed" || value.state === "failed");
}

function parseSessionHead(value: unknown): SessionResult<CanonicalSessionHeadRef> {
	if (!isRecord(value) || !hasExactKeys(value, ["authorityId", "tenantId", "sessionId", "cursor"])) {
		return failure("authority lifecycle final session head is malformed");
	}
	const authorityId = typeof value.authorityId === "string" ? parseRuntimeId("authority", value.authorityId) : undefined;
	const tenantId = typeof value.tenantId === "string" ? parseRuntimeId("tenant", value.tenantId) : undefined;
	const sessionId = typeof value.sessionId === "string" ? parseRuntimeId("session", value.sessionId) : undefined;
	if (!authorityId || !tenantId || !sessionId || !isEventCursor(value.cursor)) {
		return failure("authority lifecycle final session head is invalid");
	}
	const cursor = value.cursor;
	if (
		cursor.stream?.scope !== "session" || cursor.stream.sessionId !== sessionId ||
		!parseRuntimeId("eventStream", cursor.stream.streamId) || !parseRuntimeId("event", cursor.eventId) ||
		!Number.isSafeInteger(cursor.sequence) || cursor.sequence < 0 || !/^[a-f0-9]{64}$/.test(cursor.eventHash)) {
		return failure("authority lifecycle final session head is invalid");
	}
	const expectedStream = createSessionEventStreamRef({ authorityId, tenantId }, sessionId);
	if (!sameRuntimeEventStream(cursor.stream, expectedStream)) {
		return failure("authority lifecycle final session head uses a non-canonical session stream");
	}
	return { ok: true, value: { authorityId, tenantId, sessionId, cursor } };
}

function lifecycleEvent(event: RuntimeEventV3): event is AuthorityLifecycleRuntimeEvent {
	return LIFECYCLE_EVENT_TYPE_SET.has(event.type);
}

function parseCommand(value: string, field: string, sequence: number): SessionResult<CommandId> {
	const parsed = parseRuntimeId("command", value);
	return parsed ? { ok: true, value: parsed } : failure(`${field} is invalid`, sequence);
}

function sessionEntry(
	sessions: Map<SessionId, AuthoritySessionLifecycleProjection>,
	sessionId: SessionId,
): AuthoritySessionLifecycleProjection | undefined {
	return sessions.get(sessionId);
}

function requireSameHead(
	left: CanonicalSessionHeadRef,
	right: CanonicalSessionHeadRef,
	sequence: number,
): SessionResult<void> {
	return left.authorityId === right.authorityId && left.tenantId === right.tenantId &&
		left.sessionId === right.sessionId && sameCursor(left.cursor, right.cursor)
		? { ok: true, value: undefined }
		: failure("authority lifecycle terminal event changed the final session head", sequence);
}

function applyLifecycleEvent(
	sessions: Map<SessionId, AuthoritySessionLifecycleProjection>,
	event: AuthorityLifecycleRuntimeEvent,
): SessionResult<void> {
	const finalHead = parseSessionHead(event.payload.finalSessionHead);
	if (!finalHead.ok) return finalHead;
	const subjectSessionId = parseRuntimeId("session", event.payload.subjectSessionId);
	if (!subjectSessionId || subjectSessionId !== finalHead.value.sessionId) {
		return failure("subjectSessionId does not match the explicit final session head", event.sequence);
	}
	const current = sessionEntry(sessions, subjectSessionId);
	const lifecycleCursor = cursorFor(event);

	switch (event.type) {
		case "session.handoff_requested": {
			const handoffId = parseCommand(event.payload.handoffId, "handoffId", event.sequence);
			const sourceAuthorityId = parseRuntimeId("authority", event.payload.sourceAuthorityId);
			const sourceTenantId = parseRuntimeId("tenant", event.payload.sourceTenantId);
			const targetAuthorityId = parseRuntimeId("authority", event.payload.targetAuthorityId);
			const targetTenantId = parseRuntimeId("tenant", event.payload.targetTenantId);
			if (!handoffId.ok || !sourceAuthorityId || !sourceTenantId || !targetAuthorityId || !targetTenantId) {
				return failure("handoff request identity is invalid", event.sequence);
			}
			if (sourceAuthorityId !== event.authorityId || sourceTenantId !== event.tenantId ||
				finalHead.value.authorityId !== sourceAuthorityId || finalHead.value.tenantId !== sourceTenantId) {
				return failure("handoff request source does not match the authority stream", event.sequence);
			}
			if (current?.deletion?.state === "tombstoned" || current?.deletion?.state === "committed") {
				return failure("a tombstoned session cannot begin handoff", event.sequence);
			}
			if (current?.handoff && current.handoff.state === "requested") {
				return failure("session already has an unresolved handoff", event.sequence);
			}
			const handoff: SessionHandoffLifecycleProjection = {
				handoffId: handoffId.value,
				idempotencyKey: event.payload.idempotencyKey,
				state: "requested",
				finalSessionHead: finalHead.value,
				sourceAuthorityId,
				sourceTenantId,
				targetAuthorityId,
				targetTenantId,
				referenceGraphDigest: event.payload.referenceGraphDigest,
				leaseTransferIntentDigest: event.payload.leaseTransferIntentDigest,
				requestedEventId: event.eventId,
				terminalEventId: null,
				targetRuntimeId: null,
				leaseTransferReceiptId: null,
				leaseTransferReceiptDigest: null,
				failure: null,
				lastLifecycleCursor: lifecycleCursor,
			};
			sessions.set(subjectSessionId, {
				sessionId: subjectSessionId,
				finalSessionHead: finalHead.value,
				referenceGraphDigest: event.payload.referenceGraphDigest,
				handoff,
				deletion: current?.deletion ?? null,
				lastLifecycleCursor: lifecycleCursor,
			});
			return { ok: true, value: undefined };
		}
		case "session.handoff_committed": {
			const handoffId = parseCommand(event.payload.handoffId, "handoffId", event.sequence);
			const targetAuthorityId = parseRuntimeId("authority", event.payload.targetAuthorityId);
			const targetTenantId = parseRuntimeId("tenant", event.payload.targetTenantId);
			const targetRuntimeId = parseRuntimeId("runtime", event.payload.targetRuntimeId);
			const receiptId = parseRuntimeId("receipt", event.payload.leaseTransferReceiptId);
			if (!handoffId.ok || !current?.handoff || current.handoff.state !== "requested" ||
				current.handoff.handoffId !== handoffId.value || !targetAuthorityId || !targetTenantId ||
				!targetRuntimeId || !receiptId || targetAuthorityId !== current.handoff.targetAuthorityId ||
				targetTenantId !== current.handoff.targetTenantId ||
				event.payload.referenceGraphDigest !== current.handoff.referenceGraphDigest) {
				return failure("handoff commit is not correlated to one unresolved request", event.sequence);
			}
			const headMatch = requireSameHead(current.handoff.finalSessionHead, finalHead.value, event.sequence);
			if (!headMatch.ok) return headMatch;
			const handoff: SessionHandoffLifecycleProjection = {
				...current.handoff,
				state: "committed",
				terminalEventId: event.eventId,
				targetRuntimeId,
				leaseTransferReceiptId: receiptId,
				leaseTransferReceiptDigest: event.payload.leaseTransferReceiptDigest,
				lastLifecycleCursor: lifecycleCursor,
			};
			sessions.set(subjectSessionId, { ...current, handoff, lastLifecycleCursor: lifecycleCursor });
			return { ok: true, value: undefined };
		}
		case "session.handoff_failed": {
			const handoffId = parseCommand(event.payload.handoffId, "handoffId", event.sequence);
			if (!handoffId.ok || !current?.handoff || current.handoff.state !== "requested" ||
				current.handoff.handoffId !== handoffId.value) {
				return failure("handoff failure is not correlated to one unresolved request", event.sequence);
			}
			const headMatch = requireSameHead(current.handoff.finalSessionHead, finalHead.value, event.sequence);
			if (!headMatch.ok) return headMatch;
			const handoff: SessionHandoffLifecycleProjection = {
				...current.handoff,
				state: "failed",
				terminalEventId: event.eventId,
				failure: { ...event.payload.error, outcomeCertain: event.payload.outcomeCertain },
				lastLifecycleCursor: lifecycleCursor,
			};
			sessions.set(subjectSessionId, { ...current, handoff, lastLifecycleCursor: lifecycleCursor });
			return { ok: true, value: undefined };
		}
		case "session.deletion_planned": {
			const deletionId = parseCommand(event.payload.deletionId, "deletionId", event.sequence);
			const legalHoldReceiptId = parseRuntimeId("receipt", event.payload.legalHoldReceiptId);
			if (!deletionId.ok || !legalHoldReceiptId || finalHead.value.authorityId !== event.authorityId ||
				finalHead.value.tenantId !== event.tenantId) {
				return failure("deletion plan identity does not match the authority stream", event.sequence);
			}
			if (current?.deletion && current.deletion.state !== "failed") {
				return failure("session already has a durable deletion lifecycle", event.sequence);
			}
			if (current?.handoff?.state === "requested") {
				return failure("session deletion cannot begin during unresolved handoff", event.sequence);
			}
			const deletion: SessionDeletionLifecycleProjection = {
				deletionId: deletionId.value,
				idempotencyKey: event.payload.idempotencyKey,
				state: "planned",
				finalSessionHead: finalHead.value,
				referenceGraphDigest: event.payload.referenceGraphDigest,
				legalHoldDecision: event.payload.legalHoldDecision,
				legalHoldReceiptId,
				legalHoldReceiptDigest: event.payload.legalHoldReceiptDigest,
				plannedEventId: event.eventId,
				tombstoneEventId: null,
				terminalEventId: null,
				tombstoneReceiptId: null,
				tombstoneReceiptDigest: null,
				deletionReceiptId: null,
				deletionReceiptDigest: null,
				failure: null,
				lastLifecycleCursor: lifecycleCursor,
			};
			sessions.set(subjectSessionId, {
				sessionId: subjectSessionId,
				finalSessionHead: finalHead.value,
				referenceGraphDigest: event.payload.referenceGraphDigest,
				handoff: current?.handoff ?? null,
				deletion,
				lastLifecycleCursor: lifecycleCursor,
			});
			return { ok: true, value: undefined };
		}
		case "session.deletion_tombstoned": {
			const deletionId = parseCommand(event.payload.deletionId, "deletionId", event.sequence);
			const plannedEventId = parseRuntimeId("event", event.payload.plannedEventId);
			const receiptId = parseRuntimeId("receipt", event.payload.tombstoneReceiptId);
			if (!deletionId.ok || !current?.deletion || current.deletion.state !== "planned" ||
				current.deletion.legalHoldDecision !== "clear" || current.deletion.deletionId !== deletionId.value ||
				!plannedEventId || plannedEventId !== current.deletion.plannedEventId || !receiptId ||
				event.payload.referenceGraphDigest !== current.deletion.referenceGraphDigest) {
				return failure("deletion tombstone is not correlated to one clear deletion plan", event.sequence);
			}
			const headMatch = requireSameHead(current.deletion.finalSessionHead, finalHead.value, event.sequence);
			if (!headMatch.ok) return headMatch;
			const deletion: SessionDeletionLifecycleProjection = {
				...current.deletion,
				state: "tombstoned",
				tombstoneEventId: event.eventId,
				tombstoneReceiptId: receiptId,
				tombstoneReceiptDigest: event.payload.tombstoneReceiptDigest,
				lastLifecycleCursor: lifecycleCursor,
			};
			sessions.set(subjectSessionId, { ...current, deletion, lastLifecycleCursor: lifecycleCursor });
			return { ok: true, value: undefined };
		}
		case "session.deletion_committed": {
			const deletionId = parseCommand(event.payload.deletionId, "deletionId", event.sequence);
			const tombstoneEventId = parseRuntimeId("event", event.payload.tombstoneEventId);
			const receiptId = parseRuntimeId("receipt", event.payload.deletionReceiptId);
			if (!deletionId.ok || !current?.deletion || current.deletion.state !== "tombstoned" ||
				current.deletion.deletionId !== deletionId.value || !tombstoneEventId ||
				tombstoneEventId !== current.deletion.tombstoneEventId || !receiptId ||
				event.payload.referenceGraphDigest !== current.deletion.referenceGraphDigest) {
				return failure("deletion commit is not correlated to one durable tombstone", event.sequence);
			}
			const headMatch = requireSameHead(current.deletion.finalSessionHead, finalHead.value, event.sequence);
			if (!headMatch.ok) return headMatch;
			const deletion: SessionDeletionLifecycleProjection = {
				...current.deletion,
				state: "committed",
				terminalEventId: event.eventId,
				deletionReceiptId: receiptId,
				deletionReceiptDigest: event.payload.deletionReceiptDigest,
				lastLifecycleCursor: lifecycleCursor,
			};
			sessions.set(subjectSessionId, { ...current, deletion, lastLifecycleCursor: lifecycleCursor });
			return { ok: true, value: undefined };
		}
		case "session.deletion_failed": {
			const deletionId = parseCommand(event.payload.deletionId, "deletionId", event.sequence);
			if (!deletionId.ok || !current?.deletion ||
				(current.deletion.state !== "planned" && current.deletion.state !== "tombstoned") ||
				current.deletion.deletionId !== deletionId.value) {
				return failure("deletion failure is not correlated to an unresolved deletion", event.sequence);
			}
			const headMatch = requireSameHead(current.deletion.finalSessionHead, finalHead.value, event.sequence);
			if (!headMatch.ok) return headMatch;
			const deletion: SessionDeletionLifecycleProjection = {
				...current.deletion,
				state: "failed",
				terminalEventId: event.eventId,
				failure: { ...event.payload.error, outcomeCertain: event.payload.outcomeCertain },
				lastLifecycleCursor: lifecycleCursor,
			};
			sessions.set(subjectSessionId, { ...current, deletion, lastLifecycleCursor: lifecycleCursor });
			return { ok: true, value: undefined };
		}
	}
}

function projectionState(
	authorityId: AuthorityId,
	tenantId: TenantId,
	stream: AuthorityTenantEventStreamRef,
	sessions: Map<SessionId, AuthoritySessionLifecycleProjection>,
	head: EventCursor | null,
): AuthorityLifecycleProjectionState {
	return {
		authorityId,
		tenantId,
		stream,
		sessions: [...sessions.values()].sort((left, right) => left.sessionId.localeCompare(right.sessionId)),
		head,
	};
}

export function reduceAuthorityLifecycleEvents(
	events: readonly RuntimeEventV3[],
	scope: { authorityId: AuthorityId; tenantId: TenantId; stream: AuthorityTenantEventStreamRef },
): SessionResult<AuthorityLifecycleProjection> {
	const canonicalStream = createAuthorityTenantEventStreamRef(scope);
	if (!sameRuntimeEventStream(scope.stream, canonicalStream)) {
		return failure("authority lifecycle reducer requires the canonical authority/tenant stream");
	}
	const verification = verifyRuntimeEventChain(events, scope);
	if (verification.integrity !== "valid") {
		return {
			ok: false,
			error: verification.error ?? {
				code: "corrupted_log",
				message: "authority lifecycle event chain is invalid",
				retryable: false,
			},
		};
	}
	const sessions = new Map<SessionId, AuthoritySessionLifecycleProjection>();
	for (const event of events) {
		if (!lifecycleEvent(event)) continue;
		const applied = applyLifecycleEvent(sessions, event);
		if (!applied.ok) return applied;
	}
	const state = projectionState(scope.authorityId, scope.tenantId, scope.stream, sessions, verification.head ?? null);
	return { ok: true, value: { ...state, projectionDigest: canonicalDigest(state) } };
}

function projectionStateWithoutDigest(projection: SessionProjection): SessionProjectionState {
	const { projectionDigest: _projectionDigest, ...state } = projection;
	return state;
}

function validSessionProjectionDigest(projection: SessionProjection): boolean {
	try {
		return canonicalDigest(projectionStateWithoutDigest(projection)) === projection.projectionDigest;
	} catch {
		return false;
	}
}

function lifecycleHeadRef(
	projection: AuthorityLifecycleProjection,
	lifecycle: AuthoritySessionLifecycleProjection,
): SessionLifecycleHeadRef {
	const deletionIsHead = lifecycle.deletion !== null &&
		sameCursor(lifecycle.deletion.lastLifecycleCursor, lifecycle.lastLifecycleCursor);
	const handoffIsHead = lifecycle.handoff !== null &&
		sameCursor(lifecycle.handoff.lastLifecycleCursor, lifecycle.lastLifecycleCursor);
	if (deletionIsHead && lifecycle.deletion) {
		return {
			authorityId: projection.authorityId,
			tenantId: projection.tenantId,
			subjectSessionId: lifecycle.sessionId,
			stream: projection.stream,
			cursor: lifecycle.lastLifecycleCursor,
			finalSessionHead: lifecycle.finalSessionHead.cursor,
			lifecycle: "deletion",
			state: lifecycle.deletion.state,
			referenceGraphDigest: lifecycle.referenceGraphDigest,
		};
	}
	if (handoffIsHead && lifecycle.handoff) {
		return {
			authorityId: projection.authorityId,
			tenantId: projection.tenantId,
			subjectSessionId: lifecycle.sessionId,
			stream: projection.stream,
			cursor: lifecycle.lastLifecycleCursor,
			finalSessionHead: lifecycle.finalSessionHead.cursor,
			lifecycle: "handoff",
			state: lifecycle.handoff.state,
			referenceGraphDigest: lifecycle.referenceGraphDigest,
		};
	}
	throw new TypeError("authority lifecycle projection has no correlated lifecycle head");
}

/** 只通过显式 authority projection 与 final session head 做 join；不比较跨 stream sequence。 */
export function joinSessionLifecycle(
	session: SessionProjection,
	authorityLifecycle: AuthorityLifecycleProjection,
): SessionResult<SessionProjection> {
	if (!validSessionProjectionDigest(session)) return failure("session projection digest is invalid");
	if (
		session.authorityId !== authorityLifecycle.authorityId ||
		session.tenantId !== authorityLifecycle.tenantId
	) return failure("session and authority lifecycle scope do not match");
	const canonicalAuthorityStream = createAuthorityTenantEventStreamRef(authorityLifecycle);
	if (!sameRuntimeEventStream(authorityLifecycle.stream, canonicalAuthorityStream)) {
		return failure("authority lifecycle projection uses a non-canonical stream");
	}
	const lifecycle = authoritySessionLifecycle(authorityLifecycle, session.sessionId);
	if (!lifecycle) return failure("authority lifecycle has no explicit reference for the session");
	const sessionHead: EventCursor = {
		stream: session.stream,
		sequence: session.headSequence,
		eventId: session.headEventId,
		eventHash: session.headEventHash,
	};
	if (!sameCursor(lifecycle.finalSessionHead.cursor, sessionHead)) {
		return failure("authority lifecycle final session head does not match the session projection");
	}
	if (!sameRuntimeEventStream(lifecycle.lastLifecycleCursor.stream, authorityLifecycle.stream)) {
		return failure("authority lifecycle head cursor is outside the authority stream");
	}
	const reference = lifecycleHeadRef(authorityLifecycle, lifecycle);
	if (session.lifecycleHeadRef && canonicalDigest(session.lifecycleHeadRef) !== canonicalDigest(reference)) {
		return failure("session projection is already joined to a different lifecycle head");
	}
	const state: SessionProjectionState = {
		...projectionStateWithoutDigest(session),
		lifecycleHeadRef: reference,
	};
	return { ok: true, value: { ...state, projectionDigest: canonicalDigest(state) } };
}

export function authoritySessionLifecycle(
	projection: AuthorityLifecycleProjection,
	sessionId: SessionId,
): AuthoritySessionLifecycleProjection | undefined {
	return projection.sessions.find((entry) => entry.sessionId === sessionId);
}

export function requireCommittedDeletionForGc(
	projection: AuthorityLifecycleProjection,
	sessionId: SessionId,
	finalSessionHead: EventCursor,
	referenceGraphDigest: string,
): SessionResult<SessionDeletionLifecycleProjection> {
	const lifecycle = authoritySessionLifecycle(projection, sessionId);
	const deletion = lifecycle?.deletion;
	if (!deletion || deletion.state !== "committed" || !deletion.tombstoneEventId || !deletion.tombstoneReceiptId ||
		!deletion.deletionReceiptId || deletion.referenceGraphDigest !== referenceGraphDigest ||
		!sameCursor(deletion.finalSessionHead.cursor, finalSessionHead)) {
		return failure("GC requires a correlated durable deletion tombstone and commit");
	}
	return { ok: true, value: deletion };
}
