/** Control/telemetry passive contract 的 exact schemas 与 guards。 */

import { Type } from "typebox";
import { Value } from "typebox/value";
import {
	CanonicalUtcTimestampSchema,
	RuntimeContentRefSchema,
	RuntimeDigestSchema,
	RuntimeIdSchema,
	RuntimeStreamHeadSchema,
	isCanonicalUtcTimestamp,
} from "../protocol/foundation-schemas.ts";
import { isRuntimeId } from "../protocol/ids.ts";
import { AdapterIdentityRefSchema } from "../protocol/adapter.ts";
import type {
	CostRecord,
	LifecycleRef,
	ManagedPolicyRef,
	ProductionCompositionReceipt,
	RemoteInvocationRef,
	RuntimeActivity,
	TelemetryManifest,
} from "./control-telemetry.ts";

export const RuntimeActivitySchema = Type.Object(
	{
		sessionId: RuntimeIdSchema,
		turnId: Type.Optional(RuntimeIdSchema),
		toolCallId: Type.Optional(RuntimeIdSchema),
		agentId: Type.Optional(RuntimeIdSchema),
		state: Type.Union([
			Type.Literal("idle"),
			Type.Literal("running"),
			Type.Literal("waiting"),
			Type.Literal("stopping"),
			Type.Literal("terminal"),
			Type.Literal("uncertain"),
		]),
		sourceHead: RuntimeStreamHeadSchema,
		lastDurableProgressAt: CanonicalUtcTimestampSchema,
		costSummaryRef: Type.Optional(RuntimeContentRefSchema),
		exporterHealthRef: Type.Optional(RuntimeContentRefSchema),
	},
	{ additionalProperties: false },
);

export const ProductionCompositionReceiptSchema = Type.Object(
	{
		receiptId: RuntimeIdSchema,
		runtimeId: RuntimeIdSchema,
		generation: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		featureRequirementsDigest: RuntimeDigestSchema,
		adapters: Type.Array(AdapterIdentityRefSchema, { maxItems: 64 }),
		effectiveFeatures: Type.Array(Type.String({ pattern: "^[A-Za-z0-9._-]+$", minLength: 1, maxLength: 128 }), { maxItems: 128 }),
		compositionDigest: RuntimeDigestSchema,
		issuedAt: CanonicalUtcTimestampSchema,
		expiresAt: CanonicalUtcTimestampSchema,
	},
	{ additionalProperties: false },
);

export const ManagedPolicyRefSchema = Type.Object(
	{
		policyId: RuntimeIdSchema,
		sourceDigests: Type.Array(RuntimeDigestSchema, { minItems: 1, maxItems: 64 }),
		winnerDigest: RuntimeDigestSchema,
		loserDigests: Type.Array(RuntimeDigestSchema, { maxItems: 64 }),
		denyUnionDigest: RuntimeDigestSchema,
		normalizationReasonCode: Type.String({ minLength: 1, maxLength: 128 }),
		effectiveDigest: RuntimeDigestSchema,
		receiptRef: RuntimeContentRefSchema,
	},
	{ additionalProperties: false },
);

export const CostRecordSchema = Type.Object(
	{
		receiptId: RuntimeIdSchema,
		sessionId: RuntimeIdSchema,
		parentSessionId: Type.Optional(RuntimeIdSchema),
		providerId: Type.String({ minLength: 1, maxLength: 128 }),
		modelId: Type.String({ minLength: 1, maxLength: 256 }),
		operation: Type.Union([
			Type.Literal("model_call"),
			Type.Literal("tool_call"),
			Type.Literal("verification"),
			Type.Literal("remote_execution"),
		]),
		inputUnits: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		outputUnits: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		cacheUnits: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		toolUnits: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		currency: Type.String({ pattern: "^[A-Z]{3}$", minLength: 3, maxLength: 3 }),
		estimatedMicrounits: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		finalMicrounits: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
		reconciliationRef: Type.Optional(RuntimeContentRefSchema),
		recordedAt: CanonicalUtcTimestampSchema,
	},
	{ additionalProperties: false },
);

export const TelemetryManifestSchema = Type.Object(
	{
		manifestId: RuntimeIdSchema,
		allowedFieldsDigest: RuntimeDigestSchema,
		sinksDigest: RuntimeDigestSchema,
		samplingPermille: Type.Integer({ minimum: 0, maximum: 1000 }),
		redactionPolicyDigest: RuntimeDigestSchema,
		retentionDays: Type.Integer({ minimum: 0, maximum: 36500 }),
		tenantId: RuntimeIdSchema,
		exporter: AdapterIdentityRefSchema,
		manifestDigest: RuntimeDigestSchema,
	},
	{ additionalProperties: false },
);

