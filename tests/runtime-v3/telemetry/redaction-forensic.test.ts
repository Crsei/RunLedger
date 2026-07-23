import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	ForensicTraceRequestRefSchema,
	evaluateForensicTraceGate,
	sanitizeTelemetryObservation,
	type ForensicTraceRequestRef,
} from "../../../src/runtime/telemetry/redaction.ts";
import { TELEMETRY_SCHEMA_VERSION, TelemetrySampleSchema, type TelemetryObservation } from "../../../src/runtime/telemetry/types.ts";

const D = "a".repeat(64);
const authorityId = createRuntimeId("authority", "telemetry-redaction");
const tenantId = createRuntimeId("tenant", "telemetry-redaction");
const principalId = createRuntimeId("principal", "telemetry-redaction");
const sessionId = createRuntimeId("session", "telemetry-redaction");

function observation(): TelemetryObservation {
	return {
		schemaVersion: TELEMETRY_SCHEMA_VERSION, authorityId, tenantId, principalId, sessionId,
		traceId: createRuntimeId("trace", "telemetry-redaction"), name: "runtime.tool.finished", severity: "info",
		observedAt: "2026-07-22T00:00:00.000Z", eventSequence: 3, eventHash: D,
		attributes: {
			"event.type": "tool.finished", "tool.name": "read", "duration_ms": 5,
			prompt: "private prompt", "tool.output": "secret output", arguments: { path: "/secret" },
			environment: { TOKEN: "secret" }, authorization: "Bearer secret", "unknown.field": "drop",
		},
	};
}

function forensicRequest(): ForensicTraceRequestRef {
	return {
		schemaVersion: TELEMETRY_SCHEMA_VERSION, authorityId, tenantId, principalId, sessionId,
		requestId: createRuntimeId("command", "forensic"), approvalId: createRuntimeId("approval", "forensic"),
		approvalReceiptId: createRuntimeId("receipt", "forensic-approval"),
		effectivePolicyReceiptId: createRuntimeId("receipt", "forensic-policy"), effectivePolicyDigest: D,
		organizationDecision: "allow", purposeDigest: D,
		encryptedArtifact: {
			authorityId, tenantId, artifactId: createRuntimeId("artifact", "forensic"), storedDigest: D,
			kind: "log", originalSize: 100, storedSize: 180, mediaType: "application/octet-stream",
			redaction: "encrypted_forensic", transformReceipt: createRuntimeId("receipt", "forensic-transform"),
		},
		keyLifecycleReceiptId: createRuntimeId("receipt", "forensic-key"), auditReceiptId: createRuntimeId("receipt", "forensic-audit"),
		requestedAt: "2026-07-22T00:00:00.000Z", expiresAt: "2026-07-22T00:10:00.000Z",
	};
}

describe("telemetry redaction", () => {
	it("exports only explicit metadata allowlist fields", () => {
		const sample = sanitizeTelemetryObservation(observation());
		expect(sample).toMatchObject({ ok: true, value: { projection: "metadata_only", redaction: { droppedAttributeCount: 6 } } });
		if (!sample.ok) return;
		expect(Check(TelemetrySampleSchema, sample.value)).toBe(true);
		expect(sample.value.attributes).toEqual([
			{ key: "duration_ms", value: 5 }, { key: "event.type", value: "tool.finished" }, { key: "tool.name", value: "read" },
		]);
		expect(JSON.stringify(sample.value)).not.toMatch(/private prompt|secret output|Bearer|TOKEN|\/secret/);
	});
});

describe("forensic trace gate", () => {
	it("requires explicit policy allow, approval/key/audit refs, encrypted Artifact and bounded live window", () => {
		const request = forensicRequest();
		expect(Check(ForensicTraceRequestRefSchema, request)).toBe(true);
		const permit = evaluateForensicTraceGate(request, new Date("2026-07-22T00:05:00.000Z"));
		expect(permit).toMatchObject({ ok: true, value: { contentHandling: "encrypted_artifact_only", encryptedArtifactId: request.encryptedArtifact.artifactId } });
		expect(JSON.stringify(permit)).not.toMatch(/private prompt|tool output|secret|rawContent/u);
	});

	it("fails closed when organization policy denies, the window expires, or the artifact is not encrypted", () => {
		const request = forensicRequest();
		expect(evaluateForensicTraceGate({ ...request, organizationDecision: "deny" }, new Date("2026-07-22T00:05:00.000Z"))).toMatchObject({ ok: false, error: { code: "forensic_denied" } });
		expect(evaluateForensicTraceGate(request, new Date("2026-07-22T00:10:00.000Z"))).toMatchObject({ ok: false, error: { code: "forensic_denied" } });
		const plaintext = { ...request, encryptedArtifact: { ...request.encryptedArtifact, redaction: "redacted" as const } };
		expect(evaluateForensicTraceGate(plaintext as ForensicTraceRequestRef, new Date("2026-07-22T00:05:00.000Z"))).toMatchObject({ ok: false, error: { code: "forensic_denied" } });
	});
});
