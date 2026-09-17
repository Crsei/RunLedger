// Adapted from collab-web GuestClient stable snapshot/subscribe model; see THIRD_PARTY_NOTICES.md.
import type { WebSnapshot, WebTimelineRow, WebTimelinePage, WebEvent } from "../contracts/index.ts";
import { ApiError, query, errorText } from "./api.ts";

export interface SessionView {
  readonly snapshot: WebSnapshot | null; readonly rows: readonly WebTimelineRow[];
  readonly paused: boolean; readonly revision: number; readonly before: string | null; readonly loading: boolean; readonly error: string | null; readonly stale: boolean;
}
export class WebSessionStore {
  private readonly get: <T>(path: string, signal: AbortSignal) => Promise<T>;
  private readonly events: (id: string, cursor: string, signal: AbortSignal) => AsyncIterable<WebEvent>;
  constructor(get: <T>(path: string, signal: AbortSignal) => Promise<T>, events: (id: string, cursor: string, signal: AbortSignal) => AsyncIterable<WebEvent>) { this.get = get; this.events = events; }
  private readonly listeners = new Set<() => void>();
  private state: SessionView = { snapshot: null, rows: [], paused: false, revision: 0, before: null, loading: false, error: null, stale: false };
  private controller: AbortController | undefined;
  private id = "";
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getSnapshot = (): SessionView => this.state;
  private commit(update: Partial<SessionView>): void { this.state = { ...this.state, ...update }; for (const listener of this.listeners) listener(); }
  select(id: string): void {
    this.stop(); this.id = id; const controller = new AbortController(); this.controller = controller;
    this.commit({ snapshot: null, rows: [], paused: false, revision: 0, before: null, loading: true, error: null, stale: false });
    void this.reload(controller);
  }
  private async reload(controller: AbortController): Promise<void> {
    let cursor: string | undefined, retryMs = 1000;
    while (!controller.signal.aborted) {
      try {
        if (!cursor) {
          const snapshot = await this.get<WebSnapshot>(`/api/v1/sessions/${this.id}/snapshot`, controller.signal);
          if (controller.signal.aborted) return;
          this.commit({ snapshot, rows: snapshot.timeline.items, before: snapshot.timeline.before, loading: false, error: null, stale: false });
          cursor = snapshot.resumeCursor;
        }
        for await (const event of this.events(this.id, cursor, controller.signal)) {
          if (controller.signal.aborted) return;
          retryMs = 1000;
          if (event.kind === "resync_required") throw new ApiError("resync_required");
          if (event.kind === "connection") {
            this.commit({ snapshot: this.state.snapshot ? { ...this.state.snapshot, connection: event.connection } : null, stale: event.connection.freshness === "stale" });
          } else if (event.kind === "invalidate") {
            this.commit({ revision: this.state.revision + 1 });
          } else if (event.kind === "durable") {
            let next: string | null = cursor;
            do {
              const page: WebTimelinePage = await this.get<WebTimelinePage>(`/api/v1/sessions/${this.id}/timeline${query({ cursor: next, direction: "newer" })}`, controller.signal);
              if (controller.signal.aborted) return;
              const map = new Map(this.state.rows.map((row) => [row.id, row]));
              for (const row of page.items) if (!this.state.paused || map.has(row.id)) map.set(row.id, row);
              const rows = [...map.values()].sort((a, b) => a.sequence - b.sequence || Number(a.id.split(":").at(-1)) - Number(b.id.split(":").at(-1)));
              if (rows.length > 2000) {
                const snapshot = await this.get<WebSnapshot>(`/api/v1/sessions/${this.id}/snapshot`, controller.signal);
                if (controller.signal.aborted) return;
                if (!this.state.paused) this.commit({ snapshot, rows: snapshot.timeline.items, before: snapshot.timeline.before });
              } else this.commit({ rows });
              this.commit({ stale: false, error: null, revision: this.state.revision + 1 });
              next = page.after;
              // 中途断线可从已消费的分页边界恢复；失效通知的高水位不能提前确认。
              if (next) cursor = next;
            } while (next);
            cursor = event.resumeCursor;
          }
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.code === "resync_required") cursor = undefined;
        this.commit({ loading: false, error: errorText(error), stale: true });
        if (error instanceof ApiError && error.code === "unauthenticated") return;
        await new Promise<void>((resolve) => {
          const finish = () => { clearTimeout(timer); controller.signal.removeEventListener("abort", finish); resolve(); };
          const timer = setTimeout(finish, retryMs); controller.signal.addEventListener("abort", finish, { once: true });
        });
        retryMs = Math.min(16000, retryMs * 2);
      }
    }
  }
  async older(): Promise<void> {
    const controller = this.controller, cursor = this.state.before;
    if (!controller || !cursor || this.state.loading) return;
    this.commit({ loading: true, paused: true });
    try {
      const page = await this.get<WebTimelinePage>(`/api/v1/sessions/${this.id}/timeline${query({ cursor })}`, controller.signal);
      if (!controller.signal.aborted) {
        const map = new Map([...page.items, ...this.state.rows].map((row) => [row.id, row]));
        this.commit({ rows: [...map.values()].slice(0, 2000), before: page.before, loading: false });
      }
    } catch (error) { if (!controller.signal.aborted) this.commit({ error: errorText(error), loading: false }); }
  }
  pause(): void { if (!this.state.paused) this.commit({ paused: true }); }
  latest(): void { if (this.id) this.select(this.id); }
  stop(): void { this.controller?.abort(); }
}
