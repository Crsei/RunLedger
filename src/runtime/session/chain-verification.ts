/** 严格 event-chain 验证；任何坏行/缺口/篡改都在首个 cursor fail closed。 */

import { computeRuntimeEventHash, computeRuntimeEventPayloadDigest } from "../protocol/v3/event-hash.ts";
import {
	sameRuntimeEventStream,
	type EventCursor,
	type RuntimeEventStreamRef,
	type RuntimeEventV3,
} from "../protocol/v3/events.ts";
import type { AuthorityId, TenantId } from "../protocol/v3/ids.ts";
import { validateRuntimeEvent } from "../protocol/v3/schemas.ts";
import { reduceSessionEvents } from "./reducer.ts";
import type { EventLogVerification, SessionKernelError } from "./types.ts";

function failure(
	scope: RuntimeEventLogScope,
	eventCount: number,
	sequence: number,
	error: SessionKernelError,
): EventLogVerification {
	return {
		authorityId: scope.authorityId,
		tenantId: scope.tenantId,
		stream: scope.stream,
		integrity: "corrupted",
		attestation: "unattested",
		eventCount,
		firstBadSequence: sequence,
		error,
	};
}

export interface RuntimeEventLogScope {
	authorityId: AuthorityId;
	tenantId: TenantId;
	stream: RuntimeEventStreamRef;
}

export function verifyRuntimeEventChain(
	events: readonly RuntimeEventV3[],
	scope: RuntimeEventLogScope,
): EventLogVerification {
	let previousHash: string | null = null;
	let head: EventCursor | undefined;
	const eventIds = new Set<string>();
	for (let index = 0; index < events.length; index += 1) {
		const event = events[index];
		const schema = validateRuntimeEvent(event);
		if (!schema.ok) {
			return failure(scope, index, index, {
				code: schema.code === "oversized_payload" ? "oversized_event" : "invalid_event",
				message: schema.message,
				retryable: false,
			});
		}
		if (
			event.authorityId !== scope.authorityId ||
			event.tenantId !== scope.tenantId ||
			!sameRuntimeEventStream(event.stream, scope.stream)
		) {
			return failure(scope, index, index, {
				code: "identity_mismatch",
				message: "event authority, tenant, or stream does not match the store",
				retryable: false,
			});
		}
		if (event.sequence !== index || event.previousEventHash !== previousHash) {
			return failure(scope, index, index, {
				code: "sequence_conflict",
				message: "event sequence or previous hash is discontinuous",
				retryable: false,
			});
		}
		if (eventIds.has(event.eventId)) {
			return failure(scope, index, index, {
				code: "invalid_event",
				message: "eventId is duplicated within the session chain",
				retryable: false,
			});
		}
		eventIds.add(event.eventId);
		const payloadDigest = computeRuntimeEventPayloadDigest(event.payload);
		const eventHash = computeRuntimeEventHash(event);
		if (event.payloadDigest !== payloadDigest || event.currentEventHash !== eventHash) {
			return failure(scope, index, index, {
				code: "hash_mismatch",
				message: "payload or event hash does not match canonical content",
				retryable: false,
			});
		}
		previousHash = event.currentEventHash;
		head = {
			stream: event.stream,
			sequence: event.sequence,
			eventId: event.eventId,
			eventHash: event.currentEventHash,
		};
	}
	if (events.length > 0 && scope.stream.scope === "session") {
		const projection = reduceSessionEvents(events);
		if (!projection.ok) {
			const firstBadSequence = typeof projection.error.details?.sequence === "number"
				? projection.error.details.sequence
				: events.length - 1;
			return failure(
					scope,
				Math.max(0, firstBadSequence),
				Math.max(0, firstBadSequence),
				projection.error,
			);
		}
	}
	return {
		authorityId: scope.authorityId,
		tenantId: scope.tenantId,
		stream: scope.stream,
		integrity: "valid",
		attestation: "unattested",
		eventCount: events.length,
		...(head ? { head } : {}),
	};
}
