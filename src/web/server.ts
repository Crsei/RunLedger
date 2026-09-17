import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Value } from "typebox/value";
import type { TSchema } from "typebox";
import {
  WEB_BOUNDS, WEB_ERROR_STATUS, WebPageRequestSchema, WebSessionsRequestSchema, WebTrajectoryRequestSchema,
  WebProjectsPageSchema, WebSessionsPageSchema, WebSnapshotSchema, WebTimelinePageSchema,
  WebTrajectoryPageSchema, WebDetailRequestSchema, WebTrajectoryDetailSchema, type WebEvent, WebProcessesSchema, WebChildrenSchema, WebPlanSchema, WebUsageRequestSchema, WebUsageSchema,
} from "@runledger/collab-web/contracts";
import type { RunledgerLayout } from "../runtime/contracts/storage-layout.ts";
import { SessionStoreError } from "../storage/session-store/session-store-error.ts";
import { SessionStoreDatabaseError } from "../storage/session-store/database.ts";
import { HistoryReadError } from "../storage/session-store/history-reader.ts";
import { WebUsageReader } from "./usage.ts";
import { WebCapabilities } from "./capabilities.ts";
import { WebAuth } from "./auth.ts";
import { WebHistory } from "./history.ts";
import { WebCursorError } from "./cursor.ts";
import { WebObservers } from "./observer.ts";
import { LiveWebTrajectory } from "./live-trajectory.ts";
import { OfflineWebTrajectory } from "./offline-trajectory.ts";

