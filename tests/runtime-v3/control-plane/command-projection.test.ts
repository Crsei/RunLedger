import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createIdempotencyKey } from "../../../src/runtime/protocol/v3/coordination.ts";
import type { RuntimeEventPayloadMap } from "../../../src/runtime/protocol/v3/event-payloads.ts";
import type { RuntimeEventType } from "../../../src/runtime/protocol/v3/event-catalog.ts";
import {
	createAuthorityTenantEventStreamRef,
	createSessionEventStreamRef,
	RUNTIME_SCHEMA_VERSION,
	type EventCursor,
	type RuntimeEventEnvelopeV3,
	type RuntimeEventV3,
} from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	findCanonicalCommand,
	reduceControlPlaneEvents,
} from "../../../src/runtime/control-plane/command-projection.ts";

const authorityId = createRuntimeId("authority", "command-projection");
const tenantId = createRuntimeId("tenant", "command-projection");
const principalId = createRuntimeId("principal", "command-projection");
const runtimeId = createRuntimeId("runtime", "command-projection");
const sessionId = createRuntimeId("session", "command-projection");
const stream = createAuthorityTenantEventStreamRef({ authorityId, tenantId });
const sessionStream = createSessionEventStreamRef({ authorityId, tenantId }, sessionId);
const D = "d".repeat(64);

function hashFor(sequence: number): string {
	return sequence.toString(16).padStart(64, "0");
}

function event<TType extends RuntimeEventType>(
	type: TType,
	sequence: number,
	payload: RuntimeEventPayloadMap[TType],
): RuntimeEventEnvelopeV3<TType> {
	return {
		schemaVersion: RUNTIME_SCHEMA_VERSION,
		authorityId,
		tenantId,
		principalId,
		eventId: createRuntimeId("event", `command-projection-${sequence}`),
		stream,
		sequence,
		timestamp: `2026-07-22T00:01:${sequence.toString().padStart(2, "0")}.000Z`,
		type,
		previousEventHash: sequence === 0 ? null : hashFor(sequence - 1),
		payloadDigest: canonicalDigest(payload),
		currentEventHash: hashFor(sequence),
		traceId: createRuntimeId("trace", `command-projection-${sequence}`),
		payload,
	};
}

function sessionCursor(sequence: number): EventCursor {
	return {
		stream: sessionStream,
		sequence,
		eventId: createRuntimeId("event", `session-domain-${sequence}`),
		eventHash: canonicalDigest({ session: sequence }),
	};
}

function turnStartEffect(cursor: EventCursor) {
	return {
		type: "turn:start" as const,
		sessionId,
		queueItemId: createRuntimeId("queueItem", `command-projection-${cursor.sequence}`),
		durableCursor: cursor,
		preflightDigest: canonicalDigest({ preflight: cursor.sequence }),
	};
}

function rejection(code: "preflight_rejected" | "internal_error") {
	return {
		code,
		message: `canonical ${code}`,
		retryable: false,
	};
}

function claim(sequence = 0, suffix = "one") {
	return event("command.claimed", sequence, {
		commandId: createRuntimeId("command", `command-${suffix}`),
		commandType: "turn:start",
		idempotencyKey: createIdempotencyKey(`command-projection-${suffix}`),
		requestDigest: canonicalDigest({ request: suffix }),
		requestedBy: principalId,
		runtimeId,
		runtimeGeneration: 1,
		domain: "session",
		subjectSessionId: sessionId,
		domainExpectedRevision: {
			stream: sessionStream,
			sequence: 0,
			eventHash: canonicalDigest({ session: 0 }),
		},
	});
}

function claimRef(value: ReturnType<typeof claim>) {
	return {
		commandId: value.payload.commandId,
		claimEventId: value.eventId,
		requestDigest: value.payload.requestDigest,
	};
}

function projection(events: readonly RuntimeEventV3[]) {
	const result = reduceControlPlaneEvents(events);
	expect(result.ok).toBe(true);
	if (!result.ok || !result.value) throw new Error("expected a control-plane projection");
	return result.value;
}