export const RemoteInvocationRefSchema = Type.Object(
	{
		receiptId: RuntimeIdSchema,
		authorityId: RuntimeIdSchema,
		tenantId: RuntimeIdSchema,
		workloadId: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$", minLength: 1, maxLength: 128 }),
		workspaceRef: RuntimeContentRefSchema,
		capabilityRef: RuntimeContentRefSchema,
		credentialGrantRef: RuntimeContentRefSchema,
		requestDigest: RuntimeDigestSchema,
		executorAttestationRef: RuntimeContentRefSchema,
		resultReceiptRef: RuntimeContentRefSchema,
	},
	{ additionalProperties: false },
);

export const LifecycleRefSchema = Type.Object(
	{
		subjectKind: Type.Union([
			Type.Literal("session"),
			Type.Literal("handoff"),
			Type.Literal("deletion"),
			Type.Literal("retention"),
		]),
		subjectId: RuntimeIdSchema,
		authorityHead: RuntimeStreamHeadSchema,
		legalHoldRef: Type.Optional(RuntimeContentRefSchema),
		referenceGraphDigest: RuntimeDigestSchema,
		tombstoneRef: Type.Optional(RuntimeContentRefSchema),
	},
	{ additionalProperties: false },
);

export function isRuntimeActivity(value: unknown): value is RuntimeActivity {
	if (!Value.Check(RuntimeActivitySchema, value)) return false;
	return (
		isRuntimeId(value.sessionId, "session") &&
		(value.turnId === undefined || isRuntimeId(value.turnId, "turn")) &&
		(value.toolCallId === undefined || isRuntimeId(value.toolCallId, "toolCall")) &&
		(value.agentId === undefined || isRuntimeId(value.agentId, "agent")) &&
		value.sourceHead.streamId === value.sessionId &&
		isCanonicalUtcTimestamp(value.lastDurableProgressAt)
	);
}

export function isProductionCompositionReceipt(value: unknown): value is ProductionCompositionReceipt {
	if (!Value.Check(ProductionCompositionReceiptSchema, value)) return false;
	return (
		isRuntimeId(value.receiptId, "receipt") &&
		isRuntimeId(value.runtimeId, "runtime") &&
		isCanonicalUtcTimestamp(value.issuedAt) &&
		isCanonicalUtcTimestamp(value.expiresAt) &&
		Date.parse(value.expiresAt) > Date.parse(value.issuedAt) &&
		new Set(value.adapters.map((adapter) => adapter.adapterId)).size === value.adapters.length &&
		new Set(value.effectiveFeatures).size === value.effectiveFeatures.length
	);
}

export function isManagedPolicyRef(value: unknown): value is ManagedPolicyRef {
	if (!Value.Check(ManagedPolicyRefSchema, value)) return false;
	return isRuntimeId(value.policyId, "receipt");
}

export function isCostRecord(value: unknown): value is CostRecord {
	if (!Value.Check(CostRecordSchema, value)) return false;
	return (
		isRuntimeId(value.receiptId, "receipt") &&
		isRuntimeId(value.sessionId, "session") &&
		(value.parentSessionId === undefined || isRuntimeId(value.parentSessionId, "session")) &&
		isCanonicalUtcTimestamp(value.recordedAt)
	);
}

export function isTelemetryManifest(value: unknown): value is TelemetryManifest {
	if (!Value.Check(TelemetryManifestSchema, value)) return false;
	return isRuntimeId(value.manifestId, "receipt") && isRuntimeId(value.tenantId, "tenant");
}

export function isRemoteInvocationRef(value: unknown): value is RemoteInvocationRef {
	if (!Value.Check(RemoteInvocationRefSchema, value)) return false;
	return (
		isRuntimeId(value.receiptId, "receipt") &&
		isRuntimeId(value.authorityId, "authority") &&
		isRuntimeId(value.tenantId, "tenant")
	);
}

export function isLifecycleRef(value: unknown): value is LifecycleRef {
	if (!Value.Check(LifecycleRefSchema, value) || !isRuntimeId(value.authorityHead.streamId, "authority")) return false;
	return value.subjectKind !== "session" || isRuntimeId(value.subjectId, "session");
}
