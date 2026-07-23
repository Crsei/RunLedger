/** 每个 production composition 的 closed telemetry 字段与 sink manifest。 */

import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import {
	isRuntimeId,
	type AuthorityId,
	type ReceiptId,
	type TenantId,
} from "../protocol/v3/ids.ts";
import { DEFAULT_TELEMETRY_ATTRIBUTE_ALLOWLIST } from "./redaction.ts";
import {
	TELEMETRY_CHANNELS,
	TELEMETRY_SCHEMA_VERSION,
	type TelemetryChannel,
	type TelemetryResult,
	type TelemetrySample,
} from "./types.ts";

export const TELEMETRY_MANIFEST_SCHEMA_VERSION = 1 as const;
export const MAX_TELEMETRY_MANIFEST_LIFETIME_MS = 24 * 60 * 60 * 1_000;

export const TELEMETRY_REQUIRED_EVENT_FIELDS = [
	"event.authority_id",
	"event.tenant_id",
	"event.principal_id",
	"event.session_id",
	"event.trace_id",
	"event.name",
	"event.severity",
	"event.observed_at",
	"event.redaction_policy_id",
	"event.sample_digest",
] as const;

export const TELEMETRY_OPTIONAL_EVENT_FIELDS = [
	"event.sequence",
	"event.hash",
	...Array.from(DEFAULT_TELEMETRY_ATTRIBUTE_ALLOWLIST, (key) => `attribute.${key}`).sort(),
] as const;

export const TELEMETRY_ACTIVITY_FIELDS = [
	"activity.session_state",
	"activity.goal_state",
	"activity.task_count",
	"activity.tool_state",
	"activity.waiting_permission",
	"activity.nested_agent_count",
	"activity.last_durable_cursor",
	"activity.heartbeat_freshness",
] as const;

export const TELEMETRY_COST_FIELDS = [
	"cost.input_tokens",
	"cost.output_tokens",
	"cost.cache_read_tokens",
	"cost.cache_write_tokens",
	"cost.usd",
	"cost.wall_time_ms",
	"cost.tool_calls",
	"cost.network_bytes",
	"cost.storage_bytes",
	"cost.verification_runs",
	"cost.retry_count",
	"cost.agent_count",
] as const;

export const TELEMETRY_MANIFEST_FIELDS = [
	...TELEMETRY_REQUIRED_EVENT_FIELDS,
	...TELEMETRY_OPTIONAL_EVENT_FIELDS,
	...TELEMETRY_ACTIVITY_FIELDS,
	...TELEMETRY_COST_FIELDS,
] as const;

export type TelemetryManifestField = (typeof TELEMETRY_MANIFEST_FIELDS)[number];

export interface TelemetryManifestSampling {
	kind: "always" | "ratio";
	numerator: number;
	denominator: number;
}

export interface TelemetryManifestSink {
	sinkId: string;
	channel: TelemetryChannel;
	exporterIdentityDigest: string;
	fields: readonly TelemetryManifestField[];
	sampling: TelemetryManifestSampling;
	retentionDays: number;
}

export interface TelemetryManagedPolicyRef {
	receiptId: ReceiptId;
	revision: number;
	effectivePolicyDigest: string;
}

export type TelemetryForensicManifest =
	| { enabled: false }
	| {
		enabled: true;
		storeIdentityDigest: string;
		keyProviderIdentityDigest: string;
		aclPolicyDigest: string;
		maximumRetentionDays: number;
	};

export interface TelemetryManifestBody {
	schemaVersion: typeof TELEMETRY_MANIFEST_SCHEMA_VERSION;
	authorityId: AuthorityId;
	tenantId: TenantId;
	runtimeGeneration: number;
	redactionPolicyDigest: string;
	managedPolicyRef: TelemetryManagedPolicyRef | null;
	eventFields: readonly TelemetryManifestField[];
	activityFields: readonly TelemetryManifestField[];
	costFields: readonly TelemetryManifestField[];
	sinks: readonly TelemetryManifestSink[];
	metadataRetentionDays: number;
	forensic: TelemetryForensicManifest;
	issuedAt: string;
	expiresAt: string;
}

export interface TelemetryManifest extends TelemetryManifestBody {
	manifestDigest: string;
}

