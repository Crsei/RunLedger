import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { RunledgerLayout } from "../runtime/contracts/storage-layout.ts";
import type { TraceContentDescriptor } from "../runtime/trace/types.ts";
import { safeText } from "../runtime/trajectory/projection.ts";
import { assertSafePath } from "../runtime/trajectory/safe-path.ts";
import type { WebTrajectoryDetail } from "@runledger/collab-web/contracts";
import { WebCursorError, type WebCursors } from "./cursor.ts";

async function boundedFile(home: string, path: string, limit: number): Promise<Buffer> {
  await assertSafePath(home, path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error("detail_quota");
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const next = await file.read(buffer, offset, buffer.length - offset, offset);
      if (next.bytesRead === 0) break;
      offset += next.bytesRead;
    }
    if (offset > stat.size) throw new Error("detail_changed");
    return buffer.subarray(0, offset);
  } finally { await file.close(); }
}
/** ref 必须来自当前 Session 已验证的 Trace 记录，不提供按 digest 查询的 HTTP 路由。 */
export async function artifactText(layout: RunledgerLayout, ref: TraceContentDescriptor): Promise<string | undefined> {
  if (ref.storage !== "artifact") return undefined;
  if (!/^[a-f0-9]{64}$/.test(ref.digest) || ref.size > 2 * 1024 * 1024) throw new Error("invalid_artifact");
  const [data, metadata] = await Promise.all([
    boundedFile(layout.home, join(layout.artifacts, "sha256", ref.digest.slice(0, 2), ref.digest), 2 * 1024 * 1024),
    boundedFile(layout.home, join(layout.artifactMetadata, "sha256", ref.digest.slice(0, 2), `${ref.digest}.json`), 64 * 1024),
  ]);
  const meta = JSON.parse(metadata.toString("utf8")) as Record<string, unknown>;
  if (data.length !== ref.size || createHash("sha256").update(data).digest("hex") !== ref.digest
    || meta.digest !== ref.digest || meta.size !== ref.size || meta.artifactId !== ref.artifactId) throw new Error("corrupt_artifact");
  return safeText(JSON.parse(data.toString("utf8")), 2 * 1024 * 1024);
}
export function detailPage(cursors: WebCursors, scope: string, sessionId: string, recordId: string, field: "input" | "output", text: string, cursor?: string): WebTrajectoryDetail {
  const key = cursor === undefined ? 0 : cursors.decode(scope, cursor);
  if (typeof key !== "number" || !Number.isSafeInteger(key) || key < 0 || key > text.length) throw new WebCursorError();
  let end = Math.min(text.length, key + 12 * 1024);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? "")) end--;
  const base = { version: 1 as const, sessionId, recordId, field };
  const make = (stop: number): WebTrajectoryDetail => ({ ...base, text: text.slice(key, stop), availability: stop < text.length ? "more" : "complete", next: stop < text.length ? cursors.encode(scope, stop) : null });
  let result = make(end);
  while (Buffer.byteLength(JSON.stringify(result)) > 48 * 1024) { end = key + Math.floor((end - key) * 0.8); if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? "")) end--; if (end <= key) throw new Error("detail_quota"); result = make(end); }
  return result;
}
