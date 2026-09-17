import { constants } from "node:fs";
import { open, opendir } from "node:fs/promises";
import { join } from "node:path";
import { canonicalDigest } from "../runtime/protocol/canonical-json.ts";
import { assertSafePath } from "../runtime/trajectory/safe-path.ts";
import { object } from "../runtime/trajectory/projection.ts";
import type { RunledgerLayout } from "../runtime/contracts/storage-layout.ts";
import type { TraceEvent } from "../runtime/trace/types.ts";

async function* files(home: string, directory: string, depth = 0): AsyncGenerator<string> {
  if (depth > 3) return;
  let handle;
  try { await assertSafePath(home, directory); handle = await opendir(directory); } catch (error) { if (object(error).code === "ENOENT") return; throw error; }
  try {
  // Bun 的 opendir 可能到首次迭代才报告目录不存在。
  for await (const entry of handle) {
    if (entry.isDirectory() && /^\d{2,4}$/.test(entry.name)) yield* files(home, join(directory, entry.name), depth + 1);
    else if (entry.isFile() && /^[A-Za-z0-9_.-]+\.jsonl$/.test(entry.name)) yield join(directory, entry.name);
  }
  } catch (error) { if (object(error).code !== "ENOENT") throw error; }
}
/** 每次 next 至多读取一个有界事件或跳过一个非目标文件，调用方可分批让出事件循环。 */
export async function* readSessionTraces(layout: RunledgerLayout, sessionId: string): AsyncGenerator<TraceEvent | undefined> {
  let fileCount = 0;
  for await (const path of files(layout.home, layout.events)) {
    if (++fileCount > 10000) throw new Error("trace_scan_quota");
    await assertSafePath(layout.home, path);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!(await file.stat()).isFile()) throw new Error("trace_not_file");
      let offset = 0, remaining = Buffer.alloc(0), sequence = 0;
      let previous: string | null = null, traceId: string | undefined, skip = false;
      const chunk = Buffer.alloc(8192);
      for (;;) {
        const read = await file.read(chunk, 0, chunk.length, offset);
        if (read.bytesRead === 0) break;
        offset += read.bytesRead;
        remaining = Buffer.concat([remaining, chunk.subarray(0, read.bytesRead)]);
        let end: number;
        while ((end = remaining.indexOf(10)) >= 0) {
          if (end > 66 * 1024) throw new Error("trace_event_quota");
          const raw = remaining.subarray(0, end).toString("utf8");
          remaining = remaining.subarray(end + 1);
          if (!raw) continue;
          const event = JSON.parse(raw) as TraceEvent;
          if (sequence === 0 && event.metadata?.sessionId !== sessionId) { skip = true; break; }
          const { eventHash, ...body } = event;
          if (event.sequence !== sequence + 1 || event.previousEventHash !== previous || canonicalDigest(body) !== eventHash
            || (traceId !== undefined && event.traceId !== traceId)) throw new Error("trace_integrity_failed");
          traceId = event.traceId; sequence = event.sequence; previous = eventHash;
          yield event;
        }
        if (skip) break;
        if (remaining.length > 66 * 1024) throw new Error("trace_event_quota");
      }
      if (!skip && remaining.length !== 0) throw new Error("trace_incomplete");
      yield undefined;
    } finally { await file.close(); }
  }
}
