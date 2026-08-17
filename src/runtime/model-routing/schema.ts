/** Model routing contract 的 exact schemas 与 guards。 */

import { Type } from "typebox";
import { Value } from "typebox/value";
import { RuntimeContentRefSchema, RuntimeDigestSchema, RuntimeIdSchema } from "../protocol/foundation-schemas.ts";
import { isRuntimeId } from "../protocol/ids.ts";
import type { ModelCapabilityProfile, ModelRouteDecision, ModelRouteRequest } from "./types.ts";

const IdentifierSchema = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]*$", minLength: 1, maxLength: 256 });

export const ModelCapabilityProfileSchema = Type.Object(
	{
		profileId: IdentifierSchema,
		providerId: IdentifierSchema,
		modelId: IdentifierSchema,
		manifestVersion: Type.String({ minLength: 1, maxLength: 64 }),
		manifestDigest: RuntimeDigestSchema,
		contextWindow: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
		maxOutputTokens: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
		reasoningProtocol: Type.Union([Type.Literal("none"), Type.Literal("native"), Type.Literal("signature")]),
		toolProtocol: Type.Union([Type.Literal("none"), Type.Literal("json"), Type.Literal("provider-native")]),
		imageInput: Type.Boolean(),
		compaction: Type.Union([Type.Literal("none"), Type.Literal("summary"), Type.Literal("full-replace")]),
		status: Type.Union([Type.Literal("verified"), Type.Literal("unknown"), Type.Literal("retired")]),
		conversionRef: Type.Optional(RuntimeContentRefSchema),
		adapterStateRef: Type.Optional(RuntimeContentRefSchema),
	},
	{ additionalProperties: false },
);

export const ModelRouteRequestSchema = Type.Object(
	{
		requestId: RuntimeIdSchema,
		operation: Type.Union([Type.Literal("request"), Type.Literal("switch"), Type.Literal("summarize"), Type.Literal("compact")]),
		requestKind: Type.Optional(Type.Union([Type.Literal("interactive"), Type.Literal("idle-recap"), Type.Literal("auto-title")])),
		sourceProfileId: Type.Optional(IdentifierSchema),
		targetProfileId: IdentifierSchema,
		contextDigest: RuntimeDigestSchema,
		planDigest: RuntimeDigestSchema,
		resourceDigest: RuntimeDigestSchema,
		requiredContextTokens: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		requiredOutputTokens: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		requiresTools: Type.Boolean(),
		requiresReasoningReplay: Type.Boolean(),
		requiresImages: Type.Boolean(),
		traceId: RuntimeIdSchema,
	},
	{ additionalProperties: false },
);

const ModelRouteDiagnosticSchema = Type.Object(
	{
		code: Type.String({ minLength: 1, maxLength: 128 }),
		severity: Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("error")]),
		message: Type.String({ minLength: 1, maxLength: 2048 }),
	},
	{ additionalProperties: false },
);

export const ModelRouteDecisionSchema = Type.Object(
	{
		requestId: RuntimeIdSchema,
		outcome: Type.Union([Type.Literal("compatible"), Type.Literal("fork"), Type.Literal("deny")]),
		targetProviderId: IdentifierSchema,
		targetModelId: IdentifierSchema,
		targetProfileId: IdentifierSchema,
		manifestDigest: RuntimeDigestSchema,
		reasonCode: Type.String({ minLength: 1, maxLength: 128 }),
		diagnostics: Type.Array(ModelRouteDiagnosticSchema, { maxItems: 32 }),
		decisionDigest: RuntimeDigestSchema,
		conversionRef: Type.Optional(RuntimeContentRefSchema),
		forkSessionId: Type.Optional(RuntimeIdSchema),
	},
	{ additionalProperties: false },
);

export function isModelCapabilityProfile(value: unknown): value is ModelCapabilityProfile {
	return Value.Check(ModelCapabilityProfileSchema, value);
}

export function isModelRouteRequest(value: unknown): value is ModelRouteRequest {
	if (!Value.Check(ModelRouteRequestSchema, value)) return false;
	return isRuntimeId(value.requestId, "command") && isRuntimeId(value.traceId, "trace");
}

export function isModelRouteDecision(value: unknown): value is ModelRouteDecision {
	if (!Value.Check(ModelRouteDecisionSchema, value) || !isRuntimeId(value.requestId, "command")) return false;
	if (value.outcome === "fork") return value.forkSessionId !== undefined && isRuntimeId(value.forkSessionId, "session");
	return value.forkSessionId === undefined;
}
