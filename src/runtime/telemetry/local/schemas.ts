import { Type } from "typebox";
import { Value } from "typebox/value";
import {
	CanonicalUtcTimestampSchema,
	RuntimeIdSchema,
} from "../../protocol/foundation-schemas.ts";
import { isRuntimeId } from "../../protocol/ids.ts";
import type {
	TelemetryCorrelationContext,
	TelemetryObservation,
	ObservedQuantity,
	ObservationUnit,
} from "./types.ts";

const ObservationUnitSchema = Type.Union([
	Type.Literal("bytes"),
	Type.Literal("tokens"),
	Type.Literal("usd_micros"),
	Type.Literal("milliseconds"),
	Type.Literal("count"),
]);
const ObservationAccuracySchema = Type.Union([
	Type.Literal("exact"),
	Type.Literal("sampled"),
	Type.Literal("estimated"),
	Type.Literal("upper_bound"),
]);
const ObservationSourceSchema = Type.Union([
	Type.Literal("runtime_meter"),
	Type.Literal("provider_reported"),
	Type.Literal("canonical_serialization"),
	Type.Literal("linux_proc"),
	Type.Literal("derived"),
]);
const ObservationUnavailableReasonSchema = Type.Union([
	Type.Literal("recording_disabled"),
	Type.Literal("transport_not_instrumented"),
	Type.Literal("platform_unsupported"),
	Type.Literal("permission_denied"),
	Type.Literal("correlation_missing"),
	Type.Literal("provider_usage_missing"),
	Type.Literal("sample_failed"),
	Type.Literal("not_applicable"),
]);

const NonNegativeSafeIntegerSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });

export const TelemetryCorrelationContextSchema = Type.Object(
	{
		sessionId: RuntimeIdSchema,
		traceId: RuntimeIdSchema,
		ownerGeneration: NonNegativeSafeIntegerSchema,
		agentId: Type.Optional(RuntimeIdSchema),
		turnId: Type.Optional(RuntimeIdSchema),
		toolCallId: Type.Optional(RuntimeIdSchema),
		commandId: Type.Optional(RuntimeIdSchema),
		executionId: Type.Optional(RuntimeIdSchema),
		goalId: Type.Optional(RuntimeIdSchema),
		planRevision: Type.Optional(NonNegativeSafeIntegerSchema),
		taskId: Type.Optional(RuntimeIdSchema),
		attemptId: Type.Optional(RuntimeIdSchema),
		verificationCommandId: Type.Optional(RuntimeIdSchema),
	},
	{ additionalProperties: false },
);

