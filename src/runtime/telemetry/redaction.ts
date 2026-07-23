/** Telemetry 写出前 allowlist 脱敏与显式 forensic gate。 */

import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import { ArtifactRefSchema, type ArtifactRef } from "../protocol/v3/capability.ts";
import type {
	ApprovalId,
	AuthorityId,
	CommandId,
	PrincipalId,
	ReceiptId,
	SessionId,
	TenantId,
} from "../protocol/v3/ids.ts";
import {
	MAX_TELEMETRY_ATTRIBUTES,
	MAX_TELEMETRY_ATTRIBUTE_VALUE_LENGTH,
	TELEMETRY_SCHEMA_VERSION,
	isTelemetryObservation,
	type TelemetryAttribute,
	type TelemetryObservation,
	type TelemetryResult,
	type TelemetrySample,
} from "./types.ts";

export const DEFAULT_TELEMETRY_ATTRIBUTE_ALLOWLIST: ReadonlySet<string> = new Set([
	"runtime.id", "session.state", "event.type", "operation.kind", "outcome", "status",
	"model.id", "model.provider", "tool.name", "tool.call_id", "agent.id", "task.id",
	"approval.id", "verification.id", "workspace.id", "artifact.id", "resource.id",
	"receipt.id", "policy.digest", "executor.kind", "error.code", "duration_ms",
	"input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "cost_usd",
	"retry_count", "network_request_count", "network_bytes_sent", "network_bytes_received",
	"storage_operation_count", "storage_bytes_read", "storage_bytes_written",
]);

const FORBIDDEN_ATTRIBUTE_FRAGMENT =
	/(?:prompt|message|content|output|result|argument|\bargs\b|reasoning|thinking|secret|token|password|authorization|cookie|environment|\benv\b|credential|private|raw|command)/iu;

function safeValue(value: unknown): value is string | number | boolean {
	return (
		(typeof value === "string" && value.length <= MAX_TELEMETRY_ATTRIBUTE_VALUE_LENGTH) ||
		(typeof value === "number" && Number.isFinite(value)) ||
		typeof value === "boolean"
	);
}

export function sanitizeTelemetryObservation(
	observation: TelemetryObservation,
	allowlist: ReadonlySet<string> = DEFAULT_TELEMETRY_ATTRIBUTE_ALLOWLIST,
): TelemetryResult<TelemetrySample> {
	if (!isTelemetryObservation(observation)) {
		return { ok: false, error: { code: "invalid_schema", message: "telemetry observation is invalid", retryable: false } };
	}
	const attributes: TelemetryAttribute[] = [];
	let droppedAttributeCount = 0;
	for (const [key, value] of Object.entries(observation.attributes).sort(([left], [right]) => left.localeCompare(right))) {
		if (
			attributes.length >= MAX_TELEMETRY_ATTRIBUTES ||
			FORBIDDEN_ATTRIBUTE_FRAGMENT.test(key) ||
			!allowlist.has(key) ||
			!safeValue(value)
		) {
			droppedAttributeCount += 1;
			continue;
		}
		attributes.push({ key, value });
	}
	const body = {
		schemaVersion: TELEMETRY_SCHEMA_VERSION,
		projection: "metadata_only" as const,
		authorityId: observation.authorityId,
		tenantId: observation.tenantId,
		principalId: observation.principalId,
		sessionId: observation.sessionId,
		traceId: observation.traceId,
		name: observation.name,
		severity: observation.severity,
		observedAt: observation.observedAt,
		...(observation.eventSequence === undefined ? {} : { eventSequence: observation.eventSequence }),
		...(observation.eventHash === undefined ? {} : { eventHash: observation.eventHash }),
		attributes,
		redaction: { policyId: "runledger-telemetry-metadata-v1" as const, droppedAttributeCount },
	};
	return { ok: true, value: { ...body, sampleDigest: canonicalDigest(body) } };
}

export interface ForensicTraceRequestRef {
	schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
	authorityId: AuthorityId;
	tenantId: TenantId;
	principalId: PrincipalId;
	sessionId: SessionId;
	requestId: CommandId;
	approvalId: ApprovalId;
	approvalReceiptId: ReceiptId;
	effectivePolicyReceiptId: ReceiptId;
	effectivePolicyDigest: string;
	organizationDecision: "allow" | "deny";
	purposeDigest: string;
	encryptedArtifact: ArtifactRef;
	keyLifecycleReceiptId: ReceiptId;
	auditReceiptId: ReceiptId;
	requestedAt: string;
	expiresAt: string;
}

