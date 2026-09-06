import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, opendir, open, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SessionStore } from "../../storage/session-store/session-store.ts";
import { sessionEventHash } from "../../storage/session-store/event-append.ts";
import { rowToEvent } from "../../storage/session-store/row-mappers.ts";
import type { EffectiveRecordingConfig } from "../../storage/settings-manager.ts";
import { TRAJECTORY_BOUNDS, type TrajectoryDetail, type TrajectoryPage, type TrajectoryStatus } from "../contracts/trajectory.ts";
import type { RunledgerLayout } from "../contracts/storage-layout.ts";
import { canonicalDigest, canonicalJson } from "../protocol/canonical-json.ts";
import type { SessionDomainResult } from "../session-runtime/domain-router.ts";
import type { SessionProtocolOperationDescriptor } from "../session-server/protocol.ts";
import type { TraceEvent } from "../trace/types.ts";
import type { TraceRecordingDiagnostic } from "../trace/recorder.ts";
import { FileArtifactStore } from "../trace/artifact-store.ts";
import { TrajectoryIndex, publicRecord, type IndexedTrajectoryRecord } from "./index-store.ts";
import { numeric, object, projectSessionEvent, projectTraceEvent, safeText, sessionDetail, string } from "./projection.ts";

export interface TrajectoryServiceOptions {
  readonly layout: RunledgerLayout;
  readonly store: SessionStore;
  readonly sessionId: string;
  readonly generation: number;
  readonly config: EffectiveRecordingConfig;
}
interface Cursor { readonly scope: string; readonly position: number; readonly search: string; readonly timeFrom?: number; readonly timeTo?: number }
const OPERATIONS = ["trajectory.page", "trajectory.search", "trajectory.detail", "trajectory.status"];

