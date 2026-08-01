/** Resource contract 的 exact TypeBox schemas 与 runtime guards。 */

import { Type } from "typebox";
import { Value } from "typebox/value";
import { CapabilityClaimSchema, isCapabilityClaim } from "../protocol/capability.ts";
import { canonicalDigest } from "../protocol/canonical-json.ts";
import {
	CanonicalUtcTimestampSchema,
	RuntimeContentRefSchema,
	RuntimeDigestSchema,
	RuntimeIdSchema,
	RuntimeStreamHeadSchema,
	isCanonicalUtcTimestamp,
} from "../protocol/foundation-schemas.ts";
import { isRuntimeId } from "../protocol/ids.ts";
import type {
	ResourceApprovalReceipt,
	ResourceIdentity,
	ResourceLifecycleEvent,
	RuntimeResourceSnapshot,
	RuntimeToolDescriptor,
	RuntimeToolInvocation,
	RuntimeToolResult,
} from "./types.ts";

const ResourceKindSchema = Type.Union([
	Type.Literal("plugin"),
	Type.Literal("skill"),
	Type.Literal("hook"),
	Type.Literal("mcp-server"),
	Type.Literal("mcp-tool"),
]);
const ResourceSourceSchema = Type.Union([
	Type.Literal("builtin"),
	Type.Literal("user"),
	Type.Literal("project"),
	Type.Literal("plugin"),
	Type.Literal("session"),
]);

export const ResourceIdentitySchema = Type.Object(
	{
		resourceId: RuntimeIdSchema,
		kind: ResourceKindSchema,
		qualifiedId: Type.String({ minLength: 1, maxLength: 256 }),
		version: Type.String({ minLength: 1, maxLength: 64 }),
		source: ResourceSourceSchema,
		digest: RuntimeDigestSchema,
	},
	{ additionalProperties: false },
);

const ResourceProvenanceSchema = Type.Object(
	{
		source: ResourceSourceSchema,
		sourceLocatorDigest: RuntimeDigestSchema,
		publisher: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
		signatureRef: Type.Optional(RuntimeContentRefSchema),
		parentResourceId: Type.Optional(RuntimeIdSchema),
	},
	{ additionalProperties: false },
);

export const ResourceApprovalReceiptSchema = Type.Object(
	{
		receiptId: RuntimeIdSchema,
		identity: ResourceIdentitySchema,
		manifestDigest: RuntimeDigestSchema,
		configDigest: RuntimeDigestSchema,
		commandDigest: RuntimeDigestSchema,
		assetsDigest: RuntimeDigestSchema,
		capabilityDigest: RuntimeDigestSchema,
		principalId: RuntimeIdSchema,
		scope: Type.Union([Type.Literal("session"), Type.Literal("project"), Type.Literal("user")]),
		approvedAt: CanonicalUtcTimestampSchema,
		expiresAt: Type.Optional(CanonicalUtcTimestampSchema),
		revocationRevision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	},
	{ additionalProperties: false },
);

export const RuntimeToolDescriptorSchema = Type.Object(
	{
		identity: ResourceIdentitySchema,
		provenance: ResourceProvenanceSchema,
		runtimeName: Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_-]*$", minLength: 1, maxLength: 128 }),
		description: Type.String({ minLength: 1, maxLength: 2048 }),
		parametersSchemaRef: RuntimeContentRefSchema,
		claims: Type.Array(CapabilityClaimSchema, { maxItems: 32 }),
		exposure: Type.Union([Type.Literal("direct"), Type.Literal("deferred"), Type.Literal("hidden")]),
		isReadOnly: Type.Boolean(),
		isDestructive: Type.Boolean(),
		isConcurrencySafe: Type.Boolean(),
		trust: Type.Union([
			Type.Literal("untrusted"),
			Type.Literal("trusted"),
			Type.Literal("stale"),
			Type.Literal("revoked"),
		]),
		activation: Type.Union([
			Type.Literal("disabled"),
			Type.Literal("ready"),
			Type.Literal("blocked"),
			Type.Literal("failed"),
		]),
		descriptorDigest: RuntimeDigestSchema,
	},
	{ additionalProperties: false },
);

export const RuntimeToolInvocationSchema = Type.Object(
	{
		requestId: RuntimeIdSchema,
		tool: ResourceIdentitySchema,
		inputDigest: RuntimeDigestSchema,
		inputRef: Type.Optional(RuntimeContentRefSchema),
		requestedClaims: Type.Array(CapabilityClaimSchema, { maxItems: 32 }),
		decisionReceiptRef: RuntimeContentRefSchema,
		snapshotId: RuntimeIdSchema,
		correlationId: RuntimeIdSchema,
	},
	{ additionalProperties: false },
);

const ResourceContentSchema = Type.Union([
	Type.Object(
		{ type: Type.Literal("text"), text: Type.String({ maxLength: 4096 }) },
		{ additionalProperties: false },
	),
	Type.Object(
		{ type: Type.Literal("content_ref"), ref: RuntimeContentRefSchema },
		{ additionalProperties: false },
	),
]);

