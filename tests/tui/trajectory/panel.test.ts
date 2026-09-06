import { describe, expect, it } from "vitest";
import type { TrajectoryClientPort, TrajectoryPage, TrajectoryRecord } from "../../../src/runtime/contracts/trajectory.ts";
import { TrajectoryPanel } from "../../../src/tui/trajectory/panel.ts";
import { trajectoryCost, trajectorySpans } from "../../../src/tui/trajectory/layout.ts";

function record(id: string, ordinal: number, overrides: Partial<TrajectoryRecord> = {}): TrajectoryRecord {
  return { id, ordinal, revision: 1, runId: "r1", kind: "model", name: id, summary: "safe", state: "succeeded", source: "session", generation: 1, input: "unavailable", output: "session", ...overrides };
}
function page(records: readonly TrajectoryRecord[]): TrajectoryPage {
  return { version: 1, sessionId: "s", records, hasOlder: false, hasNewer: false,
    watermark: { generation: 1, revision: 1, sessionSequence: 1, traceRevision: 1 },
    status: { mode: "events", failurePolicy: "best_effort", health: "ready", diagnostics: [], recordedBytes: 128, records: records.length, historyCoverage: "session-and-trace" } };
}
describe("trajectory presentation", () => {
  it("compresses idle gaps but preserves overlapping operations and unavailable duration", () => {
    const rows = [record("model", 1, { startedAtMs: 100, durationMs: 50 }), record("tool", 2, { kind: "tool", startedAtMs: 120, durationMs: 70 }), record("next", 3, { startedAtMs: 300, durationMs: 10 }), record("unknown", 4)];
    const spans = trajectorySpans(rows, true);
    expect(spans.map(({ start, end }) => [start, end])).toEqual([[0, 50], [20, 90], [90, 100]]);
    expect(trajectorySpans(rows, false)).toHaveLength(4);
    expect(trajectoryCost(0.002524)).toBe("$0.002524");
    expect(trajectoryCost(undefined)).toBe("unavailable");
  });
  it("opens while running, renders all controls and releases its subscription on close", async () => {
    let subscribed = 0, closed = 0;
    const client: TrajectoryClientPort = { page: async () => ({ ok: true, value: page([record("r1", 1, { kind: "run", state: "running" }), record("model", 2), record("tool", 3, { kind: "tool" }), record("attempt", 4, { kind: "attempt" })]) }),
      detail: async () => ({ ok: false, code: "unused" }), subscribe: () => { subscribed++; return () => subscribed--; } };
    const panel = new TrajectoryPanel({ client, sessionId: "s", getHeight: () => 22, onChange: () => undefined, onClose: () => closed++ });
    await panel.open();
    const text = panel.render(80).join("\n");
    for (const label of ["Trajectory", "Duration", "Turns", "Calls", "Overview", "Follow"]) expect(text).toContain(label);
    panel.handleInput("c");
    expect(panel.render(80).join("\n")).toContain("tool tool");
    expect(panel.render(80).join("\n")).not.toContain("attempt attempt");
    panel.handleInput("/"); panel.handleInput("d");
    expect(panel.render(80).join("\n")).toContain("Search: d");
    expect(panel.render(80).join("\n")).toContain("Duration off");
    panel.handleInput("escape"); panel.handleInput("escape");
    expect(closed).toBe(1); expect(subscribed).toBe(0);
  });
  it("ignores a page that completes after the panel is disposed", async () => {
    let resolve!: (result: { ok: true; value: TrajectoryPage }) => void;
    const pending = new Promise<{ ok: true; value: TrajectoryPage }>((done) => { resolve = done; });
    let changes = 0;
    const client: TrajectoryClientPort = { page: () => pending, detail: async () => ({ ok: false, code: "unused" }), subscribe: () => () => undefined };
    const panel = new TrajectoryPanel({ client, sessionId: "s", getHeight: () => 22, onChange: () => changes++, onClose: () => undefined });
    const opening = panel.open(); await Promise.resolve();
    panel.dispose(); const before = changes;
    resolve({ ok: true, value: page([record("late", 1)]) }); await opening;
    expect(changes).toBe(before);
  });
});
