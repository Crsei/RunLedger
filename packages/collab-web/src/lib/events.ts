import type { WebEvent } from "../contracts/index.ts";
import { ApiError, query } from "./api.ts";

/** fetch 流允许中止、背压，以及只在历史补读完成后推进消费游标。 */
export async function* httpSessionEvents(id: string, cursor: string, signal: AbortSignal): AsyncGenerator<WebEvent> {
  const response = await fetch(`/api/v1/sessions/${id}/events${query({ cursor })}`, { signal, credentials: "same-origin", cache: "no-store" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { code?: string };
    throw new ApiError(body.code ?? `http_${response.status}`);
  }
  if (!response.body) throw new ApiError("stream_unavailable");
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let pending = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) throw new ApiError("stream_disconnected");
      pending += decoder.decode(chunk.value, { stream: true });
      let boundary: number;
      while ((boundary = pending.indexOf("\n\n")) >= 0) {
        const block = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
        if (block.length > 65536) throw new ApiError("stream_overflow");
        const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (data) yield JSON.parse(data) as WebEvent;
      }
      if (pending.length > 65536) throw new ApiError("stream_overflow");
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

/** 同源标签页共享长连接，避免浏览器 HTTP/1 连接池被 SSE 占满。 */
export async function* sessionEvents(id: string, cursor: string, signal: AbortSignal): AsyncGenerator<WebEvent> {
  if (typeof SharedWorker === "undefined") { yield* httpSessionEvents(id, cursor, signal); return; }
  const worker = new SharedWorker("/event-worker.js", { name: "runledger-read-only", type: "module" });
  const port = worker.port, queue: WebEvent[] = [];
  let failure: ApiError | undefined, wake: (() => void) | undefined;
  const abort = () => { port.postMessage({ action: "unsubscribe" }); wake?.(); };
  port.onmessage = (message: MessageEvent<{ event?: WebEvent; error?: string }>) => {
    if (message.data.error) failure = new ApiError(message.data.error);
    else if (message.data.event) {
      if (queue.length >= 16) failure = new ApiError("stream_overflow"); else queue.push(message.data.event);
    }
    wake?.();
  };
  worker.onerror = () => { failure = new ApiError("stream_disconnected"); wake?.(); };
  signal.addEventListener("abort", abort, { once: true });
  const heartbeat = setInterval(() => port.postMessage({ action: "ping" }), 10000);
  port.start(); port.postMessage({ action: "subscribe", id, cursor });
  try {
    while (!signal.aborted) {
      if (failure) throw failure;
      const event = queue.shift();
      if (event) { yield event; port.postMessage({ action: "ack" }); }
      else await new Promise<void>((resolve) => { wake = resolve; });
    }
  } finally { clearInterval(heartbeat); signal.removeEventListener("abort", abort); abort(); port.close(); }
}
