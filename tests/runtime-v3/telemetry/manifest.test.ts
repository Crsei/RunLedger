import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	createTelemetryManifest,
	projectTelemetrySampleForSink,
	TELEMETRY_ACTIVITY_FIELDS,
	TELEMETRY_COST_FIELDS,
	TELEMETRY_REQUIRED_EVENT_FIELDS,
	validateTelemetryManifest,
	type TelemetryManifestExpectation,
} from "../../../src/runtime/telemetry/manifest.ts";
import { sanitizeTelemetryObservation } from "../../../src/runtime/telemetry/redaction.ts";
import { TELEMETRY_SCHEMA_VERSION } from "../../../src/runtime/telemetry/types.ts";

const authorityId = createRuntimeId("authority", "manifest");
const tenantId = createRuntimeId("tenant", "manifest");
const redactionPolicyDigest = canonicalDigest("metadata-redaction-v1");
const exporterIdentityDigest = canonicalDigest("otel-exporter-v1");
const eventFields = [
	...TELEMETRY_REQUIRED_EVENT_FIELDS,
	"event.sequence" as const,
	"event.hash" as const,
	"attribute.event.type" as const,
	"attribute.status" as const,
];

const expectation: TelemetryManifestExpectation = {
	authorityId,
	tenantId,
	runtimeGeneration: 4,
	redactionPolicyDigest,
	managedPolicyRef: null,
	exporterIdentities: [{ sinkId: "otel-main", channel: "otel", exporterIdentityDigest }],
};

function manifest() {
	const created = createTelemetryManifest({
		authorityId,
		tenantId,
		runtimeGeneration: 4,
		redactionPolicyDigest,
		managedPolicyRef: null,
		eventFields,
		activityFields: [...TELEMETRY_ACTIVITY_FIELDS],
		costFields: [...TELEMETRY_COST_FIELDS],
		sinks: [{
			sinkId: "otel-main",
			channel: "otel",
			exporterIdentityDigest,
			fields: eventFields,
			sampling: { kind: "always", numerator: 1, denominator: 1 },
			retentionDays: 14,
		}],
		metadataRetentionDays: 14,
		forensic: {
			enabled: true,
			storeIdentityDigest: canonicalDigest("forensic-store"),
			keyProviderIdentityDigest: canonicalDigest("forensic-key-provider"),
			aclPolicyDigest: canonicalDigest("forensic-acl"),
			maximumRetentionDays: 30,
		},
		issuedAt: "2026-07-22T00:00:00.000Z",
		expiresAt: "2026-07-22T01:00:00.000Z",
	});
	if (!created.ok) throw new Error(created.error.message);
	return created.value;
}

describe("TelemetryManifest", () => {
	it("binds closed fields, exporter identity, retention and independent forensic composition", () => {
		const value = manifest();
		expect(validateTelemetryManifest(value, expectation, new Date("2026-07-22T00:30:00.000Z"))).toMatchObject({ ok: true });
		expect(value.forensic).toMatchObject({ enabled: true, maximumRetentionDays: 30 });
		expect(value.sinks[0]?.fields).toEqual(eventFields);
	});

	it("fails closed on unknown fields, undeclared sinks, policy drift and expiry", () => {
		const value = manifest();
		expect(validateTelemetryManifest({
			...value,
			eventFields: [...value.eventFields, "event.raw_prompt"],
		}, expectation, new Date("2026-07-22T00:30:00.000Z"))).toMatchObject({
			ok: false,
			error: { code: "invalid_schema" },
		});
		expect(validateTelemetryManifest(value, {
			...expectation,
			exporterIdentities: [...expectation.exporterIdentities, {
				sinkId: "siem-undeclared",
				channel: "siem",
				exporterIdentityDigest: canonicalDigest("siem-undeclared"),
			}],
		}, new Date("2026-07-22T00:30:00.000Z"))).toMatchObject({ ok: false, error: { code: "manifest_drift" } });
		expect(validateTelemetryManifest(value, {
			...expectation,
			redactionPolicyDigest: canonicalDigest("changed-policy"),
		}, new Date("2026-07-22T00:30:00.000Z"))).toMatchObject({ ok: false, error: { code: "manifest_drift" } });
		expect(validateTelemetryManifest(value, expectation, new Date(value.expiresAt))).toMatchObject({
			ok: false,
			error: { code: "manifest_denied" },
		});
	});

	it("projects each sink to only its declared metadata fields", () => {
		const sample = sanitizeTelemetryObservation({
			schemaVersion: TELEMETRY_SCHEMA_VERSION,
			authorityId,
			tenantId,
			principalId: createRuntimeId("principal", "manifest"),
			sessionId: createRuntimeId("session", "manifest"),
			traceId: createRuntimeId("trace", "manifest"),
			name: "runtime.turn.finished",
			severity: "info",
			observedAt: "2026-07-22T00:30:00.000Z",
			eventSequence: 3,
			eventHash: canonicalDigest("event"),
			attributes: {
				"event.type": "turn.finished",
				status: "ok",
				"tool.name": "read",
				prompt: "never-export",
			},
		});
		if (!sample.ok) throw new Error(sample.error.message);
		const projected = projectTelemetrySampleForSink(manifest(), "otel-main", sample.value);
		expect(projected).toMatchObject({ ok: true });
		if (!projected.ok) return;
		expect(projected.value.attributes).toEqual([
			{ key: "event.type", value: "turn.finished" },
			{ key: "status", value: "ok" },
		]);
		expect(JSON.stringify(projected.value)).not.toMatch(/never-export|tool\.name/u);
	});
});
