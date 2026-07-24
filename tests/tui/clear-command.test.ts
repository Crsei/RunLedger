import { describe, expect, it } from "vitest";
import { createInitialTuiState, reduceTui } from "../../src/tui/application/reducer.ts";
import type { TuiState } from "../../src/tui/application/types.ts";
import {
  clearTimelineViewport,
  createTimelineState,
  reduceTimeline,
} from "../../src/tui/timeline/tool-reducer.ts";

const BOOTSTRAP = {
  workspace: "/workspace",
  session: { id: "session-1", format: "v3" as const, lifecycle: "active" as const },
};

describe("native /clear viewport action", () => {
  it("drops terminal command rows while preserving active ownership and application state", () => {
    const base = createInitialTuiState(BOOTSTRAP);
    const state: TuiState = {
      ...base,
      queryGuard: {
        state: "running",
        correlationId: "command:active",
        effectId: "command:active:effect:0",
      },
      queue: [{ id: "queue:1", kind: "prompt", text: "later" }],
      commandsById: {
        "command:done": {
          invocationId: "command:done",
          canonicalName: "model",
          normalizedArgs: [],
          execution: { state: "succeeded", summary: "done" },
        },
        "command:active": {
          invocationId: "command:active",
          canonicalName: "login",
          normalizedArgs: [],
          execution: { state: "running", effectId: "command:active:effect:0" },
        },
      },
      commandOrder: ["command:done", "command:active"],
    };

    const cleared = reduceTui(state, { type: "timeline.viewport.clear" }).state;
    expect(cleared.commandOrder).toEqual(["command:active"]);
    expect(cleared.commandsById["command:done"]).toBeUndefined();
    expect(cleared.queryGuard).toEqual(state.queryGuard);
    expect(cleared.queue).toEqual(state.queue);
    expect(cleared.bootstrap).toBe(state.bootstrap);
    expect(cleared.viewportClearRevision).toBe(1);

    const recorded = reduceTui(cleared, {
      type: "command.terminal",
      command: {
        invocationId: "command:clear",
        canonicalName: "clear",
        normalizedArgs: [],
      },
      terminal: { state: "succeeded", summary: "viewport cleared" },
    }).state;
    expect(recorded.commandOrder).toEqual(["command:active", "command:clear"]);
  });

  it("keeps active message/tool rows so their late terminal event still converges", () => {
    let timeline = createTimelineState();
    timeline = reduceTimeline(timeline, {
      type: "message.end",
      id: "old",
      timestamp: 1,
      role: "user",
      text: "committed history",
      status: "succeeded",
    });
    timeline = reduceTimeline(timeline, {
      type: "tool.start",
      id: "tool:active",
      timestamp: 2,
      toolName: "bash",
    });

    const cleared = clearTimelineViewport(timeline);
    expect(cleared.committedRows).toEqual([]);
    expect(cleared.activeOrder).toEqual(["tool:active"]);
    const terminal = reduceTimeline(cleared, {
      type: "tool.end",
      id: "tool:active",
      timestamp: 3,
      toolName: "bash",
      output: "done",
      status: "succeeded",
    });
    expect(terminal.activeOrder).toEqual([]);
    expect(terminal.committedRows).toEqual([
      expect.objectContaining({ kind: "tool", status: "succeeded", output: "done" }),
    ]);
  });
});
