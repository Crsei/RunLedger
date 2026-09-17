import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { WebTrajectoryRequestSchema, type WebTrajectoryPage, type WebTrajectoryDetail, WEB_BOUNDS } from "@runledger/collab-web/contracts";
import type { RunledgerLayout } from "../runtime/contracts/storage-layout.ts";
import type { TraceEvent } from "../runtime/trace/types.ts";
import { TrajectoryIndex, type IndexedTrajectoryRecord } from "../runtime/trajectory/index-store.ts";
import { object, projectSessionEvent, projectTraceEvent, sessionDetail, safeText, type TrajectoryProjectionPort } from "../runtime/trajectory/projection.ts";
import { HistoryReadError } from "../storage/session-store/history-reader.ts";
import type { SessionEventRecord } from "../storage/session-store/session-store.ts";
import { WebCursorError } from "./cursor.ts";
import type { WebHistory } from "./history.ts";
import { assistantText, messageText } from "../presentation/message-text.ts";
import { publicId, projectWebTimeline } from "./timeline-projector.ts";
import { trajectoryDto } from "./trajectory-mapping.ts";
import { readSessionTraces } from "./trace-reader.ts";
import { artifactText, detailPage } from "./detail.ts";

type Request = Static<typeof WebTrajectoryRequestSchema>;
interface Cache {
  readonly sessionId: string; readonly epoch: string; readonly sourceEpoch: string; readonly path: string;
  readonly index: TrajectoryIndex; readonly port: TrajectoryProjectionPort;
  traces: AsyncGenerator<TraceEvent | undefined>;
  traceHead: number; traceCheckedAt: number; receiptsDone: boolean;
  sequence: number; receipt: number; tracesDone: boolean; hasTrace: boolean;
  degraded: boolean; quota: boolean; lastAccess: number; recording: WebTrajectoryPage["recording"];
}
export const WEB_CACHE_BOUNDS = Object.freeze({ sessions: 4, bytes: 128 * 1024 * 1024, scanEvents: 200, traceEvents: 100 });
/** Web 私有、可丢弃的 SQLite 投影；从不打开 Owner 的 trajectory 文件。 */
export class OfflineWebTrajectory {
  private readonly layout: RunledgerLayout;
  private readonly history: WebHistory;
  private directory: string | undefined;
  private readonly caches = new Map<string, Cache>();
  private pending: Promise<unknown> = Promise.resolve();
  private closed = false;
  private queued = 0;
  constructor(layout: RunledgerLayout, history: WebHistory) { this.layout = layout; this.history = history; }
  private exclusive<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    if (this.queued >= 32) return Promise.reject(new HistoryReadError("busy"));
    this.queued++;
    const result = this.pending.then(() => {
      if (this.closed || signal?.aborted) throw new HistoryReadError("busy");
      return operation();
    }).finally(() => { this.queued--; });
    this.pending = result.catch(() => undefined);
    return result;
  }
  async close(): Promise<void> {
    this.closed = true; await this.pending;
    for (const cache of this.caches.values()) await this.dispose(cache);
    this.caches.clear();
    if (this.directory) rmSync(this.directory, { recursive: true, force: true });
  }
  private async dispose(cache: Cache): Promise<void> {
    await cache.traces.return(undefined).catch(() => undefined);
    cache.index.close();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(cache.path + suffix, { force: true });
  }
  private async cache(sessionId: string): Promise<Cache> {
    const previous = this.caches.get(sessionId);
    const sourceEpoch = this.history.source(sessionId).epoch;
    if (previous && previous.sourceEpoch === sourceEpoch) { previous.lastAccess = Date.now(); return previous; }
    if (previous) { await this.dispose(previous); this.caches.delete(sessionId); }
    if (this.caches.size >= WEB_CACHE_BOUNDS.sessions) {
      const oldest = [...this.caches.values()].sort((a, b) => a.lastAccess - b.lastAccess)[0];
      await this.dispose(oldest); this.caches.delete(oldest.sessionId);
    }
    this.history.read((reader) => reader.session(sessionId));
    this.directory ??= mkdtempSync(join(tmpdir(), "runledger-web-"));
    const path = join(this.directory, `${publicId(sessionId)}.sqlite`), index = new TrajectoryIndex(path);
    index.db.execSync("CREATE TABLE web_ids (public_id TEXT PRIMARY KEY, record_id TEXT NOT NULL)");
    const port: TrajectoryProjectionPort = {
      get: (key) => index.get(key), set: (key, value) => index.set(key, value), find: (id) => index.find(id),
      put: (record) => {
        index.put(record);
        index.db.runSync("INSERT OR IGNORE INTO web_ids VALUES (?,?)", [publicId(record.id), record.id]);
      },
    };
    const cache: Cache = { sessionId, epoch: randomBytes(16).toString("hex"), sourceEpoch, path, index, port,
      traces: readSessionTraces(this.layout, sessionId), traceHead: -1, traceCheckedAt: 0, receiptsDone: false, sequence: 0, receipt: 0, tracesDone: false, hasTrace: false,
      degraded: false, quota: false, lastAccess: Date.now(), recording: "unknown" };
    this.caches.set(sessionId, cache); return cache;
  }
  private async advance(cache: Cache, signal?: AbortSignal): Promise<number> {
    const { head, events, receipts } = this.history.read((reader) => ({ head: reader.session(cache.sessionId).headSequence,
      events: reader.events(cache.sessionId, { after: cache.sequence, limit: WEB_CACHE_BOUNDS.scanEvents }), receipts: reader.receipts(cache.sessionId, cache.receipt) }));
    if (cache.quota) return head;
    cache.receiptsDone = receipts.length < 200;
    if (cache.traceHead < 0) cache.traceHead = head;
    if (cache.tracesDone && (head !== cache.traceHead || Date.now() - cache.traceCheckedAt > 30000)) {
      await cache.traces.return(undefined).catch(() => undefined);
      cache.traces = readSessionTraces(this.layout, cache.sessionId); cache.tracesDone = false;
      cache.traceHead = head; cache.degraded = false;
    }
    cache.index.db.withImmediateTransactionSync(() => {
      for (const event of events) {
        if (event.eventType === "agent.event") projectSessionEvent(cache.port, object(JSON.parse(event.payloadJson)), event.sequence, event.ownerGeneration);
        // fork 不复制 agent.event；ledger 保留独立可查看的对话来源，不能猜测 Run/Step。
        if (event.eventType === "ledger.message") {
          const message = object(object(object(JSON.parse(event.payloadJson)).payload).message);
          cache.port.put({ id: `ledger/${event.eventId}`, runId: "unlinked/ledger", kind: "message", name: safeText(message.role, 128),
            summary: safeText(message.content, 4096), state: "succeeded", source: "session", generation: event.ownerGeneration,
            startedAtMs: event.createdAtMs, input: "unavailable", output: "session", sessionOutputSeq: event.sequence });
        }
        cache.sequence = event.sequence;
      }
      for (const receipt of receipts) {
        const id = `attempt/${String(receipt.attempt_id)}`, old = cache.index.find(id), started = receipt.outcome === "started";
        cache.port.put({ id, runId: `unlinked/${String(receipt.origin_generation)}`, kind: "attempt", name: safeText(receipt.effect_class, 128),
          source: "session", generation: Number(receipt.origin_generation), input: "unavailable", output: "unavailable", ...old,
          summary: `Receipt: ${safeText(receipt.outcome)}; call association unavailable`,
          state: started ? "running" : receipt.outcome === "rejected" ? "failed" : receipt.outcome === "uncertain" ? "unknown" : receipt.outcome === "interrupted" ? "interrupted" : "succeeded",
          ...(started ? { startedAtMs: Number(receipt.created_at_ms) } : { endedAtMs: Number(receipt.created_at_ms) }) });
        cache.receipt = Number(receipt.position);
      }
    });
    if (signal?.aborted) return head;
    if (!cache.tracesDone) {
      try {
        for (let i = 0; i < WEB_CACHE_BOUNDS.traceEvents && !signal?.aborted; i++) {
          const next = await cache.traces.next();
          if (next.done) { cache.tracesDone = true; cache.traceCheckedAt = Date.now(); break; }
          const event = next.value;
          if (!event) continue;
          cache.hasTrace = true;
          const run = String(event.metadata?.runId ?? cache.index.get(`run:${event.traceId}`) ?? `legacy-trace-${event.traceId}`);
          cache.index.set(`run:${event.traceId}`, run);
          if (event.metadata?.recordingMode === "events" || event.metadata?.recordingMode === "events_and_artifacts") cache.recording = event.metadata.recordingMode;
          cache.index.db.withImmediateTransactionSync(() => projectTraceEvent(cache.port, event, run, Number(event.metadata?.ownerGeneration ?? 0)));
        }
      } catch { cache.degraded = true; cache.tracesDone = true; cache.traceCheckedAt = Date.now(); }
    }
    let bytes = 0;
    for (const item of this.caches.values()) for (const suffix of ["", "-wal"]) {
      try { bytes += statSync(item.path + suffix).size; } catch { /* 已 checkpoint 的 sidecar 可以不存在。 */ }
    }
    if (bytes > WEB_CACHE_BOUNDS.bytes) { cache.quota = true; cache.degraded = true; }
    await new Promise<void>((done) => setTimeout(done, 0));
    return head;
  }
  page(sessionId: string, request: Request = {}, signal?: AbortSignal): Promise<WebTrajectoryPage> {
    return this.exclusive(signal, async () => {
      if (!Value.Check(WebTrajectoryRequestSchema, request) || (request.timeFrom !== undefined && request.timeTo !== undefined && request.timeFrom >= request.timeTo)) throw new HistoryReadError("invalid_request");
      const cache = await this.cache(sessionId), head = await this.advance(cache, signal);
      const scope = JSON.stringify(["trajectory", sessionId, cache.epoch, request.search, request.timeFrom, request.timeTo, request.recordId]);
      const anchor = request.cursor === undefined ? undefined : this.history.cursors.decode(scope, request.cursor);
      if (anchor !== undefined && (typeof anchor !== "number" || !Number.isSafeInteger(anchor) || anchor < 0)) throw new WebCursorError();
      const conditions = ["1=1"], params: unknown[] = [];
      if (request.search) { conditions.push("instr(search_text,?)>0"); params.push(request.search.toLowerCase()); }
      if (request.timeFrom !== undefined) { conditions.push("json_extract(json,'$.startedAtMs')>=?"); params.push(request.timeFrom); }
      if (request.timeTo !== undefined) { conditions.push("json_extract(json,'$.startedAtMs')<?"); params.push(request.timeTo); }
      if (request.recordId !== undefined) { conditions.push("id=(SELECT record_id FROM web_ids WHERE public_id=?)"); params.push(request.recordId); }
      const base = conditions.join(" AND "), newer = request.direction === "newer";
      const rows = cache.index.db.queryAll(`SELECT json FROM trajectory_records WHERE ${base} ${anchor === undefined ? "" : `AND ordinal${newer ? ">" : "<"}?`} ORDER BY ordinal ${newer ? "ASC" : "DESC"} LIMIT ?`, [...params, ...(anchor === undefined ? [] : [anchor]), (request.pageSize ?? 50) + 1]);
      const selected: IndexedTrajectoryRecord[] = []; let bytes = 8192;
      for (const row of rows) {
        const record = JSON.parse(String(row.json)) as IndexedTrajectoryRecord;
        const size = Buffer.byteLength(JSON.stringify(trajectoryDto(record)));
        if (selected.length >= (request.pageSize ?? 50) || bytes + size > WEB_BOUNDS.pageBytes) break;
        bytes += size; selected.push(record);
      }
      if (!newer) selected.reverse();
      const first = selected[0]?.ordinal, last = selected.at(-1)?.ordinal;
      const exists = (operator: string, point?: number) => point !== undefined && cache.index.db.querySingle(`SELECT 1 FROM trajectory_records WHERE ${base} AND ordinal${operator}? LIMIT 1`, [...params, point]) !== undefined;
      return { version: 1, asOfMs: Date.now(), before: exists("<", first) ? this.history.cursors.encode(scope, first) : null,
        after: exists(">", last) ? this.history.cursors.encode(scope, last) : null,
        watermark: this.history.watermark(sessionId, cache.sequence), projectionRevision: Number(cache.index.get("revision") ?? 0),
        health: cache.quota ? "degraded" : cache.sequence < head || !cache.tracesDone || !cache.receiptsDone ? "rebuilding" : cache.degraded ? "degraded" : "ready",
        coverage: cache.degraded || cache.sequence < head || !cache.tracesDone || !cache.receiptsDone ? "partial" : cache.hasTrace ? "session-and-trace" : "session-only",
        recording: cache.recording, scannedEvents: cache.sequence, totalEvents: head, items: selected.map(trajectoryDto) };
    });
  }
  detail(sessionId: string, recordId: string, field: "input" | "output", cursor?: string, signal?: AbortSignal): Promise<WebTrajectoryDetail> {
    return this.exclusive(signal, async () => {
      const cache = await this.cache(sessionId);
      const empty = (availability: WebTrajectoryDetail["availability"]): WebTrajectoryDetail => ({ version: 1, sessionId, recordId, field, text: "", availability, next: null });
      let text: string | undefined, revision = 0;
      if (recordId.startsWith("ledger:")) {
        const match = /^ledger:(\d+):(\d+)$/.exec(recordId);
        if (!match) throw new HistoryReadError("invalid_request");
        const event = this.history.read((reader) => reader.event(sessionId, Number(match[1])));
        if (!event) return empty("unavailable");
        const row = projectWebTimeline(event)[Number(match[2])];
        if (!row) throw new HistoryReadError("not_found");
        const message = object(object(object(JSON.parse(event.payloadJson)).payload).message);
        const parts = Array.isArray(message.content) ? message.content.map(object) : [];
        const part = parts.find((candidate) => publicId(String(candidate.id ?? candidate.toolCallId)) === row.tool?.callId);
        if (row.tool) {
          const value = field === "input" ? part?.arguments : part?.type === "toolCall" ? undefined : part?.content ?? part?.result ?? (message.toolCallId ? message.content : undefined);
          if (value === undefined) return empty("not-recorded");
          text = safeText(value, 2 * 1024 * 1024 + 1);
        } else {
          if (field === "input") return empty("not-recorded");
          text = safeText(row.kind === "thinking" ? messageText(message, "thinking") : row.kind === "assistant" ? assistantText(message) : messageText(message), 2 * 1024 * 1024 + 1);
        }
        revision = event.sequence;
      } else {
        const id = cache.index.db.querySingle("SELECT record_id FROM web_ids WHERE public_id=?", [recordId])?.record_id;
        const record = typeof id === "string" ? cache.index.find(id) : undefined;
        if (!record) throw new HistoryReadError("not_found");
        revision = record.revision;
        const seq = field === "input" ? record.sessionInputSeq : record.sessionOutputSeq;
        if (seq !== undefined) {
          const event: SessionEventRecord | undefined = this.history.read((reader) => reader.event(sessionId, seq));
          if (!event) return empty("unavailable");
          const payload = object(JSON.parse(event.payloadJson));
          text = event.eventType === "ledger.message" ? safeText(object(payload.payload).message, 2 * 1024 * 1024 + 1) : sessionDetail(payload, field);
        } else {
          const ref = field === "input" ? record.traceInput : record.traceOutput;
          if (ref === undefined) return empty("not-recorded");
          try { text = await artifactText(this.layout, ref); } catch { return empty("corrupt"); }
        }
      }
      if (text !== undefined && text.length > 2 * 1024 * 1024) return empty("unavailable");
      return text === undefined ? empty("not-recorded") : detailPage(this.history.cursors, `detail:${sessionId}:${cache.epoch}:${recordId}:${field}:${revision}`, sessionId, recordId, field, text, cursor);
    });
  }
}
