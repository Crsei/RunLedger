/** ContextEngine exact schemas 与 runtime guards。 */

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
import type { ContextAssemblyReceipt, ContextAssemblyRequest, ContextFragment } from "./types.ts";

const FragmentIdSchema = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$", minLength: 1, maxLength: 128 });
const ModelProfileIdSchema = Type.String({ minLength: 1, maxLength: 256 });

export const ContextFragmentSchema = Type.Object(
	{
		fragmentId: FragmentIdSchema,
		layer: Type.Union([
			Type.Literal("identity"),
			Type.Literal("policy"),
			Type.Literal("mode"),
			Type.Literal("resources"),
			Type.Literal("history"),
			Type.Literal("memory"),
			Type.Literal("task"),
		]),
		order: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		contentRef: RuntimeContentRefSchema,
		contentDigest: RuntimeDigestSchema,
		estimatedTokens: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		trust: Type.Union([Type.Literal("trusted"), Type.Literal("untrusted"), Type.Literal("mixed")]),
		taint: Type.Union([
			Type.Literal("none"),
			Type.Literal("user_input"),
			Type.Literal("tool_output"),
			Type.Literal("external"),
		]),
		priority: Type.Union([Type.Literal("required"), Type.Literal("normal"), Type.Literal("optional")]),
	},
	{ additionalProperties: false },
);

export const ContextAssemblyRequestSchema = Type.Object(
	{
		requestId: RuntimeIdSchema,
		modelProfileId: ModelProfileIdSchema,
		contextWindow: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
		outputReserve: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		toolReserve: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		fragments: Type.Array(ContextFragmentSchema, { maxItems: 256 }),
		traceId: RuntimeIdSchema,
	},
	{ additionalProperties: false },
);

const ContextOmissionSchema = Type.Object(
	{
		fragmentId: FragmentIdSchema,
		reasonCode: Type.String({ minLength: 1, maxLength: 128 }),
	},
	{ additionalProperties: false },
);
const ContextDiagnosticSchema = Type.Object(
	{
		code: Type.String({ minLength: 1, maxLength: 128 }),
		severity: Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("error")]),
		message: Type.String({ minLength: 1, maxLength: 2048 }),
	},
	{ additionalProperties: false },
);

export const ContextAssemblyReceiptSchema = Type.Object(
	{
		requestId: RuntimeIdSchema,
		modelProfileId: ModelProfileIdSchema,
		fragmentIds: Type.Array(FragmentIdSchema, { maxItems: 256 }),
		omittedFragments: Type.Array(ContextOmissionSchema, { maxItems: 256 }),
		estimatedInputTokens: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		reservedOutputTokens: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		contextDigest: RuntimeDigestSchema,
		diagnostics: Type.Array(ContextDiagnosticSchema, { maxItems: 64 }),
		sourceHead: RuntimeStreamHeadSchema,
		projectionDigest: RuntimeDigestSchema,
		assembledAt: CanonicalUtcTimestampSchema,
	},
	{ additionalProperties: false },
);

export function isContextFragment(value: unknown): value is ContextFragment {
	return Value.Check(ContextFragmentSchema, value);
}

export function isContextAssemblyRequest(value: unknown): value is ContextAssemblyRequest {
	if (!Value.Check(ContextAssemblyRequestSchema, value)) return false;
	if (!isRuntimeId(value.requestId, "command") || !isRuntimeId(value.traceId, "trace")) return false;
	if (value.outputReserve + value.toolReserve > value.contextWindow) return false;
	const ids = new Set(value.fragments.map((fragment) => fragment.fragmentId));
	return ids.size === value.fragments.length && value.fragments.every(isContextFragment);
}

export function isContextAssemblyReceipt(value: unknown): value is ContextAssemblyReceipt {
	if (!Value.Check(ContextAssemblyReceiptSchema, value)) return false;
	return isRuntimeId(value.requestId, "command") && isCanonicalUtcTimestamp(value.assembledAt);
}
