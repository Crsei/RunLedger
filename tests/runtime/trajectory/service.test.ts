import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { openSessionDatabase } from "../../../src/storage/session-store/database.ts";
import { installSessionStoreSchema } from "../../../src/storage/session-store/schema.ts";
import { SessionStore } from "../../../src/storage/session-store/session-store.ts";
import { OwnerStore } from "../../../src/storage/session-store/owner-store.ts";
import { standardHarnessProfileRef } from "../../../src/runtime/harness-profiles/index.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { runtimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/canonical-json.ts";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import type { TrajectoryPage, TrajectoryDetail } from "../../../src/runtime/contracts/trajectory.ts";
import { SessionDomainRouter } from "../../../src/runtime/session-runtime/domain-router.ts";
import { SessionQueryHandler, type SessionQueryPort } from "../../../src/runtime/session-runtime/query-handler.ts";
import { TrajectoryService } from "../../../src/runtime/trajectory/service.ts";
import { createLocalTraceRecorderFactory } from "../../../src/runtime/trace/composition.ts";
import type { OwnerFence } from "../../../src/runtime/session-owner/types.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(mode: "off" | "events" = "off") {
  const root = await mkdtemp(join(tmpdir(), "trajectory-test-"));
  const layout = buildRunledgerLayout(root, "posix");
  const db = openSessionDatabase(layout.database); installSessionStoreSchema(db);
  const store = new SessionStore(db);
  const sessionId = createRuntimeId("session", "trajectory");
  store.createSession({ sessionId, workspaceId: createRuntimeId("workspace", "fixture"), repositoryId: createRuntimeId("repository", "fixture"), settingsDigest: "a".repeat(64), harnessProfile: standardHarnessProfileRef() });
  const owners = new OwnerStore(db);
  const result = owners.tryClaim({ mode: "fresh", sessionId }, { runtimeId: createRuntimeId("runtime", "fixture"), endpoint: { host: "127.0.0.1", port: 49152 }, authTokenHex: "a".repeat(64), ownerStartedAtMs: Date.now() });
  if (!result.ok || result.outcome !== "claimed") throw new Error("claim failed");
  const fence: OwnerFence = result.fence;
  const config = { mode, failurePolicy: "best_effort" as const };
  const service = new TrajectoryService({ layout, store, sessionId, generation: 1, config });
  cleanups.push(async () => { await service.close(); db.close(); await rm(root, { recursive: true, force: true }); });
  let count = 0;
  let hash = store.replaySessionEvents(sessionId).at(-1)?.currentEventHash ?? null;
  function append(event: Record<string, unknown>) {
    const row = store.appendEvent(fence, { eventId: createRuntimeId("event", `trajectory-${++count}`), ownerGeneration: 1, eventType: "agent.event", payloadJson: JSON.stringify(event), createdAtMs: Number(event.timestamp), expectedPreviousEventHash: hash });
    hash = row.currentEventHash;
  }
  async function page(payload: Record<string, unknown> = {}): Promise<TrajectoryPage> {
    const result = await service.query("trajectory.page", payload);
    if (!result.ok) throw new Error(result.code);
    return result.value as unknown as TrajectoryPage;
  }
  return { root, layout, store, service, config, sessionId, append, page, fence };
}

