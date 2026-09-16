/** Goal Mode exact schemas 与 runtime guards。 */

import { Type } from "typebox";
import { Value } from "typebox/value";
import {
	CanonicalUtcTimestampSchema,
	RuntimeDigestSchema,
	RuntimeIdSchema,
	RuntimeStreamHeadSchema,
	isCanonicalUtcTimestamp,
} from "../../protocol/foundation-schemas.ts";
import { isRuntimeId } from "../../protocol/ids.ts";
import type { GoalCompletionRequest, GoalModeState, GoalUsage } from "./types.ts";

export const GoalUsageSchema = Type.Object(
	{
		tokensUsed: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		inputTokens: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		cacheWriteTokens: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		outputTokens: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		activeDurationMs: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		accountingCompleteness: Type.Union([Type.Literal("complete"), Type.Literal("partial")]),
		unaccountedTurns: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	},
	{ additionalProperties: false },
);

export const GoalBudgetSchema = Type.Object(
	{
		tokenBudget: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
		timeBudgetMs: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
	},
	{ additionalProperties: false },
);

export const GoalCompletionRequestSchema = Type.Object(
	{
		requestedAt: CanonicalUtcTimestampSchema,
		requestedBy: Type.Union([Type.Literal("agent"), Type.Literal("user")]),
	},
	{ additionalProperties: false },
);

export const GoalModeStateSchema = Type.Object(
	{
		status: Type.Union([
			Type.Literal("inactive"),
			Type.Literal("active"),
			Type.Literal("paused"),
			Type.Literal("budget_limited"),
			Type.Literal("complete"),
			Type.Literal("dropped"),
		]),
		sessionId: RuntimeIdSchema,
		goalId: RuntimeIdSchema,
		revision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		objective: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
		objectiveDigest: Type.Optional(RuntimeDigestSchema),
		budget: GoalBudgetSchema,
		usage: GoalUsageSchema,
		continuations: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		completion: Type.Optional(GoalCompletionRequestSchema),
		pauseReason: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
		completedAt: Type.Optional(CanonicalUtcTimestampSchema),
		policyCeilingDigest: RuntimeDigestSchema,
		sourceHead: RuntimeStreamHeadSchema,
		projectionDigest: RuntimeDigestSchema,
		completeness: Type.Union([Type.Literal("complete"), Type.Literal("partial")]),
		updatedAt: CanonicalUtcTimestampSchema,
	},
	{ additionalProperties: false },
);

export function isGoalUsage(value: unknown): value is GoalUsage {
	if (!Value.Check(GoalUsageSchema, value)) return false;
	// 下界一致性：可见分项之和不得超过总下界，且 partial 必须由未计量轮次解释。
	return (
		value.inputTokens + value.cacheWriteTokens + value.outputTokens === value.tokensUsed &&
		(value.accountingCompleteness === "partial") === (value.unaccountedTurns > 0)
	);
}

export function isGoalCompletionRequest(value: unknown): value is GoalCompletionRequest {
	return Value.Check(GoalCompletionRequestSchema, value) && isCanonicalUtcTimestamp(value.requestedAt);
}

export function isGoalModeState(value: unknown): value is GoalModeState {
	if (!Value.Check(GoalModeStateSchema, value)) return false;
	return (
		isRuntimeId(value.sessionId, "session") &&
		isRuntimeId(value.goalId, "goal") &&
		isGoalUsage(value.usage) &&
		(value.completion === undefined || isGoalCompletionRequest(value.completion)) &&
		(value.completedAt === undefined || isCanonicalUtcTimestamp(value.completedAt)) &&
		isCanonicalUtcTimestamp(value.updatedAt)
	);
}
