import { Type } from "typebox";
import type { Static } from "typebox";
import { WEB_BOUNDS, WebIdSchema, WebIntegerSchema, WebLabelSchema, WebPageFields, WebTextSchema, WebUnavailableSchema } from "./common.ts";

export const WebProcessesSchema = Type.Union([WebUnavailableSchema, Type.Object({
  ...WebPageFields, available: Type.Literal(true), sessionId: WebIdSchema,
  items: Type.Array(Type.Object({
    id: WebIdSchema, label: WebLabelSchema, state: WebLabelSchema,
    outputPreview: WebTextSchema, truncated: Type.Boolean(),
  }, { additionalProperties: false }), { maxItems: WEB_BOUNDS.maxPageSize }),
}, { additionalProperties: false })]);
export const WebChildrenSchema = Type.Union([WebUnavailableSchema, Type.Object({
  ...WebPageFields, available: Type.Literal(true), sessionId: WebIdSchema,
  items: Type.Array(Type.Object({
    id: WebIdSchema, sessionId: Type.Union([WebIdSchema, Type.Null()]),
    state: WebLabelSchema, summary: WebTextSchema,
  }, { additionalProperties: false }), { maxItems: WEB_BOUNDS.maxPageSize }),
}, { additionalProperties: false })]);
export const WebPlanSchema = Type.Union([WebUnavailableSchema, Type.Object({
  version: Type.Literal(1), available: Type.Literal(true), sessionId: WebIdSchema,
  asOfMs: WebIntegerSchema, summary: WebTextSchema, truncated: Type.Boolean(),
}, { additionalProperties: false })]);
export type WebProcesses = Static<typeof WebProcessesSchema>;
export type WebChildren = Static<typeof WebChildrenSchema>;
export type WebPlan = Static<typeof WebPlanSchema>;
