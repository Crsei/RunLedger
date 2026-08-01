import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../../src/runtime/protocol/canonical-json.ts";
import { RUNTIME_EVENT_TYPES } from "../../src/runtime/protocol/events.ts";
import { createRuntimeId } from "../../src/runtime/protocol/ids.ts";
import { RUNTIME_EVENT_PAYLOAD_SCHEMAS, validateRuntimeEvent } from "../../src/runtime/protocol/schemas.ts";

function sha256(value: unknown) {
	return { algorithm: "sha256", digest: canonicalDigest(value) } as const;
}

function sessionCreatedEvent() {
	const payload = {
		subject: {
			kind: "session",
			id: createRuntimeId("session", "fixture"),
		},
		correlationId: createRuntimeId("trace", "fixture"),
		effect: "committed",
		transition: {
			revision: 0,
			previousStatus: null,
			nextStatus: "created",
		},
		bindings: [
			{ role: "root_goal", subjectId: createRuntimeId("goal", "fixture") },
			{ role: "root_agent", subjectId: createRuntimeId("agent", "fixture") },
		],
	};
	const eventWithoutHash = {
		authorityId: createRuntimeId("authority", "fixture"),
		tenantId: createRuntimeId("tenant", "fixture"),
		principalId: createRuntimeId("principal", "fixture"),
		eventId: createRuntimeId("event", "fixture"),
		stream: {
			scope: "session",
			streamId: createRuntimeId("session", "fixture"),
			sessionId: createRuntimeId("session", "fixture"),
		},
		sequence: 0,
		timestamp: "2026-08-01T00:00:00.000Z",
		type: "session.created",
		previousEventHash: null,
		payloadDigest: sha256(payload),
		traceId: createRuntimeId("trace", "fixture"),
		payload,
	} as const;
	const currentEventHash = sha256({
		authorityId: eventWithoutHash.authorityId,
		tenantId: eventWithoutHash.tenantId,
		principalId: eventWithoutHash.principalId,
		eventId: eventWithoutHash.eventId,
		stream: eventWithoutHash.stream,
		sequence: eventWithoutHash.sequence,
		timestamp: eventWithoutHash.timestamp,
		type: eventWithoutHash.type,
		previousEventHash: eventWithoutHash.previousEventHash,
		payloadDigest: eventWithoutHash.payloadDigest,
		traceId: eventWithoutHash.traceId,
	});
	return { ...eventWithoutHash, currentEventHash };
}

describe("Runtime exact event contract", () => {
	it("freezes all planned event names without retired aliases", () => {
		expect(new Set(RUNTIME_EVENT_TYPES).size).toBe(RUNTIME_EVENT_TYPES.length);
		expect(RUNTIME_EVENT_TYPES).toContain("session.created");
		expect(RUNTIME_EVENT_TYPES).toContain("session.handoff_committed");
		expect(RUNTIME_EVENT_TYPES).toContain("task.definition_revised");
		expect(RUNTIME_EVENT_TYPES).toContain("agent.merge_committed");
		expect(RUNTIME_EVENT_TYPES).toContain("capability.rate_limit_recorded");
		expect(RUNTIME_EVENT_TYPES).toContain("episode.seal_recorded");
		expect(RUNTIME_EVENT_TYPES).toContain("resource.snapshot_acquired");
		expect(RUNTIME_EVENT_TYPES).toContain("command.reconciliation_required");
		expect(RUNTIME_EVENT_TYPES).toContain("telemetry.delivery_recorded");
		expect(RUNTIME_EVENT_TYPES).not.toContain("session.started");
		expect(RUNTIME_EVENT_TYPES).not.toContain("resource.snapshot");
		expect(Object.keys(RUNTIME_EVENT_PAYLOAD_SCHEMAS)).toEqual([...RUNTIME_EVENT_TYPES]);
		expect(new Set(Object.values(RUNTIME_EVENT_PAYLOAD_SCHEMAS)).size).toBe(RUNTIME_EVENT_TYPES.length);
	});

	it("accepts a type-bound exact payload and rejects unknown fields", () => {
		const event = sessionCreatedEvent();
		expect(validateRuntimeEvent(event)).toEqual({ ok: true, value: event });
		expect(validateRuntimeEvent({ ...event, sessionId: event.stream.sessionId })).toMatchObject({ ok: false });
		expect(validateRuntimeEvent({ ...event, payload: { ...event.payload, rawPrompt: "secret" } })).toMatchObject({
			ok: false,
		});
	});

	it("rejects subject/type mismatches, oversize metadata, and tampering", () => {
		const event = sessionCreatedEvent();
		expect(validateRuntimeEvent({
			...event,
			payload: { ...event.payload, subject: { kind: "goal", id: createRuntimeId("goal", "wrong") } },
		})).toMatchObject({ ok: false });
		expect(validateRuntimeEvent({
			...event,
			payload: { ...event.payload, reasonCode: "x".repeat(129) },
		})).toMatchObject({ ok: false });
		expect(validateRuntimeEvent({
			...event,
			payload: { ...event.payload, effect: "uncertain" },
		})).toMatchObject({ ok: false, code: "invalid_digest" });
	});
});
