import { Value } from "typebox/value";
import type { Static } from "typebox";
import { WebTrajectoryRequestSchema, type WebTrajectoryPage, type WebTrajectoryDetail } from "@runledger/collab-web/contracts";
import type { TrajectoryPage, TrajectoryDetail } from "../runtime/contracts/trajectory.ts";
import { HistoryReadError } from "../storage/session-store/history-reader.ts";
import type { WebHistory } from "./history.ts";
import { WebCursorError } from "./cursor.ts";
import type { WebObservers } from "./observer.ts";
import { trajectoryDto } from "./trajectory-mapping.ts";
import { publicId } from "./timeline-projector.ts";

/** Owner 游标和记录 locator 始终留在服务端适配层，浏览器只持有桥接签名游标。 */
export class LiveWebTrajectory {
  private readonly history: WebHistory;
  private readonly observers: WebObservers;
  private readonly records = new Map<string, { readonly epoch: string; readonly id: string }>();
  constructor(history: WebHistory, observers: WebObservers) { this.history = history; this.observers = observers; }
  async page(sessionId: string, request: Static<typeof WebTrajectoryRequestSchema>): Promise<WebTrajectoryPage | undefined> {
    if (!Value.Check(WebTrajectoryRequestSchema, request)) throw new HistoryReadError("invalid_request");
    const epoch = this.history.source(sessionId).epoch;
    const scope = JSON.stringify(["live-trajectory", sessionId, epoch, request.search, request.recordId, request.timeFrom, request.timeTo]);
    const cursor = request.cursor === undefined ? undefined : this.history.cursors.decode(scope, request.cursor);
    if (cursor !== undefined && typeof cursor !== "string") throw new WebCursorError();
    const record = request.recordId ? this.records.get(`${sessionId}:${request.recordId}`) : undefined;
    if (request.recordId && (!record || record.epoch !== epoch)) throw new HistoryReadError("not_found");
    const result = await this.observers.query(sessionId, "trajectory.page", { ...request, recordId: record?.id, cursor });
    if (result === undefined) return undefined;
    if (result.ok !== true) throw new WebCursorError();
    const value = result.value as TrajectoryPage;
    for (const record of value.records) this.records.set(`${sessionId}:${publicId(record.id)}`, { epoch, id: record.id });
    while (this.records.size > 4000) this.records.delete(this.records.keys().next().value!);
    return { version: 1, asOfMs: Date.now(), before: value.hasOlder && value.before ? this.history.cursors.encode(scope, value.before) : null,
      after: value.hasNewer && value.after ? this.history.cursors.encode(scope, value.after) : null,
      watermark: this.history.watermark(sessionId, value.watermark.sessionSequence), projectionRevision: value.watermark.revision,
      health: value.status.health, coverage: value.status.historyCoverage, recording: value.status.mode,
      scannedEvents: value.watermark.sessionSequence, totalEvents: this.history.read((reader) => reader.session(sessionId).headSequence), items: value.records.map(trajectoryDto) };
  }
  async detail(sessionId: string, recordId: string, field: "input" | "output", cursor?: string): Promise<WebTrajectoryDetail | undefined> {
    if (recordId.startsWith("ledger:")) return undefined;
    const epoch = this.history.source(sessionId).epoch, record = this.records.get(`${sessionId}:${recordId}`);
    if (!record || record.epoch !== epoch) throw new HistoryReadError("not_found");
    const scope = `live-detail:${sessionId}:${epoch}:${recordId}:${field}`;
    const position = cursor === undefined ? { cursor: undefined, offset: 0 } : this.history.cursors.decode(scope, cursor) as { cursor?: string; offset: number };
    if (!position || !Number.isSafeInteger(position.offset) || position.offset < 0 || (position.cursor !== undefined && typeof position.cursor !== "string")) throw new WebCursorError();
    const result = await this.observers.query(sessionId, "trajectory.detail", { recordId: record.id, field, cursor: position.cursor });
    if (result === undefined) return undefined;
    if (result.ok !== true) throw new WebCursorError();
    const value = result.value as TrajectoryDetail;
    if (position.offset > value.text.length) throw new WebCursorError();
    let end = Math.min(value.text.length, position.offset + 6000);
    if (end < value.text.length && /[\uD800-\uDBFF]/.test(value.text[end - 1] ?? "")) end--;
    const next = end < value.text.length ? this.history.cursors.encode(scope, { cursor: position.cursor, offset: end })
      : value.next ? this.history.cursors.encode(scope, { cursor: value.next, offset: 0 }) : null;
    return { version: 1, sessionId, recordId, field, text: value.text.slice(position.offset, end),
      availability: next ? "more" : value.availability, next };
  }
}
