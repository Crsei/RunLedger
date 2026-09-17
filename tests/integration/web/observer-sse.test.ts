import { ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { WebHistory } from "../../../src/web/history.ts";
import { WebObservers } from "../../../src/web/observer.ts";
import { startWebServer } from "../../../src/web/server.ts";
import type { WebSnapshot, WebEvent, WebTimelinePage } from "@runledger/collab-web/contracts";
import { createServerHarness } from "../../runtime/session-server/harness.ts";

async function nextEvent(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<WebEvent> {
  const decoder = new TextDecoder(); let text = "";
  while (!text.includes("\n\n")) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error("unexpected stream end");
    text += decoder.decode(chunk.value, { stream: true });
  }
  return JSON.parse(text.split("\n\n")[0].slice(6)) as WebEvent;
}

describe("Web observer real TCP and SSE", () => {
  it("attaches without claiming driver, forbids arbitrary domain reads and invalidates the old source on disconnect", async () => {
    const h = await createServerHarness(), history = new WebHistory(buildRunledgerLayout(h.dir, "posix").database), observers = new WebObservers(history);
    const fullReplay = vi.spyOn(h.store, "replaySessionEvents");
    const before = h.store.latestEventHead(h.sessionId);
    try {
      expect(history.read((reader) => reader.owner(h.sessionId)) !== undefined).toBe(true);
      await observers.ensure(h.sessionId);
      expect(history.source(h.sessionId).generation).toBe(h.fence.generation);
      expect(h.store.latestEventHead(h.sessionId)).toEqual(before);
      expect(fullReplay).not.toHaveBeenCalled();
      expect(await observers.query(h.sessionId, "session.prompt", {})).toBeUndefined();
      const cursor = history.resumeCursor(h.sessionId, before.sequence), events: WebEvent[] = [];
      const unsubscribe = await observers.subscribe(h.sessionId, cursor, (event) => events.push(event));
      await h.server.close();
      await vi.waitFor(() => expect(events.some((event) => event.kind === "resync_required")).toBe(true));
      expect(() => history.resumeSequence(h.sessionId, cursor)).toThrow();
      expect(h.store.latestEventHead(h.sessionId)).toEqual(before);
      unsubscribe();
    } finally { fullReplay.mockRestore(); await observers.close(); h.owner.release("detached"); await h.server.close(); h.cleanup(); }
  });

  it("disconnects a backpressured HTTP observer while the Owner and new observers continue", async () => {
    const h = await createServerHarness(), server = await startWebServer({ layout: buildRunledgerLayout(h.dir, "posix") });
    const original = ServerResponse.prototype.write;
    let pressured = false;
    const write = vi.spyOn(ServerResponse.prototype, "write").mockImplementation(function (this: ServerResponse, chunk: unknown, ...args: unknown[]): boolean {
      const result = Reflect.apply(original, this, [chunk, ...args]) as boolean;
      if (!pressured && this.getHeader("content-type") === "text/event-stream" && String(chunk).startsWith("data:")) { pressured = true; return false; }
      return result;
    });
    const controller = new AbortController();
    try {
      const auth = await fetch(`${server.origin}/auth/exchange`, { method: "POST", headers: { Origin: server.origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: new URL(server.loginUrl).hash.slice(1) }) });
      const headers = { Cookie: auth.headers.get("set-cookie")!.split(";")[0] }, path = `${server.origin}/api/v1/sessions/${h.sessionId}`;
      const snapshot = await (await fetch(`${path}/snapshot`, { headers })).json() as WebSnapshot;
      const stream = await fetch(`${path}/events?cursor=${snapshot.resumeCursor}`, { headers, signal: controller.signal });
      const reading = (async () => { const reader = stream.body!.getReader(); try { while (!(await reader.read()).done) { /* 持续读直到背压注入导致连接关闭。 */ } } catch { return "disconnected"; } return "ended"; })();
      h.store.appendEvent(h.fence, { eventId: createRuntimeId("event", "backpressure"), ownerGeneration: h.fence.generation, eventType: "ledger.message", payloadJson: JSON.stringify({ payload: { message: { role: "assistant", content: [{ type: "text", text: "after-backpressure" }] } } }), createdAtMs: Date.now(), expectedPreviousEventHash: h.store.latestEventHead(h.sessionId).hash });
      await vi.waitFor(() => expect(pressured).toBe(true));
      expect(await reading).toBe("disconnected"); write.mockRestore();
      const newer = await (await fetch(`${path}/snapshot`, { headers })).json() as WebSnapshot;
      expect(newer.connection.state).toBe("connected"); expect(newer.timeline.items.at(-1)?.text).toBe("after-backpressure");
      expect(h.store.replaySessionEvents(h.sessionId).some((event) => event.eventType === "driver.claimed")).toBe(false);
    } finally { write.mockRestore(); controller.abort(); await server.close(); h.owner.release("detached"); await h.server.close(); h.cleanup(); }
  });

  it("replays the snapshot/subscribe race to ten observers and reconnects from the consumed cursor", async () => {
    const h = await createServerHarness(), server = await startWebServer({ layout: buildRunledgerLayout(h.dir, "posix") });
    const controllers: AbortController[] = [];
    try {
      const auth = await fetch(`${server.origin}/auth/exchange`, { method: "POST", headers: { Origin: server.origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: new URL(server.loginUrl).hash.slice(1) }) });
      const headers = { Cookie: auth.headers.get("set-cookie")!.split(";")[0] };
      const path = `${server.origin}/api/v1/sessions/${h.sessionId}`;
      const snapshot = await (await fetch(`${path}/snapshot`, { headers })).json() as WebSnapshot;
      expect(snapshot.connection.state).toBe("connected");
      const append = (text: string) => h.store.appendEvent(h.fence, { eventId: createRuntimeId("event", text), ownerGeneration: h.fence.generation, eventType: "ledger.message", payloadJson: JSON.stringify({ payload: { message: { role: "assistant", content: [{ type: "text", text }] } } }), createdAtMs: Date.now(), expectedPreviousEventHash: h.store.latestEventHead(h.sessionId).hash });
      append("race");
      const events = await Promise.all(Array.from({ length: 10 }, async () => {
        const controller = new AbortController(); controllers.push(controller);
        const stream = await fetch(`${path}/events?cursor=${snapshot.resumeCursor}`, { headers, signal: controller.signal });
        expect(stream.status).toBe(200);
        const reader = stream.body!.getReader();
        const event = await nextEvent(reader); controller.abort();
        return event;
      }));
      expect(events.every((event) => event.kind === "durable")).toBe(true);
      const first = events[0]; if (first.kind !== "durable") throw new Error("durable required");
      const page = await (await fetch(`${path}/timeline?direction=newer&cursor=${snapshot.resumeCursor}`, { headers })).json() as WebTimelinePage;
      expect(page.items.map((row) => row.text)).toEqual(["race"]);
      append("reconnect");
      const controller = new AbortController(); controllers.push(controller);
      const stream = await fetch(`${path}/events?cursor=${first.resumeCursor}`, { headers, signal: controller.signal });
      const resumed = await nextEvent(stream.body!.getReader()); controller.abort();
      expect(resumed.kind).toBe("durable");
      const newer = await (await fetch(`${path}/timeline?direction=newer&cursor=${first.resumeCursor}`, { headers })).json() as WebTimelinePage;
      expect(newer.items.map((row) => row.text)).toEqual(["reconnect"]);
      expect(h.store.replaySessionEvents(h.sessionId).some((event) => event.eventType === "driver.claimed")).toBe(false);
    } finally { controllers.forEach((controller) => controller.abort()); await server.close(); h.owner.release("detached"); await h.server.close(); h.cleanup(); }
  });
});
