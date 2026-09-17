import { HistoryReadError } from "../storage/session-store/history-reader.ts";
import { WebCursorError } from "./cursor.ts";
import { randomBytes } from "node:crypto";
import { SessionClientTransport } from "../runtime/session-server/client-transport.ts";
import { SESSION_PROTOCOL_VERSION, isSessionHandshakeResponse, type SessionFrameEnvelope } from "../runtime/session-server/protocol.ts";
import { object } from "../runtime/trajectory/projection.ts";
import type { WebEvent } from "@runledger/collab-web/contracts";
import type { WebHistory } from "./history.ts";

const READ_OPERATIONS = new Set(["trajectory.page", "trajectory.search", "trajectory.detail", "trajectory.status", "session.process.list", "session.process.output", "agent.inspect", "plan.inspect"]);
function frame(kind: SessionFrameEnvelope["kind"], body: Record<string, unknown>): SessionFrameEnvelope {
  return { frameId: `web_${randomBytes(12).toString("hex")}`, kind, body, protocolVersion: SESSION_PROTOCOL_VERSION };
}
interface ObservedSession {
  readonly id: string; readonly listeners: Set<(event: WebEvent) => void>;
  transport?: SessionClientTransport; generation: number | null; runtimeId: string | null;
  operations: Set<string>; head: number; lastAccess: number; lastConnect: number; connecting?: Promise<void>;
}
export class WebObservers {
  private readonly history: WebHistory;
  private readonly sessions = new Map<string, ObservedSession>();
  private readonly timer: ReturnType<typeof setInterval>;
  private polling = false;
  private stopped = false;
  constructor(history: WebHistory) {
    this.history = history;
    this.timer = setInterval(() => { void this.poll(); }, 200); this.timer.unref();
  }
  private notify(session: ObservedSession, event: WebEvent): void {
    for (const listener of session.listeners) { try { listener(event); } catch { session.listeners.delete(listener); } }
  }
  private durable(session: ObservedSession, head: number): void {
    if (head <= session.head) return;
    session.head = head;
    this.notify(session, { version: 1, kind: "durable", watermark: this.history.watermark(session.id, head), resumeCursor: this.history.resumeCursor(session.id, head) });
  }
  private disconnected(session: ObservedSession): void {
    const wasConnected = session.generation !== null;
    const transport = session.transport; session.transport = undefined; transport?.destroy();
    session.generation = null; session.runtimeId = null; session.operations.clear();
    this.history.setSource(session.id, null);
    if (wasConnected) this.notify(session, { version: 1, kind: "resync_required", sessionId: session.id });
    this.notify(session, { version: 1, kind: "connection", sessionId: session.id, connection: { state: "offline", freshness: "stale", checkedAtMs: Date.now() } });
  }
  private async request(transport: SessionClientTransport, request: SessionFrameEnvelope): Promise<SessionFrameEnvelope> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([transport.request(request), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { transport.destroy(); reject(new Error("observer_timeout")); }, 2000);
      })]);
    } finally { clearTimeout(timer); }
  }
  private async connect(session: ObservedSession): Promise<void> {
    session.lastConnect = Date.now();
    const owner = this.history.read((reader) => reader.owner(session.id));
    if (!owner || this.stopped) return;
    let transport: SessionClientTransport | undefined;
    try {
      transport = await SessionClientTransport.connect(owner.port, { connectTimeoutMs: 300 });
      if (this.stopped || !this.sessions.has(session.id)) { transport.destroy(); return; }
      const handshake = await this.request(transport, frame("initialize_request", {
        protocolVersion: SESSION_PROTOCOL_VERSION, sessionId: session.id,
        expectedRuntimeId: owner.runtimeId, expectedGeneration: owner.generation, authToken: owner.authToken,
        clientId: `client_web_${randomBytes(12).toString("hex")}`, clientCapabilities: ["session.core"],
      }));
      const { requestFrameId: _requestFrameId, ...accepted } = handshake.body;
      if (!isSessionHandshakeResponse(accepted) || !accepted.accepted
        || accepted.runtimeId !== owner.runtimeId || accepted.generation !== owner.generation) throw new Error("observer_rejected");
      if (this.stopped || this.sessions.get(session.id) !== session) { transport.destroy(); return; }
      session.transport = transport; session.generation = owner.generation; session.runtimeId = owner.runtimeId;
      session.operations = new Set(accepted.operationManifest.filter((item) => item.access === "read").map((item) => item.operation));
      const previous = this.history.source(session.id).generation;
      this.history.setSource(session.id, owner.generation);
      if (previous !== owner.generation && session.listeners.size) this.notify(session, { version: 1, kind: "resync_required", sessionId: session.id });
      const active = transport;
      transport.onClose(() => { if (session.transport === active) this.disconnected(session); });
      transport.onEvent((incoming) => {
        if (session.transport !== active) return;
        if (incoming.kind === "resync_required") { this.notify(session, { version: 1, kind: "resync_required", sessionId: session.id }); return; }
        if (incoming.kind !== "subscription_event") return;
        if (typeof incoming.body.sequence === "number" && Number.isSafeInteger(incoming.body.sequence)) {
          // 只接纳有界高水位失效通知；不复制事件 payload 到浏览器队列。
          this.durable(session, incoming.body.sequence);
          active.notify(frame("ack_cursor", { cursor: incoming.body.sequence }));
        } else if (incoming.body.eventType === "trajectory.changed") {
          this.notify(session, { version: 1, kind: "invalidate", sessionId: session.id, target: "trajectory" });
        }
      });
      const cursor = this.history.read((reader) => reader.session(session.id).headSequence);
      const subscription = await this.request(transport, frame("subscribe_request", { cursor }));
      if (subscription.body.ok !== true) throw new Error("observer_subscribe_failed");
      this.durable(session, cursor);
      this.notify(session, { version: 1, kind: "connection", sessionId: session.id, connection: { state: "connected", freshness: "current", checkedAtMs: Date.now() } });
    } catch { transport?.destroy(); if (session.transport === transport) this.disconnected(session); }
  }
  async ensure(id: string): Promise<ObservedSession> {
    let session = this.sessions.get(id);
    if (!session) {
      if (this.sessions.size >= 32) {
        const idle = [...this.sessions.values()].filter((item) => !item.listeners.size).sort((a, b) => a.lastAccess - b.lastAccess)[0];
        if (!idle) throw new HistoryReadError("busy");
        idle.transport?.destroy(); this.sessions.delete(idle.id);
      }
      const head = this.history.read((reader) => reader.session(id).headSequence);
      session = { id, listeners: new Set(), generation: null, runtimeId: null, operations: new Set(), head, lastAccess: Date.now(), lastConnect: 0 };
      this.sessions.set(id, session);
    }
    session.lastAccess = Date.now();
    if (!session.transport && Date.now() - session.lastConnect > 2000) {
      session.connecting ??= this.connect(session).finally(() => { session!.connecting = undefined; });
      await session.connecting;
    }
    return session;
  }
  async subscribe(id: string, cursor: string, listener: (event: WebEvent) => void): Promise<() => void> {
    const session = await this.ensure(id);
    const sequence = this.history.resumeSequence(id, cursor);
    const head = this.history.read((reader) => reader.session(id).headSequence);
    if (sequence > head) throw new WebCursorError();
    session.listeners.add(listener);
    if (head > sequence) listener({ version: 1, kind: "durable", watermark: this.history.watermark(id, head), resumeCursor: this.history.resumeCursor(id, head) });
    return () => { session.listeners.delete(listener); session.lastAccess = Date.now(); };
  }
  async query(id: string, operation: string, payload: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    if (!READ_OPERATIONS.has(operation)) return undefined;
    const session = await this.ensure(id), transport = session.transport;
    if (!transport || !session.operations.has(operation)) return undefined;
    const correlation = `web_${randomBytes(12).toString("hex")}`;
    try {
      const result = await this.request(transport, frame("query_request", { kind: "domain_query", body: {
        sessionId: id, generation: session.generation, operation, payload, correlationId: correlation, effectId: correlation,
      } }));
      return object(result.body);
    } catch { this.disconnected(session); return undefined; }
  }
  private async poll(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      for (const session of this.sessions.values()) {
        if (!session.listeners.size && Date.now() - session.lastAccess > 10000) {
          session.transport?.destroy(); this.sessions.delete(session.id); continue;
        }
        try {
          const state = this.history.read((reader) => ({ head: reader.session(session.id).headSequence, owner: reader.owner(session.id) }));
          if (session.transport && (state.owner?.generation !== session.generation || state.owner?.runtimeId !== session.runtimeId)) this.disconnected(session);
          this.durable(session, state.head);
          if (!session.transport && session.listeners.size && !session.connecting && Date.now() - session.lastConnect > 2000) {
            session.connecting = this.connect(session).catch(() => undefined).finally(() => { session.connecting = undefined; });
          }
        } catch { this.notify(session, { version: 1, kind: "connection", sessionId: session.id, connection: { state: "offline", freshness: "stale", checkedAtMs: Date.now() } }); }
      }
    } finally { this.polling = false; }
  }
  async close(): Promise<void> {
    this.stopped = true; clearInterval(this.timer);
    for (const session of this.sessions.values()) { session.listeners.clear(); session.transport?.destroy(); }
    await Promise.allSettled([...this.sessions.values()].map((session) => session.connecting));
    this.sessions.clear();
  }
}