/** 仅 owner 持有的可重建查询投影；所有公开查询经 domain envelope 鉴权。 */
export class TrajectoryService {
  readonly operationManifest: readonly SessionProtocolOperationDescriptor[] = OPERATIONS.map((operation) => ({ operation, capability: "session.trajectory", access: "read" }));
  private readonly options: TrajectoryServiceOptions;
  private readonly secret = randomBytes(32);
  private readonly listeners = new Set<() => void>();
  private readonly diagnostics = new Set<string>();
  private index: TrajectoryIndex | undefined;
  private initializing: Promise<void> | undefined;
  private rebuilding: Promise<void> | undefined;
  private disposed = false;
  private notification: ReturnType<typeof setTimeout> | undefined;
  constructor(options: TrajectoryServiceOptions) { this.options = options; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  invalidate(): void {
    if (this.disposed || this.notification !== undefined) return;
    this.notification = setTimeout(() => {
      this.notification = undefined;
      for (const listener of this.listeners) { try { listener(); } catch { /* 观察者不能阻断记录。 */ } }
    }, 100);
    this.notification.unref?.();
  }
  diagnostic(diagnostic: TraceRecordingDiagnostic): void { this.diagnostics.add(diagnostic.code); this.invalidate(); }

  /** durable append 之后的 cache 通知；cache 失败不改变已提交 Trace。 */
  async recorded(event: TraceEvent, locator: string): Promise<void> {
    if (this.disposed) return;
    try {
      await this.initialize();
      const index = this.index!;
      this.register(event.traceId, locator);
      const source = index.db.querySingle("SELECT * FROM trajectory_sources WHERE trace_id=?", [event.traceId])!;
      if (event.sequence === Number(source.sequence) + 1) {
        this.ingestTrace(event, source, Number(source.offset) + Buffer.byteLength(`${canonicalJson(event)}\n`));
      } else if (event.sequence > Number(source.sequence)) await this.readSource(event.traceId, locator);
      this.invalidate();
    } catch { this.diagnostics.add("trajectory_index_write_failed"); this.invalidate(); }
  }
  async query(operation: string, payload: Record<string, unknown>): Promise<SessionDomainResult> {
    const fail = (code: string): SessionDomainResult => ({ ok: false, status: "failed", operation, code });
    if (!OPERATIONS.includes(operation)) return fail("operation_unavailable");
    if (this.disposed) return fail("trajectory_closed");
    if (Object.keys(payload).some((key) => !["cursor", "direction", "pageSize", "search", "recordId", "field", "timeFrom", "timeTo"].includes(key))) return fail("invalid_trajectory_request");
    try {
      await this.initialize();
      this.syncSession(2_000);
      this.syncAttempts(2_000);
      let value: TrajectoryPage | TrajectoryDetail | TrajectoryStatus;
      if (operation === "trajectory.detail") value = await this.detail(payload);
      else if (operation === "trajectory.status") value = this.status();
      else value = this.page(payload);
      return { ok: true, status: "ok", operation, domainRevision: Number(this.index!.get("revision") ?? 0), value: value as unknown as Record<string, unknown> };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (["invalid_trajectory_cursor", "invalid_trajectory_request", "trajectory_record_not_found"].includes(message)) return fail(message);
      this.diagnostics.add("trajectory_query_failed");
      return fail("trajectory_unavailable");
    }
  }
  async close(): Promise<void> {
    this.disposed = true;
    if (this.notification !== undefined) clearTimeout(this.notification);
    this.listeners.clear();
    await this.initializing?.catch(() => undefined);
    await this.rebuilding?.catch(() => undefined);
    this.index?.close();
    this.index = undefined;
  }
  private initialize(): Promise<void> {
    if (this.initializing !== undefined) return this.initializing;
    this.initializing = this.openIndex();
    return this.initializing;
  }
  private async openIndex(): Promise<void> {
    const directory = join(this.options.layout.projections, "trajectory");
    await assertSafePath(this.options.layout.home, directory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${canonicalDigest(this.options.sessionId)}.sqlite`);
    await assertSafePath(this.options.layout.home, path);
    try { this.index = new TrajectoryIndex(path); }
    catch {
      // 仅隔离本 session 的可重建 cache，不触及 Session/Trace authority。
      await rename(path, `${path}.corrupt-${Date.now()}`);
      for (const suffix of ["-wal", "-shm"]) await rename(`${path}${suffix}`, `${path}.corrupt-${Date.now()}${suffix}`).catch(() => undefined);
      this.index = new TrajectoryIndex(path);
      this.diagnostics.add("trajectory_cache_rebuilt");
    }
    if (this.index.get("session") !== undefined && this.index.get("session") !== this.options.sessionId) throw new Error("cache identity mismatch");
    this.index.set("session", this.options.sessionId);
    this.rebuilding = this.rebuild().catch(() => { this.diagnostics.add("trajectory_history_incomplete"); }).finally(() => { this.rebuilding = undefined; this.invalidate(); });
  }
  private async rebuild(): Promise<void> {
    while (!this.disposed && this.syncSession(1_000)) await yieldEventLoop();
    while (!this.disposed && this.syncAttempts(1_000)) await yieldEventLoop();
    // 一次启动扫描发现旧日志；后续查询只访问 session cache 与已登记文件。
    await this.discover(this.options.layout.events, 0);
    let last = "";
    while (!this.disposed) {
      const sources = this.index!.db.queryAll("SELECT trace_id,locator FROM trajectory_sources WHERE trace_id>? ORDER BY trace_id LIMIT 200", [last]);
      if (sources.length === 0) break;
      for (const source of sources) {
        last = String(source.trace_id);
        try { await lstat(resolve(this.options.layout.home, String(source.locator))); }
        catch { this.diagnostics.add("trajectory_source_unavailable"); }
      }
      await yieldEventLoop();
    }
  }
  private async discover(directory: string, depth: number): Promise<void> {
    if (this.disposed || depth > 3) return;
    await assertSafePath(this.options.layout.home, directory);
    let handle;
    try { await lstat(directory); handle = await opendir(directory); } catch (error) { if (isMissing(error)) return; throw error; }
    for await (const entry of handle) {
      if (this.disposed) break;
      if (entry.isDirectory() && /^\d{2,4}$/.test(entry.name)) await this.discover(join(directory, entry.name), depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const traceId = entry.name.slice(0, -6);
        const path = join(directory, entry.name);
        const locator = path.slice(this.options.layout.home.length + 1).replaceAll("\\", "/");
        try { await this.readSource(traceId, locator, true); } catch { this.diagnostics.add("trajectory_trace_unreadable"); }
      }
      await yieldEventLoop();
    }
  }
  private register(traceId: string, locator: string): void {
    if (!/^events\/\d{4}\/\d{2}\/\d{2}\/[A-Za-z0-9_.-]+\.jsonl$/.test(locator)) throw new Error("invalid trace locator");
    this.index!.db.runSync("INSERT OR IGNORE INTO trajectory_sources(trace_id,locator) VALUES (?,?)", [traceId, locator]);
  }
  private async readSource(traceId: string, locator: string, validatePrefix = false): Promise<void> {
    if (!/^events\/\d{4}\/\d{2}\/\d{2}\/[A-Za-z0-9_.-]+\.jsonl$/.test(locator)) return;
    const path = resolve(this.options.layout.home, locator);
    await assertSafePath(this.options.layout.home, path);
    const file = await open(path, "r");
    try {
      let source = this.index!.db.querySingle("SELECT * FROM trajectory_sources WHERE trace_id=?", [traceId]);
      let offset = validatePrefix ? 0 : Number(source?.offset ?? 0);
      let verifiedSequence = validatePrefix ? 0 : Number(source?.sequence ?? 0);
      let verifiedHash = validatePrefix ? null : source?.hash ?? null;
      if ((await file.stat()).size < Number(source?.offset ?? 0)) throw new Error("trace source shortened");
      let remaining = Buffer.alloc(0);
      let readPosition = offset;
      const chunk = Buffer.alloc(64 * 1024);
      while (!this.disposed) {
        const read = await file.read(chunk, 0, chunk.length, readPosition);
        if (read.bytesRead === 0) break;
        readPosition += read.bytesRead;
        remaining = Buffer.concat([remaining, chunk.subarray(0, read.bytesRead)]);
        let end: number;
        while ((end = remaining.indexOf(10)) >= 0) {
          if (end > TRAJECTORY_BOUNDS.eventBytes + 2_048) throw new Error("trace event too large");
          const raw = remaining.subarray(0, end).toString("utf8");
          offset += end + 1;
          remaining = remaining.subarray(end + 1);
          if (raw.length === 0) continue;
          const event = JSON.parse(raw) as TraceEvent;
          if (event.traceId !== traceId) throw new Error("trace identity mismatch");
          const { eventHash, ...body } = event;
          if (event.sequence !== verifiedSequence + 1 || event.previousEventHash !== verifiedHash || canonicalDigest(body) !== eventHash) throw new Error("trace integrity failed");
          verifiedSequence = event.sequence; verifiedHash = eventHash;
          if (source !== undefined && event.sequence === Number(source.sequence) && eventHash !== source.hash) throw new Error("trace cache checkpoint mismatch");
          if (source === undefined) {
            if (event.metadata?.sessionId !== this.options.sessionId) return;
            this.register(traceId, locator);
            source = this.index!.db.querySingle("SELECT * FROM trajectory_sources WHERE trace_id=?", [traceId])!;
          }
          this.ingestTrace(event, source, offset);
          source = this.index!.db.querySingle("SELECT * FROM trajectory_sources WHERE trace_id=?", [traceId])!;
        }
        if (remaining.length > TRAJECTORY_BOUNDS.eventBytes) throw new Error("trace event too large");
        await yieldEventLoop();
      }
      if (remaining.length > 0) this.diagnostics.add("trajectory_incomplete_trace_tail");
    } finally { await file.close(); }
  }
  private ingestTrace(event: TraceEvent, source: Record<string, unknown>, offset: number): void {
    if (event.sequence <= Number(source.sequence)) return;
    const { eventHash, ...body } = event;
    if (event.sequence !== Number(source.sequence) + 1 || event.previousEventHash !== (source.hash ?? null) || canonicalDigest(body) !== eventHash) throw new Error("trace integrity failed");
    const run = string(event.metadata?.runId) ?? string(source.run_id) ?? `legacy-trace-${event.traceId}`;
    const generation = numeric(event.metadata?.ownerGeneration) ?? Number(source.generation);
    if (event.sequence === 1 && event.metadata?.sessionId !== this.options.sessionId) throw new Error("trace session mismatch");
    const index = this.index!;
    index.db.withImmediateTransactionSync(() => {
      projectTraceEvent(index, event, run, generation);
      index.db.runSync("UPDATE trajectory_sources SET offset=?,sequence=?,hash=?,run_id=?,generation=? WHERE trace_id=?", [offset, event.sequence, eventHash, run, generation, event.traceId]);
      index.set("traceRevision", String(Number(index.get("traceRevision") ?? 0) + 1));
    });
  }
  private syncSession(limit: number): boolean {
    const index = this.index!;
    const since = Number(index.get("sessionSequence") ?? 0);
    const database = this.options.store.database();
    const candidates = database.queryAll("SELECT sequence, length(CAST(payload_json AS BLOB)) AS bytes FROM session_events WHERE session_id=? AND sequence>? ORDER BY sequence LIMIT ?", [this.options.sessionId, since, limit]);
    let count = 0, bytes = 0;
    for (const candidate of candidates) {
      const size = Number(candidate.bytes);
      if (size > 8 * 1024 * 1024) {
        if (count === 0) this.diagnostics.add("trajectory_session_event_oversized");
        break;
      }
      if (count > 0 && bytes + size > 4 * 1024 * 1024) break;
      bytes += size; count++;
    }
    const rows = count === 0 ? [] : database.queryAll("SELECT * FROM session_events WHERE session_id=? AND sequence>? ORDER BY sequence LIMIT ?", [this.options.sessionId, since, count]);
    let previous = index.get("sessionHash") ?? null;
    let sequence = since;
    index.db.withImmediateTransactionSync(() => {
      for (const row of rows) {
        const event = rowToEvent(row);
        if (event.sequence !== sequence + 1 || event.previousEventHash !== previous || sessionEventHash(event.sessionId, event.sequence, event.eventId, event.eventType, event.payloadJson, previous) !== event.currentEventHash) throw new Error("session integrity failed");
        sequence = event.sequence; previous = event.currentEventHash;
        if (event.eventType === "agent.event") projectSessionEvent(index, object(JSON.parse(event.payloadJson)), sequence, event.ownerGeneration);
      }
      index.set("sessionSequence", String(sequence));
      if (previous !== null) index.set("sessionHash", previous);
    });
    if (rows.length > 0) this.invalidate();
    return count > 0 && (count < candidates.length || candidates.length === limit);
  }
  private syncAttempts(limit: number): boolean {
    const index = this.index!;
    const since = Number(index.get("attemptSequence") ?? 0);
    const rows = this.options.store.database().queryAll("SELECT rowid AS position, attempt_id, origin_generation, outcome, effect_class, created_at_ms FROM command_attempt_receipts WHERE session_id=? AND rowid>? ORDER BY rowid LIMIT ?", [this.options.sessionId, since, limit]);
    index.db.withImmediateTransactionSync(() => {
      for (const row of rows) {
        const id = `attempt/${String(row.attempt_id)}`;
        const old = index.find(id);
        const timestamp = Number(row.created_at_ms);
        const started = row.outcome === "started";
        index.put({ id, runId: `unlinked/${String(row.origin_generation)}`, kind: "attempt", name: safeText(row.effect_class, 128),
          source: "session",
          generation: Number(row.origin_generation), input: "unavailable", output: "unavailable", ...old,
          summary: "Receipt: " + safeText(row.outcome, 128) + "; call association unavailable",
          state: started ? "running" : row.outcome === "rejected" ? "failed" : row.outcome === "interrupted" ? "interrupted" : row.outcome === "uncertain" ? "unknown" : "succeeded",
          ...(started ? { startedAtMs: timestamp } : { endedAtMs: timestamp, durationMs: old?.startedAtMs === undefined ? undefined : Math.max(0, timestamp - old.startedAtMs) }),
        });
        index.set("attemptSequence", String(row.position));
      }
    });
    return rows.length === limit;
  }
  private status(): TrajectoryStatus {
    const index = this.index!;
    const missing = index.db.queryAll("SELECT id FROM trajectory_records r WHERE kind='run' AND NOT EXISTS (SELECT 1 FROM trajectory_sources s WHERE s.run_id=substr(r.id,5)) LIMIT 12");
    const unfinished = index.db.queryAll("SELECT id FROM trajectory_records WHERE kind='run' AND json_extract(json,'$.state')='running' AND json_extract(json,'$.generation')<? LIMIT 12", [this.options.generation]);
    const gaps = [...missing.map((row) => ({ runId: String(row.id), reason: "trace-unavailable" as const })), ...unfinished.map((row) => ({ runId: String(row.id), reason: "prior-generation-unfinished" as const }))].slice(0, 12);
    const hasTrace = Number(index.get("traceRevision") ?? 0) > 0;
    return { mode: this.options.config.mode, failurePolicy: this.options.config.failurePolicy,
      health: this.diagnostics.size > 0 || unfinished.length > 0 ? "degraded" : this.rebuilding !== undefined ? "rebuilding" : "ready",
      diagnostics: [...this.diagnostics].slice(0, 12),
      recordedBytes: Number(index.db.querySingle("SELECT COALESCE(SUM(offset),0) AS n FROM trajectory_sources")?.n ?? 0),
      records: Number(index.db.querySingle("SELECT COUNT(*) AS n FROM trajectory_records")?.n ?? 0),
      gaps, historyCoverage: this.diagnostics.size > 0 || unfinished.length > 0 || this.rebuilding !== undefined || (missing.length > 0 && hasTrace) ? "partial" : missing.length > 0 || !hasTrace ? "session-only" : "session-and-trace" };
  }
  private page(payload: Record<string, unknown>): TrajectoryPage {
    const search = string(payload.search) ?? "";
    const size = payload.pageSize === undefined ? TRAJECTORY_BOUNDS.pageSize : numeric(payload.pageSize);
    if (size === undefined || !Number.isInteger(size) || size < 1 || size > TRAJECTORY_BOUNDS.maxPageSize || search.length > TRAJECTORY_BOUNDS.searchCharacters) throw new Error("invalid_trajectory_request");
    if (payload.search !== undefined && typeof payload.search !== "string") throw new Error("invalid_trajectory_request");
    const timeFrom = numeric(payload.timeFrom), timeTo = numeric(payload.timeTo);
    if ((payload.timeFrom !== undefined && timeFrom === undefined) || (payload.timeTo !== undefined && timeTo === undefined) || (timeFrom !== undefined && timeTo !== undefined && timeFrom > timeTo)) throw new Error("invalid_trajectory_request");
    const scope = { search, timeFrom, timeTo };
    const cursor = payload.cursor === undefined ? undefined : this.decode(payload.cursor, "page");
    if (cursor !== undefined && (cursor.search !== search || cursor.timeFrom !== timeFrom || cursor.timeTo !== timeTo)) throw new Error("invalid_trajectory_cursor");
    if (payload.direction !== undefined && payload.direction !== "older" && payload.direction !== "newer") throw new Error("invalid_trajectory_request");
    const newer = payload.direction === "newer";
    const filters = ["1=1"];
    const params: unknown[] = [];
    if (search) { filters.push("instr(search_text, ?) > 0"); params.push(search.toLowerCase()); }
    if (timeFrom !== undefined) { filters.push("COALESCE(json_extract(json,'$.endedAtMs'),json_extract(json,'$.startedAtMs'),0)>=?"); params.push(timeFrom); }
    if (timeTo !== undefined) { filters.push("COALESCE(json_extract(json,'$.startedAtMs'),0)<=?"); params.push(timeTo); }
    let anchor = cursor?.position;
    if (payload.recordId !== undefined) {
      const record = this.index!.find(String(payload.recordId));
      if (!record) throw new Error("trajectory_record_not_found");
      anchor = record.ordinal + (newer ? -1 : 1);
    }
    const base = filters.join(" AND ");
    if (anchor !== undefined) { filters.push(`ordinal ${newer ? ">" : "<"} ?`); params.push(anchor); }
    const rows = this.index!.db.queryAll(`SELECT json FROM trajectory_records WHERE ${filters.join(" AND ")} ORDER BY ordinal ${newer ? "ASC" : "DESC"} LIMIT ?`, [...params, size]);
    const records: ReturnType<typeof publicRecord>[] = [];
    let bytes = 0;
    for (const row of rows) {
      let record = publicRecord(JSON.parse(String(row.json)) as IndexedTrajectoryRecord);
      if (record.generation < this.options.generation && (record.state === "running" || record.state === "waiting")) record = { ...record, state: "unknown" };
      const added = Buffer.byteLength(JSON.stringify(record));
      if (bytes + added > TRAJECTORY_BOUNDS.pageBytes) break;
      bytes += added; records.push(record);
    }
    if (!newer) records.reverse();
    const first = records[0]?.ordinal, last = records.at(-1)?.ordinal;
    const countParams = params.slice(0, anchor === undefined ? params.length : -1);
    const exists = (op: string, n: number | undefined): boolean => n !== undefined && this.index!.db.querySingle(`SELECT 1 AS n FROM trajectory_records WHERE ${base} AND ordinal ${op} ? LIMIT 1`, [...countParams, n]) !== undefined;
    return { version: 1, sessionId: this.options.sessionId, records,
      ...(first === undefined ? {} : { before: this.encode({ scope: "page", position: first, ...scope }) }),
      ...(last === undefined ? {} : { after: this.encode({ scope: "page", position: last, ...scope }) }),
      hasOlder: exists("<", first), hasNewer: exists(">", last), status: this.status(),
      watermark: { generation: this.options.generation, revision: Number(this.index!.get("revision") ?? 0), sessionSequence: Number(this.index!.get("sessionSequence") ?? 0), traceRevision: Number(this.index!.get("traceRevision") ?? 0), attemptSequence: Number(this.index!.get("attemptSequence") ?? 0) } };
  }
  private async detail(payload: Record<string, unknown>): Promise<TrajectoryDetail> {
    if (typeof payload.recordId !== "string" || (payload.field !== "input" && payload.field !== "output")) throw new Error("invalid_trajectory_request");
    const record = this.index!.find(payload.recordId);
    if (!record) throw new Error("trajectory_record_not_found");
    const field = payload.field;
    const dto = record.generation < this.options.generation && (record.state === "running" || record.state === "waiting") ? { ...publicRecord(record), state: "unknown" as const } : publicRecord(record);
    const scope = `detail:${record.id}:${field}:${record.revision}`;
    const offset = payload.cursor === undefined ? 0 : this.decode(payload.cursor, scope).position;
    const seq = field === "input" ? record.sessionInputSeq : record.sessionOutputSeq;
    const ref = field === "input" ? record.traceInput : record.traceOutput;
    let text: string;
    if (seq !== undefined) {
      const row = this.options.store.database().querySingle("SELECT CASE WHEN length(CAST(payload_json AS BLOB))<=8388608 THEN payload_json ELSE NULL END AS payload_json FROM session_events WHERE session_id=? AND sequence=?", [this.options.sessionId, seq]);
      if (!row) return { record: dto, field, text: "", availability: "unavailable" };
      if (row.payload_json === null) return { record: dto, field, text: "Saved event exceeds safe preview size (8 MiB).", availability: "unavailable" };
      text = sessionDetail(object(JSON.parse(String(row.payload_json))), field);
      if (text.length > 2 * 1024 * 1024) return { record: dto, field, text: "Saved body exceeds safe preview size (2 MiB).", availability: "unavailable" };
    } else if (ref?.storage === "artifact") {
      const artifact = new FileArtifactStore({ dataRoot: this.options.layout.artifacts, metadataRoot: this.options.layout.artifactMetadata });
      if (!/^[a-f0-9]{64}$/.test(ref.digest)) throw new Error("invalid artifact");
      await assertSafePath(this.options.layout.home, join(this.options.layout.artifacts, "sha256", ref.digest.slice(0, 2), ref.digest));
      await assertSafePath(this.options.layout.home, join(this.options.layout.artifactMetadata, "sha256", ref.digest.slice(0, 2), `${ref.digest}.json`));
      try {
        const dataStat = await lstat(join(this.options.layout.artifacts, "sha256", ref.digest.slice(0, 2), ref.digest));
        const metaStat = await lstat(join(this.options.layout.artifactMetadata, "sha256", ref.digest.slice(0, 2), `${ref.digest}.json`));
        if (dataStat.size > 2 * 1024 * 1024 || metaStat.size > 64 * 1024) return { record: dto, field, text: "Artifact exceeds safe preview size.", availability: "unavailable" };
        await artifact.metadata(ref);
        if (ref.size > 2 * 1024 * 1024) return { record: dto, field, text: "Artifact exceeds safe preview size (2 MiB).", availability: "unavailable" };
        text = safeText(JSON.parse(Buffer.from(await artifact.read(ref)).toString("utf8")), 2 * 1024 * 1024);
      } catch { return { record: dto, field, text: "", availability: "corrupt" }; }
    } else return { record: dto, field, text: "", availability: "not-recorded" };
    const bytes = Buffer.from(text);
    if (offset > bytes.length) throw new Error("invalid_trajectory_cursor");
    let end = Math.min(bytes.length, offset + TRAJECTORY_BOUNDS.detailBytes);
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    return { record: dto, field, text: bytes.subarray(offset, end).toString("utf8"), availability: end < bytes.length ? "more" : "complete",
      ...(end < bytes.length ? { next: this.encode({ scope, position: end, search: "" }) } : {}) };
  }
  private encode(cursor: Cursor): string {
    const body = Buffer.from(JSON.stringify(cursor)).toString("base64url");
    return `${body}.${createHmac("sha256", this.secret).update(body).digest("base64url")}`;
  }
  private decode(raw: unknown, scope: string): Cursor {
    if (typeof raw !== "string" || raw.length > 2_048) throw new Error("invalid_trajectory_cursor");
    const [body, signature, extra] = raw.split(".");
    if (!body || !signature || extra !== undefined) throw new Error("invalid_trajectory_cursor");
    const expected = createHmac("sha256", this.secret).update(body).digest();
    const supplied = Buffer.from(signature, "base64url");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error("invalid_trajectory_cursor");
    const value = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Cursor;
    if (value.scope !== scope || !Number.isSafeInteger(value.position) || value.position < 0) throw new Error("invalid_trajectory_cursor");
    return value;
  }
}
export async function assertSafePath(home: string, path: string): Promise<void> {
  const root = resolve(home), target = resolve(path);
  if (target !== root && !target.startsWith(`${root}/`) && !target.startsWith(`${root}\\`)) throw new Error("trajectory path outside home");
  const relative = target.slice(root.length).split(/[\\/]/).filter(Boolean);
  let current = root;
  for (const part of ["", ...relative]) {
    current = part ? join(current, part) : current;
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error("trajectory symlink rejected"); }
    catch (error) { if (!isMissing(error)) throw error; }
  }
}
function isMissing(error: unknown): boolean { return object(error).code === "ENOENT"; }
function yieldEventLoop(): Promise<void> { return new Promise((done) => setTimeout(done, 0)); }
