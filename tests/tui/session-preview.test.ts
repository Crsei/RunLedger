import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../src/runtime/types.ts";
import { createInitialTuiState, reduceTui } from "../../src/tui/application/reducer.ts";
import { SessionPreviewComponent } from "../../src/tui/components/session-preview.ts";
import { projectSessionPreview } from "../../src/tui/sessions/projector.ts";
import { createSessionPickerState } from "../../src/tui/sessions/picker-reducer.ts";
import type { SessionDetail, SessionSummary } from "../../src/tui/sessions/types.ts";
import { projectReplay } from "../../src/tui/timeline/projector.ts";
import { createTimelineState, reduceTimeline } from "../../src/tui/timeline/tool-reducer.ts";

const BOOTSTRAP = {
  workspace: "/workspace",
  session: { id: "current", format: "v3" as const, lifecycle: "active" as const },
};

const SUMMARY: SessionSummary = {
  id: "selected",
  title: "Selected",
  createdAt: 1,
  modifiedAt: 2,
  format: "v2",
  compatibility: "read-only",
  lifecycle: "unknown",
  isCurrent: false,
};

const MESSAGES: readonly AgentMessage[] = [
  { role: "user", content: [{ type: "text", text: "hello" }] },
  {
    role: "assistant",
    content: [
      { type: "text", text: "world" },
      { type: "toolCall", id: "call:1", name: "echo", arguments: { text: "input" } },
    ],
    stopReason: "toolUse",
  },
  {
    role: "toolResult",
    content: [{
      type: "toolResult",
      toolCallId: "call:1",
      toolName: "echo",
      content: [{ type: "text", text: "tool output" }],
    }],
  },
];

describe("session preview lane", () => {
  it("starts only after enrich success and correlates its own request tuple", () => {
    const initial = {
      ...createInitialTuiState(BOOTSTRAP),
      overlay: { state: "session-picker" as const, sourceInvocationId: "command:1" },
      sessionPicker: {
        ...createSessionPickerState(),
        generation: 1,
        selectedSessionId: SUMMARY.id,
        list: { state: "ready" as const, value: { sessions: [SUMMARY], diagnostics: [] } },
      },
    };
    const enriching = reduceTui(initial, {
      type: "session.picker.select",
      sessionId: SUMMARY.id,
    });
    const enrichEffect = enriching.effects[0]!;
    if (enrichEffect.type !== "session.enrich") throw new Error("expected enrich effect");
    const detail: SessionDetail = {
      summary: SUMMARY,
      filePath: "/selected.jsonl",
      messageCount: 2,
    };
    const enriched = reduceTui(enriching.state, {
      type: "session.enrich.completed",
      effectId: enrichEffect.effectId,
      correlationId: enrichEffect.correlationId,
      generation: enrichEffect.generation,
      enrichRequestId: enrichEffect.enrichRequestId,
      sessionId: enrichEffect.sessionId,
      result: { ok: true, value: detail },
    });
    expect(enriched.state.sessionPicker.detail.state).toBe("ready");
    expect(enriched.state.sessionPicker.preview.state).toBe("loading");
    const previewEffect = enriched.effects[0]!;
    if (previewEffect.type !== "session.preview") throw new Error("expected preview effect");

    const mainTimeline = reduceTimeline(createTimelineState(), {
      type: "message.end",
      id: "main",
      timestamp: 1,
      role: "user",
      text: "main remains",
      status: "succeeded",
    });
    const before = structuredClone(mainTimeline);
    const previewTimeline = projectSessionPreview(MESSAGES);
    const ready = reduceTui(enriched.state, {
      type: "session.preview.completed",
      effectId: previewEffect.effectId,
      correlationId: previewEffect.correlationId,
      generation: previewEffect.generation,
      previewRequestId: previewEffect.previewRequestId,
      sessionId: previewEffect.sessionId,
      result: {
        ok: true,
        value: {
          sessionId: SUMMARY.id,
          messages: MESSAGES,
          timeline: previewTimeline,
          truncated: false,
          sourceBytes: 100,
        },
      },
    }).state;
    expect(ready.queryGuard).toEqual({ state: "idle" });
    expect(ready.sessionPicker.preview).toMatchObject({ state: "ready" });
    expect(mainTimeline).toEqual(before);
  });

  it("uses the exact same replay projector and Timeline reducer as the main view", () => {
    let expected = createTimelineState();
    for (const event of projectReplay(MESSAGES)) expected = reduceTimeline(expected, event);
    expect(projectSessionPreview(MESSAGES)).toEqual(expected);
    const component = new SessionPreviewComponent({
      state: "ready",
      value: {
        sessionId: SUMMARY.id,
        messages: MESSAGES,
        timeline: expected,
        truncated: true,
        sourceBytes: 100,
      },
    });
    const rendered = component.render(80).join("\n");
    expect(rendered).toContain("Transcript preview · last bounded messages");
    expect(rendered).toContain("hello");
    expect(rendered).toContain("world");
    expect(rendered).toContain("✓ [echo] tool output");
  });
});
