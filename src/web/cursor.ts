import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { HistoryReadError } from "../storage/session-store/history-reader.ts";

export class WebCursorError extends Error { constructor() { super("resync_required"); } }
/** 签名游标只绑定读取范围；身份与 Session 访问校验仍由查询入口负责。 */
export class WebCursors {
  private readonly key = randomBytes(32);
  readonly epoch = randomBytes(16).toString("hex");
  encode(scope: string, position: unknown): string {
    const payload = JSON.stringify({ scope, position });
    const signature = createHmac("sha256", this.key).update(payload).digest("hex");
    const cursor = Buffer.from(JSON.stringify([payload, signature])).toString("base64url");
    if (cursor.length > 2048) throw new HistoryReadError("invalid_request");
    return cursor;
  }
  decode(scope: string, cursor: string): unknown {
    try {
      if (cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new WebCursorError();
      const [payload, signature]: unknown[] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      if (typeof payload !== "string" || typeof signature !== "string" || !/^[a-f0-9]{64}$/.test(signature)) throw new WebCursorError();
      const expected = createHmac("sha256", this.key).update(payload).digest();
      if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) throw new WebCursorError();
      const parsed = JSON.parse(payload) as { scope?: unknown; position?: unknown };
      if (parsed.scope !== scope) throw new WebCursorError();
      return parsed.position;
    } catch { throw new WebCursorError(); }
  }
}
