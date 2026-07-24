import { describe, expect, it } from "vitest";
import { createInitialTuiState, reduceTui } from "../../src/tui/application/reducer.ts";
import type { TuiEffect } from "../../src/tui/application/types.ts";
import { CurrentSessionDetailComponent } from "../../src/tui/components/current-session-detail.ts";
import type { SessionDetail } from "../../src/tui/sessions/types.ts";

const BOOTSTRAP = {
  workspace: "/canonical/workspace",
  session: { id: "session-current", format: "v3" as const, lifecycle: "active" as const },
};

function currentEffect(): Extract<TuiEffect, { type: "session.current.enrich" }> {
  return {
    type: "session.current.enrich",
    effectId: "command:session:current-session:1",
    correlationId: "command:session",
    generation: 1,
    enrichRequestId: "command:session:current-session:1",
    sessionId: "session-current",
  };
}

const DETAIL: SessionDetail = {
  summary: {
    id: "session-current",
    title: "Canonical",
    cwd: "/canonical/workspace",
    createdAt: 1,
    modifiedAt: 2,
    format: "v3",
    compatibility: "read-only",
    lifecycle: "active",
    isCurrent: true,
  },
  filePath: "/canonical/session.jsonl",
  messageCount: 4,
  turnCount: 2,
  toolCount: 1,
};

describe("native /session current detail", () => {
  it("opens loading synchronously and correlates success to the original command", () => {
    const effect = currentEffect();
    const dispatched = reduceTui(createInitialTuiState(BOOTSTRAP), {
      type: "effect.dispatch",
      effect,
      command: {
        invocationId: "command:session",
        canonicalName: "session",
        normalizedArgs: [],
      },
    });
    expect(dispatched.state.overlay).toEqual({
      state: "current-session-detail",
      sourceInvocationId: "command:session",
    });
    expect(dispatched.state.currentSessionDetail).toMatchObject({
      sessionId: "session-current",
      detail: { state: "loading" },
    });

    const started = reduceTui(dispatched.state, {
      type: "effect.started",
      effectId: effect.effectId,
      correlationId: effect.correlationId,
    }).state;
    const completed = reduceTui(started, {
      type: "session.current.enrich.completed",
      effectId: effect.effectId,
      correlationId: effect.correlationId,
      generation: effect.generation,
      enrichRequestId: effect.enrichRequestId,
      sessionId: effect.sessionId,
      result: { ok: true, value: DETAIL },
    }).state;
    expect(completed.queryGuard).toEqual({ state: "idle" });
    expect(completed.currentSessionDetail.detail).toMatchObject({
      state: "ready",
      value: { summary: { id: "session-current" } },
    });
    expect(completed.commandsById["command:session"]?.execution).toEqual({
      state: "succeeded",
      summary: "current session details loaded",
    });
  });

  it("cancels the same invocation and aborts only its owned effect on close", () => {
    const effect = currentEffect();
    const dispatched = reduceTui(createInitialTuiState(BOOTSTRAP), {
      type: "effect.dispatch",
      effect,
      command: {
        invocationId: "command:session",
        canonicalName: "session",
        normalizedArgs: [],
      },
    });
    const closed = reduceTui(dispatched.state, { type: "session.current.close" });
    expect(closed.abortEffectIds).toEqual([effect.effectId]);
    expect(closed.state.queryGuard).toEqual({ state: "idle" });
    expect(closed.state.commandsById["command:session"]?.execution).toMatchObject({
      state: "cancelled",
    });
  });

  it("renders canonical state and handles Esc without consulting footer text", () => {
    let cancelled = 0;
    const component = new CurrentSessionDetailComponent({
      generation: 1,
      invocationId: "command:session",
      requestId: "request:1",
      sessionId: "session-current",
      detail: { state: "ready", value: DETAIL },
    }, () => cancelled++);
    const rendered = component.render(80).join("\n");
    expect(rendered).toContain("/canonical/workspace");
    expect(rendered).toContain("id: session-current");
    component.handleInput("\x1b");
    expect(cancelled).toBe(1);
  });
});