export interface TelemetryManifestExpectation {
	authorityId: AuthorityId;
	tenantId: TenantId;
	runtimeGeneration: number;
	redactionPolicyDigest: string;
	managedPolicyRef?: TelemetryManagedPolicyRef | null;
	exporterIdentities: readonly {
		sinkId: string;
		channel: TelemetryChannel;
		exporterIdentityDigest: string;
	}[];
}

const exact = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
const runtimeId = (kind: string) => Type.String({ pattern: `^${kind}_[A-Za-z0-9][A-Za-z0-9._~-]*$`, maxLength: 128 });
const digest = Type.String({ pattern: "^[a-f0-9]{64}$", minLength: 64, maxLength: 64 });
const timestamp = Type.String({
	pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$",
	maxLength: 24,
});
const boundedIdentity = Type.String({
	pattern: "^[A-Za-z][A-Za-z0-9_.-]*$",
	minLength: 1,
	maxLength: 128,
});
const manifestFieldSchema = Type.Union(TELEMETRY_MANIFEST_FIELDS.map((field) => Type.Literal(field)));
const manifestFieldsSchema = Type.Array(manifestFieldSchema, {
	maxItems: TELEMETRY_MANIFEST_FIELDS.length,
	uniqueItems: true,
});
const TelemetryManifestSamplingSchema = exact({
	kind: Type.Union([Type.Literal("always"), Type.Literal("ratio")]),
	numerator: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
	denominator: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
});
const TelemetryManifestSinkSchema = exact({
	sinkId: boundedIdentity,
	channel: Type.Union(TELEMETRY_CHANNELS.map((channel) => Type.Literal(channel))),
	exporterIdentityDigest: digest,
	fields: manifestFieldsSchema,
	sampling: TelemetryManifestSamplingSchema,
	retentionDays: Type.Integer({ minimum: 1, maximum: 3_650 }),
});
const TelemetryManagedPolicyRefSchema = exact({
	receiptId: runtimeId("receipt"),
	revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
	effectivePolicyDigest: digest,
});
const TelemetryForensicManifestSchema = Type.Union([
	exact({ enabled: Type.Literal(false) }),
	exact({
		enabled: Type.Literal(true),
		storeIdentityDigest: digest,
		keyProviderIdentityDigest: digest,
		aclPolicyDigest: digest,
		maximumRetentionDays: Type.Integer({ minimum: 1, maximum: 3_650 }),
	}),
]);
export const TelemetryManifestSchema = exact({
	schemaVersion: Type.Literal(TELEMETRY_MANIFEST_SCHEMA_VERSION),
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	runtimeGeneration: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
	redactionPolicyDigest: digest,
	managedPolicyRef: Type.Union([Type.Null(), TelemetryManagedPolicyRefSchema]),
	eventFields: manifestFieldsSchema,
	activityFields: manifestFieldsSchema,
	costFields: manifestFieldsSchema,
	sinks: Type.Array(TelemetryManifestSinkSchema, { maxItems: 32 }),
	metadataRetentionDays: Type.Integer({ minimum: 1, maximum: 3_650 }),
	forensic: TelemetryForensicManifestSchema,
	issuedAt: timestamp,
	expiresAt: timestamp,
	manifestDigest: digest,
});

const fieldOrder = new Map(TELEMETRY_MANIFEST_FIELDS.map((field, index) => [field, index] as const));
const channelOrder = new Map(TELEMETRY_CHANNELS.map((channel, index) => [channel, index] as const));

function failure(
	code: "invalid_schema" | "scope_mismatch" | "manifest_denied" | "manifest_drift",
	message: string,
): TelemetryResult<never> {
	return { ok: false, error: { code, message, retryable: false } };
}

