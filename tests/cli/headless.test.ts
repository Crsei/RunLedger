import { describe, it, expect } from "vitest";
import { runHeadless, type HeadlessController } from "../../src/cli/headless.ts";
import type { AgentEvent, AgentEventSink } from "../../src/runtime/types.ts";

function controller(prompt: (emit: AgentEventSink) => Promise<void>) {
  let listener: AgentEventSink = () => undefined;
  let interrupted = false;
  let detached = false;
  const value: HeadlessController = {
    sessionId: "test",
    subscribe: (fn) => { listener = fn; return () => { detached = true; }; },
    prompt: () => prompt(listener),
    interrupt: () => { interrupted = true; },
  };
  return { value, interrupted: () => interrupted, detached: () => detached };
}
const start: AgentEvent = { type: "agent_start", timestamp: 1, runId: "r" };
const end: AgentEvent = { type: "agent_end", timestamp: 2, runId: "r", stopReason: "stop" };
describe("headless production controller driver", () => {
  it("handles end before prompt acknowledgement and retains ordered boundaries", async () => {
    const c = controller(async (emit) => { await emit(start); await emit(end); });
    const events: unknown[] = [];
    await runHeadless(c.value, "task", { write: e => { events.push(e); } });
    expect(events).toEqual([{ type: "runledger_session", sessionId: "test" }, start, end,
      { type: "runledger_complete", sessionId: "test", stopReason: "stop" }]);
    expect(c.detached()).toBe(true);
  });
  it("rejects admission failures and model failures", async () => {
    const c = controller(async () => { throw new Error("denied"); });
    await expect(runHeadless(c.value, "task", { write: () => undefined })).rejects.toThrow("denied");
    expect(c.detached()).toBe(true);
    const model = controller(async emit => { await emit(start); await emit({ ...end, stopReason: "error" }); });
    await expect(runHeadless(model.value, "task", { write: () => undefined })).rejects.toThrow("error");
  });
  it("times out even if command admission never acknowledges", async () => {
    const c = controller(() => new Promise<void>(() => undefined));
    await expect(runHeadless(c.value, "task", { write: () => undefined, timeoutMs: 10 })).rejects.toThrow("timed out");
    expect(c.interrupted()).toBe(true);
    expect(c.detached()).toBe(true);
  });
  it("rejects a run stopped by the runtime budget", async () => {
    const c = controller(async emit => {
      await emit(start);
      await emit({ ...end, terminationReason: "model_turn_limit" });
    });
    await expect(runHeadless(c.value, "task", { write: () => undefined })).rejects.toThrow("model_turn_limit");
  });
  it("interrupts timed out executions and removes the subscription", async () => {
    const c = controller(async emit => { await emit(start); });
    await expect(runHeadless(c.value, "task", { write: () => undefined, timeoutMs: 10 })).rejects.toThrow("timed out");
    expect(c.interrupted()).toBe(true);
    expect(c.detached()).toBe(true);
  });
});
