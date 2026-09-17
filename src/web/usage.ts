import type { Static } from "typebox";
import { Value } from "typebox/value";
import { WebUsageRequestSchema, type WebUsage } from "@runledger/collab-web/contracts";
import type { RunledgerLayout } from "../runtime/contracts/storage-layout.ts";
import type { TraceEvent } from "../runtime/trace/types.ts";
import { HistoryReadError } from "../storage/session-store/history-reader.ts";
import { workspaceId, type WebHistory } from "./history.ts";
import { readSessionTraces } from "./trace-reader.ts";
import { UsageProjection } from "./usage-projection.ts";
import { object } from "../runtime/trajectory/projection.ts";

interface Cache {
  readonly projection: UsageProjection; readonly positions: Map<string, number>; readonly traceCheckedAt: Map<string, number>;
  after: string; current?: { id: string; head: number; trace?: AsyncGenerator<TraceEvent | undefined> };
  complete: boolean; degraded: boolean; checkedAt: number; lastAccess: number;
}
/** 按需分批扫 SQL/Trace；只缓存展示投影，不写 Session authority。 */
export class WebUsageReader {
  private readonly history: WebHistory;
  private readonly layout: RunledgerLayout;
  private readonly caches = new Map<string, Cache>();
  private pending: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private closed = false;
  constructor(history: WebHistory, layout: RunledgerLayout) { this.history = history; this.layout = layout; }
  async close(): Promise<void> {
    this.closed = true; await this.pending;
    for (const cache of this.caches.values()) await cache.current?.trace?.return(undefined);
    this.caches.clear();
  }
  read(id: string, request: Static<typeof WebUsageRequestSchema>, signal?: AbortSignal): Promise<WebUsage> {
    if (this.queued >= 16) return Promise.reject(new HistoryReadError("busy"));
    this.queued++;
    const task = this.pending.then(async () => {
      if (this.closed || signal?.aborted) throw new HistoryReadError("busy");
      if (!Value.Check(WebUsageRequestSchema, request) || request.timeFrom >= request.timeTo) throw new HistoryReadError("invalid_request");
      const workspace = workspaceId(id);
      if (!this.history.read((reader) => reader.projectExists(workspace))) throw new HistoryReadError("not_found");
      let cache = this.caches.get(id);
      if (!cache) {
        if (this.caches.size >= 2) {
          const [key, oldest] = [...this.caches].sort((a, b) => a[1].lastAccess - b[1].lastAccess)[0];
          await oldest.current?.trace?.return(undefined); this.caches.delete(key);
        }
        cache = { projection: new UsageProjection(), positions: new Map(), traceCheckedAt: new Map(), after: "", complete: false, degraded: false, checkedAt: 0, lastAccess: Date.now() };
        this.caches.set(id, cache);
      }
      cache.lastAccess = Date.now();
      if (cache.complete && Date.now() - cache.checkedAt > 2000) { cache.after = ""; cache.complete = false; }
      for (let batch = 0; batch < 5 && !cache.complete && !signal?.aborted; batch++) {
        if (!cache.current) {
          const next = this.history.read((reader) => reader.usageSessions(workspace, cache.after, 1))[0];
          if (!next) { cache.complete = true; cache.checkedAt = Date.now(); break; }
          cache.current = next;
          if (cache.positions.has(next.id) && cache.positions.get(next.id) === next.head && Date.now() - (cache.traceCheckedAt.get(next.id) ?? 0) < 30000) { cache.after = next.id; cache.current = undefined; continue; }
        }
        const current = cache.current;
        const sequence = cache.positions.get(current.id) ?? 0;
        if (sequence < current.head) {
          const events = this.history.read((reader) => reader.events(current.id, { after: sequence, through: current.head, limit: 200 }));
          for (const event of events) {
            const payload = object(JSON.parse(event.payloadJson));
            if (event.eventType === "agent.event" || event.eventType === "model.call") cache.projection.event(current.id, event.eventId, payload);
            if (event.eventType === "ledger.message" && event.ownerGeneration > 0) {
              const message = object(payload.payload);
              if (object(message.message).role === "assistant" && typeof message.modelCallId !== "string") {
                cache.projection.event(current.id, event.eventId, { type: "message_end", role: "assistant" });
              }
            }
            cache.positions.set(current.id, event.sequence);
          }
          if (!events.length) { cache.degraded = true; cache.positions.set(current.id, current.head); }
          if ((cache.positions.get(current.id) ?? 0) < current.head) continue;
        }
        current.trace ??= readSessionTraces(this.layout, current.id);
        let done = false;
        try {
          for (let n = 0; n < 100 && !signal?.aborted; n++) {
            const next = await current.trace.next();
            if (next.done) { done = true; break; }
            if (next.value) cache.projection.trace(current.id, next.value);
          }
        } catch { cache.degraded = true; done = true; }
        if (done) {
          cache.traceCheckedAt.set(current.id, Date.now());
          cache.positions.set(current.id, current.head); cache.after = current.id; cache.current = undefined;
          if (cache.positions.size > 10000) { cache.degraded = true; cache.complete = true; }
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      return cache.projection.snapshot(id, request.timeFrom, request.timeTo, cache.complete && !cache.degraded);
    }).finally(() => { this.queued--; });
    this.pending = task.catch(() => undefined); return task;
  }
}
