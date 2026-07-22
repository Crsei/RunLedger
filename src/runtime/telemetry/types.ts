/** Phase 11 隐私优先 telemetry 的稳定类型与 exact schema。 */

import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import type {
	AgentId,
	AuthorityId,
	PrincipalId,
	SessionId,
	TenantId,
	TraceId,
} from "../protocol/v3/ids.ts";

export const TELEMETRY_SCHEMA_VERSION = 1 as const;
export const TELEMETRY_CHANNELS = ["otel", "siem", "rollout"] as const;
export const TELEMETRY_SEVERITIES = ["debug", "info", "warn", "error"] as const;
export const MAX_TELEMETRY_ATTRIBUTES = 64;
export const MAX_TELEMETRY_ATTRIBUTE_KEY_LENGTH = 128;
export const MAX_TELEMETRY_ATTRIBUTE_VALUE_LENGTH = 512;

export type TelemetryChannel = (typeof TELEMETRY_CHANNELS)[number];
export type TelemetrySeverity = (typeof TELEMETRY_SEVERITIES)[number];
export type TelemetryAttributeValue = string | number | boolean;

export interface TelemetryAttribute {
	key: string;
	value: TelemetryAttributeValue;
}

/** observation 可含不可信扩展字段；只有 redaction pipeline 的输出能交给 exporter。 */
export interface TelemetryObservation {
	schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
	authorityId: AuthorityId;
	tenantId: TenantId;
	principalId: PrincipalId;
	sessionId: SessionId;
	traceId: TraceId;
	name: string;
	severity: TelemetrySeverity;
	observedAt: string;
	eventSequence?: number;
	eventHash?: string;
	attributes: Readonly<Record<string, unknown>>;
}

/** exporter 只接收此 metadata-only projection，不接收原始 observation。 */
export interface TelemetrySample {
	schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
	projection: "metadata_only";
	authorityId: AuthorityId;
	tenantId: TenantId;
	principalId: PrincipalId;
	sessionId: SessionId;
	traceId: TraceId;
	name: string;
	severity: TelemetrySeverity;
	observedAt: string;
	eventSequence?: number;
	eventHash?: string;
	attributes: readonly TelemetryAttribute[];
	redaction: {
		policyId: "runledger-telemetry-metadata-v1";
		droppedAttributeCount: number;
	};
	sampleDigest: string;
}

export interface ExporterHealthSignal {
	schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
	exporterId: string;
	channel: TelemetryChannel;
	state: "healthy" | "degraded" | "dropping";
	failureCount: number;
	droppedCount: number;
	queueDepth: number;
	observedAt: string;
	reasonDigest?: string;
}

export type TelemetryPublishReceipt =
	| { accepted: true; sampleDigest: string }
	| { accepted: false; reason: "invalid_observation" | "queue_full" | "manifest_denied"; sampleDigest?: string };

export interface TelemetryError {
	code:
		| "invalid_schema"
		| "scope_mismatch"
		| "out_of_order"
		| "manifest_denied"
		| "manifest_drift"
		| "forensic_denied"
		| "forensic_not_found"
		| "forensic_key_unavailable"
		| "forensic_retention_blocked"
		| "durable_write_failed";
	message: string;
	retryable: boolean;
}

export type TelemetryResult<T> = { ok: true; value: T } | { ok: false; error: TelemetryError };

const runtimeId = (kind: string) =>
	Type.String({ pattern: `^${kind}_[A-Za-z0-9][A-Za-z0-9._~-]*$`, maxLength: 128 });
const digest = Type.String({ pattern: "^[a-f0-9]{64}$", maxLength: 64 });
const timestamp = Type.String({
	pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$",
	maxLength: 24,
});
const exact = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

export const TelemetryAttributeSchema = exact({
	key: Type.String({ minLength: 1, maxLength: MAX_TELEMETRY_ATTRIBUTE_KEY_LENGTH }),
	value: Type.Union([
		Type.String({ maxLength: MAX_TELEMETRY_ATTRIBUTE_VALUE_LENGTH }),
		Type.Number(),
		Type.Boolean(),
	]),
});

export const TelemetryObservationSchema = exact({
	schemaVersion: Type.Literal(TELEMETRY_SCHEMA_VERSION),
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	principalId: runtimeId("principal"),
	sessionId: runtimeId("session"),
	traceId: runtimeId("trace"),
	name: Type.String({ pattern: "^[a-z][a-z0-9_.-]*$", minLength: 1, maxLength: 128 }),
	severity: Type.Union(TELEMETRY_SEVERITIES.map((value) => Type.Literal(value))),
	observedAt: timestamp,
	eventSequence: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
	eventHash: Type.Optional(digest),
	attributes: Type.Record(Type.String({ minLength: 1, maxLength: 256 }), Type.Unknown(), {
		maxProperties: 256,
	}),
});

export const TelemetrySampleSchema = exact({
	schemaVersion: Type.Literal(TELEMETRY_SCHEMA_VERSION),
	projection: Type.Literal("metadata_only"),
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	principalId: runtimeId("principal"),
	sessionId: runtimeId("session"),
	traceId: runtimeId("trace"),
	name: Type.String({ pattern: "^[a-z][a-z0-9_.-]*$", minLength: 1, maxLength: 128 }),
	severity: Type.Union(TELEMETRY_SEVERITIES.map((value) => Type.Literal(value))),
	observedAt: timestamp,
	eventSequence: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
	eventHash: Type.Optional(digest),
	attributes: Type.Array(TelemetryAttributeSchema, {
		maxItems: MAX_TELEMETRY_ATTRIBUTES,
	}),
	redaction: exact({
		policyId: Type.Literal("runledger-telemetry-metadata-v1"),
		droppedAttributeCount: Type.Integer({ minimum: 0, maximum: 256 }),
	}),
	sampleDigest: digest,
});

export const ExporterHealthSignalSchema = exact({
	schemaVersion: Type.Literal(TELEMETRY_SCHEMA_VERSION),
	exporterId: Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_.-]*$", minLength: 1, maxLength: 128 }),
	channel: Type.Union(TELEMETRY_CHANNELS.map((value) => Type.Literal(value))),
	state: Type.Union([Type.Literal("healthy"), Type.Literal("degraded"), Type.Literal("dropping")]),
	failureCount: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	droppedCount: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	queueDepth: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	observedAt: timestamp,
	reasonDigest: Type.Optional(digest),
});

export function isTelemetryObservation(value: unknown): value is TelemetryObservation {
	return Check(TelemetryObservationSchema, value);
}

export function isTelemetrySample(value: unknown): value is TelemetrySample {
	return Check(TelemetrySampleSchema, value);
}

export function isExporterHealthSignal(value: unknown): value is ExporterHealthSignal {
	return Check(ExporterHealthSignalSchema, value);
}

export interface CostAgentKey {
	agentId: AgentId;
}
