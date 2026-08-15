import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../../src/runtime/protocol/canonical-json.ts";
import { RUNTIME_EVENT_TYPES, type RuntimeEvent, type RuntimeEventType } from "../../src/runtime/protocol/events.ts";
import { createRuntimeId } from "../../src/runtime/protocol/ids.ts";
import {
	RUNTIME_EVENT_PAYLOAD_REQUIREMENTS,
	RUNTIME_EVENT_PAYLOAD_SCHEMAS,
	validateRuntimeEvent,
} from "../../src/runtime/protocol/schemas.ts";

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
		idempotencyKey: "session-create-fixture",
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

function agentProjectionEvent(type: RuntimeEventType, payload: Record<string, unknown>): RuntimeEvent {
	const eventWithoutHash = {
		authorityId: createRuntimeId("authority", "agent-contract"),
		tenantId: createRuntimeId("tenant", "agent-contract"),
		principalId: createRuntimeId("principal", "agent-contract"),
		eventId: createRuntimeId("event", `agent-${type.replaceAll(".", "-")}`),
		stream: {
			scope: "session" as const,
			streamId: createRuntimeId("session", "agent-contract"),
			sessionId: createRuntimeId("session", "agent-contract"),
		},
		sequence: 0,
		timestamp: "2026-08-01T00:00:00.000Z",
		type,
		previousEventHash: null,
		payloadDigest: sha256(payload),
		traceId: createRuntimeId("trace", `agent-${type.replaceAll(".", "-")}`),
		payload,
	};
	return {
		...eventWithoutHash,
		currentEventHash: sha256({
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
		}),
	} as unknown as RuntimeEvent;
}

describe("Runtime exact event contract", () => {
	it("freezes all planned event names without retired aliases", () => {
		expect(new Set(RUNTIME_EVENT_TYPES).size).toBe(RUNTIME_EVENT_TYPES.length);
		expect(RUNTIME_EVENT_TYPES).toContain("session.created");
		expect(RUNTIME_EVENT_TYPES).toContain("session.handoff_committed");
		expect(RUNTIME_EVENT_TYPES).toContain("task.definition_revised");
		expect(RUNTIME_EVENT_TYPES).toContain("agent.root_registered");
		expect(RUNTIME_EVENT_TYPES).toContain("agent.activated");
		expect(RUNTIME_EVENT_TYPES).toContain("agent.reconciliation_required");
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
		expect(Object.keys(RUNTIME_EVENT_PAYLOAD_REQUIREMENTS)).toEqual([...RUNTIME_EVENT_TYPES]);
		for (const type of RUNTIME_EVENT_TYPES) {
			expect(RUNTIME_EVENT_PAYLOAD_REQUIREMENTS[type].length, type).toBeGreaterThan(0);
		}
		expect(RUNTIME_EVENT_PAYLOAD_REQUIREMENTS["session.created"]).toEqual([
			"transition",
			"bindings",
			"idempotencyKey",
		]);
		expect(RUNTIME_EVENT_PAYLOAD_REQUIREMENTS["permission.decided"]).toEqual([
			"transition",
			"refs",
			"expectedRevision",
		]);
		expect(RUNTIME_EVENT_PAYLOAD_REQUIREMENTS["agent.root_registered"]).toEqual([
			"transition",
			"idempotencyKey",
		]);
		expect(RUNTIME_EVENT_PAYLOAD_REQUIREMENTS["agent.activated"]).toEqual([
			"transition",
			"refs",
			"expectedRevision",
		]);
		expect(RUNTIME_EVENT_PAYLOAD_REQUIREMENTS["agent.reconciliation_required"]).toEqual([
			"transition",
			"refs",
			"expectedRevision",
			"reasonCode",
		]);

		expect(validateRuntimeEvent(agentProjectionEvent("agent.root_registered", {
			subject: { kind: "agent", id: createRuntimeId("agent", "agent-contract-root") },
			correlationId: createRuntimeId("trace", "agent-agent-root_registered"),
			effect: "committed",
			idempotencyKey: "root-register",
			transition: { revision: 0, previousStatus: null, nextStatus: "running" },
		}))).toMatchObject({ ok: true });
		expect(validateRuntimeEvent(agentProjectionEvent("agent.activated", {
			subject: { kind: "agent", id: createRuntimeId("agent", "agent-contract-child") },
			correlationId: createRuntimeId("trace", "agent-agent-activated"),
			effect: "committed",
			transition: { revision: 1, previousStatus: "prepared", nextStatus: "running" },
			expectedRevision: 0,
			refs: [{ subjectKind: "receipt", digest: sha256({ activation: true }) }],
		}))).toMatchObject({ ok: true });
		expect(validateRuntimeEvent(agentProjectionEvent("agent.reconciliation_required", {
			subject: { kind: "agent", id: createRuntimeId("agent", "agent-contract-child") },
			correlationId: createRuntimeId("trace", "agent-agent-reconciliation_required"),
			effect: "uncertain",
			transition: { revision: 2, previousStatus: "running", nextStatus: "recovery_required" },
			expectedRevision: 1,
			reasonCode: "activation_uncertain",
			refs: [{ subjectKind: "details", digest: sha256({ uncertain: true }) }],
		}))).toMatchObject({ ok: true });
	});

	it("accepts a type-bound exact payload and rejects unknown fields", () => {
		const event = sessionCreatedEvent();
		expect(validateRuntimeEvent(event)).toEqual({ ok: true, value: event });
		expect(validateRuntimeEvent({ ...event, sessionId: event.stream.sessionId })).toMatchObject({ ok: false });
		expect(validateRuntimeEvent({ ...event, payload: { ...event.payload, rawPrompt: "secret" } })).toMatchObject({
			ok: false,
		});
		const { transition: _transition, ...missingTransition } = event.payload;
		expect(validateRuntimeEvent({ ...event, payload: missingTransition })).toMatchObject({
			ok: false,
			code: "invalid_schema",
		});
		expect(validateRuntimeEvent({ ...event, type: "session.repair_reported" })).toMatchObject({
			ok: false,
			code: "invalid_schema",
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
