/** Adapter port 的 exact schemas、correlation 与 outcome guards。 */

import { Type } from "typebox";
import { Value } from "typebox/value";
import { IdentityContextSchema, isIdentityContext } from "../identity/schemas.ts";
import {
	CanonicalUtcTimestampSchema,
	RuntimeContentRefSchema,
	RuntimeDigestSchema,
	RuntimeErrorShapeSchema,
	RuntimeIdSchema,
	isCanonicalUtcTimestamp,
} from "../protocol/foundation-schemas.ts";
import { isRuntimeId } from "../protocol/ids.ts";
import { AdapterIdentityRefSchema } from "../protocol/adapter.ts";
import {
	RUNTIME_ADAPTER_PORT_ACTIONS,
	RUNTIME_ADAPTER_PORT_NAMES,
	type AdapterPortRequest,
	type AdapterPortResult,
	type AdapterProgressAnnotation,
	type RuntimeAdapterPortName,
} from "./ports.ts";

const ALL_ADAPTER_ACTIONS = [...new Set(Object.values(RUNTIME_ADAPTER_PORT_ACTIONS).flat())];
const AdapterPortNameSchema = Type.Unsafe<RuntimeAdapterPortName>({
	type: "string",
	enum: [...RUNTIME_ADAPTER_PORT_NAMES],
});
const AdapterPortActionSchema = Type.Unsafe<string>({
	type: "string",
	enum: ALL_ADAPTER_ACTIONS,
});

export const AdapterPortRequestSchema = Type.Object(
	{
		port: AdapterPortNameSchema,
		action: AdapterPortActionSchema,
		requestId: RuntimeIdSchema,
		identity: IdentityContextSchema,
		traceId: RuntimeIdSchema,
		idempotencyKey: Type.String({ pattern: "^[A-Za-z0-9._:-]+$", minLength: 1, maxLength: 128 }),
		expectedRevision: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
		deadline: CanonicalUtcTimestampSchema,
		inputDigest: RuntimeDigestSchema,
		inputRef: Type.Optional(RuntimeContentRefSchema),
		cancellationOf: Type.Optional(RuntimeIdSchema),
	},
	{ additionalProperties: false },
);

export const AdapterPortResultSchema = Type.Object(
	{
		port: AdapterPortNameSchema,
		action: AdapterPortActionSchema,
		requestId: RuntimeIdSchema,
		outcome: Type.Union([
			Type.Literal("ok"),
			Type.Literal("unsupported"),
			Type.Literal("denied"),
			Type.Literal("conflict"),
			Type.Literal("unavailable"),
			Type.Literal("cancelled"),
			Type.Literal("uncertain"),
		]),
		effect: Type.Union([
			Type.Literal("none"),
			Type.Literal("accepted"),
			Type.Literal("terminal"),
			Type.Literal("uncertain"),
		]),
		adapter: AdapterIdentityRefSchema,
		outputDigest: RuntimeDigestSchema,
		outputRef: Type.Optional(RuntimeContentRefSchema),
		receiptRef: Type.Optional(RuntimeContentRefSchema),
		error: Type.Optional(RuntimeErrorShapeSchema),
		completedAt: CanonicalUtcTimestampSchema,
	},
	{ additionalProperties: false },
);

export const AdapterProgressAnnotationSchema = Type.Object(
	{
		port: AdapterPortNameSchema,
		action: AdapterPortActionSchema,
		requestId: RuntimeIdSchema,
		sequence: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		message: Type.String({ minLength: 1, maxLength: 2048 }),
		annotationDigest: RuntimeDigestSchema,
		observedAt: CanonicalUtcTimestampSchema,
	},
	{ additionalProperties: false },
);

const CANCEL_PORTS = new Set<RuntimeAdapterPortName>([
	"runtime_event_subscription",
	"approval_coordinator",
	"sandbox_execution",
	"resource_invocation",
	"model_stream",
	"verification_runner",
	"human_gate",
	"remote_executor",
]);

function isKnownPortAction(port: RuntimeAdapterPortName, action: string): boolean {
	return (RUNTIME_ADAPTER_PORT_ACTIONS[port] as readonly string[]).includes(action);
}

function isCancellationAction(port: RuntimeAdapterPortName, action: string): boolean {
	return action === "cancel" && CANCEL_PORTS.has(port);
}

export function isAdapterPortRequest(value: unknown): value is AdapterPortRequest {
	if (!Value.Check(AdapterPortRequestSchema, value)) return false;
	if (
		!isKnownPortAction(value.port, value.action) ||
		!isRuntimeId(value.requestId, "command") ||
		!isIdentityContext(value.identity) ||
		!isRuntimeId(value.traceId, "trace") ||
		!isCanonicalUtcTimestamp(value.deadline) ||
		Date.parse(value.deadline) <= Date.parse(value.identity.issuedAt)
	) return false;
	if (isCancellationAction(value.port, value.action)) {
		return value.cancellationOf !== undefined && isRuntimeId(value.cancellationOf, "command");
	}
	return value.cancellationOf === undefined;
}

export function isAdapterPortResult(value: unknown): value is AdapterPortResult {
	if (!Value.Check(AdapterPortResultSchema, value)) return false;
	if (
		!isKnownPortAction(value.port, value.action) ||
		!isRuntimeId(value.requestId, "command") ||
		!isCanonicalUtcTimestamp(value.completedAt)
	) return false;
	switch (value.outcome) {
		case "ok":
			return value.error === undefined && (value.effect === "accepted" || value.effect === "terminal") && (value.outputRef !== undefined || value.receiptRef !== undefined);
		case "cancelled":
			return value.effect === "terminal" && value.error !== undefined && value.receiptRef !== undefined;
		case "uncertain":
			return value.effect === "uncertain" && value.error !== undefined;
		case "unsupported":
		case "denied":
		case "conflict":
		case "unavailable":
			return value.effect === "none" && value.error !== undefined;
	}
}

export function isAdapterProgressAnnotation(value: unknown): value is AdapterProgressAnnotation {
	if (!Value.Check(AdapterProgressAnnotationSchema, value)) return false;
	return (
		isKnownPortAction(value.port, value.action) &&
		isRuntimeId(value.requestId, "command") &&
		isCanonicalUtcTimestamp(value.observedAt)
	);
}