describe("owner trajectory query", () => {
  it("projects multiple model steps in one run, preserves waits and nonzero cost", async () => {
    const f = await fixture();
    f.append({ type: "agent_start", runId: "r1", timestamp: 10 });
    f.append({ type: "turn_start", runId: "r1", turn: 1, timestamp: 11 });
    f.append({ type: "message_start", runId: "r1", role: "assistant", timestamp: 12 });
    f.append({ type: "message_end", runId: "r1", role: "assistant", timestamp: 20, message: { model: "fixture", content: [{ type: "text", text: "Inspect files" }], usage: { input: 10, output: 4, cost: { total: 0.0003 } } } });
    f.append({ type: "tool_execution_start", runId: "r1", toolCallId: "call1", toolName: "read", args: { path: "file.ts", apiKey: "secret" }, timestamp: 21 });
    f.append({ type: "tool_execution_end", runId: "r1", toolCallId: "call1", toolName: "read", result: { content: [{ type: "text", text: "result" }] }, isError: false, timestamp: 30 });
    f.append({ type: "turn_end", runId: "r1", turn: 1, timestamp: 30 });
    f.append({ type: "agent_work_pause", runId: "r1", waitId: "w", reason: "approval", timestamp: 30 });
    f.append({ type: "agent_work_resume", runId: "r1", waitId: "w", reason: "approval", timestamp: 40 });
    f.append({ type: "turn_start", runId: "r1", turn: 2, timestamp: 40 });
    f.append({ type: "agent_end", runId: "r1", timestamp: 60, elapsedMs: 50, activeDurationMs: 40, stopReason: "stop" });
    const page = await f.page();
    expect(page.records.filter((row) => row.kind === "run")).toHaveLength(1);
    expect(page.records.filter((row) => row.kind === "step")).toHaveLength(2);
    expect(page.records.find((row) => row.kind === "run")).toMatchObject({ durationMs: 50, activeDurationMs: 40 });
    expect(page.records.find((row) => row.kind === "wait")).toMatchObject({ durationMs: 10 });
    expect(page.records.find((row) => row.kind === "model")).toMatchObject({ costUsd: 0.0003 });
    expect(page.status.mode).toBe("off");
    expect(JSON.stringify(page)).not.toContain('"secret"');
    const detail = await f.service.query("trajectory.detail", { recordId: "tool/r1/call1", field: "input" });
    expect(detail.ok && detail.value.text).toContain("REDACTED");
  });
  it("pages all older history without duplicates and rejects forged/cross-owner cursors", async () => {
    const f = await fixture();
    for (let i = 0; i < 125; i++) {
      f.append({ type: "agent_start", runId: `r${i}`, timestamp: i * 10 });
      f.append({ type: "agent_end", runId: `r${i}`, timestamp: i * 10 + 5 });
    }
    let page = await f.page();
    expect(page.records).toHaveLength(50);
    const ids = page.records.map((row) => row.id);
    while (page.hasOlder) { page = await f.page({ cursor: page.before, direction: "older" }); ids.push(...page.records.map((row) => row.id)); }
    expect(ids).toHaveLength(125); expect(new Set(ids).size).toBe(125);
    expect(await f.service.query("trajectory.page", { cursor: `${page.before}x` })).toMatchObject({ ok: false, code: "invalid_trajectory_cursor" });
    const other = await fixture();
    expect(await other.service.query("trajectory.page", { cursor: page.before })).toMatchObject({ ok: false, code: "invalid_trajectory_cursor" });
    expect(await f.service.query("trajectory.page", { sessionId: "other" })).toMatchObject({ ok: false, code: "invalid_trajectory_request" });
  });
  it("reads default trace records through the same index and retains them after restart/off", async () => {
    const f = await fixture("events");
    const factory = createLocalTraceRecorderFactory({ layout: f.layout, config: f.config });
    const recorder = await factory.create({ sessionId: f.sessionId, ownerGeneration: 1, onRecorded: (event, locator) => f.service.recorded(event, locator) });
    await recorder!.startRun({ metadata: { runId: "r1" } });
    await recorder!.recordAgentEvent({ type: "turn_start", turn: 1, timestamp: Date.now() });
    await recorder!.finishRun({ phase: "finished" });
    const page = await f.page();
    expect(page.records.some((row) => row.id === "run/r1")).toBe(true);
    expect(page.status.recordedBytes).toBeGreaterThan(0);
    const reopened = new TrajectoryService({ layout: f.layout, store: f.store, sessionId: f.sessionId, generation: 2, config: { mode: "off", failurePolicy: "best_effort" } });
    try {
      const result = await reopened.query("trajectory.page", {});
      expect(result.ok && (result.value as unknown as TrajectoryPage).records.some((row) => row.id === "run/r1")).toBe(true);
    } finally { await reopened.close(); }
  });
  it("searches older unloaded metadata and pages UTF-8 detail by bytes", async () => {
    const f = await fixture();
    f.append({ type: "agent_start", runId: "r", timestamp: 1 });
    f.append({ type: "tool_execution_start", runId: "r", toolCallId: "c", toolName: "read", args: { target: "needle" }, timestamp: 2 });
    f.append({ type: "tool_execution_end", runId: "r", toolCallId: "c", toolName: "read", result: "中文".repeat(20_000), timestamp: 3 });
    expect((await f.page({ search: "needle" })).records).toHaveLength(1);
    const first = await f.service.query("trajectory.detail", { recordId: "tool/r/c", field: "output" });
    if (!first.ok) throw new Error(first.code);
    const detail = first.value as unknown as TrajectoryDetail;
    expect(detail.availability).toBe("more"); expect(detail.text).not.toContain("�");
    expect(Buffer.byteLength(detail.text)).toBeLessThanOrEqual(48 * 1024);
    expect(await f.service.query("trajectory.detail", { recordId: "tool/r/c", field: "input", cursor: detail.next })).toMatchObject({ ok: false, code: "invalid_trajectory_cursor" });
  });
  it("updates one live model row without indexing private reasoning", async () => {
    const f = await fixture();
    f.append({ type: "agent_start", runId: "live", timestamp: 10 });
    f.append({ type: "turn_start", turn: 1, timestamp: 11 });
    f.append({ type: "message_start", role: "assistant", timestamp: 12 });
    f.append({ type: "message_update", timestamp: 15, assistantMessageEvent: { type: "text_delta", delta: "visible " } });
    f.append({ type: "message_update", timestamp: 16, assistantMessageEvent: { type: "thinking_delta", delta: "private-token" } });
    f.append({ type: "message_update", timestamp: 17, assistantMessageEvent: { type: "text_delta", delta: "answer" } });
    const page = await f.page();
    expect(page.records.filter((row) => row.kind === "model")).toEqual([expect.objectContaining({ id: "model/live/1", summary: "visible answer", ttftMs: 3 })]);
    expect(JSON.stringify(page)).not.toContain("private-token");
  });
  it("rebuilds a corrupt cache without modifying session authority", async () => {
    const f = await fixture();
    f.append({ type: "agent_start", runId: "r", timestamp: 1 });
    await f.page(); await f.service.close();
    const path = join(f.layout.projections, "trajectory", `${canonicalDigest(f.sessionId)}.sqlite`);
    await writeFile(path, "broken cache");
    const reopened = new TrajectoryService({ layout: f.layout, store: f.store, sessionId: f.sessionId, generation: 2, config: f.config });
    try {
      const result = await reopened.query("trajectory.page", {});
      expect(result.ok && (result.value as unknown as TrajectoryPage).records[0]?.id).toBe("run/r");
      expect(result.ok && (result.value as unknown as TrajectoryPage).status.diagnostics).toContain("trajectory_cache_rebuilt");
    } finally { await reopened.close(); }
  });
  it("does not label oversized or absent content as complete", async () => {
    const f = await fixture();
    f.append({ type: "agent_start", runId: "r", timestamp: 1 });
    f.append({ type: "tool_execution_end", toolCallId: "large", toolName: "read", result: "x".repeat(2 * 1024 * 1024 + 100), timestamp: 2 });
    await f.page();
    const result = await f.service.query("trajectory.detail", { recordId: "tool/r/large", field: "output" });
    expect(result.ok && result.value.availability).toBe("unavailable");
  });

  it("rejects stale and cross-session envelopes before reaching the trajectory service", async () => {
    const f = await fixture();
    const router = new SessionDomainRouter(f.sessionId, 1, f.store, { beginAttempt: () => { throw new Error("readonly query started attempt"); }, settleAttempt: () => ({ ok: false, code: "unused" }) }, { additionalOperations: f.service.operationManifest });
    const handler = new SessionQueryHandler({ store: f.store, sessionId: f.sessionId, domainRouter: router, domain: { trajectory: f.service } } as SessionQueryPort);
    const body = { sessionId: f.sessionId, generation: 1, correlationId: "q", effectId: "q", operation: "trajectory.page", payload: {} };
    expect(await handler.handleQuery({ kind: "domain_query", body: { ...body, generation: 2 } })).toMatchObject({ ok: false, code: "generation_mismatch" });
    expect(await handler.handleQuery({ kind: "domain_query", body: { ...body, sessionId: "other" } })).toMatchObject({ ok: false, code: "generation_mismatch" });
    expect(await handler.handleQuery({ kind: "domain_query", body })).toMatchObject({ ok: true });
  });
  it("projects attempt receipts without guessing a tool association", async () => {
    const f = await fixture();
    const attemptId = createRuntimeId("attempt", "receipt");
    f.store.beginCommandAttempt(f.fence, { sessionId: f.sessionId, commandId: createRuntimeId("command", "receipt"), attemptId, effectClass: "readonly", requestDigest: runtimeDigest({ fixture: true }), originGeneration: 1, createdAtMs: 100 });
    const page = await f.page();
    expect(page.records.find((record) => record.id === `attempt/${attemptId}`)).toMatchObject({ kind: "attempt", state: "running", summary: expect.stringContaining("association unavailable") });
    f.store.appendAttemptReceipt(f.fence, { receiptId: createRuntimeId("receipt", "terminal"), sessionId: f.sessionId, commandId: createRuntimeId("command", "receipt"), attemptId, originGeneration: 1, settledGeneration: 1, effectClass: "readonly", outcome: "committed", createdAtMs: 120 });
    const final = await f.page();
    expect(final.records.find((record) => record.id === `attempt/${attemptId}`)).toMatchObject({ state: "succeeded", durationMs: 20, summary: "Receipt: committed; call association unavailable" });
  });

  it("stops oversized Session replay before copying unbounded event bodies into the query", async () => {
    const f = await fixture();
    f.append({ type: "agent_start", runId: "large", timestamp: 1 });
    f.append({ type: "tool_execution_end", toolCallId: "large", result: "x".repeat(8 * 1024 * 1024 + 1), timestamp: 2 });
    const page = await f.page();
    expect(page.status).toMatchObject({ health: "degraded", historyCoverage: "partial", diagnostics: expect.arrayContaining(["trajectory_session_event_oversized"]) });
    expect(page.records).toHaveLength(1);
    expect(page.watermark.sessionSequence).toBeLessThan(f.store.replaySessionEvents(f.sessionId).at(-1)!.sequence);
  });

});
