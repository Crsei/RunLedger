import { Type } from "typebox";
import type { Static } from "typebox";
import { WEB_BOUNDS, WebIdSchema, WebIntegerSchema, WebLabelSchema, WebPageFields, WebPageRequestSchema } from "./common.ts";

export const WebSessionStatusSchema = Type.Union([
  Type.Literal("active"), Type.Literal("recovery_required"), Type.Literal("paused"),
  Type.Literal("completed"), Type.Literal("failed"), Type.Literal("archived"), Type.Literal("unknown"),
]);
export const WebProjectSchema = Type.Object({
  id: WebIdSchema,
  workspaceId: Type.Union([WebIdSchema, Type.Null()]),
  displayName: WebLabelSchema,
  sessionCount: WebIntegerSchema,
  lastActivityAtMs: WebIntegerSchema,
  verifiedOnlineCount: Type.Union([WebIntegerSchema, Type.Null()]),
}, { additionalProperties: false });
export const WebSessionSchema = Type.Object({
  id: WebIdSchema, projectId: WebIdSchema,
  repositoryId: Type.Union([WebIdSchema, Type.Null()]),
  title: Type.Union([WebLabelSchema, Type.Null()]),
  status: WebSessionStatusSchema,
  createdAtMs: WebIntegerSchema, updatedAtMs: WebIntegerSchema,
  headSequence: WebIntegerSchema,
}, { additionalProperties: false });
export const WebProjectsPageSchema = Type.Object({
  ...WebPageFields, catalogRevision: WebIntegerSchema,
  items: Type.Array(WebProjectSchema, { maxItems: WEB_BOUNDS.maxPageSize }),
}, { additionalProperties: false });
export const WebSessionsRequestSchema = Type.Object({
  ...WebPageRequestSchema.properties,
  status: Type.Optional(WebSessionStatusSchema),
  timeFrom: Type.Optional(WebIntegerSchema), timeTo: Type.Optional(WebIntegerSchema),
}, { additionalProperties: false });
export const WebSessionsPageSchema = Type.Object({
  ...WebPageFields, catalogRevision: WebIntegerSchema, projectId: WebIdSchema,
  items: Type.Array(WebSessionSchema, { maxItems: WEB_BOUNDS.maxPageSize }),
}, { additionalProperties: false });
export type WebProject = Static<typeof WebProjectSchema>;
export type WebSession = Static<typeof WebSessionSchema>;
export type WebProjectsPage = Static<typeof WebProjectsPageSchema>;
export type WebSessionsPage = Static<typeof WebSessionsPageSchema>;
