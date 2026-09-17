import { Type } from "typebox";
import type { Static } from "typebox";
import { WebIdSchema, WebIntegerSchema, WebNumberSchema } from "./common.ts";

/** 数量分别保留精确与估算部分；缺失不能变成零或完整总额。 */
export const WebUsageQuantitySchema = Type.Object({
  exact: Type.Union([WebNumberSchema, Type.Null()]),
  estimated: Type.Union([WebNumberSchema, Type.Null()]),
  missingCalls: WebIntegerSchema,
}, { additionalProperties: false });
export const WebUsageRequestSchema = Type.Object({
  timeFrom: WebIntegerSchema, timeTo: WebIntegerSchema,
}, { additionalProperties: false });
export const WebUsageSchema = Type.Object({
  version: Type.Literal(1), projectId: WebIdSchema, asOfMs: WebIntegerSchema,
  timeFrom: WebIntegerSchema, timeTo: WebIntegerSchema,
  coverage: Type.Union([Type.Literal("complete"), Type.Literal("partial"), Type.Literal("unavailable")]),
  uniqueCalls: WebIntegerSchema, excludedUnidentifiedObservations: WebIntegerSchema,
  sources: Type.Array(Type.Union([Type.Literal("provider"), Type.Literal("replayed"), Type.Literal("metered"), Type.Literal("estimated")]), { maxItems: 4, uniqueItems: true }),
  inputTokens: WebUsageQuantitySchema, outputTokens: WebUsageQuantitySchema,
  cacheReadTokens: WebUsageQuantitySchema, cacheWriteTokens: WebUsageQuantitySchema,
  costUsd: WebUsageQuantitySchema,
}, { additionalProperties: false });
export type WebUsage = Static<typeof WebUsageSchema>;