describe("ControlPlaneProjection", () => {
	it("rebuilds an exact applied command from its claim and domain cursor", () => {
		const claimed = claim();
		const appliedCursor = sessionCursor(1);
		const result = turnStartEffect(appliedCursor);
		const applied = event("command.applied", 1, {
			claim: claimRef(claimed),
			runtimeId,
			runtimeGeneration: 1,
			appliedCursor,
			result,
			resultDigest: canonicalDigest(result),
			effect: "committed",
		});
		const state = projection([claimed, applied]);
		const commandId = createRuntimeId("command", "command-one");
		expect(findCanonicalCommand(state, commandId)).toMatchObject({
			claim: { commandId, commandType: "turn:start", subjectSessionId: sessionId, runtimeId, runtimeGeneration: 1 },
			outcome: { status: "applied", appliedCursor },
		});
	});

	it("fails closed when a typed event object carries a command outside the shared closed set", () => {
		const claimed = claim();
		const tampered = {
			...claimed,
			payload: { ...claimed.payload, commandType: "future:mutate" },
		} as unknown as RuntimeEventV3;
		expect(reduceControlPlaneEvents([tampered])).toMatchObject({ ok: false });
	});

	it("fails closed on missing, mismatched, or oversized canonical terminal values", () => {
		const claimed = claim();
		const appliedCursor = sessionCursor(1);
		const result = turnStartEffect(appliedCursor);
		const applied = event("command.applied", 1, {
			claim: claimRef(claimed),
			runtimeId,
			runtimeGeneration: 1,
			appliedCursor,
			result,
			resultDigest: canonicalDigest(result),
			effect: "committed",
		});
		const { result: _missing, ...missingResult } = applied.payload;
		expect(reduceControlPlaneEvents([
			claimed,
			{ ...applied, payload: missingResult } as unknown as RuntimeEventV3,
		])).toMatchObject({ ok: false, error: { code: "recovery_required" } });
		expect(reduceControlPlaneEvents([
			claimed,
			{
				...applied,
				payload: {
					...applied.payload,
					result: { ...result, preflightDigest: "f".repeat(64) },
				},
			} as unknown as RuntimeEventV3,
		])).toMatchObject({ ok: false, error: { code: "recovery_required" } });

		const error = rejection("internal_error");
		const rejected = event("command.rejected", 1, {
			claim: claimRef(claimed),
			runtimeId,
			runtimeGeneration: 1,
			code: error.code,
			error: { ...error, message: "x".repeat(1025) },
			reasonDigest: canonicalDigest(error),
			retryable: false,
			effect: "none",
		});
		expect(reduceControlPlaneEvents([claimed, rejected])).toMatchObject({
			ok: false,
			error: { code: "recovery_required" },
		});
	});

	it("allows an uncertain command to converge only through the same claim", () => {
		const claimed = claim(0, "uncertain");
		const uncertain = event("command.reconciliation_required", 1, {
			claim: claimRef(claimed),
			runtimeId,
			runtimeGeneration: 1,
			effect: "uncertain",
			reconciliationReceiptId: createRuntimeId("receipt", "command-uncertain"),
			reconciliationDigest: canonicalDigest({ reconcile: "required" }),
		});
		const result = turnStartEffect(sessionCursor(2));
		const applied = event("command.applied", 2, {
			claim: claimRef(claimed),
			runtimeId,
			runtimeGeneration: 1,
			appliedCursor: result.durableCursor,
			result,
			resultDigest: canonicalDigest(result),
			effect: "committed",
		});
		expect(projection([claimed, uncertain]).commands[0]?.outcome.status).toBe("reconciliation_required");
		expect(projection([claimed, uncertain, applied]).commands[0]?.outcome.status).toBe("applied");

		const tampered = {
			...applied,
			payload: { ...applied.payload, claim: { ...applied.payload.claim, requestDigest: D } },
		};
		expect(reduceControlPlaneEvents([claimed, uncertain, tampered])).toMatchObject({ ok: false });
	});

	it("rejects duplicate command identities and idempotency keys", () => {
		const first = claim(0, "duplicate");
		const duplicateId = claim(1, "other");
		const sameId = {
			...duplicateId,
			payload: { ...duplicateId.payload, commandId: first.payload.commandId },
		};
		expect(reduceControlPlaneEvents([first, sameId])).toMatchObject({ ok: false });

		const sameKey = {
			...duplicateId,
			payload: { ...duplicateId.payload, idempotencyKey: first.payload.idempotencyKey },
		};
		expect(reduceControlPlaneEvents([first, sameKey])).toMatchObject({ ok: false });
	});

	it("rejects cross-session result cursors and stale runtime generations", () => {
		const claimed = claim();
		const wrongSessionId = createRuntimeId("session", "other");
		const wrongCursor: EventCursor = {
			stream: createSessionEventStreamRef({ authorityId, tenantId }, wrongSessionId),
			sequence: 1,
			eventId: createRuntimeId("event", "wrong-session"),
			eventHash: D,
		};
		const wrongResult = turnStartEffect(wrongCursor);
		const wrongSession = event("command.applied", 1, {
			claim: claimRef(claimed), runtimeId, runtimeGeneration: 1,
			appliedCursor: wrongCursor, result: wrongResult,
			resultDigest: canonicalDigest(wrongResult), effect: "committed",
		});
		expect(reduceControlPlaneEvents([claimed, wrongSession])).toMatchObject({ ok: false });

		const staleError = rejection("internal_error");
		const staleGeneration = event("command.rejected", 1, {
			claim: claimRef(claimed), runtimeId, runtimeGeneration: 2,
			code: staleError.code, error: staleError,
			reasonDigest: canonicalDigest(staleError), retryable: false, effect: "none",
		});
		expect(reduceControlPlaneEvents([claimed, staleGeneration])).toMatchObject({ ok: false });
	});

	it("keeps mixed authority metadata in the same stream head and stable digest", () => {
		const policy = event("policy.effective_recorded", 0, {
			policyId: createRuntimeId("resource", "command-policy"),
			policyRevision: 1,
			policyDigest: D,
			sourceReceiptId: createRuntimeId("receipt", "command-policy"),
			sourceReceiptDigest: D,
			effectiveAt: "2026-07-22T00:01:00.000Z",
		});
		const claimed = claim(1, "mixed");
		const rejectedError = rejection("preflight_rejected");
		const rejected = event("command.rejected", 2, {
			claim: claimRef(claimed), runtimeId, runtimeGeneration: 1,
			code: rejectedError.code, error: rejectedError,
			reasonDigest: canonicalDigest(rejectedError), retryable: false, effect: "none",
		});
		const events = [policy, claimed, rejected];
		const first = projection(events);
		const second = projection(structuredClone(events));
		expect(first.head.sequence).toBe(2);
		expect(first.commands[0]?.outcome.status).toBe("rejected");
		expect(first.projectionDigest).toBe(second.projectionDigest);
	});
});