function isCanonicalTimestamp(value: string): boolean {
	const parsed = new Date(value);
	return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function orderedFields(fields: readonly TelemetryManifestField[]): readonly TelemetryManifestField[] {
	return [...new Set(fields)].sort(
		(left, right) => (fieldOrder.get(left) ?? Number.MAX_SAFE_INTEGER) -
			(fieldOrder.get(right) ?? Number.MAX_SAFE_INTEGER),
	);
}

function orderedSinks(sinks: readonly TelemetryManifestSink[]): readonly TelemetryManifestSink[] {
	return [...sinks]
		.map((sink) => ({ ...sink, fields: orderedFields(sink.fields), sampling: { ...sink.sampling } }))
		.sort((left, right) => {
			const channelDifference = (channelOrder.get(left.channel) ?? Number.MAX_SAFE_INTEGER) -
				(channelOrder.get(right.channel) ?? Number.MAX_SAFE_INTEGER);
			return channelDifference || left.sinkId.localeCompare(right.sinkId);
		});
}

function managedPolicyRefsEqual(
	left: TelemetryManagedPolicyRef | null,
	right: TelemetryManagedPolicyRef | null,
): boolean {
	return canonicalDigest(left) === canonicalDigest(right);
}

function manifestBody(manifest: TelemetryManifest): TelemetryManifestBody {
	const { manifestDigest: _manifestDigest, ...body } = manifest;
	return body;
}

function manifestStructureIsValid(manifest: TelemetryManifest): boolean {
	const eventFields = orderedFields(manifest.eventFields);
	const activityFields = orderedFields(manifest.activityFields);
	const costFields = orderedFields(manifest.costFields);
	const sinks = orderedSinks(manifest.sinks);
	if (
		!sameValues(manifest.eventFields, eventFields) ||
		!sameValues(manifest.activityFields, activityFields) ||
		!sameValues(manifest.costFields, costFields) ||
		manifest.sinks.some((sink, index) => sink.sinkId !== sinks[index]?.sinkId || sink.channel !== sinks[index]?.channel)
	) return false;
	if (!TELEMETRY_REQUIRED_EVENT_FIELDS.every((field) => manifest.eventFields.includes(field))) return false;
	const declared = new Set([...manifest.eventFields, ...manifest.activityFields, ...manifest.costFields]);
	const sinkIds = new Set<string>();
	for (const sink of manifest.sinks) {
		if (sinkIds.has(sink.sinkId) || sink.fields.some((field) => !declared.has(field))) return false;
		sinkIds.add(sink.sinkId);
		if (!TELEMETRY_REQUIRED_EVENT_FIELDS.every((field) => sink.fields.includes(field))) return false;
		if (
			(sink.sampling.kind === "always" && (sink.sampling.numerator !== 1 || sink.sampling.denominator !== 1)) ||
			(sink.sampling.kind === "ratio" && sink.sampling.numerator > sink.sampling.denominator)
		) return false;
	}
	return true;
}

function sameValues<T extends string>(left: readonly T[], right: readonly T[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function createTelemetryManifest(
	input: Omit<TelemetryManifestBody, "schemaVersion">,
): TelemetryResult<TelemetryManifest> {
	const body: TelemetryManifestBody = {
		schemaVersion: TELEMETRY_MANIFEST_SCHEMA_VERSION,
		...input,
		managedPolicyRef: input.managedPolicyRef ? { ...input.managedPolicyRef } : null,
		eventFields: orderedFields(input.eventFields),
		activityFields: orderedFields(input.activityFields),
		costFields: orderedFields(input.costFields),
		sinks: orderedSinks(input.sinks),
		forensic: { ...input.forensic },
	};
	const manifest: TelemetryManifest = { ...body, manifestDigest: canonicalDigest(body) };
	return validateTelemetryManifest(manifest, {
		authorityId: input.authorityId,
		tenantId: input.tenantId,
		runtimeGeneration: input.runtimeGeneration,
		redactionPolicyDigest: input.redactionPolicyDigest,
		managedPolicyRef: input.managedPolicyRef,
		exporterIdentities: input.sinks.map((sink) => ({
			sinkId: sink.sinkId,
			channel: sink.channel,
			exporterIdentityDigest: sink.exporterIdentityDigest,
		})),
	}, new Date(input.issuedAt));
}

export function validateTelemetryManifest(
	value: unknown,
	expected: TelemetryManifestExpectation,
	at: Date = new Date(),
): TelemetryResult<TelemetryManifest> {
	if (!Check(TelemetryManifestSchema, value)) return failure("invalid_schema", "telemetry manifest schema is invalid");
	const manifest = value as unknown as TelemetryManifest;
	const issuedAt = Date.parse(manifest.issuedAt);
	const expiresAt = Date.parse(manifest.expiresAt);
	if (
		!isRuntimeId(manifest.authorityId, "authority") ||
		!isRuntimeId(manifest.tenantId, "tenant") ||
		!isCanonicalTimestamp(manifest.issuedAt) ||
		!isCanonicalTimestamp(manifest.expiresAt) ||
		!Number.isFinite(at.getTime()) ||
		expiresAt <= issuedAt ||
		expiresAt - issuedAt > MAX_TELEMETRY_MANIFEST_LIFETIME_MS ||
		at.getTime() < issuedAt ||
		at.getTime() >= expiresAt
	) return failure("manifest_denied", "telemetry manifest lifetime is invalid or expired");
	if (
		manifest.authorityId !== expected.authorityId ||
		manifest.tenantId !== expected.tenantId ||
		manifest.runtimeGeneration !== expected.runtimeGeneration
	) return failure("scope_mismatch", "telemetry manifest scope does not match the runtime");
	if (
		manifest.redactionPolicyDigest !== expected.redactionPolicyDigest ||
		(expected.managedPolicyRef !== undefined &&
			!managedPolicyRefsEqual(manifest.managedPolicyRef, expected.managedPolicyRef))
	) return failure("manifest_drift", "telemetry manifest policy binding has drifted");
	if (!manifestStructureIsValid(manifest)) return failure("manifest_denied", "telemetry manifest fields or sinks are not closed");
	const expectedExporters = [...expected.exporterIdentities].sort((left, right) => {
		const channelDifference = (channelOrder.get(left.channel) ?? Number.MAX_SAFE_INTEGER) -
			(channelOrder.get(right.channel) ?? Number.MAX_SAFE_INTEGER);
		return channelDifference || left.sinkId.localeCompare(right.sinkId);
	});
	if (
		expectedExporters.length !== manifest.sinks.length ||
		expectedExporters.some((exporter, index) => {
			const sink = manifest.sinks[index];
			return !sink ||
				exporter.sinkId !== sink.sinkId ||
				exporter.channel !== sink.channel ||
				exporter.exporterIdentityDigest !== sink.exporterIdentityDigest;
		})
	) return failure("manifest_drift", "telemetry exporter identity or sink set has drifted");
	if (manifest.manifestDigest !== canonicalDigest(manifestBody(manifest))) {
		return failure("manifest_drift", "telemetry manifest digest has drifted");
	}
	return { ok: true, value: Object.freeze({
		...manifest,
		managedPolicyRef: manifest.managedPolicyRef ? Object.freeze({ ...manifest.managedPolicyRef }) : null,
		eventFields: Object.freeze([...manifest.eventFields]),
		activityFields: Object.freeze([...manifest.activityFields]),
		costFields: Object.freeze([...manifest.costFields]),
		sinks: Object.freeze(manifest.sinks.map((sink) => Object.freeze({
			...sink,
			fields: Object.freeze([...sink.fields]),
			sampling: Object.freeze({ ...sink.sampling }),
		}))),
		forensic: Object.freeze({ ...manifest.forensic }),
	}) };
}

export function telemetrySampleManifestFields(sample: TelemetrySample): readonly TelemetryManifestField[] {
	const fields: TelemetryManifestField[] = [...TELEMETRY_REQUIRED_EVENT_FIELDS];
	if (sample.eventSequence !== undefined) fields.push("event.sequence");
	if (sample.eventHash !== undefined) fields.push("event.hash");
	for (const attribute of sample.attributes) {
		const field = `attribute.${attribute.key}`;
		if (TELEMETRY_MANIFEST_FIELDS.includes(field as TelemetryManifestField)) {
			fields.push(field as TelemetryManifestField);
		}
	}
	return orderedFields(fields);
}

export function projectTelemetrySampleForSink(
	manifest: TelemetryManifest,
	sinkId: string,
	sample: TelemetrySample,
): TelemetryResult<TelemetrySample> {
	const sink = manifest.sinks.find((candidate) => candidate.sinkId === sinkId);
	if (!sink) return failure("manifest_denied", "telemetry sink is not declared by the manifest");
	const allowed = new Set(sink.fields);
	const attributes = sample.attributes.filter((attribute) => allowed.has(`attribute.${attribute.key}` as TelemetryManifestField));
	const body = {
		...sample,
		attributes,
		redaction: {
			...sample.redaction,
			droppedAttributeCount: sample.redaction.droppedAttributeCount + sample.attributes.length - attributes.length,
		},
	};
	const { sampleDigest: _sampleDigest, ...withoutDigest } = body;
	return { ok: true, value: { ...withoutDigest, sampleDigest: canonicalDigest(withoutDigest) } };
}
