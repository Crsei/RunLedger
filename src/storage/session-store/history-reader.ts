import { existsSync } from "node:fs";
import { openSessionDatabase, SessionStoreDatabaseError, type SessionDatabase } from "./database.ts";
import { checkStoreCompatibility } from "./schema-compatibility.ts";
import { SESSION_STORE_SCHEMA_VERSION } from "./schema.ts";
import { readEventRange, type EventRangeRequest } from "./event-range.ts";
import type { SessionEventRecord } from "./session-store.ts";

export type HistoryReadErrorCode = "database_missing" | "schema_incompatible" | "migration_in_progress" | "corrupt" | "busy" | "not_found" | "invalid_request" | "unavailable";
export class HistoryReadError extends Error {
  readonly code: HistoryReadErrorCode;
  constructor(code: HistoryReadErrorCode) { super(code); this.code = code; }
}
export interface HistorySession {
  readonly id: string; readonly workspaceId: string; readonly repositoryId: string;
  readonly title: string | null; readonly status: string;
  readonly createdAtMs: number; readonly updatedAtMs: number; readonly headSequence: number;
}
export interface HistoryProject { readonly workspaceId: string; readonly sessions: number; readonly lastActivityAtMs: number }
export interface HistorySessionsRequest {
  readonly workspaceId: string;
  readonly position?: { readonly createdAtMs: number; readonly id: string };
  readonly newer?: boolean; readonly limit: number;
  readonly status?: string; readonly timeFrom?: number; readonly timeTo?: number;
}
function session(row: Record<string, unknown>): HistorySession {
  return { id: String(row.session_id), workspaceId: String(row.workspace_id), repositoryId: String(row.repository_id),
    title: row.title == null ? null : String(row.title), status: String(row.status),
    createdAtMs: Number(row.created_at_ms), updatedAtMs: Number(row.updated_at_ms), headSequence: Number(row.head_sequence) };
}
function boundedLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 201) throw new HistoryReadError("invalid_request");
}
/** 仅打开现有 authority；没有安装、迁移、恢复或 Owner claim 入口。 */
export class SessionHistoryReader {
  private readonly db: SessionDatabase;
  constructor(path: string) {
    if (!existsSync(path)) throw new HistoryReadError("database_missing");
    try { this.db = openSessionDatabase(path, { readOnly: true }); }
    catch (error) {
      throw new HistoryReadError(error instanceof SessionStoreDatabaseError && error.code === "busy" ? "busy" : "corrupt");
    }
    try { this.assertReadable(); } catch (error) { this.db.close(); throw error; }
  }
  close(): void { this.db.close(); }
  read<T>(fn: (reader: SessionHistoryReader) => T): T {
    return this.db.withReadTransactionSync(() => { this.assertReadable(); return fn(this); });
  }
  private assertReadable(): void {
    const compatibility = checkStoreCompatibility(this.db);
    if (!compatibility.ok || compatibility.header.storeVersion !== SESSION_STORE_SCHEMA_VERSION) throw new HistoryReadError("schema_incompatible");
    if (compatibility.header.admission !== "ready") throw new HistoryReadError("migration_in_progress");
  }
  revision(): number { return Number(this.db.querySingle("SELECT catalog_revision FROM store_control WHERE singleton_id=1")?.catalog_revision ?? 0); }
  projects(position: string | undefined, newer: boolean, limit: number): readonly HistoryProject[] {
    boundedLimit(limit);
    const rows = this.db.queryAll(`SELECT workspace_id,COUNT(*) AS sessions,MAX(updated_at_ms) AS activity FROM sessions
      ${position === undefined ? "" : `WHERE workspace_id ${newer ? "<" : ">"} ?`}
      GROUP BY workspace_id ORDER BY workspace_id ${newer ? "DESC" : "ASC"} LIMIT ?`, position === undefined ? [limit] : [position, limit]);
    return rows.map((row) => ({ workspaceId: String(row.workspace_id), sessions: Number(row.sessions), lastActivityAtMs: Number(row.activity) }));
  }
  sessions(request: HistorySessionsRequest): readonly HistorySession[] {
    boundedLimit(request.limit);
    const conditions = ["workspace_id=?"]; const params: unknown[] = [request.workspaceId];
    if (request.position !== undefined) {
      conditions.push(`(created_at_ms, session_id) ${request.newer ? ">" : "<"} (?,?)`);
      params.push(request.position.createdAtMs, request.position.id);
    }
    if (request.status !== undefined) { conditions.push("status=?"); params.push(request.status); }
    if (request.timeFrom !== undefined) { conditions.push("created_at_ms>=?"); params.push(request.timeFrom); }
    if (request.timeTo !== undefined) { conditions.push("created_at_ms<?"); params.push(request.timeTo); }
    params.push(request.limit);
    return this.db.queryAll(`SELECT session_id,workspace_id,repository_id,title,status,created_at_ms,updated_at_ms,head_sequence
      FROM sessions WHERE ${conditions.join(" AND ")} ORDER BY created_at_ms ${request.newer ? "ASC" : "DESC"},session_id ${request.newer ? "ASC" : "DESC"} LIMIT ?`, params).map(session);
  }
  session(id: string): HistorySession {
    const row = this.db.querySingle("SELECT session_id,workspace_id,repository_id,title,status,created_at_ms,updated_at_ms,head_sequence FROM sessions WHERE session_id=?", [id]);
    if (row === undefined) throw new HistoryReadError("not_found");
    return session(row);
  }
  usageSessions(workspaceId: string, after: string, limit = 50): readonly { id: string; head: number }[] {
    boundedLimit(limit);
    return this.db.queryAll("SELECT session_id,head_sequence FROM sessions WHERE workspace_id=? AND session_id>? ORDER BY session_id LIMIT ?", [workspaceId, after, limit])
      .map((row) => ({ id: String(row.session_id), head: Number(row.head_sequence) }));
  }
  projectExists(workspaceId: string): boolean { return this.db.querySingle("SELECT 1 FROM sessions WHERE workspace_id=? LIMIT 1", [workspaceId]) !== undefined; }
  events(id: string, request: EventRangeRequest = {}): readonly SessionEventRecord[] { return readEventRange(this.db, id, request); }
  event(id: string, sequence: number): SessionEventRecord | undefined { return this.events(id, { after: sequence - 1, before: sequence + 1, limit: 1 })[0]; }
  /** 私有桥接使用；不进入 browser DTO。 */
  owner(id: string): { runtimeId: string; generation: number; port: number; authToken: string } | undefined {
    const row = this.db.querySingle("SELECT runtime_id,generation,port,auth_token FROM session_owners WHERE session_id=? AND state IN ('running','recovery_required')", [id]);
    if (!row || typeof row.runtime_id !== "string" || typeof row.port !== "number" || !(row.auth_token instanceof Uint8Array)) return undefined;
    return { runtimeId: row.runtime_id, generation: Number(row.generation), port: row.port, authToken: Buffer.from(row.auth_token).toString("hex") };
  }
  receipts(id: string, after: number, limit = 200): readonly Record<string, unknown>[] {
    boundedLimit(limit);
    return this.db.queryAll("SELECT rowid AS position,attempt_id,origin_generation,outcome,effect_class,created_at_ms FROM command_attempt_receipts WHERE session_id=? AND rowid>? ORDER BY rowid LIMIT ?", [id, after, limit]);
  }
}
