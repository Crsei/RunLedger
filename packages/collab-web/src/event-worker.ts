import type { WebEvent, WebSnapshot } from "./contracts/index.ts";
import { httpSessionEvents } from "./lib/events.ts";
import { ApiError, get } from "./lib/api.ts";

interface Subscriber { readonly port: MessagePort; readonly queued: Map<string, WebEvent>; pending: boolean; sentAt: number; lastSeen: number; hub?: Hub }
interface Hub { readonly id: string; readonly controller: AbortController; readonly subscribers: Set<Subscriber>; latest?: WebEvent }
const hubs = new Map<string, Hub>(), subscribers = new Set<Subscriber>();
function send(subscriber: Subscriber): void {
  if (subscriber.pending) return;
  const entry = subscriber.queued.entries().next().value;
  if (!entry) return;
  subscriber.queued.delete(entry[0]); subscriber.pending = true; subscriber.sentAt = Date.now();
  subscriber.port.postMessage({ event: entry[1] });
}
function enqueue(subscriber: Subscriber, event: WebEvent): void {
  const key = event.kind === "invalidate" ? `invalidate:${event.target}` : event.kind;
  // 单个慢标签页最多持有一个未确认事件及每种失效通知的最新值。
  subscriber.queued.set(key, event); send(subscriber);
}
function remove(subscriber: Subscriber): void {
  subscribers.delete(subscriber); subscriber.queued.clear();
  const hub = subscriber.hub;
  hub?.subscribers.delete(subscriber); subscriber.hub = undefined;
  if (hub && !hub.subscribers.size) { hub.controller.abort(); if (hubs.get(hub.id) === hub) hubs.delete(hub.id); }
}
async function follow(hub: Hub, cursor: string): Promise<void> {
  try {
    for await (const event of httpSessionEvents(hub.id, cursor, hub.controller.signal)) {
      if (event.kind === "durable") hub.latest = event;
      if (event.kind === "resync_required") hub.latest = undefined;
      for (const subscriber of hub.subscribers) enqueue(subscriber, event);
    }
  } catch (error) {
    if (!hub.controller.signal.aborted) {
      for (const subscriber of [...hub.subscribers]) {
        subscriber.port.postMessage({ error: error instanceof ApiError ? error.code : "stream_disconnected" }); remove(subscriber);
      }
    }
  }
}
const scope = globalThis as unknown as { onconnect: (event: MessageEvent) => void };
scope.onconnect = (event) => {
  const port = event.ports[0], subscriber: Subscriber = { port, queued: new Map(), pending: false, sentAt: Date.now(), lastSeen: Date.now() };
  port.onmessage = (message: MessageEvent<{ action: string; id?: string; cursor?: string }>) => {
    subscriber.lastSeen = Date.now();
    if (message.data.action === "ping") return;
    if (message.data.action === "ack") { subscriber.pending = false; send(subscriber); return; }
    if (message.data.action === "unsubscribe") { remove(subscriber); port.close(); return; }
    if (message.data.action !== "subscribe" || typeof message.data.id !== "string" || typeof message.data.cursor !== "string") return;
    remove(subscriber);
    if (subscribers.size >= 64) { port.postMessage({ error: "busy" }); return; }
    const { id, cursor } = message.data;
    let hub = hubs.get(id), created = false;
    if (!hub) {
      if (hubs.size >= 4) { port.postMessage({ error: "busy" }); return; }
      hub = { id, controller: new AbortController(), subscribers: new Set() }; hubs.set(id, hub); created = true;
    }
    subscriber.hub = hub; subscriber.pending = false; hub.subscribers.add(subscriber); subscribers.add(subscriber);
    if (hub.latest) enqueue(subscriber, hub.latest);
    const active = hub;
    // 较早的快照可以晚于其他标签页加入；补发当前高水位覆盖这段竞态。
    void get<WebSnapshot>(`/api/v1/sessions/${id}/snapshot`, hub.controller.signal).then((snapshot) => {
      if (subscriber.hub === active) enqueue(subscriber, { version: 1, kind: "durable", watermark: snapshot.timeline.watermark, resumeCursor: snapshot.resumeCursor });
    }).catch((error: unknown) => {
      if (subscriber.hub === active && !active.controller.signal.aborted) {
        subscriber.port.postMessage({ error: error instanceof ApiError ? error.code : "stream_disconnected" }); remove(subscriber);
      }
    });
    if (created) void follow(hub, cursor);
  };
  port.start();
};
setInterval(() => {
  for (const subscriber of subscribers) if (Date.now() - subscriber.lastSeen > 45000 || (subscriber.pending && Date.now() - subscriber.sentAt > 30000)) {
    subscriber.port.postMessage({ error: "stream_disconnected" }); remove(subscriber); subscriber.port.close();
  }
}, 10000);
