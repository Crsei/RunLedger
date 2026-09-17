import type { SessionDatabase } from "./database.ts";
import type { SessionEventRecord } from "./session-store.ts";
import { rowToEvent } from "./row-mappers.ts";
import { sessionEventHash } from "./event-append.ts";
import { SessionStoreError } from "./session-store-error.ts";

export const EVENT_READ_BOUNDS = Object.freeze({ rows: 200, bytes: 4 * 1024 * 1024, eventBytes: 8 * 1024 * 1024 });
export interface EventRangeRequest {
  readonly after?: number;
  readonly before?: number;
  readonly through?: number;
  readonly limit?: number;
  readonly descending?: boolean;
}
/** SQL 先取有界长度元数据，避免单个恶意大行耗尽读取进程内存。调用方持有一致读事务。 */
export function readEventRange(db: Pick<SessionDatabase, "queryAll" | "querySingle">, sessionId: string, request: EventRangeRequest = {}): readonly SessionEventRecord[] {
  const limit = request.limit ?? EVENT_READ_BOUNDS.rows;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4096
    || [request.after, request.before, request.through].some((n) => n !== undefined && (!Number.isSafeInteger(n) || n < 0))) {
    throw new SessionStoreError("invalid_input", "invalid event range");
  }
  const order = request.descending ? "DESC" : "ASC";
  const where = "session_id=? AND sequence>? AND sequence<? AND sequence<=?";
  const params = [sessionId, request.after ?? 0, request.before ?? Number.MAX_SAFE_INTEGER, request.through ?? Number.MAX_SAFE_INTEGER];
  const candidates = db.queryAll(`SELECT sequence, length(CAST(payload_json AS BLOB)) AS bytes FROM session_events WHERE ${where} ORDER BY sequence ${order} LIMIT ?`, [...params, limit]);
  let count = 0, bytes = 0;
  for (const row of candidates) {
    const size = Number(row.bytes);
    if (size > EVENT_READ_BOUNDS.eventBytes) {
      if (count === 0) throw new SessionStoreError("invalid_input", "event exceeds read limit");
      break;
    }
    if (count > 0 && bytes + size > EVENT_READ_BOUNDS.bytes) break;
    count++; bytes += size;
  }
  if (count === 0) return [];
  const events = db.queryAll(`SELECT * FROM session_events WHERE ${where} ORDER BY sequence ${order} LIMIT ?`, [...params, count]).map(rowToEvent);
  const ascending = request.descending ? [...events].reverse() : events;
  const first = ascending[0];
  const predecessor = db.querySingle("SELECT sequence,current_event_hash FROM session_events WHERE session_id=? AND sequence=?", [sessionId, first.sequence - 1]);
  let previous = first.sequence === 1 ? null : predecessor?.current_event_hash;
  let sequence = first.sequence - 1;
  if (previous === undefined) throw new SessionStoreError("sequence_conflict", "event predecessor missing");
  for (const event of ascending) {
    if (event.sequence !== sequence + 1 || event.previousEventHash !== previous
      || event.currentEventHash !== sessionEventHash(sessionId, event.sequence, event.eventId, event.eventType, event.payloadJson, event.previousEventHash)) {
      throw new SessionStoreError("sequence_conflict", "event integrity failed");
    }
    sequence = event.sequence; previous = event.currentEventHash;
  }
  return events;
}
