import { describe, expect, it } from "vitest";
import { createInitialTuiState, reduceTui } from "../../src/tui/application/reducer.ts";
import { SessionPickerComponent } from "../../src/tui/components/session-picker.ts";
import { createSessionPickerState } from "../../src/tui/sessions/picker-reducer.ts";
import type { SessionSummary } from "../../src/tui/sessions/types.ts";

const BOOTSTRAP = {
  workspace: "/workspace",
  session: { id: "session-1", format: "v3" as const, lifecycle: "active" as const },
};

const SESSIONS: readonly SessionSummary[] = [{
  id: "session-a",
  title: "Alpha",
  createdAt: 1,
  modifiedAt: 2,
  format: "v2",
  compatibility: "read-only",
  lifecycle: "unknown",
  isCurrent: false,
}, {
  id: "session-b",
  title: "Beta",
  createdAt: 2,
  modifiedAt: 3,
  format: "v3",
  compatibility: "read-only",
  lifecycle: "active",
  isCurrent: true,
}];

describe("session picker reducer correlation", () => {
  it("opens synchronously, resolves the matching list, and ignores stale results", () => {
    const initial = createInitialTuiState(BOOTSTRAP, {
      sessionCatalog: { available: true },
    });
    const opened = reduceTui(initial, {
      type: "session.picker.open",
      sourceInvocationId: "command:1",
    });
    expect(opened.state.overlay.state).toBe("session-picker");
    expect(opened.state.sessionPicker.list.state).toBe("loading");
    expect(opened.effects).toHaveLength(1);
    const effect = opened.effects[0]!;
    if (effect.type !== "session.list") throw new Error("expected session.list");

    const searched = reduceTui(opened.state, {
      type: "session.picker.search",
      query: "beta",
    });
    expect(searched.abortEffectIds).toEqual([effect.effectId]);
    const replacement = searched.effects[0]!;
    if (replacement.type !== "session.list") throw new Error("expected replacement list");
    const stale = reduceTui(searched.state, {
      type: "session.list.completed",
      effectId: effect.effectId,
      correlationId: effect.correlationId,
      generation: effect.generation,
      listRequestId: effect.listRequestId,
      result: { ok: true, value: { sessions: SESSIONS, diagnostics: [] } },
    });
    expect(stale.state).toBe(searched.state);

    const ready = reduceTui(searched.state, {
      type: "session.list.completed",
      effectId: replacement.effectId,
      correlationId: replacement.correlationId,
      generation: replacement.generation,
      listRequestId: replacement.listRequestId,
      result: {
        ok: true,
        value: { sessions: [SESSIONS[1]!], diagnostics: [] },
      },
    });
    expect(ready.state.queryGuard.state).toBe("idle");
    expect(ready.state.sessionPicker).toMatchObject({
      query: "beta",
      selectedSessionId: "session-b",
      list: { state: "ready" },
    });
  });

  it("invalidates and aborts its owned request before closing", () => {
    const opened = reduceTui(createInitialTuiState(BOOTSTRAP), {
      type: "session.picker.open",
      sourceInvocationId: "command:1",
    });
    const effect = opened.effects[0]!;
    const closed = reduceTui(opened.state, { type: "session.picker.close" });
    expect(closed.state.overlay).toEqual({ state: "closed" });
    expect(closed.state.queryGuard).toEqual({ state: "idle" });
    expect(closed.abortEffectIds).toEqual([effect.effectId]);
    expect(closed.state.sessionPicker.generation).toBeGreaterThan(
      opened.state.sessionPicker.generation,
    );
  });
});

describe("SessionPickerComponent", () => {
  it("filters through callbacks, moves selection, inspects, cancels, and fits target widths", () => {
    const searches: string[] = [];
    const selections: string[] = [];
    const inspections: string[] = [];
    let cancelled = 0;
    const component = new SessionPickerComponent({
      ...createSessionPickerState(),
      query: "",
      selectedSessionId: "session-a",
      list: {
        state: "ready",
        value: {
          sessions: SESSIONS,
          diagnostics: [{ code: "corrupt", fileName: "bad.jsonl", message: "bad" }],
        },
      },
    }, {
      onSearch: (query) => searches.push(query),
      onSelect: (sessionId) => selections.push(sessionId),
      onInspect: (sessionId) => inspections.push(sessionId),
      onCancel: () => cancelled++,
    });

    component.handleInput("b");
    component.handleInput("\x1b[B");
    component.handleInput("\r");
    component.handleInput("\x1b");
    expect(searches).toEqual(["b"]);
    expect(selections).toEqual(["session-b"]);
    expect(inspections).toEqual(["session-a"]);
    expect(cancelled).toBe(1);
    for (const width of [60, 80, 143]) {
      expect(component.render(width).every((line) => line.length <= width)).toBe(true);
    }
    expect(component.render(80).join("\n")).toContain("1 unavailable session file");
  });
});
