import { openSessionDatabase, type SessionDatabase } from "../../storage/session-store/database.ts";
import type { TrajectoryRecord } from "../contracts/trajectory.ts";
import type { TraceContentDescriptor } from "../trace/types.ts";

export interface IndexedTrajectoryRecord extends TrajectoryRecord {
  readonly sessionInputSeq?: number;
  readonly sessionOutputSeq?: number;
  readonly traceInput?: TraceContentDescriptor;
  readonly traceOutput?: TraceContentDescriptor;
}
/** 独立可重建 cache；不安装或修改 Session authority schema。 */
export class TrajectoryIndex {
  readonly db: SessionDatabase;
  constructor(path: string) {
    this.db = openSessionDatabase(path);
    this.db.execSync(`CREATE TABLE IF NOT EXISTS trajectory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS trajectory_records (id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL UNIQUE,
        parent_id TEXT, run_id TEXT NOT NULL, kind TEXT NOT NULL, search_text TEXT NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS trajectory_order ON trajectory_records(ordinal);
      CREATE INDEX IF NOT EXISTS trajectory_parent ON trajectory_records(parent_id);
      CREATE INDEX IF NOT EXISTS trajectory_kind ON trajectory_records(kind);
      CREATE TABLE IF NOT EXISTS trajectory_sources (trace_id TEXT PRIMARY KEY, locator TEXT NOT NULL,
        offset INTEGER NOT NULL DEFAULT 0, sequence INTEGER NOT NULL DEFAULT 0, hash TEXT, run_id TEXT, generation INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS trajectory_source_run ON trajectory_sources(run_id);`);
    if (this.get("version") !== "1") {
      this.db.execSync("DELETE FROM trajectory_records; DELETE FROM trajectory_sources; DELETE FROM trajectory_meta;");
      this.set("version", "1");
    }
  }
  get(key: string): string | undefined { return this.db.querySingle("SELECT value FROM trajectory_meta WHERE key = ?", [key])?.value as string | undefined; }
  set(key: string, value: string): void { this.db.runSync("INSERT INTO trajectory_meta VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [key, value]); }
  find(id: string): IndexedTrajectoryRecord | undefined {
    const row = this.db.querySingle("SELECT json FROM trajectory_records WHERE id = ?", [id]);
    return row === undefined ? undefined : JSON.parse(String(row.json)) as IndexedTrajectoryRecord;
  }
  put(record: Omit<IndexedTrajectoryRecord, "ordinal" | "revision">): void {
    const old = this.find(record.id);
    const revision = Number(this.get("revision") ?? 0) + 1;
    const ordinal = old?.ordinal ?? Number(this.get("ordinal") ?? 0) + 1;
    const next = { ...old, ...record, revision, ordinal };
    this.db.runSync(`INSERT INTO trajectory_records VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id, run_id=excluded.run_id,
        kind=excluded.kind, search_text=excluded.search_text, json=excluded.json`,
    [next.id, ordinal, next.parentId ?? null, next.runId, next.kind, `${next.name}\n${next.summary}`.toLowerCase(), JSON.stringify(next)]);
    this.set("revision", String(revision));
    if (old === undefined) this.set("ordinal", String(ordinal));
  }
  close(): void { this.db.close(); }
}

export function publicRecord(record: IndexedTrajectoryRecord): TrajectoryRecord {
  const { sessionInputSeq: _a, sessionOutputSeq: _b, traceInput: _c, traceOutput: _d, ...dto } = record;
  return dto;
}
