import { randomBytes } from "node:crypto";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import {
  WEB_BOUNDS, WebPageRequestSchema, WebSessionsRequestSchema, WebSessionStatusSchema,
  type WebProject, type WebProjectsPage, type WebSession, type WebSessionsPage, type WebSnapshot, type WebTimelinePage,
} from "@runledger/collab-web/contracts";
import { SessionHistoryReader, HistoryReadError, type HistorySession } from "../storage/session-store/history-reader.ts";
import { WebCursors, WebCursorError } from "./cursor.ts";
import { projectWebTimeline } from "./timeline-projector.ts";

export type PageRequest = Static<typeof WebPageRequestSchema>;
export type SessionsRequest = Static<typeof WebSessionsRequestSchema>;
interface TimelinePosition { readonly sequence: number; readonly row: number }
function position(value: unknown): TimelinePosition {
  if (typeof value !== "object" || value === null || !("sequence" in value) || !("row" in value)
    || !Number.isSafeInteger(value.sequence) || !Number.isSafeInteger(value.row)
    || Number(value.sequence) < 0 || Number(value.row) < -1) throw new WebCursorError();
  return { sequence: Number(value.sequence), row: Number(value.row) };
}
export function projectId(workspaceId: string): string { return `p_${Buffer.from(workspaceId).toString("base64url")}`; }
export function workspaceId(id: string): string {
  if (!/^p_[A-Za-z0-9_-]*$/.test(id) || id.length > 256) throw new HistoryReadError("invalid_request");
  const value = Buffer.from(id.slice(2), "base64url").toString("utf8");
  if (projectId(value) !== id) throw new HistoryReadError("invalid_request");
  return value;
}
function sessionDto(record: HistorySession): WebSession {
  return { id: record.id, projectId: projectId(record.workspaceId), repositoryId: record.repositoryId || null,
    title: record.title?.slice(0, 512) ?? null, status: Value.Check(WebSessionStatusSchema, record.status) ? record.status : "unknown",
    createdAtMs: record.createdAtMs, updatedAtMs: record.updatedAtMs, headSequence: record.headSequence };
}
function boundedItems<T>(items: readonly T[]): T[] {
  const result: T[] = []; let bytes = 8192;
  for (const item of items) {
    const size = Buffer.byteLength(JSON.stringify(item));
    if (bytes + size > WEB_BOUNDS.pageBytes) break;
    result.push(item); bytes += size;
  }
  return result;
}
/** 服务实例私有游标与短 SQLite 只读事务；不加载用户配置、不装配 Runtime。 */
export class WebHistory {
  readonly cursors = new WebCursors();
  private readonly path: string;
  private historyEpoch = this.cursors.epoch;
  private readonly sources = new Map<string, { readonly generation: number | null; readonly epoch: string }>();
  constructor(path: string) { this.path = path; }
  read<T>(operation: (reader: SessionHistoryReader) => T): T {
    const reader = new SessionHistoryReader(this.path);
    try { return reader.read(operation); } finally { reader.close(); }
  }
  source(sessionId: string): { readonly generation: number | null; readonly epoch: string } {
    return this.sources.get(sessionId) ?? { generation: null, epoch: this.historyEpoch };
  }
  setSource(sessionId: string, generation: number | null): void {
    if (this.source(sessionId).generation === generation) return;
    if (!this.sources.has(sessionId) && this.sources.size >= 4096) {
      this.sources.delete(this.sources.keys().next().value!);
      this.historyEpoch = randomBytes(16).toString("hex");
    }
    this.sources.set(sessionId, { generation, epoch: randomBytes(16).toString("hex") });
  }
  watermark(sessionId: string, sequence: number): WebTimelinePage["watermark"] {
    const source = this.source(sessionId);
    return { sessionId, sequence, ownerGeneration: source.generation, epoch: source.epoch, source: source.generation === null ? "history" : "owner" };
  }
  timelineScope(sessionId: string): string { return `timeline:${sessionId}:${this.source(sessionId).epoch}`; }
  resumeCursor(sessionId: string, sequence: number): string {
    return this.cursors.encode(this.timelineScope(sessionId), { sequence, row: Number.MAX_SAFE_INTEGER });
  }
  resumeSequence(sessionId: string, cursor: string): number {
    return position(this.cursors.decode(this.timelineScope(sessionId), cursor)).sequence;
  }
  projects(request: PageRequest = {}): WebProjectsPage {
    if (!Value.Check(WebPageRequestSchema, request)) throw new HistoryReadError("invalid_request");
    return this.read((reader) => {
      const revision = reader.revision(), size = request.pageSize ?? WEB_BOUNDS.pageSize;
      const scope = `projects:${revision}`, newer = request.direction === "newer";
      const key = request.cursor === undefined ? undefined : this.cursors.decode(scope, request.cursor);
      if (key !== undefined && typeof key !== "string") throw new WebCursorError();
      const records = reader.projects(key, newer, size + 1);
      const items: WebProject[] = boundedItems(records.slice(0, size).map((row) => ({ id: projectId(row.workspaceId), workspaceId: row.workspaceId || null,
        displayName: row.workspaceId || "未识别项目", sessionCount: row.sessions, lastActivityAtMs: row.lastActivityAtMs, verifiedOnlineCount: null })));
      const extra = records.length > items.length;
      if (newer) items.reverse();
      const first = items[0], last = items.at(-1);
      return { version: 1, asOfMs: Date.now(), catalogRevision: revision, items,
        before: first && (newer ? extra : key !== undefined) ? this.cursors.encode(scope, first.workspaceId ?? "") : null,
        after: last && (newer ? key !== undefined : extra) ? this.cursors.encode(scope, last.workspaceId ?? "") : null };
    });
  }
  sessions(id: string, request: SessionsRequest = {}): WebSessionsPage {
    if (!Value.Check(WebSessionsRequestSchema, request) || (request.timeFrom !== undefined && request.timeTo !== undefined && request.timeFrom >= request.timeTo)) throw new HistoryReadError("invalid_request");
    return this.read((reader) => {
      const workspace = workspaceId(id);
      if (!reader.projectExists(workspace)) throw new HistoryReadError("not_found");
      const revision = reader.revision(), size = request.pageSize ?? WEB_BOUNDS.pageSize, newer = request.direction === "newer";
      const scope = JSON.stringify(["sessions", id, revision, request.status, request.timeFrom, request.timeTo]);
      const key = request.cursor === undefined ? undefined : this.cursors.decode(scope, request.cursor);
      if (key !== undefined && (typeof key !== "object" || key === null || !("createdAtMs" in key) || !("id" in key)
        || typeof key.id !== "string" || !Number.isSafeInteger(key.createdAtMs))) throw new WebCursorError();
      const records = reader.sessions({ workspaceId: workspace, limit: size + 1, newer,
        position: key as { createdAtMs: number; id: string } | undefined, status: request.status, timeFrom: request.timeFrom, timeTo: request.timeTo });
      const items = boundedItems(records.slice(0, size).map(sessionDto)), extra = records.length > items.length;
      if (newer) items.reverse();
      const encode = (item: WebSession) => this.cursors.encode(scope, { createdAtMs: item.createdAtMs, id: item.id });
      return { version: 1, asOfMs: Date.now(), projectId: id, catalogRevision: revision, items,
        before: items[0] && (newer ? key !== undefined : extra) ? encode(items.at(-1)!) : null,
        after: items[0] && (newer ? extra : key !== undefined) ? encode(items[0]) : null };
    });
  }
  snapshot(id: string): WebSnapshot {
    return this.read((reader) => {
      const session = sessionDto(reader.session(id));
      const timeline = this.timelineInRead(reader, id, session.headSequence, {});
      return { version: 1, session, timeline, resumeCursor: this.resumeCursor(id, session.headSequence),
        connection: { state: this.source(id).generation === null ? "offline" : "connected", freshness: "current", checkedAtMs: Date.now() } };
    });
  }
  timeline(id: string, request: PageRequest = {}): WebTimelinePage {
    if (!Value.Check(WebPageRequestSchema, request)) throw new HistoryReadError("invalid_request");
    return this.read((reader) => this.timelineInRead(reader, id, reader.session(id).headSequence, request));
  }
  private timelineInRead(reader: SessionHistoryReader, id: string, head: number, request: PageRequest): WebTimelinePage {
    const newer = request.direction === "newer", size = request.pageSize ?? WEB_BOUNDS.pageSize, scope = this.timelineScope(id);
    const key = request.cursor === undefined ? { sequence: newer ? 0 : head + 1, row: newer ? -1 : 0 } : position(this.cursors.decode(scope, request.cursor));
    if (key.sequence > head + 1) throw new WebCursorError();
    const items: WebTimelinePage["items"] = [];
    const selected = [...items];
    let boundary = key, scanned = 0, bytes = 8192, exhausted = false, limited = false;
    while (scanned < 1000 && !limited) {
      const events = reader.events(id, { ...(newer ? { after: Math.max(0, boundary.sequence - 1) } : { before: boundary.sequence + 1 }), through: head, limit: 200, descending: !newer });
      if (events.length === 0) { exhausted = true; break; }
      for (const event of events) {
        const rows = projectWebTimeline(event).map((row, index) => ({ row, index }));
        if (!newer) rows.reverse();
        for (const candidate of rows) {
          const comparison = event.sequence === key.sequence ? candidate.index - key.row : event.sequence - key.sequence;
          if (newer ? comparison <= 0 : comparison >= 0) continue;
          const rowBytes = Buffer.byteLength(JSON.stringify(candidate.row));
          if (selected.length >= size || bytes + rowBytes > WEB_BOUNDS.pageBytes) { limited = true; break; }
          selected.push(candidate.row); bytes += rowBytes;
          boundary = { sequence: event.sequence, row: candidate.index };
        }
        if (limited) break;
        scanned++;
        boundary = { sequence: event.sequence, row: newer ? Number.MAX_SAFE_INTEGER : -1 };
        if (scanned >= 1000) break;
      }
      if (limited || scanned >= 1000) break;
      // 下一批不再读取已完整处理的事件。
      boundary = { sequence: boundary.sequence + (newer ? 1 : -1), row: newer ? -1 : Number.MAX_SAFE_INTEGER };
      if (boundary.sequence < 1 || boundary.sequence > head) { exhausted = true; break; }
    }
    if (!newer) selected.reverse();
    const first = selected[0], last = selected.at(-1);
    const rowPosition = (row: WebTimelinePage["items"][number]): TimelinePosition => ({ sequence: row.sequence, row: Number(row.id.slice(row.id.lastIndexOf(":") + 1)) });
    const before = newer ? (first ? this.cursors.encode(scope, rowPosition(first)) : null) : exhausted ? null : this.cursors.encode(scope, boundary);
    const after = newer ? exhausted ? null : this.cursors.encode(scope, boundary) : last ? this.cursors.encode(scope, rowPosition(last)) : null;
    return { version: 1, before, after, asOfMs: Date.now(), watermark: this.watermark(id, head), items: selected };
  }
}
