/** Runtime 基础 contract 的 exact TypeBox schema 与 runtime guards。 */

import { Type } from "typebox";
import { Value } from "typebox/value";
import type {
	RuntimeContentRef,
	RuntimeDigest,
	RuntimeRevisionRef,
	RuntimeStreamHead,
} from "./foundation.ts";
import { RUNTIME_ERROR_CODES, type RuntimeErrorShape } from "./errors.ts";
import { RUNTIME_ID_KINDS, RUNTIME_ID_SEED_MAX_LENGTH, type RuntimeId } from "./ids.ts";

const RUNTIME_ID_PATTERN = `^(?:${RUNTIME_ID_KINDS.join("|")})_[A-Za-z0-9._~-]{1,${RUNTIME_ID_SEED_MAX_LENGTH}}$`;
const CANONICAL_UTC_TIMESTAMP_PATTERN = "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$";

export const RuntimeIdSchema = Type.Unsafe<RuntimeId>({
	type: "string",
	pattern: RUNTIME_ID_PATTERN,
	maxLength: RUNTIME_ID_SEED_MAX_LENGTH + 16,
});

export const RuntimeDigestSchema = Type.Object(
	{
		algorithm: Type.Literal("sha256"),
		digest: Type.String({ pattern: "^[a-f0-9]{64}$", minLength: 64, maxLength: 64 }),
	},
	{ additionalProperties: false },
);

const RuntimeContentSubjectKindSchema = Type.Union([
	Type.Literal("artifact"),
	Type.Literal("content"),
	Type.Literal("details"),
	Type.Literal("attestation"),
	Type.Literal("receipt"),
	Type.Literal("manifest"),
	Type.Literal("snapshot"),
	Type.Literal("projection"),
]);

export const RuntimeContentRefSchema = Type.Object(
	{
		subjectKind: RuntimeContentSubjectKindSchema,
		digest: RuntimeDigestSchema,
		mediaType: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
		size: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
	},
	{ additionalProperties: false },
);

export const RuntimeRevisionRefSchema = Type.Object(
	{
		subjectId: RuntimeIdSchema,
		revision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	},
	{ additionalProperties: false },
);

export const RuntimeStreamHeadSchema = Type.Object(
	{
		streamId: RuntimeIdSchema,
		sequence: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		eventHash: RuntimeDigestSchema,
	},
	{ additionalProperties: false },
);

const RuntimeErrorCodeSchema = Type.Unsafe<RuntimeErrorShape["code"]>({
	type: "string",
	enum: [...RUNTIME_ERROR_CODES],
});

export const RuntimeErrorShapeSchema = Type.Object(
	{
		code: RuntimeErrorCodeSchema,
		message: Type.String({ minLength: 1, maxLength: 2048 }),
		retryable: Type.Boolean(),
		correlationId: RuntimeIdSchema,
		detailsRef: Type.Optional(RuntimeContentRefSchema),
	},
	{ additionalProperties: false },
);

export const CanonicalUtcTimestampSchema = Type.Unsafe<string>({
	type: "string",
	pattern: CANONICAL_UTC_TIMESTAMP_PATTERN,
	minLength: 24,
	maxLength: 24,
});

export function isRuntimeDigest(value: unknown): value is RuntimeDigest {
	return Value.Check(RuntimeDigestSchema, value);
}

export function isRuntimeContentRef(value: unknown): value is RuntimeContentRef {
	return Value.Check(RuntimeContentRefSchema, value);
}

export function isRuntimeRevisionRef(value: unknown): value is RuntimeRevisionRef {
	return Value.Check(RuntimeRevisionRefSchema, value);
}

export function isRuntimeStreamHead(value: unknown): value is RuntimeStreamHead {
	return Value.Check(RuntimeStreamHeadSchema, value);
}

export function isRuntimeErrorShape(value: unknown): value is RuntimeErrorShape {
	return Value.Check(RuntimeErrorShapeSchema, value);
}

export function isCanonicalUtcTimestamp(value: unknown): value is string {
	if (!Value.Check(CanonicalUtcTimestampSchema, value)) return false;
	const date = new Date(value);
	return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}
