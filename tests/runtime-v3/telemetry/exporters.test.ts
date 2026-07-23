import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	createTelemetryManifest,
	TELEMETRY_REQUIRED_EVENT_FIELDS,
	type TelemetryManifestExpectation,
} from "../../../src/runtime/telemetry/manifest.ts";
import { OtelTelemetryExporter, toOtelSpanProjection, type OtelProjectionSinkPort } from "../../../src/runtime/telemetry/otel.ts";
import { sanitizeTelemetryObservation } from "../../../src/runtime/telemetry/redaction.ts";
import { SiemTelemetryExporter, toSiemAuditProjection, type SiemProjectionSinkPort } from "../../../src/runtime/telemetry/siem.ts";
import { BoundedTelemetryFanout, type TelemetryExporterPort } from "../../../src/runtime/telemetry/sinks.ts";
import { TELEMETRY_SCHEMA_VERSION, type TelemetryObservation } from "../../../src/runtime/telemetry/types.ts";

const D = "b".repeat(64);
const NOW = new Date("2026-07-22T00:05:00.000Z");
function observation(index = 0): TelemetryObservation {
	return {
		schemaVersion: TELEMETRY_SCHEMA_VERSION,
		authorityId: createRuntimeId("authority", "exporter"), tenantId: createRuntimeId("tenant", "exporter"),
		principalId: createRuntimeId("principal", "exporter"), sessionId: createRuntimeId("session", "exporter"),
		traceId: createRuntimeId("trace", `exporter-${index}`), name: "runtime.turn.finished", severity: "info",
		observedAt: "2026-07-22T00:00:00.000Z", eventSequence: index, eventHash: D,
		attributes: { "event.type": "turn.finished", status: "ok", prompt: "must not export" },
	};
}

function fanoutOptions(exporters: readonly TelemetryExporterPort[]) {
	const eventFields = [
		...TELEMETRY_REQUIRED_EVENT_FIELDS,
		"event.sequence" as const,
		"event.hash" as const,
		"attribute.event.type" as const,
		"attribute.status" as const,
	];
	const exporterIdentities = exporters.map((exporter) => ({
		sinkId: exporter.id,
		channel: exporter.channel,
		exporterIdentityDigest: exporter.identityDigest,
	}));
	const redactionPolicyDigest = canonicalDigest("runledger-telemetry-metadata-v1");
	const created = createTelemetryManifest({
		authorityId: createRuntimeId("authority", "exporter"),
		tenantId: createRuntimeId("tenant", "exporter"),
		runtimeGeneration: 1,
		redactionPolicyDigest,
		managedPolicyRef: null,
		eventFields,
		activityFields: [],
		costFields: [],
		sinks: exporterIdentities.map((exporter) => ({
			...exporter,
			fields: eventFields,
			sampling: { kind: "always" as const, numerator: 1, denominator: 1 },
			retentionDays: 7,
		})),
		metadataRetentionDays: 7,
		forensic: { enabled: false },
		issuedAt: "2026-07-22T00:00:00.000Z",
		expiresAt: "2026-07-22T01:00:00.000Z",
	});
	if (!created.ok) throw new Error(created.error.message);
	const manifestExpectation: TelemetryManifestExpectation = {
		authorityId: createRuntimeId("authority", "exporter"),
		tenantId: createRuntimeId("tenant", "exporter"),
		runtimeGeneration: 1,
		redactionPolicyDigest,
		managedPolicyRef: null,
		exporterIdentities,
	};
	return { manifest: created.value, manifestExpectation, clock: () => NOW };
}

describe("OTel/SIEM projections", () => {
	it("maps only the already-redacted sample into disposable projections", () => {
		const sample = sanitizeTelemetryObservation(observation());
		if (!sample.ok) throw new Error("fixture failed");
		const otel = toOtelSpanProjection(sample.value);
		const siem = toSiemAuditProjection(sample.value);
		expect(otel.traceId).toHaveLength(32);
		expect(otel.spanId).toHaveLength(16);
		expect(siem.eventSequence).toBe(0);
		expect(JSON.stringify({ otel, siem })).not.toMatch(/must not export|prompt|tool output|reasoning|environment/iu);
	});

	it("provides opaque OTel and SIEM sink adapters", async () => {
		const batches: number[] = [];
		const otelSink: OtelProjectionSinkPort = { export: async (spans) => { batches.push(spans.length); } };
		const siemSink: SiemProjectionSinkPort = { export: async (records) => { batches.push(records.length); } };
		const exporters = [new OtelTelemetryExporter("otel-main", otelSink), new SiemTelemetryExporter("siem-main", siemSink)];
		const fanout = new BoundedTelemetryFanout({ exporters, ...fanoutOptions(exporters) });
		expect(fanout.publish(observation())).toMatchObject({ accepted: true });
		await fanout.drain();
		expect(batches).toEqual([1, 1]);
	});
});

describe("bounded telemetry exporter health", () => {
	it("never throws through publish and bounds failure/drop health signals", async () => {
		const failing: TelemetryExporterPort = {
			id: "failing", channel: "rollout", identityDigest: canonicalDigest("failing-rollout-exporter"),
			export: async () => ({ ok: false, retryable: true, reasonDigest: D }),
		};
		const fanout = new BoundedTelemetryFanout({ exporters: [failing], healthCapacity: 2, batchSize: 1, ...fanoutOptions([failing]) });
		for (let index = 0; index < 4; index += 1) {
			expect(fanout.publish(observation(index))).toMatchObject({ accepted: true });
			await fanout.drain();
		}
		expect(fanout.healthSignals()).toHaveLength(2);
		expect(fanout.healthSignals().at(-1)).toMatchObject({ state: "degraded", failureCount: 4, reasonDigest: D });
	});

	it("times out a hung exporter and drops overflow instead of blocking canonical work", async () => {
		const hanging: TelemetryExporterPort = {
			id: "hanging", channel: "otel", identityDigest: canonicalDigest("hanging-otel-exporter"),
			export: async (_samples, signal) => new Promise((resolve) => {
				signal.addEventListener("abort", () => resolve({ ok: false, retryable: true, reasonDigest: D }), { once: true });
			}),
		};
		const fanout = new BoundedTelemetryFanout({ exporters: [hanging], maxQueue: 1, batchSize: 1, exporterTimeoutMs: 5, ...fanoutOptions([hanging]) });
		expect(fanout.publish(observation(1))).toMatchObject({ accepted: true });
		expect(fanout.publish(observation(2))).toMatchObject({ accepted: true });
		expect(fanout.publish(observation(3))).toMatchObject({ accepted: false, reason: "queue_full" });
		await fanout.drain();
		expect(fanout.healthSignals().some((signal) => signal.state === "dropping")).toBe(true);
		expect(fanout.healthSignals().some((signal) => signal.state === "degraded")).toBe(true);
	});
});
