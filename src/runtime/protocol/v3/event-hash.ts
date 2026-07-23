/** Runtime v3 payload digest 与 event hash 的唯一计算规则。 */

import { canonicalDigest } from "./canonical-json.ts";
import type { RuntimeEventType } from "./event-catalog.ts";
import type {
	AuthorityId,
	EventId,
	PrincipalId,
	TenantId,
	TraceId,
} from "./ids.ts";
import type { RuntimeEventStreamRef } from "./events.ts";

export interface RuntimeEventHashInput {
	schemaVersion: 3;
	authorityId: AuthorityId;
	tenantId: TenantId;
	principalId: PrincipalId;
	eventId: EventId;
	stream: RuntimeEventStreamRef;
	sequence: number;
	timestamp: string;
	type: RuntimeEventType;
	previousEventHash: string | null;
	payloadDigest: string;
	traceId: TraceId;
}

export function computeRuntimeEventPayloadDigest(payload: unknown): string {
	return canonicalDigest(payload);
}

export function computeRuntimeEventHash(input: RuntimeEventHashInput): string {
	return canonicalDigest({
		schemaVersion: input.schemaVersion,
		authorityId: input.authorityId,
		tenantId: input.tenantId,
		principalId: input.principalId,
		eventId: input.eventId,
		stream: input.stream,
		sequence: input.sequence,
		timestamp: input.timestamp,
		type: input.type,
		previousEventHash: input.previousEventHash,
		payloadDigest: input.payloadDigest,
		traceId: input.traceId,
	});
}
