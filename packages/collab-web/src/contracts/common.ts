import { Type } from "typebox";

/** 字符限制不能替代响应序列化后的 UTF-8 字节限制。 */
export const WEB_BOUNDS = Object.freeze({
  pageSize: 50, maxPageSize: 200, pageBytes: 192 * 1024,
  detailBytes: 48 * 1024, textCharacters: 12 * 1024,
  cursorCharacters: 2048, pendingEvents: 256, eventBytes: 64 * 1024,
});
export const WebIdSchema = Type.String({ minLength: 1, maxLength: 256, pattern: "^[A-Za-z0-9_.:~-]+$" });
export const WebCursorSchema = Type.String({ minLength: 1, maxLength: WEB_BOUNDS.cursorCharacters, pattern: "^[A-Za-z0-9_-]+$" });
export const WebIntegerSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const WebNumberSchema = Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const WebTextSchema = Type.String({ maxLength: WEB_BOUNDS.textCharacters });
export const WebLabelSchema = Type.String({ maxLength: 512 });
export const WebPageRequestSchema = Type.Object({
  cursor: Type.Optional(WebCursorSchema),
  direction: Type.Optional(Type.Union([Type.Literal("older"), Type.Literal("newer")])),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: WEB_BOUNDS.maxPageSize })),
}, { additionalProperties: false });
export const WebPageFields = {
  version: Type.Literal(1),
  before: Type.Union([WebCursorSchema, Type.Null()]),
  after: Type.Union([WebCursorSchema, Type.Null()]),
  asOfMs: WebIntegerSchema,
};
export const WebWatermarkSchema = Type.Object({
  sessionId: WebIdSchema,
  sequence: WebIntegerSchema,
  ownerGeneration: Type.Union([WebIntegerSchema, Type.Null()]),
  source: Type.Union([Type.Literal("owner"), Type.Literal("history")]),
  epoch: WebIdSchema,
}, { additionalProperties: false });
export const WebConnectionSchema = Type.Object({
  state: Type.Union([Type.Literal("connected"), Type.Literal("offline"), Type.Literal("checking")]),
  freshness: Type.Union([Type.Literal("current"), Type.Literal("stale"), Type.Literal("unknown")]),
  checkedAtMs: Type.Union([WebIntegerSchema, Type.Null()]),
}, { additionalProperties: false });
export const WebUnavailableSchema = Type.Object({
  available: Type.Literal(false),
  reason: Type.Union([Type.Literal("not-equipped"), Type.Literal("offline"), Type.Literal("not-recorded"), Type.Literal("incompatible")]),
}, { additionalProperties: false });
export const WEB_ERROR_STATUS = Object.freeze({
  unauthenticated: 401, forbidden: 403, not_found: 404, invalid_request: 400,
  resync_required: 409, database_missing: 503, schema_incompatible: 503,
  migration_in_progress: 503, busy: 503, corrupt: 503, unavailable: 503,
  response_too_large: 413, internal_error: 500,
} as const);
export const WebErrorSchema = Type.Object({
  version: Type.Literal(1), ok: Type.Literal(false),
  code: Type.Union(Object.keys(WEB_ERROR_STATUS).map((code) => Type.Literal(code as keyof typeof WEB_ERROR_STATUS))),
}, { additionalProperties: false });
