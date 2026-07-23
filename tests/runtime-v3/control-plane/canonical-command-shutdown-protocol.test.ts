import { describe, expect, it } from "vitest";
import { reduceControlPlaneEvents } from "../../../src/runtime/control-plane/command-projection.ts";
import {
	CONTROL_PLANE_COMMAND_TYPES as CONTROL_PLANE_API_COMMAND_TYPES,
} from "../../../src/runtime/control-plane/types.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import {
	CONTROL_PLANE_COMMAND_TYPES,
	createIdempotencyKey,
} from "../../../src/runtime/protocol/v3/coordination.ts";
import {
	isRuntimeEventTypeAllowedInStream,
	type RuntimeEventType,
} from "../../../src/runtime/protocol/v3/event-catalog.ts";
import type { RuntimeEventPayloadMap } from "../../../src/runtime/protocol/v3/event-payloads.ts";
import {
	createAuthorityTenantEventStreamRef,
	createSessionEventStreamRef,
	RUNTIME_SCHEMA_VERSION,
	type RuntimeEventEnvelopeV3,
	type RuntimeEventV3,
} from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { validateRuntimeEvent } from "../../../src/runtime/protocol/v3/schemas.ts";
import {
	isAllowedRuntimeStateTransition,
	isCorrelatedDaemonShutdownRequest,
	isCorrelatedDaemonShutdownTerminal,
} from "../../../src/runtime/protocol/v3/state-transitions.ts";
import { MANDATORY_FLUSH_EVENT_TYPES } from "../../../src/runtime/session/event-writer.ts";

const authorityId = createRuntimeId("authority", "command-shutdown-protocol");
const tenantId = createRuntimeId("tenant", "command-shutdown-protocol");
const principalId = createRuntimeId("principal", "command-shutdown-protocol");
const runtimeId = createRuntimeId("runtime", "command-shutdown-protocol");
const sessionId = createRuntimeId("session", "command-shutdown-protocol");
const stream = createAuthorityTenantEventStreamRef({ authorityId, tenantId });
const sessionStream = createSessionEventStreamRef({ authorityId, tenantId }, sessionId);
const requestDigest = canonicalDigest({ command: "shutdown" });
const reasonDigest = canonicalDigest({ reason: "operator_request" });
const deadline = "2026-07-22T01:01:30.000Z";

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
		eventId: createRuntimeId("event", `command-shutdown-${type.replaceAll(".", "-")}-${sequence}`),
		stream,
		sequence,
		timestamp: `2026-07-22T01:01:${sequence.toString().padStart(2, "0")}.000Z`,
		type,
		previousEventHash: sequence === 0 ? null : canonicalDigest({ sequence: sequence - 1 }),
		payloadDigest: canonicalDigest(payload),
		currentEventHash: canonicalDigest({ type, sequence, payload }),
		traceId: createRuntimeId("trace", `command-shutdown-${sequence}`),
		payload,
	};
}

const commandId = createRuntimeId("command", "shutdown-command");
const idempotencyKey = createIdempotencyKey("shutdown-command-idempotency-key");
const claimed = event("command.claimed", 0, {
	commandId,
	commandType: "shutdown",
	idempotencyKey,
	requestDigest,
	requestedBy: principalId,
	runtimeId,
	runtimeGeneration: 7,
	domain: "daemon",
	domainExpectedRevision: null,
});
const claim = {
	commandId,
	claimEventId: claimed.eventId,
	requestDigest,
};
const requested = event("daemon.shutdown_requested", 1, {
	claim,
	idempotencyKey,
	runtimeId,
	runtimeGeneration: 7,
	reasonDigest,
	drainDeadline: deadline,
});
const request = {
	claim,
	requestedEventId: requested.eventId,
	requestedPayloadDigest: requested.payloadDigest,
};
const completed = event("daemon.shutdown_completed", 2, {
	request,
	runtimeId,
	runtimeGeneration: 7,
	drainDeadline: deadline,
	outcome: "drained",
	shutdownReceiptId: createRuntimeId("receipt", "shutdown-completed"),
	shutdownReceiptDigest: canonicalDigest({ receipt: "shutdown-completed" }),
	outcomeCertain: true,
});
const failed = event("daemon.shutdown_failed", 2, {
	request,
	runtimeId,
	runtimeGeneration: 7,
	drainDeadline: deadline,
	error: {
		code: "writer_flush_failed",
		messageDigest: canonicalDigest({ error: "writer_flush_failed" }),
		retryable: false,
	},
	outcomeCertain: false,
	effect: "uncertain",
});

