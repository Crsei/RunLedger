/** Compaction exact schema 与 runtime guard。 */

import { Type } from "typebox";
import { Value } from "typebox/value";
import {
	CanonicalUtcTimestampSchema,
	RuntimeContentRefSchema,
	RuntimeDigestSchema,
	RuntimeIdSchema,
	isCanonicalUtcTimestamp,
} from "../../protocol/foundation-schemas.ts";
import { isRuntimeId } from "../../protocol/ids.ts";
import { RuntimeEventRangeRefSchema, isRuntimeEventRangeRef } from "../../protocol/schemas.ts";
import type { CompactionCheckpoint } from "./types.ts";

export const CompactionCheckpointSchema = Type.Object(
	{
		compactionId: RuntimeIdSchema,
		sessionId: RuntimeIdSchema,
		reason: Type.Union([
			Type.Literal("manual"),
			Type.Literal("auto"),
			Type.Literal("overflow"),
			Type.Literal("model_switch"),
		]),
		status: Type.Union([
			Type.Literal("planned"),
			Type.Literal("started"),
			Type.Literal("completed"),
			Type.Literal("failed"),
		]),
		sourceRange: RuntimeEventRangeRefSchema,
		replacementArtifactRef: Type.Optional(RuntimeContentRefSchema),
		invariantDigest: RuntimeDigestSchema,
		attempt: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
		terminalReceiptRef: Type.Optional(RuntimeContentRefSchema),
		projectionDigest: RuntimeDigestSchema,
		completeness: Type.Union([Type.Literal("complete"), Type.Literal("partial")]),
		createdAt: CanonicalUtcTimestampSchema,
	},
	{ additionalProperties: false },
);

export function isCompactionCheckpoint(value: unknown): value is CompactionCheckpoint {
	if (!Value.Check(CompactionCheckpointSchema, value)) return false;
	if (
		!isRuntimeId(value.compactionId, "snapshot") ||
		!isRuntimeId(value.sessionId, "session") ||
		!isRuntimeEventRangeRef(value.sourceRange) ||
		!isCanonicalUtcTimestamp(value.createdAt)
	) return false;
	if (value.sourceRange.stream.scope !== "session" || value.sourceRange.stream.sessionId !== value.sessionId) return false;
	if (value.status === "completed") return value.replacementArtifactRef !== undefined && value.terminalReceiptRef !== undefined;
	if (value.status === "failed") return value.terminalReceiptRef !== undefined;
	return value.terminalReceiptRef === undefined;
}