type ErrorCode = keyof typeof WEB_ERROR_STATUS;
export interface WebServerOptions { readonly layout: RunledgerLayout; readonly port?: number; readonly assetsDirectory?: string }
export interface WebServerHandle { readonly origin: string; readonly loginUrl: string; close(): Promise<void> }
function headers(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
}
function fail(response: ServerResponse, code: ErrorCode): void {
  if (response.headersSent) { response.destroy(); return; }
  response.writeHead(WEB_ERROR_STATUS[code], { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ version: 1, ok: false, code }));
}
function json(response: ServerResponse, value: unknown, schema?: TSchema, maxBytes: number = WEB_BOUNDS.pageBytes): void {
  if (schema && !Value.Check(schema, value)) { fail(response, "corrupt"); return; }
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > maxBytes) { fail(response, "response_too_large"); return; }
  response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }); response.end(encoded);
}
export function webQuery(url: URL, schema: TSchema): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of url.searchParams) {
    if (Object.hasOwn(result, key)) throw new HistoryReadError("invalid_request");
    if (["pageSize", "timeFrom", "timeTo"].includes(key)) {
      if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new HistoryReadError("invalid_request");
      result[key] = Number(value);
    } else result[key] = value;
  }
  if (!Value.Check(schema, result)) throw new HistoryReadError("invalid_request");
  return result;
}
function noQuery(url: URL): void { if (url.search) throw new HistoryReadError("invalid_request"); }
async function body(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"]?.split(";")[0].trim() !== "application/json") throw new HistoryReadError("invalid_request");
  let raw = "", size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > 4096) throw new HistoryReadError("invalid_request");
    raw += String(chunk);
  }
  try { return JSON.parse(raw); } catch { throw new HistoryReadError("invalid_request"); }
}
/** loopback 只读白名单；不提供任意 domain、command 或文件代理。 */
export async function startWebServer(options: WebServerOptions): Promise<WebServerHandle> {
  const auth = new WebAuth(), history = new WebHistory(options.layout.database), trajectory = new OfflineWebTrajectory(options.layout, history);
  const observers = new WebObservers(history), liveTrajectory = new LiveWebTrajectory(history, observers);
  const usage = new WebUsageReader(history, options.layout);
  const capabilities = new WebCapabilities(history, observers);
  const assets = options.assetsDirectory ?? fileURLToPath(new URL("./assets/", import.meta.url));
  const assetsCache = new Map<string, Buffer>();
  const controllers = new Set<AbortController>();
  let origin = "", closed = false;
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 10000, headersTimeout: 10000 }, (request, response) => {
    headers(response);
    const abort = new AbortController(); controllers.add(abort);
    response.once("close", () => { abort.abort(); controllers.delete(abort); });
    void handle(request, response, abort.signal).catch((error: unknown) => {
      const code: ErrorCode = error instanceof HistoryReadError ? error.code : error instanceof WebCursorError ? "resync_required"
        : error instanceof SessionStoreError ? error.code === "sequence_conflict" ? "corrupt" : "invalid_request"
        : error instanceof SessionStoreDatabaseError ? error.code === "busy" ? "busy" : "corrupt" : "internal_error";
      fail(response, code);
    });
  });
  server.maxConnections = 64;
  async function handle(request: IncomingMessage, response: ServerResponse, signal: AbortSignal): Promise<void> {
    if (closed || !auth.sameOrigin(request, origin)) { fail(response, "forbidden"); return; }
    if (!request.url || request.url.length > 4096 || !request.url.startsWith("/") || request.url.startsWith("//")) { fail(response, "invalid_request"); return; }
    const url = new URL(request.url, origin);
    if (url.pathname === "/auth/exchange") {
      noQuery(url);
      if (request.method !== "POST") { response.writeHead(405, { Allow: "POST" }); response.end(); return; }
      const input = await body(request);
      if (!auth.exchange(request, response, origin, input)) { fail(response, "unauthenticated"); return; }
      json(response, { ok: true }); return;
    }
    if (request.method !== "GET") { response.writeHead(405, { Allow: "GET" }); response.end(); return; }
    if (url.pathname.startsWith("/api/")) {
      if (!auth.authenticated(request)) { fail(response, "unauthenticated"); return; }
      if (url.pathname === "/api/v1/projects") { json(response, history.projects(webQuery(url, WebPageRequestSchema)), WebProjectsPageSchema); return; }
      const projectUsage = /^\/api\/v1\/projects\/([A-Za-z0-9_.:~-]+)\/usage$/.exec(url.pathname);
      if (projectUsage) {
        const query = webQuery(url, WebUsageRequestSchema) as { timeFrom: number; timeTo: number };
        json(response, await usage.read(projectUsage[1], query, signal), WebUsageSchema); return;
      }
      const project = /^\/api\/v1\/projects\/([A-Za-z0-9_.:~-]+)\/sessions$/.exec(url.pathname);
      if (project) { json(response, history.sessions(project[1], webQuery(url, WebSessionsRequestSchema)), WebSessionsPageSchema); return; }
      const events = /^\/api\/v1\/sessions\/([A-Za-z0-9_.:~-]+)\/events$/.exec(url.pathname);
      if (events) {
        if (url.searchParams.size !== 1 || !url.searchParams.has("cursor")) throw new HistoryReadError("invalid_request");
        const cursor = url.searchParams.get("cursor")!;
        if (request.headers["last-event-id"] !== undefined && request.headers["last-event-id"] !== cursor) throw new WebCursorError();
        let ready = false;
        const pending: WebEvent[] = [];
        const send = (event: WebEvent): void => {
          if (signal.aborted) return;
          if (!ready) { if (pending.length >= WEB_BOUNDS.pendingEvents) { response.destroy(); return; } pending.push(event); return; }
          const encoded = `data: ${JSON.stringify(event)}\n\n`;
          if (Buffer.byteLength(encoded) > WEB_BOUNDS.eventBytes || response.writableLength + Buffer.byteLength(encoded) > WEB_BOUNDS.pageBytes || !response.write(encoded)) response.destroy();
        };
        const unsubscribe = await observers.subscribe(events[1], cursor, send);
        if (signal.aborted) { unsubscribe(); return; }
        response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive", "X-Accel-Buffering": "no" });
        response.flushHeaders(); ready = true;
        for (const event of pending) send(event);
        pending.length = 0;
        if (signal.aborted || response.destroyed) { unsubscribe(); return; }
        const heartbeat = setInterval(() => { if (!response.write(": heartbeat\n\n")) response.destroy(); }, 15000);
        signal.addEventListener("abort", () => { clearInterval(heartbeat); unsubscribe(); }, { once: true });
        return;
      }
      const session = /^\/api\/v1\/sessions\/([A-Za-z0-9_.:~-]+)\/(snapshot|timeline|trajectory|processes|children|plan)$/.exec(url.pathname);
      if (session) {
        const id = session[1];
        switch (session[2]) {
          case "snapshot": noQuery(url); await observers.ensure(id); json(response, history.snapshot(id), WebSnapshotSchema); return;
          case "timeline": json(response, history.timeline(id, webQuery(url, WebPageRequestSchema)), WebTimelinePageSchema); return;
          case "trajectory": {
            const query = webQuery(url, WebTrajectoryRequestSchema);
            await observers.ensure(id);
            const page = history.source(id).generation === null ? await trajectory.page(id, query, signal) : await liveTrajectory.page(id, query);
            if (page === undefined) { fail(response, "unavailable"); return; }
            json(response, page, WebTrajectoryPageSchema); return;
          }
          case "processes": json(response, await capabilities.processes(id, webQuery(url, WebPageRequestSchema), signal), WebProcessesSchema); return;
          case "children": json(response, await capabilities.children(id, webQuery(url, WebPageRequestSchema)), WebChildrenSchema); return;
          case "plan": noQuery(url); json(response, await capabilities.plan(id), WebPlanSchema); return;
        }
      }
      const detail = /^\/api\/v1\/sessions\/([A-Za-z0-9_.:~-]+)\/trajectory\/([A-Za-z0-9_.:~-]+)\/detail$/.exec(url.pathname);
      if (detail) {
        const query = webQuery(url, WebDetailRequestSchema);
        await observers.ensure(detail[1]);
        const value = history.source(detail[1]).generation !== null && !detail[2].startsWith("ledger:")
          ? await liveTrajectory.detail(detail[1], detail[2], query.field as "input" | "output", query.cursor as string | undefined)
          : await trajectory.detail(detail[1], detail[2], query.field as "input" | "output", query.cursor as string | undefined, signal);
        if (value === undefined) { fail(response, "unavailable"); return; }
        json(response, value, WebTrajectoryDetailSchema, WEB_BOUNDS.detailBytes); return;
      }
      fail(response, "not_found"); return;
    }
    noQuery(url);
    const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    if (!["index.html", "app.js", "app.css", "event-worker.js"].includes(name)) { fail(response, "not_found"); return; }
    let data = assetsCache.get(name);
    if (!data) {
      try { data = await readFile(join(assets, name)); } catch { fail(response, "unavailable"); return; }
      assetsCache.set(name, data);
    }
    response.setHeader("Content-Type", name.endsWith(".js") ? "text/javascript; charset=utf-8" : name.endsWith(".css") ? "text/css; charset=utf-8" : "text/html; charset=utf-8");
    response.end(data);
  }
  try {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port ?? 0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); }); });
  } catch (error) { auth.close(); await observers.close(); await trajectory.close(); await usage.close(); throw error; }
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("web listen failed");
  origin = `http://127.0.0.1:${address.port}`;
  return { origin, loginUrl: auth.loginUrl(origin), close: async () => {
    if (closed) return; closed = true; auth.close();
    for (const controller of controllers) controller.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await observers.close(); await trajectory.close(); await usage.close();
  } };
}