describe("canonical command and daemon shutdown protocol", () => {
	it("uses one exact 13-command closed set in protocol events and the Control Plane API", () => {
		expect(CONTROL_PLANE_API_COMMAND_TYPES).toBe(CONTROL_PLANE_COMMAND_TYPES);
		expect(CONTROL_PLANE_COMMAND_TYPES).toEqual([
			"session:start",
			"session:resume",
			"session:fork",
			"session:stop",
			"turn:start",
			"turn:steer",
			"turn:followUp",
			"turn:interrupt",
			"queue:cancel",
			"approval:resolve",
			"changeProposal:requestDraftPr",
			"humanGate:resolve",
			"shutdown",
		]);
		expect(new Set(CONTROL_PLANE_COMMAND_TYPES).size).toBe(13);
		expect(validateRuntimeEvent(claimed)).toMatchObject({ ok: true });
		expect(validateRuntimeEvent({
			...claimed,
			payload: { ...claimed.payload, commandType: "future:mutation" },
		})).toMatchObject({ ok: false, code: "invalid_schema" });
		expect(validateRuntimeEvent({
			...claimed,
			payload: { ...claimed.payload, future: true },
		})).toMatchObject({ ok: false, code: "unknown_field" });

		const projected = reduceControlPlaneEvents([claimed]);
		expect(projected).toMatchObject({
			ok: true,
			value: { commands: [{ claim: { commandId, commandType: "shutdown" } }] },
		});
	});

	it("validates exact shutdown payloads and rejects unknown or inconsistent certainty fields", () => {
		for (const candidate of [requested, completed, failed]) {
			expect(validateRuntimeEvent(candidate)).toMatchObject({ ok: true });
			expect(validateRuntimeEvent({
				...candidate,
				payload: { ...candidate.payload, future: true },
			})).toMatchObject({ ok: false, code: "unknown_field" });
		}
		expect(validateRuntimeEvent({
			...completed,
			payload: {
				...completed.payload,
				request: { ...completed.payload.request, future: true },
			},
		})).toMatchObject({ ok: false, code: "unknown_field" });
		expect(validateRuntimeEvent({
			...failed,
			payload: { ...failed.payload, outcomeCertain: false, effect: "none" },
		})).toMatchObject({ ok: false, code: "invalid_schema" });
	});

	it("keeps shutdown events authority-only and behind mandatory durability barriers", () => {
		for (const candidate of [requested, completed, failed]) {
			expect(isRuntimeEventTypeAllowedInStream(candidate.type, "authority_tenant")).toBe(true);
			expect(isRuntimeEventTypeAllowedInStream(candidate.type, "session")).toBe(false);
			expect(MANDATORY_FLUSH_EVENT_TYPES.has(candidate.type)).toBe(true);
			expect(validateRuntimeEvent({ ...candidate, stream: sessionStream })).toMatchObject({
				ok: false,
				code: "invalid_schema",
			});
		}
	});

	it("allows only requested to completed or failed and verifies the exact request correlation", () => {
		expect(isAllowedRuntimeStateTransition("daemon_shutdown", "requested", "completed")).toBe(true);
		expect(isAllowedRuntimeStateTransition("daemon_shutdown", "requested", "failed")).toBe(true);
		expect(isAllowedRuntimeStateTransition("daemon_shutdown", "completed", "failed")).toBe(false);
		expect(isAllowedRuntimeStateTransition("daemon_shutdown", "failed", "completed")).toBe(false);
		expect(isCorrelatedDaemonShutdownRequest(claimed, requested)).toBe(true);
		expect(isCorrelatedDaemonShutdownTerminal(requested, completed)).toBe(true);
		expect(isCorrelatedDaemonShutdownTerminal(requested, failed)).toBe(true);

		const wrongCommandType = {
			...claimed,
			payload: { ...claimed.payload, commandType: "session:stop" as const },
		};
		expect(isCorrelatedDaemonShutdownRequest(wrongCommandType, requested)).toBe(false);

		const wrongRequest = {
			...completed,
			payload: {
				...completed.payload,
				request: {
					...completed.payload.request,
					requestedPayloadDigest: canonicalDigest({ wrong: "request" }),
				},
			},
		};
		expect(isCorrelatedDaemonShutdownTerminal(requested, wrongRequest)).toBe(false);
	});

	it("rejects a typed projection input whose command type escaped schema validation", () => {
		const tampered = {
			...claimed,
			payload: { ...claimed.payload, commandType: "future:mutation" },
		} as unknown as RuntimeEventV3;
		expect(reduceControlPlaneEvents([tampered])).toMatchObject({ ok: false });
	});
});
