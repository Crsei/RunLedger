import { Type } from "typebox";
import type { Static } from "typebox";
import { WEB_BOUNDS, WebConnectionSchema, WebCursorSchema, WebIdSchema, WebIntegerSchema, WebLabelSchema, WebPageFields, WebTextSchema, WebWatermarkSchema } from "./common.ts";
import { WebSessionSchema } from "./catalog.ts";

/** 只传投影文本；禁止传递整个事件 payload、工具对象或 HTML。 */
export const WebTimelineRowSchema = Type.Object({
  id: WebIdSchema, sequence: WebIntegerSchema, createdAtMs: WebIntegerSchema,
  kind: Type.Union([Type.Literal("user"), Type.Literal("assistant"), Type.Literal("thinking"), Type.Literal("tool"), Type.Literal("notice")]),
  text: WebTextSchema, truncated: Type.Boolean(),
  detailRecordId: Type.Optional(WebIdSchema),
  tool: Type.Optional(Type.Object({
    callId: WebIdSchema, name: WebLabelSchema,
    state: Type.Union([Type.Literal("running"), Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("unknown")]),
    inputPreview: WebTextSchema, outputPreview: WebTextSchema,
    detailRecordId: Type.Union([WebIdSchema, Type.Null()]),
    inputDetailRecordId: Type.Optional(WebIdSchema),
  }, { additionalProperties: false })),
}, { additionalProperties: false });
export const WebTimelinePageSchema = Type.Object({
  ...WebPageFields, watermark: WebWatermarkSchema,
  items: Type.Array(WebTimelineRowSchema, { maxItems: WEB_BOUNDS.maxPageSize }),
}, { additionalProperties: false });
export const WebSnapshotSchema = Type.Object({
  version: Type.Literal(1), session: WebSessionSchema,
  connection: WebConnectionSchema, timeline: WebTimelinePageSchema,
  resumeCursor: WebCursorSchema,
}, { additionalProperties: false });
/** 失效通知要求补读，不携带原始事件，不把通知当作已消费的对话。 */
export const WebEventSchema = Type.Union([
  Type.Object({
    version: Type.Literal(1), kind: Type.Literal("durable"),
    watermark: WebWatermarkSchema, resumeCursor: WebCursorSchema,
  }, { additionalProperties: false }),
  Type.Object({
    version: Type.Literal(1), kind: Type.Literal("invalidate"), sessionId: WebIdSchema,
    target: Type.Union([Type.Literal("trajectory"), Type.Literal("processes"), Type.Literal("children"), Type.Literal("plan")]),
  }, { additionalProperties: false }),
  Type.Object({
    version: Type.Literal(1), kind: Type.Literal("connection"), sessionId: WebIdSchema,
    connection: WebConnectionSchema,
  }, { additionalProperties: false }),
  Type.Object({ version: Type.Literal(1), kind: Type.Literal("resync_required"), sessionId: WebIdSchema }, { additionalProperties: false }),
]);
export type WebTimelineRow = Static<typeof WebTimelineRowSchema>;
export type WebTimelinePage = Static<typeof WebTimelinePageSchema>;
export type WebSnapshot = Static<typeof WebSnapshotSchema>;
export type WebEvent = Static<typeof WebEventSchema>;
