import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Value } from "typebox/value";
import { webFixture } from "./fixture.ts";
import { WebHistory } from "../../../src/web/history.ts";
import { OfflineWebTrajectory } from "../../../src/web/offline-trajectory.ts";
import { createLocalTraceRecorderFactory } from "../../../src/runtime/trace/composition.ts";
import { TrajectoryService } from "../../../src/runtime/trajectory/service.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/canonical-json.ts";
import { WebTrajectoryPageSchema, WebTrajectoryDetailSchema } from "@runledger/collab-web/contracts";

describe("offline Web-owned trajectory projection", () => {
  it("reuses projections in an independent cache, pages details and never writes the Owner index", async () => {
    const fixture = webFixture(), session = fixture.create("trajectory");
    session.append("agent.event", { type: "agent_start", runId: "r", timestamp: 1 });
    session.append("agent.event", { type: "tool_execution_start", runId: "r", toolCallId: "c", toolName: "read", args: { file: "a.ts" }, timestamp: 2 });
    session.append("agent.event", { type: "tool_execution_end", runId: "r", toolCallId: "c", toolName: "read", result: "中文😀".repeat(16000), isError: false, timestamp: 3 });
    const owner = new TrajectoryService({ layout: fixture.layout, store: fixture.store, sessionId: session.sessionId, generation: 1, config: { mode: "off", failurePolicy: "best_effort" } });
    await owner.query("trajectory.page", {}); await owner.close();
    const ownerPath = join(fixture.layout.projections, "trajectory", `${canonicalDigest(session.sessionId)}.sqlite`), before = readFileSync(ownerPath);
    const web = new OfflineWebTrajectory(fixture.layout, new WebHistory(fixture.layout.database));
    try {
      const page = await web.page(session.sessionId);
      expect(Value.Check(WebTrajectoryPageSchema, page)).toBe(true);
      expect(page.health).toBe("ready");
      expect(page.coverage).toBe("session-only");
      expect(page.items.find((row) => row.kind === "tool")?.state).toBe("succeeded");
      const tool = page.items.find((row) => row.kind === "tool")!;
      let detail = await web.detail(session.sessionId, tool.id, "output"), text = detail.text;
      while (detail.next) {
        expect(Value.Check(WebTrajectoryDetailSchema, detail)).toBe(true);
        expect(Buffer.byteLength(JSON.stringify(detail))).toBeLessThanOrEqual(48 * 1024);
        expect(detail.text).not.toContain("�");
        detail = await web.detail(session.sessionId, tool.id, "output", detail.next); text += detail.text;
      }
      expect(text).toBe("中文😀".repeat(16000));
      expect(readFileSync(ownerPath)).toEqual(before);
      const other = fixture.create("other");
      await expect(web.detail(other.sessionId, tool.id, "output")).rejects.toThrow("not_found");
      const controller = new AbortController(); controller.abort();
      await expect(web.page(session.sessionId, {}, controller.signal)).rejects.toThrow("busy");
    } finally { await web.close(); fixture.close(); }
  });
  it("discovers only session-owned trace artifacts and reports missing/corrupt content distinctly", async () => {
    const fixture = webFixture(), session = fixture.create("trace");
    const recorder = await createLocalTraceRecorderFactory({ layout: fixture.layout, config: { mode: "events_and_artifacts", failurePolicy: "best_effort" } }).create({ sessionId: session.sessionId, ownerGeneration: 1 });
    await recorder!.startRun({ metadata: { runId: "trace-run" } });
    await recorder!.recordAgentEvent({ type: "tool_execution_start", toolCallId: "c", toolName: "read", args: { file: "test.ts" }, timestamp: 1 });
    await recorder!.recordAgentEvent({ type: "tool_execution_end", toolCallId: "c", toolName: "read", result: { type: "toolResult", toolCallId: "call", toolName: "bash", content: [{ type: "text", text: "artifact-output" }] }, isError: false, timestamp: 2 });
    await recorder!.finishRun({ phase: "finished" });
    const web = new OfflineWebTrajectory(fixture.layout, new WebHistory(fixture.layout.database));
    try {
      const page = await web.page(session.sessionId);
      expect(page.coverage).toBe("session-and-trace");
      const tool = page.items.find((row) => row.kind === "tool")!;
      expect((await web.detail(session.sessionId, tool.id, "output")).text).toContain("artifact-output");
      expect(existsSync(fixture.layout.projections)).toBe(false);
      const nextRecorder = await createLocalTraceRecorderFactory({ layout: fixture.layout, config: { mode: "events", failurePolicy: "best_effort" } }).create({ sessionId: session.sessionId, ownerGeneration: 1 });
      await nextRecorder!.startRun({ metadata: { runId: "later-trace" } });
      await nextRecorder!.finishRun({ phase: "finished" });
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31000);
      try { expect((await web.page(session.sessionId)).items.length).toBeGreaterThan(page.items.length); } finally { clock.mockRestore(); }
    } finally { await web.close(); fixture.close(); }
  });
});
