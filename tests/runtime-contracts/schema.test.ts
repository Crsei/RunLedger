import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../../src/runtime/protocol/canonical-json.ts";
import type { Sha256Digest } from "../../src/runtime/protocol/foundation.ts";
import { RUNTIME_ID_KINDS, createRuntimeId, isRuntimeId, parseRuntimeId } from "../../src/runtime/protocol/ids.ts";
import { type RuntimeEvent } from "../../src/runtime/protocol/events.ts";
import { RuntimeContractError } from "../../src/runtime/protocol/errors.ts";
import { assertRuntimeEvent, validateRuntimeEvent } from "../../src/runtime/protocol/schemas.ts";
import { createLocalIdentityContext } from "../../src/runtime/local-identity.ts";

function exactSessionEvent(): RuntimeEvent {
	const identity = createLocalIdentityContext(new Date("2026-07-22T00:00:00.000Z"));
	const payload = {
		subject: { kind: "session" as const, id: createRuntimeId("session", "fixture") },
		correlationId: createRuntimeId("trace", "fixture"),
		effect: "committed" as const,
	};
	const payloadDigest = { algorithm: "sha256" as const, digest: canonicalDigest(payload) as Sha256Digest };
	const hashInput = {
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		principalId: identity.principalId,
		eventId: createRuntimeId("event", "fixture"),
		stream: {
			scope: "session" as const,
			streamId: createRuntimeId("session", "fixture"),
			sessionId: createRuntimeId("session", "fixture"),
		},
		sequence: 0,
		timestamp: "2026-07-22T00:00:00.000Z",
		type: "session.created" as const,
		previousEventHash: null,
		payloadDigest,
		traceId: createRuntimeId("trace", "fixture"),
	};
	return {
		...hashInput,
		currentEventHash: { algorithm: "sha256", digest: canonicalDigest(hashInput) as Sha256Digest },
		payload,
	};
}

describe("Runtime current schema", () => {
	it("rejects empty and oversized Runtime ID seeds", () => {
		expect(() => createRuntimeId("event", "")).toThrow("Runtime ID seed");
		expect(() => createRuntimeId("event", "x".repeat(129))).toThrow("Runtime ID seed");
	});

	it("rejects unknown kinds and oversized persisted Runtime IDs", () => {
		expect(isRuntimeId("future_fixture")).toBe(false);
		expect(isRuntimeId(`event_${"x".repeat(129)}`)).toBe(false);
		expect(parseRuntimeId("event", `event_${"x".repeat(129)}`)).toBeUndefined();
	});

	it("publishes every identity and correlation ID kind required by the contract", () => {
		expect(RUNTIME_ID_KINDS).toContain("turn");
		expect(RUNTIME_ID_KINDS).toContain("command");
		expect(RUNTIME_ID_KINDS).toContain("receipt");
		expect(createRuntimeId("turn", "fixture")).toBe("turn_fixture");
	});

	it("validates a catalogued event envelope", () => {
		const event = exactSessionEvent();

		expect(validateRuntimeEvent(event)).toEqual({ ok: true, value: event });
	});

	it("rejects retired contract fields and unknown event types", () => {
		const base: Record<string, unknown> = exactSessionEvent();

		expect(validateRuntimeEvent({ ...base, formatRevision: 4 })).toMatchObject({
			ok: false,
			code: "invalid_schema",
		});
		expect(validateRuntimeEvent({ ...base, type: "future.event" })).toMatchObject({
			ok: false,
			code: "unknown_event_type",
		});

		try {
			assertRuntimeEvent({ ...base, type: "future.event" });
			expect.fail("assertRuntimeEvent should reject an unknown event");
		} catch (error) {
			expect(error).toBeInstanceOf(RuntimeContractError);
			expect((error as RuntimeContractError).correlationId).toBe("trace_contract-validation");
		}
	});
});
