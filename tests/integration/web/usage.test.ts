import { createLocalTraceRecorderFactory } from "../../../src/runtime/trace/composition.ts";
import type { Model } from "../../../src/types.ts";
import { describe, expect, it, vi } from "vitest";
import { UsageProjection } from "../../../src/web/usage-projection.ts";
import { WebUsageReader } from "../../../src/web/usage.ts";
import { WebHistory, projectId } from "../../../src/web/history.ts";
import type { TraceEvent } from "../../../src/runtime/trace/types.ts";
import { webFixture } from "./fixture.ts";

const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reported: { input: true, output: true, cacheRead: true, cacheWrite: true }, cost: { total: 0.001 } };
function call(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "model_call", originSessionId: "session_origin", callId: id, phase: "finished", startedAtMs: 1000, usage, ...extra };
}
function trace(id: string, phase: TraceEvent["phase"]): TraceEvent {
  return { eventId: `event-${id}-${phase}`, traceId: "trace", nodeId: id, parentNodeId: "turn", kind: "model", name: "model", phase, timestamp: new Date(1000).toISOString(),
    sequence: phase === "started" ? 1 : 2, previousEventHash: null, eventHash: "hash", metadata: {},
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, source: "provider_reported" }, cost: { usdMicros: 1000, source: "pricing_table", billable: true } };
}

describe("project model-call usage", () => {
  it("merges updates, event/Trace copies and fork origins, counts retries independently and separates price estimates", () => {
    const projection = new UsageProjection();
    projection.event("session_origin", "1", call("a", { phase: "started", usage: undefined }));
    projection.event("session_origin", "2", call("a"));
    projection.event("session_fork", "3", call("a"));
    projection.trace("session_origin", trace("a", "started")); projection.trace("session_origin", trace("a", "finished"));
    projection.event("session_origin", "4", call("retry"));
    projection.event("session_origin", "5", call("outside", { startedAtMs: 5000 }));
    const result = projection.snapshot("project", 0, 2000, true);
    expect(result.uniqueCalls).toBe(2); expect(result.coverage).toBe("complete");
    expect(result.inputTokens).toEqual({ exact: 20, estimated: null, missingCalls: 0 });
    expect(result.costUsd).toEqual({ exact: null, estimated: 0.002, missingCalls: 0 });
    expect(result.cacheReadTokens.exact).toBe(0);
  });
  it("keeps missing usage and ambiguous zero unknown, excludes unidentified history and detects source conflict", () => {
    const projection = new UsageProjection();
    projection.event("session_origin", "1", call("missing", { usage: undefined }));
    projection.event("session_origin", "2", { type: "message_end", role: "assistant", message: { usage } });
    projection.event("session_origin", "3", call("zero", { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } }));
    let result = projection.snapshot("project", 0, 2000, true);
    expect(result.coverage).toBe("partial"); expect(result.excludedUnidentifiedObservations).toBe(1);
    expect(result.costUsd).toEqual({ exact: null, estimated: null, missingCalls: 2 });
    const conflict = new UsageProjection();
    conflict.trace("session_origin", trace("a", "started")); conflict.trace("session_origin", trace("a", "finished"));
    conflict.event("session_origin", "1", call("a", { usage: { ...usage, input: 999 } }));
    result = conflict.snapshot("project", 0, 2000, true);
    expect(result.coverage).toBe("partial"); expect(result.inputTokens.exact).toBe(999);
  });
  it("treats legacy Trace zero as unknown and retains recorded zero", () => {
    const projection = new UsageProjection();
    projection.trace("s", trace("legacy", "started")); projection.trace("s", trace("legacy", "finished"));
    expect(projection.snapshot("p", 0, 2000, true).cacheReadTokens.missingCalls).toBe(1);
    projection.trace("s", { ...trace("legacy", "finished"), metadata: { usagePresenceRecorded: true } });
    expect(projection.snapshot("p", 0, 2000, true).cacheReadTokens.exact).toBe(0);
  });
  it("refreshes appended Trace even when the Session event head is unchanged", async () => {
    const fixture = webFixture(), session = fixture.create("trace-refresh");
    const reader = new WebUsageReader(new WebHistory(fixture.layout.database), fixture.layout);
    const range = { timeFrom: 0, timeTo: Date.now() + 100000 }, id = projectId("workspace_web-fixture");
    try {
      expect((await reader.read(id, range)).uniqueCalls).toBe(0);
      const recorder = await createLocalTraceRecorderFactory({ layout: fixture.layout, config: { mode: "events", failurePolicy: "best_effort" } }).create({ sessionId: session.sessionId });
      await recorder!.startRun();
      const model: Model<"openai-completions"> = { id: "fixture", name: "fixture", provider: "fixture", api: "openai-completions", baseUrl: "http://127.0.0.1", contextWindow: 10000, maxTokens: 1000, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
      const handle = await recorder!.startModel({ turn: 1, model, context: { messages: [], tools: [] } });
      await recorder!.finishModel(handle); await recorder!.finishRun({ phase: "finished" });
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31000);
      try { expect((await reader.read(id, range)).uniqueCalls).toBe(1); } finally { clock.mockRestore(); }
    } finally { await reader.close(); fixture.close(); }
  });
  it("reads isolated SQL incrementally, ignores copied ledger totals, observes new calls and cancels", async () => {
    const fixture = webFixture(), session = fixture.create("usage"), reader = new WebUsageReader(new WebHistory(fixture.layout.database), fixture.layout);
    try {
      session.append("agent.event", call("a"));
      const fork = fixture.create("usage-fork"); fork.message("assistant", [{ type: "text", text: "inherited message" }]);
      const before = fixture.store.replaySessionEvents(session.sessionId);
      const id = projectId("workspace_web-fixture"), range = { timeFrom: 0, timeTo: 2000 };
      const result = await reader.read(id, range);
      expect(result.uniqueCalls).toBe(1); expect(result.costUsd.estimated).toBe(0.001);
      expect(result.coverage).toBe("partial");
      expect(result.excludedUnidentifiedObservations).toBe(1);
      const signal = new AbortController(); signal.abort();
      await expect(reader.read(id, range, signal.signal)).rejects.toThrow("busy");
      expect(fixture.store.replaySessionEvents(session.sessionId)).toEqual(before);
    } finally { await reader.close(); fixture.close(); }
  });
});
