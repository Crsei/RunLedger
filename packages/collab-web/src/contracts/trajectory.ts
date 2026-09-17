import { Type } from "typebox";
import type { Static } from "typebox";
import { WEB_BOUNDS, WebCursorSchema, WebIdSchema, WebIntegerSchema, WebLabelSchema, WebNumberSchema, WebPageFields, WebPageRequestSchema, WebTextSchema, WebWatermarkSchema } from "./common.ts";

export const WebTrajectoryStateSchema = Type.Union([
  Type.Literal("running"), Type.Literal("waiting"), Type.Literal("succeeded"), Type.Literal("failed"),
  Type.Literal("cancelled"), Type.Literal("interrupted"), Type.Literal("unknown"),
]);
export const WebDetailAvailabilitySchema = Type.Union([
  Type.Literal("complete"), Type.Literal("more"), Type.Literal("not-recorded"), Type.Literal("unavailable"), Type.Literal("corrupt"),
]);
export const WebTrajectoryRecordSchema = Type.Object({
  id: WebIdSchema, parentId: Type.Union([WebIdSchema, Type.Null()]),
  runId: WebIdSchema, stepId: Type.Union([WebIdSchema, Type.Null()]),
  kind: Type.Union([Type.Literal("run"), Type.Literal("step"), Type.Literal("model"), Type.Literal("tool"), Type.Literal("attempt"), Type.Literal("context"), Type.Literal("wait"), Type.Literal("message")]),
  name: WebLabelSchema, summary: WebTextSchema, state: WebTrajectoryStateSchema,
  provider: Type.Union([WebLabelSchema, Type.Null()]), model: Type.Union([WebLabelSchema, Type.Null()]),
  startedAtMs: Type.Union([WebIntegerSchema, Type.Null()]), endedAtMs: Type.Union([WebIntegerSchema, Type.Null()]),
  durationMs: Type.Union([WebNumberSchema, Type.Null()]), ttftMs: Type.Union([WebNumberSchema, Type.Null()]),
  inputTokens: Type.Union([WebNumberSchema, Type.Null()]), outputTokens: Type.Union([WebNumberSchema, Type.Null()]),
  cacheReadTokens: Type.Union([WebNumberSchema, Type.Null()]), costUsd: Type.Union([WebNumberSchema, Type.Null()]),
  usageSource: Type.Union([WebLabelSchema, Type.Null()]), costSource: Type.Union([WebLabelSchema, Type.Null()]),
  source: Type.Union([Type.Literal("session"), Type.Literal("trace")]),
  input: Type.Union([Type.Literal("session"), Type.Literal("artifact"), Type.Literal("digest_only"), Type.Literal("unavailable")]),
  output: Type.Union([Type.Literal("session"), Type.Literal("artifact"), Type.Literal("digest_only"), Type.Literal("unavailable")]),
}, { additionalProperties: false });
export const WebTrajectoryRequestSchema = Type.Object({
  ...WebPageRequestSchema.properties,
  search: Type.Optional(Type.String({ maxLength: 128 })),
  recordId: Type.Optional(WebIdSchema),
  timeFrom: Type.Optional(WebIntegerSchema), timeTo: Type.Optional(WebIntegerSchema),
}, { additionalProperties: false });
export const WebTrajectoryPageSchema = Type.Object({
  ...WebPageFields, watermark: WebWatermarkSchema,
  projectionRevision: WebIntegerSchema,
  health: Type.Union([Type.Literal("ready"), Type.Literal("rebuilding"), Type.Literal("degraded")]),
  coverage: Type.Union([Type.Literal("session-and-trace"), Type.Literal("session-only"), Type.Literal("partial")]),
  recording: Type.Union([Type.Literal("off"), Type.Literal("events"), Type.Literal("events_and_artifacts"), Type.Literal("unknown")]),
  scannedEvents: WebIntegerSchema,
  totalEvents: Type.Union([WebIntegerSchema, Type.Null()]),
  items: Type.Array(WebTrajectoryRecordSchema, { maxItems: WEB_BOUNDS.maxPageSize }),
}, { additionalProperties: false });
export const WebDetailRequestSchema = Type.Object({
  field: Type.Union([Type.Literal("input"), Type.Literal("output")]), cursor: Type.Optional(WebCursorSchema),
}, { additionalProperties: false });
export const WebTrajectoryDetailSchema = Type.Object({
  version: Type.Literal(1), sessionId: WebIdSchema, recordId: WebIdSchema,
  field: Type.Union([Type.Literal("input"), Type.Literal("output")]),
  text: WebTextSchema, availability: WebDetailAvailabilitySchema,
  next: Type.Union([WebCursorSchema, Type.Null()]),
}, { additionalProperties: false });
export type WebTrajectoryPage = Static<typeof WebTrajectoryPageSchema>;
export type WebTrajectoryDetail = Static<typeof WebTrajectoryDetailSchema>;