export const RuntimeToolResultSchema = Type.Object(
	{
		requestId: RuntimeIdSchema,
		tool: ResourceIdentitySchema,
		content: Type.Array(ResourceContentSchema, { maxItems: 32 }),
		outcome: Type.Union([
			Type.Literal("ok"),
			Type.Literal("error"),
			Type.Literal("denied"),
			Type.Literal("cancelled"),
			Type.Literal("unsupported"),
		]),
		originalBytes: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		truncated: Type.Boolean(),
		contentDigest: RuntimeDigestSchema,
	},
	{ additionalProperties: false },
);

const ResourceDiagnosticSummarySchema = Type.Object(
	{
		code: Type.String({ minLength: 1, maxLength: 128 }),
		severity: Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("error")]),
		message: Type.String({ minLength: 1, maxLength: 2048 }),
		resourceId: Type.Optional(RuntimeIdSchema),
	},
	{ additionalProperties: false },
);

export const RuntimeResourceSnapshotSchema = Type.Object(
	{
		snapshotId: RuntimeIdSchema,
		generation: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		createdAt: CanonicalUtcTimestampSchema,
		sourceHead: RuntimeStreamHeadSchema,
		resources: Type.Array(RuntimeToolDescriptorSchema, { maxItems: 256 }),
		diagnostics: Type.Array(ResourceDiagnosticSummarySchema, { maxItems: 128 }),
		digest: RuntimeDigestSchema,
		completeness: Type.Union([Type.Literal("complete"), Type.Literal("partial")]),
	},
	{ additionalProperties: false },
);

export const ResourceLifecycleEventSchema = Type.Object(
	{
		identity: ResourceIdentitySchema,
		state: Type.Union([
			Type.Literal("discovered"),
			Type.Literal("approved"),
			Type.Literal("revoked"),
			Type.Literal("activated"),
			Type.Literal("deactivated"),
			Type.Literal("failed"),
		]),
		snapshotId: RuntimeIdSchema,
		receiptRef: Type.Optional(RuntimeContentRefSchema),
		reasonCode: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
	},
	{ additionalProperties: false },
);

export function resourceIdentityKey(identity: ResourceIdentity): string {
	return `${identity.kind}:${identity.qualifiedId}@${identity.version}:${identity.source}:${identity.digest.digest}`;
}

export function resourceIdentityDigest(identity: ResourceIdentity): string {
	return canonicalDigest({
		kind: identity.kind,
		qualifiedId: identity.qualifiedId,
		version: identity.version,
		source: identity.source,
		digest: identity.digest,
	});
}

export function isResourceIdentity(value: unknown): value is ResourceIdentity {
	if (!Value.Check(ResourceIdentitySchema, value)) return false;
	return isRuntimeId(value.resourceId, "resource");
}

export function isResourceApprovalReceipt(value: unknown): value is ResourceApprovalReceipt {
	if (!Value.Check(ResourceApprovalReceiptSchema, value)) return false;
	return (
		isRuntimeId(value.receiptId, "receipt") &&
		isResourceIdentity(value.identity) &&
		isRuntimeId(value.principalId, "principal") &&
		isCanonicalUtcTimestamp(value.approvedAt) &&
		(value.expiresAt === undefined || (isCanonicalUtcTimestamp(value.expiresAt) && Date.parse(value.expiresAt) > Date.parse(value.approvedAt)))
	);
}

export function isRuntimeToolDescriptor(value: unknown): value is RuntimeToolDescriptor {
	if (!Value.Check(RuntimeToolDescriptorSchema, value)) return false;
	return (
		isResourceIdentity(value.identity) &&
		(value.provenance.parentResourceId === undefined || isRuntimeId(value.provenance.parentResourceId, "resource")) &&
		value.claims.every(isCapabilityClaim)
	);
}

export function isRuntimeToolInvocation(value: unknown): value is RuntimeToolInvocation {
	if (!Value.Check(RuntimeToolInvocationSchema, value)) return false;
	return (
		isRuntimeId(value.requestId, "command") &&
		isResourceIdentity(value.tool) &&
		value.requestedClaims.every(isCapabilityClaim) &&
		isRuntimeId(value.snapshotId, "snapshot") &&
		isRuntimeId(value.correlationId, "trace")
	);
}

export function isRuntimeToolResult(value: unknown): value is RuntimeToolResult {
	if (!Value.Check(RuntimeToolResultSchema, value)) return false;
	return isRuntimeId(value.requestId, "command") && isResourceIdentity(value.tool);
}

export function isRuntimeResourceSnapshot(value: unknown): value is RuntimeResourceSnapshot {
	if (!Value.Check(RuntimeResourceSnapshotSchema, value)) return false;
	return (
		isRuntimeId(value.snapshotId, "snapshot") &&
		isCanonicalUtcTimestamp(value.createdAt) &&
		value.resources.every(isRuntimeToolDescriptor) &&
		value.diagnostics.every((diagnostic) => diagnostic.resourceId === undefined || isRuntimeId(diagnostic.resourceId, "resource"))
	);
}

export function isResourceLifecycleEvent(value: unknown): value is ResourceLifecycleEvent {
	if (!Value.Check(ResourceLifecycleEventSchema, value)) return false;
	return isResourceIdentity(value.identity) && isRuntimeId(value.snapshotId, "snapshot");
}
