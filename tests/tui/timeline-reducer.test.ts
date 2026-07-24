import { describe, expect, it } from "vitest";
import { TimelineComponent } from "../../src/tui/components/timeline.ts";
import {
  createTimelineState,
  reduceTimeline,
  TIMELINE_ORPHAN_TIMEOUT_MS,
} from "../../src/tui/timeline/tool-reducer.ts";
import {
  createTimelineProjectionCursor,
  projectLive,
  projectReplay,
} from "../../src/tui/timeline/projector.ts";
import type { AgentMessage } from "../../src/runtime/types.ts";
import type { TuiEvent } from "../../src/tui/types.ts";

describe("Timeline/tool reducer", () => {
  it("projects equivalent replay and live messages into the same row sequence", () => {
    const user: AgentMessage = { role: "user", content: [{ type: "text", text: "hello" }] };
    const assistant: AgentMessage = {
      role: "assistant",
      content: [{ type: "text", text: "world" }],
      stopReason: "stop",
      timestamp: 2,
    };
    let replayState = createTimelineState();
    for (const event of projectReplay([user, assistant])) replayState = reduceTimeline(replayState, event);

    const liveEvents: TuiEvent[] = [
      { type: "message_start", timestamp: 0, role: "user", message: user },
      { type: "message_end", timestamp: 0, role: "user", message: user, stopReason: "stop" },
      { type: "message_start", timestamp: 2, role: "assistant", message: assistant },
      { type: "message_end", timestamp: 2, role: "assistant", message: assistant, stopReason: "stop" },
    ];
    let cursor = createTimelineProjectionCursor();
    let liveState = createTimelineState();
    for (const event of liveEvents) {
      const projected = projectLive(cursor, event);
      cursor = projected.cursor;
      for (const item of projected.events) liveState = reduceTimeline(liveState, item);
    }
    expect(liveState.committedRows).toEqual(replayState.committedRows);
  });

  it("keeps update-before-start and terminal-before-start on one terminal row", () => {
    let state = createTimelineState();
    state = reduceTimeline(state, {
      type: "tool.update",
      id: "call-1",
      timestamp: 1,
      output: "partial",
    });
    state = reduceTimeline(state, {
      type: "tool.end",
      id: "call-1",
      timestamp: 2,
      toolName: "bash",
      output: "final",
      status: "succeeded",
    });
    state = reduceTimeline(state, {
      type: "tool.start",
      id: "call-1",
      timestamp: 3,
      toolName: "bash",
      args: { command: "pwd" },
    });
    state = reduceTimeline(state, {
      type: "tool.end",
      id: "call-1",
      timestamp: 4,
      toolName: "bash",
      output: "duplicate",
      status: "failed",
    });
    expect(state.committedRows).toHaveLength(1);
    expect(state.committedRows[0]).toMatchObject({
      id: "call-1",
      status: "succeeded",
      output: "final",
      args: { command: "pwd" },
    });
    expect(state.activeOrder).toEqual([]);
  });

  it("does not merge parallel calls with the same tool name", () => {
    let state = createTimelineState();
    for (const id of ["call-1", "call-2"]) {
      state = reduceTimeline(state, {
        type: "tool.start",
        id,
        timestamp: 1,
        toolName: "read",
      });
    }
    expect(state.activeOrder).toEqual(["call-1", "call-2"]);
  });

  it("bounds partial lines and expires orphan placeholders", () => {
    let state = reduceTimeline(createTimelineState(), {
      type: "tool.update",
      id: "orphan",
      timestamp: 10,
      output: Array.from({ length: 250 }, (_, index) => `line-${index}`).join("\n"),
    });
    const active = state.activeRowsByCorrelationId.orphan;
    expect(active?.kind).toBe("tool");
    if (active?.kind === "tool") {
      expect(active.output.split("\n")).toHaveLength(200);
      expect(active.truncated).toBe(true);
    }
    state = reduceTimeline(state, {
      type: "cleanup",
      timestamp: 10 + TIMELINE_ORPHAN_TIMEOUT_MS,
    });
    expect(state.committedRows[0]?.status).toBe("aborted");
  });

  it.each([60, 80, 143])("renders every row within %d columns", (width) => {
    const state = reduceTimeline(createTimelineState(), {
      type: "message.end",
      id: "message:0",
      timestamp: 1,
      role: "user",
      text: "你好".repeat(100),
      status: "succeeded",
    });
    const component = new TimelineComponent(state);
    expect(component.render(width).every((line) => line.length <= width * 2)).toBe(true);
  });
});
