import { safeText, object } from "../runtime/trajectory/projection.ts";
import type { WebChildren, WebProcesses, WebPlan } from "@runledger/collab-web/contracts";
import type { WebObservers } from "./observer.ts";
import type { PageRequest, WebHistory } from "./history.ts";
import { publicId } from "./timeline-projector.ts";
import { WebCursorError } from "./cursor.ts";
import { HistoryReadError } from "../storage/session-store/history-reader.ts";

/** 只选择可展示字段，不透传 domain 对象、执行 handle 或 artifact locator。 */
export class WebCapabilities {
  private readonly observers: WebObservers;
  private readonly history: WebHistory;
  constructor(history: WebHistory, observers: WebObservers) { this.history = history; this.observers = observers; }
  private async read(id: string, operation: string): Promise<Record<string, unknown> | undefined> {
    this.history.read((reader) => reader.session(id));
    const result = await this.observers.query(id, operation, {});
    if (result === undefined) return undefined;
    if (result.ok !== true) throw new HistoryReadError("unavailable");
    return object(result.value);
  }
  private unavailable(id: string): { available: false; reason: "offline" | "not-equipped" } {
    return { available: false, reason: this.history.source(id).generation === null ? "offline" : "not-equipped" };
  }
  private page<T extends { id: string }>(id: string, kind: string, records: T[], request: PageRequest) {
    const all = records.sort((a, b) => a.id.localeCompare(b.id)), scope = `${kind}:${id}:${this.history.source(id).epoch}:${publicId(all.map((item) => item.id).join("|"))}`;
    const key = request.cursor === undefined ? undefined : this.history.cursors.decode(scope, request.cursor);
    if (key !== undefined && typeof key !== "string") throw new WebCursorError();
    const newer = request.direction === "newer", size = Math.min(32, request.pageSize ?? 32);
    const candidates = all.filter((item) => key === undefined || (newer ? item.id < key : item.id > key));
    const items = newer ? candidates.slice(-size) : candidates.slice(0, size);
    return { items, before: items.length && all[0].id !== items[0].id ? this.history.cursors.encode(scope, items[0].id) : null,
      after: items.length && all.at(-1)!.id !== items.at(-1)!.id ? this.history.cursors.encode(scope, items.at(-1)!.id) : null };
  }
  async processes(id: string, request: PageRequest = {}, signal?: AbortSignal): Promise<WebProcesses> {
    const value = await this.read(id, "session.process.list");
    if (!value) return this.unavailable(id);
    if (!Array.isArray(value.items) || value.items.length > 200) throw new HistoryReadError("unavailable");
    const items: Extract<WebProcesses, { available: true }>["items"] = [];
    const page = this.page(id, "processes", value.items.map(object).filter((row) => typeof row.executionId === "string").map((row) => ({ id: publicId(String(row.executionId)), row })), request);
    for (const entry of page.items) {
      if (signal?.aborted) throw new HistoryReadError("busy");
      const row = entry.row;
      const output = await this.observers.query(id, "session.process.output", { executionId: row.executionId, cursor: { sequence: 0, byteOffset: 0 }, maxBytes: 512 });
      const page = object(output?.value), display = object(row.commandDisplay);
      const text = typeof page.text === "string" ? safeText(page.text, 512) : "";
      items.push({ id: entry.id, label: safeText(display.label ?? "进程", 256), state: safeText(row.state, 128), outputPreview: text, truncated: page.truncated === true || page.nextCursor != null || Number(row.outputSize) > 512 });
    }
    return { version: 1, available: true, sessionId: id, asOfMs: Date.now(), before: page.before, after: page.after, items };
  }
  async children(id: string, request: PageRequest = {}): Promise<WebChildren> {
    const value = await this.read(id, "agent.inspect");
    if (!value) return this.unavailable(id);
    if (!Array.isArray(value.nodes) || value.nodes.length > 200) throw new HistoryReadError("unavailable");
    const items = value.nodes.map(object).filter((row) => row.role !== "root").map((row) => ({ id: publicId(String(row.agentId)), sessionId: null,
      state: safeText(row.state, 128), summary: safeText({ usage: row.usage, reason: row.reasonCode, reportBytes: row.reportBytes }, 512) }));
    const page = this.page(id, "children", items, request);
    return { version: 1, available: true, sessionId: id, asOfMs: Date.now(), ...page };
  }
  async plan(id: string): Promise<WebPlan> {
    const value = await this.read(id, "plan.inspect");
    if (!value) return this.unavailable(id);
    const state = object(value.state), approval = object(state.approval);
    return { version: 1, available: true, sessionId: id, asOfMs: Date.now(), truncated: false,
      summary: safeText({ status: state.status, revision: state.revision, completeness: state.completeness, updatedAt: state.updatedAt,
        approval: approval.status ?? null, hasPlan: state.plan != null }, 2048) };
  }
}
