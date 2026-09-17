import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { openSessionDatabase } from "../../../src/storage/session-store/database.ts";
import { installSessionStoreSchema } from "../../../src/storage/session-store/schema.ts";
import { SessionStore } from "../../../src/storage/session-store/session-store.ts";
import { OwnerStore } from "../../../src/storage/session-store/owner-store.ts";
import { SessionHistoryReader } from "../../../src/storage/session-store/history-reader.ts";
import { readEventRange } from "../../../src/storage/session-store/event-range.ts";
import { standardHarnessProfileRef } from "../../../src/runtime/harness-profiles/index.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { WebHistory } from "../../../src/web/history.ts";
import { WebSnapshotSchema, WebTimelinePageSchema } from "@runledger/collab-web/contracts";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function fixture(suffix = "one") {
  const root = mkdtempSync(join(tmpdir(), "web-history-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "state.db"), db = openSessionDatabase(path);
  cleanups.push(() => db.close());
  installSessionStoreSchema(db);
  const store = new SessionStore(db), sessionId = createRuntimeId("session", suffix);
  const create = (id: string, workspace = "worktree-one") => store.createSession({ sessionId: createRuntimeId("session", id), workspaceId: createRuntimeId("workspace", workspace), repositoryId: createRuntimeId("repository", "same-repo"), settingsDigest: "a".repeat(64), harnessProfile: standardHarnessProfileRef() });
  create(suffix);
  const owner = new OwnerStore(db).tryClaim({ mode: "fresh", sessionId }, { runtimeId: createRuntimeId("runtime", suffix), endpoint: { host: "127.0.0.1", port: 12345 }, authTokenHex: "a".repeat(64), ownerStartedAtMs: Date.now() });
  if (!owner.ok || owner.outcome !== "claimed") throw new Error("fixture claim failed");
  let count = 0;
  const append = (message: Record<string, unknown>, eventType = "ledger.message") => store.appendEvent(owner.fence, {
    eventId: createRuntimeId("event", `web-${suffix}-${++count}`), ownerGeneration: 1, eventType,
    payloadJson: JSON.stringify({ payload: { message } }), createdAtMs: count,
    expectedPreviousEventHash: store.latestEventHead(sessionId).hash,
  });
  return { root, path, db, store, sessionId, create, append, web: new WebHistory(path) };
}

describe("read-only Web history", () => {
  it("does not create a missing authority or migrate a noncurrent schema", () => {
    const f = fixture();
    const missing = join(f.root, "missing.db");
    expect(() => new SessionHistoryReader(missing)).toThrow("database_missing");
    expect(existsSync(missing)).toBe(false);
    f.db.runSync("UPDATE schema_meta SET schema_version=100");
    expect(() => f.web.projects()).toThrow("schema_incompatible");
  });
  it("opens DELETE journal read-only without switching WAL or changing authority bytes", () => {
    const f = fixture();
    f.db.execSync("PRAGMA journal_mode=DELETE");
    const digest = () => createHash("sha256").update(readFileSync(f.path)).digest("hex");
    const before = digest();
    const db = openSessionDatabase(f.path, { readOnly: true });
    try {
      expect(db.querySingle("PRAGMA journal_mode")?.journal_mode).toBe("delete");
      expect(() => db.runSync("DELETE FROM sessions")).toThrow();
    } finally { db.close(); }
    const owner = f.db.querySingle("SELECT * FROM session_owners");
    f.web.snapshot(f.sessionId);
    expect(digest()).toBe(before);
    expect(f.db.querySingle("SELECT * FROM session_owners")).toEqual(owner);
  });
  it("rejects migrations on every short read and detects event corruption", () => {
    const f = fixture();
    f.append({ role: "user", content: [{ type: "text", text: "hello" }] });
    f.db.runSync("UPDATE store_control SET admission='migration_blocked'");
    expect(() => f.web.snapshot(f.sessionId)).toThrow("migration_in_progress");
    f.db.runSync("UPDATE store_control SET admission='ready'");
    f.db.runSync("UPDATE session_events SET payload_json='{}' WHERE event_type='ledger.message'");
    expect(() => f.web.snapshot(f.sessionId)).toThrow("event integrity failed");
  });
  it("groups worktrees independently and binds catalog cursors to filters/revision", () => {
    const f = fixture();
    f.create("two"); f.create("three", "worktree-two");
    const projects = f.web.projects();
    expect(projects.items.map((p) => p.sessionCount).sort()).toEqual([1, 2]);
    const project = projects.items.find((p) => p.sessionCount === 2)!;
    const first = f.web.sessions(project.id, { pageSize: 1 });
    const next = f.web.sessions(project.id, { pageSize: 1, cursor: first.before! });
    expect(first.items[0].id).not.toBe(next.items[0].id);
    expect(() => f.web.sessions(project.id, { cursor: first.before!, status: "failed" })).toThrow("resync_required");
    f.create("four");
    expect(() => f.web.sessions(project.id, { cursor: first.before! })).toThrow("resync_required");
  });
  it("pages within multi-row events without gaps or duplicate rows and catches snapshot races", () => {
    const f = fixture();
    f.append({ role: "user", content: [{ type: "text", text: "start" }] });
    f.append({ role: "assistant", content: [{ type: "text", text: "tools" }, ...Array.from({ length: 270 }, (_, i) => ({ type: "toolCall", id: `c${i}`, name: "unknown-tool", arguments: { i } }))] });
    const snapshot = f.web.snapshot(f.sessionId);
    expect(Value.Check(WebSnapshotSchema, snapshot)).toBe(true);
    let page = snapshot.timeline;
    const ids = page.items.map((r) => r.id);
    while (page.before !== null) {
      page = f.web.timeline(f.sessionId, { cursor: page.before });
      expect(Value.Check(WebTimelinePageSchema, page)).toBe(true);
      ids.push(...page.items.map((r) => r.id));
    }
    expect(ids.length).toBe(272);
    expect(new Set(ids).size).toBe(272);
    f.append({ role: "assistant", content: [{ type: "text", text: "after snapshot" }] });
    const incremental = f.web.timeline(f.sessionId, { cursor: snapshot.resumeCursor, direction: "newer" });
    expect(incremental.items.map((r) => r.text)).toEqual(["after snapshot"]);
    const other = fixture("other");
    expect(() => other.web.timeline(other.sessionId, { cursor: snapshot.resumeCursor })).toThrow("resync_required");
    f.web.setSource(f.sessionId, 2);
    expect(() => f.web.timeline(f.sessionId, { cursor: snapshot.resumeCursor })).toThrow("resync_required");
  });
  it("advances bounded empty scan windows and caps encoded page bytes", () => {
    const f = fixture();
    f.append({ role: "user", content: [{ type: "text", text: "old" }] });
    for (let i = 0; i < 1200; i++) f.append({}, "agent.event");
    for (let i = 0; i < 10; i++) f.append({ role: "user", content: [{ type: "text", text: "中".repeat(14000) }] });
    let page = f.web.snapshot(f.sessionId).timeline;
    const ids: string[] = [];
    let count = 0;
    for (;;) {
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(192 * 1024);
      ids.push(...page.items.map((r) => r.id));
      if (!page.before) break;
      page = f.web.timeline(f.sessionId, { cursor: page.before });
      expect(++count).toBeLessThan(20);
    }
    expect(ids.length).toBe(11);
    expect(new Set(ids).size).toBe(11);
    const read = f.db.withReadTransactionSync(() => readEventRange(f.db, f.sessionId, { after: 0, limit: 2 }));
    expect(read).toHaveLength(2);
  });
});
