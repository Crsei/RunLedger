import { describe, expect, it, vi } from "vitest";
import type { WebEvent, WebSnapshot, WebTimelinePage, WebTimelineRow } from "../src/contracts/index.ts";
import { WebSessionStore } from "../src/lib/session-store.ts";

const requests = { get: vi.fn(), emit: undefined as ((event: WebEvent) => void) | undefined };
async function* events(_id: string, _cursor: string, signal: AbortSignal): AsyncGenerator<WebEvent> {
  while (!signal.aborted) {
    const event = await new Promise<WebEvent | undefined>((resolve) => {
      requests.emit = resolve; signal.addEventListener("abort", () => resolve(undefined), { once: true });
    });
    if (event) yield event;
  }
}
const watermark = { sessionId: "s", sequence: 5000, ownerGeneration: 1, source: "owner" as const, epoch: "e" };
const rows = (start: number, count: number): WebTimelineRow[] => Array.from({ length: count }, (_, offset) => ({ id: `row:${start + offset}:0`, sequence: start + offset, createdAtMs: 1, kind: "assistant", text: String(start + offset), truncated: false }));
function page(items: WebTimelineRow[], before = "older_initial", after: string | null = null): WebTimelinePage { return { version: 1, asOfMs: 1, watermark, items, before, after }; }
function snapshot(start: number, before: string): WebSnapshot { return { version: 1, session: { id: "s", projectId: "p", repositoryId: null, title: null, status: "active", createdAtMs: 1, updatedAtMs: 1, headSequence: 5000 }, connection: { state: "connected", freshness: "current", checkedAtMs: 1 }, timeline: page(rows(start, 50), before), resumeCursor: "resume" }; }

describe("browser bounded history window", () => {
  it("refreshes the backward cursor when a following window exceeds retention", async () => {
    let snapshots = 0, pages = 0;
    requests.get.mockImplementation(async (url: string) => url.endsWith("snapshot")
      ? ++snapshots === 1 ? snapshot(1, "older_initial") : snapshot(3000, "older_current")
      : page(rows(51 + pages++ * 200, 200), "older_unused", pages < 11 ? `next_${pages}` : null));
    const store = new WebSessionStore(requests.get, events);
    try {
      store.select("s"); await vi.waitFor(() => expect(store.getSnapshot().loading).toBe(false));
      requests.emit!({ version: 1, kind: "durable", watermark, resumeCursor: "tail" });
      await vi.waitFor(() => expect(pages).toBe(11));
      expect(store.getSnapshot().before).toBe("older_current");
      expect(store.getSnapshot().rows.length).toBeLessThanOrEqual(2000);
    } finally { store.stop(); requests.get.mockReset(); }
  });
  it("preserves a reader's older window during live appends and explicitly returns to latest", async () => {
    let snapshots = 0;
    requests.get.mockImplementation(async (url: string) => url.endsWith("snapshot")
      ? ++snapshots === 1 ? snapshot(500, "older_initial") : snapshot(900, "older_latest")
      : url.includes("direction=newer") ? page(rows(800, 100)) : page(rows(300, 200), "older_300"));
    const store = new WebSessionStore(requests.get, events);
    try {
      store.select("s"); await vi.waitFor(() => expect(store.getSnapshot().loading).toBe(false));
      await store.older(); const previous = store.getSnapshot().rows;
      requests.emit!({ version: 1, kind: "durable", watermark, resumeCursor: "tail" });
      await vi.waitFor(() => expect(store.getSnapshot().revision).toBeGreaterThan(0));
      expect(store.getSnapshot().rows).toEqual(previous); expect(store.getSnapshot().paused).toBe(true);
      store.latest(); await vi.waitFor(() => expect(store.getSnapshot().before).toBe("older_latest"));
      expect(store.getSnapshot().paused).toBe(false); expect(store.getSnapshot().rows[0].sequence).toBe(900);
    } finally { store.stop(); requests.get.mockReset(); }
  });
});