export interface ForensicTracePermit {
	schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
	authorityId: AuthorityId;
	tenantId: TenantId;
	principalId: PrincipalId;
	sessionId: SessionId;
	requestId: CommandId;
	approvalReceiptId: ReceiptId;
	effectivePolicyReceiptId: ReceiptId;
	encryptedArtifactId: ArtifactRef["artifactId"];
	encryptedArtifactDigest: string;
	keyLifecycleReceiptId: ReceiptId;
	auditReceiptId: ReceiptId;
	validFrom: string;
	validUntil: string;
	contentHandling: "encrypted_artifact_only";
	permitDigest: string;
}

const runtimeId = (kind: string) =>
	Type.String({ pattern: `^${kind}_[A-Za-z0-9][A-Za-z0-9._~-]*$`, maxLength: 128 });
const digest = Type.String({ pattern: "^[a-f0-9]{64}$", maxLength: 64 });
const timestamp = Type.String({
	pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$",
	maxLength: 24,
});
const exact = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

export const ForensicTraceRequestRefSchema = exact({
	schemaVersion: Type.Literal(TELEMETRY_SCHEMA_VERSION),
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	principalId: runtimeId("principal"),
	sessionId: runtimeId("session"),
	requestId: runtimeId("command"),
	approvalId: runtimeId("approval"),
	approvalReceiptId: runtimeId("receipt"),
	effectivePolicyReceiptId: runtimeId("receipt"),
	effectivePolicyDigest: digest,
	organizationDecision: Type.Union([Type.Literal("allow"), Type.Literal("deny")]),
	purposeDigest: digest,
	encryptedArtifact: ArtifactRefSchema,
	keyLifecycleReceiptId: runtimeId("receipt"),
	auditReceiptId: runtimeId("receipt"),
	requestedAt: timestamp,
	expiresAt: timestamp,
});

export const ForensicTracePermitSchema = exact({
	schemaVersion: Type.Literal(TELEMETRY_SCHEMA_VERSION),
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	principalId: runtimeId("principal"),
	sessionId: runtimeId("session"),
	requestId: runtimeId("command"),
	approvalReceiptId: runtimeId("receipt"),
	effectivePolicyReceiptId: runtimeId("receipt"),
	encryptedArtifactId: runtimeId("artifact"),
	encryptedArtifactDigest: digest,
	keyLifecycleReceiptId: runtimeId("receipt"),
	auditReceiptId: runtimeId("receipt"),
	validFrom: timestamp,
	validUntil: timestamp,
	contentHandling: Type.Literal("encrypted_artifact_only"),
	permitDigest: digest,
});

export function isForensicTracePermit(value: unknown): value is ForensicTracePermit {
	if (!Check(ForensicTracePermitSchema, value)) return false;
	const permit = value as unknown as ForensicTracePermit;
	const { permitDigest: _permitDigest, ...body } = permit;
	return permit.permitDigest === canonicalDigest(body);
}

export function evaluateForensicTraceGate(
	request: ForensicTraceRequestRef,
	at: Date,
	maximumDurationMs = 60 * 60 * 1_000,
): TelemetryResult<ForensicTracePermit> {
	if (!Check(ForensicTraceRequestRefSchema, request) || !Number.isFinite(at.getTime())) {
		return { ok: false, error: { code: "invalid_schema", message: "forensic trace request is invalid", retryable: false } };
	}
	const requestedAt = Date.parse(request.requestedAt);
	const expiresAt = Date.parse(request.expiresAt);
	const boundedMaximum = Math.max(1, Math.min(24 * 60 * 60 * 1_000, Math.trunc(maximumDurationMs)));
	if (
		request.organizationDecision !== "allow" ||
		request.encryptedArtifact.authorityId !== request.authorityId ||
		request.encryptedArtifact.tenantId !== request.tenantId ||
		request.encryptedArtifact.redaction !== "encrypted_forensic" ||
		expiresAt <= requestedAt ||
		expiresAt - requestedAt > boundedMaximum ||
		at.getTime() < requestedAt ||
		at.getTime() >= expiresAt
	) {
		return { ok: false, error: { code: "forensic_denied", message: "forensic trace gate denied the request", retryable: false } };
	}
	const body = {
		schemaVersion: TELEMETRY_SCHEMA_VERSION,
		authorityId: request.authorityId,
		tenantId: request.tenantId,
		principalId: request.principalId,
		sessionId: request.sessionId,
		requestId: request.requestId,
		approvalReceiptId: request.approvalReceiptId,
		effectivePolicyReceiptId: request.effectivePolicyReceiptId,
		encryptedArtifactId: request.encryptedArtifact.artifactId,
		encryptedArtifactDigest: request.encryptedArtifact.storedDigest,
		keyLifecycleReceiptId: request.keyLifecycleReceiptId,
		auditReceiptId: request.auditReceiptId,
		validFrom: request.requestedAt,
		validUntil: request.expiresAt,
		contentHandling: "encrypted_artifact_only" as const,
	};
	return { ok: true, value: { ...body, permitDigest: canonicalDigest(body) } };
}