function quantitySchema<TUnit extends ObservationUnit>(unit: TUnit) {
	return Type.Union([
		Type.Object(
			{
				availability: Type.Literal("available"),
				unit: Type.Literal(unit),
				value: NonNegativeSafeIntegerSchema,
				accuracy: ObservationAccuracySchema,
				source: ObservationSourceSchema,
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{
				availability: Type.Literal("unavailable"),
				unit: Type.Literal(unit),
				reason: ObservationUnavailableReasonSchema,
			},
			{ additionalProperties: false },
		),
	]);
}

const ObservationBaseProperties = {
	format: Type.Literal("runledger.telemetry.observation"),
	observationId: RuntimeIdSchema,
	observedAt: CanonicalUtcTimestampSchema,
	monotonicOffsetMs: NonNegativeSafeIntegerSchema,
	correlation: TelemetryCorrelationContextSchema,
};

export const TrafficObservationSchema = Type.Object(
	{
		...ObservationBaseProperties,
		kind: Type.Literal("traffic"),
		channel: Type.Union([
			Type.Literal("llm_http"),
			Type.Literal("llm_sse"),
			Type.Literal("llm_websocket"),
			Type.Literal("mcp_http"),
			Type.Literal("governed_http"),
			Type.Literal("gateway"),
		]),
		direction: Type.Union([Type.Literal("tx"), Type.Literal("rx")]),
		boundary: Type.Union([Type.Literal("request_body"), Type.Literal("response_body"), Type.Literal("message_payload")]),
		bytes: quantitySchema("bytes"),
		transportAttempt: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
		terminal: Type.Union([Type.Literal("completed"), Type.Literal("aborted"), Type.Literal("failed")]),
	},
	{ additionalProperties: false },
);

export const ProcessIoObservationSchema = Type.Object(
	{
		...ObservationBaseProperties,
		kind: Type.Literal("process_io"),
		stream: Type.Union([Type.Literal("stdin"), Type.Literal("stdout"), Type.Literal("stderr"), Type.Literal("pty_output")]),
		observedBytes: quantitySchema("bytes"),
		retainedBytes: quantitySchema("bytes"),
	},
	{ additionalProperties: false },
);

export const RuntimeMemoryObservationSchema = Type.Object(
	{
		...ObservationBaseProperties,
		kind: Type.Literal("runtime_memory"),
		rssBytes: quantitySchema("bytes"),
		heapTotalBytes: quantitySchema("bytes"),
		heapUsedBytes: quantitySchema("bytes"),
		externalBytes: quantitySchema("bytes"),
		arrayBuffersBytes: quantitySchema("bytes"),
	},
	{ additionalProperties: false },
);

export const LogicalSessionStateObservationSchema = Type.Object(
	{
		...ObservationBaseProperties,
		kind: Type.Literal("logical_session_state"),
		totalBytes: quantitySchema("bytes"),
		messagesBytes: quantitySchema("bytes"),
		toolResultsBytes: quantitySchema("bytes"),
		planTaskBytes: quantitySchema("bytes"),
		checkpointDescriptorBytes: quantitySchema("bytes"),
		contextCurrentTokens: quantitySchema("tokens"),
	},
	{ additionalProperties: false },
);

export const ManagedProcessMemoryObservationSchema = Type.Object(
	{
		...ObservationBaseProperties,
		kind: Type.Literal("managed_process_memory"),
		rssBytes: quantitySchema("bytes"),
		pssBytes: quantitySchema("bytes"),
		ussBytes: quantitySchema("bytes"),
		observedProcessCount: quantitySchema("count"),
	},
	{ additionalProperties: false },
);

export const TelemetryObservationSchema = Type.Union([
	TrafficObservationSchema,
	ProcessIoObservationSchema,
	RuntimeMemoryObservationSchema,
	LogicalSessionStateObservationSchema,
	ManagedProcessMemoryObservationSchema,
]);

function hasExpectedRuntimeIds(correlation: TelemetryCorrelationContext): boolean {
	return isRuntimeId(correlation.sessionId, "session")
		&& isRuntimeId(correlation.traceId, "trace")
		&& (correlation.agentId === undefined || isRuntimeId(correlation.agentId, "agent"))
		&& (correlation.turnId === undefined || isRuntimeId(correlation.turnId, "turn"))
		&& (correlation.toolCallId === undefined || isRuntimeId(correlation.toolCallId, "toolCall"))
		&& (correlation.commandId === undefined || isRuntimeId(correlation.commandId, "command"))
		&& (correlation.executionId === undefined || isRuntimeId(correlation.executionId, "execution"))
		&& (correlation.goalId === undefined || isRuntimeId(correlation.goalId, "goal"))
		&& (correlation.taskId === undefined || isRuntimeId(correlation.taskId, "task"))
		&& (correlation.attemptId === undefined || isRuntimeId(correlation.attemptId, "attempt"))
		&& (correlation.verificationCommandId === undefined || isRuntimeId(correlation.verificationCommandId, "command"));
}

export function isTelemetryCorrelationContext(value: unknown): value is TelemetryCorrelationContext {
	if (!Value.Check(TelemetryCorrelationContextSchema, value)) return false;
	return hasExpectedRuntimeIds(value as TelemetryCorrelationContext);
}

export function isObservedQuantity<TUnit extends ObservationUnit>(value: unknown, unit: TUnit): value is ObservedQuantity<TUnit> {
	if (!Value.Check(quantitySchema(unit), value)) return false;
	return true;
}

export function isTelemetryObservation(value: unknown): value is TelemetryObservation {
	if (!Value.Check(TelemetryObservationSchema, value)) return false;
	const observation = value as TelemetryObservation;
	if (!isRuntimeId(observation.observationId, "event")) return false;
	return isTelemetryCorrelationContext(observation.correlation);
}
