import { describe, expect, it } from "vitest";
import { createRuntimeId } from "../../src/runtime/protocol/ids.ts";
import { type RuntimeEvent } from "../../src/runtime/protocol/events.ts";
import { validateRuntimeEvent } from "../../src/runtime/protocol/schemas.ts";
import { createLocalIdentityContext } from "../../src/runtime/identity/local-principal.ts";

describe("Runtime current schema", () => {
	it("validates a catalogued event envelope", () => {
		const identity = createLocalIdentityContext(new Date("2026-07-22T00:00:00.000Z"));
		const event: RuntimeEvent = {
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			principalId: identity.principalId,
			eventId: createRuntimeId("event", "fixture"),
			sessionId: createRuntimeId("session", "fixture"),
			sequence: 0,
			timestamp: "2026-07-22T00:00:00.000Z",
			type: "session.started",
			previousEventHash: null,
			payloadDigest: "payload-digest",
			currentEventHash: "event-digest",
			traceId: createRuntimeId("trace", "fixture"),
			payload: { source: "test" },
		};

		expect(validateRuntimeEvent(event)).toEqual({ ok: true, value: event });
	});

	it("rejects retired contract fields and unknown event types", () => {
		const base: Record<string, unknown> = {
			authorityId: "authority_fixture",
			tenantId: "tenant_fixture",
			principalId: "principal_fixture",
			eventId: "event_fixture",
			sessionId: "session_fixture",
			sequence: 0,
			timestamp: "2026-07-22T00:00:00.000Z",
			type: "session.started",
			previousEventHash: null,
			payloadDigest: "payload",
			currentEventHash: "event",
			traceId: "trace_fixture",
			payload: {},
		};

		expect(validateRuntimeEvent({ ...base, formatRevision: 4 })).toMatchObject({
			ok: false,
			code: "invalid_schema",
		});
		expect(validateRuntimeEvent({ ...base, type: "future.event" })).toMatchObject({
			ok: false,
			code: "unknown_event_type",
		});
	});
});
