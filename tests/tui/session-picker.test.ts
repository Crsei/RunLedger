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
    expect(ready.state.queryGuard.state).toBe("dispatching");
    expect(ready.state.sessionPicker).toMatchObject({
      query: "beta",
      selectedSessionId: "session-b",
      list: { state: "ready" },
      detail: { state: "loading", sessionId: "session-b" },
    });
    expect(ready.effects[0]).toMatchObject({
      type: "session.enrich",
      sessionId: "session-b",
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

  it("does not let A detail cross a rapid A to B selection", () => {
    const initial = {
      ...createInitialTuiState(BOOTSTRAP),
      overlay: { state: "session-picker" as const, sourceInvocationId: "command:1" },
      sessionPicker: {
        ...createSessionPickerState(),
        generation: 3,
        selectedSessionId: "session-a",
        list: { state: "ready" as const, value: { sessions: SESSIONS, diagnostics: [] } },
      },
    };
    const selectingA = reduceTui(initial, {
      type: "session.picker.select",
      sessionId: "session-a",
    });
    const aEffect = selectingA.effects[0]!;
    if (aEffect.type !== "session.enrich") throw new Error("expected enrich A");
    const selectingB = reduceTui(selectingA.state, {
      type: "session.picker.select",
      sessionId: "session-b",
    });
    expect(selectingB.abortEffectIds).toEqual([aEffect.effectId]);
    const bEffect = selectingB.effects[0]!;
    if (bEffect.type !== "session.enrich") throw new Error("expected enrich B");
    const staleA = reduceTui(selectingB.state, {
      type: "session.enrich.completed",
      effectId: aEffect.effectId,
      correlationId: aEffect.correlationId,
      generation: aEffect.generation,
      enrichRequestId: aEffect.enrichRequestId,
      sessionId: "session-a",
      result: {
        ok: true,
        value: {
          summary: SESSIONS[0]!,
          filePath: "/session-a.jsonl",
          messageCount: 9,
        },
      },
    });
    expect(staleA.state).toBe(selectingB.state);
    const readyB = reduceTui(selectingB.state, {
      type: "session.enrich.completed",
      effectId: bEffect.effectId,
      correlationId: bEffect.correlationId,
      generation: bEffect.generation,
      enrichRequestId: bEffect.enrichRequestId,
      sessionId: "session-b",
      result: {
        ok: true,
        value: {
          summary: SESSIONS[1]!,
          filePath: "/session-b.jsonl",
          messageCount: 2,
        },
      },
    });
    expect(readyB.state.sessionPicker.detail).toMatchObject({
      state: "ready",
      value: { summary: { id: "session-b" }, messageCount: 2 },
    });
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

  it("renders independent detail loading, error, and ready states", () => {
    const component = new SessionPickerComponent({
      ...createSessionPickerState(),
      selectedSessionId: "session-b",
      list: { state: "ready", value: { sessions: SESSIONS, diagnostics: [] } },
      detail: {
        state: "ready",
        value: {
          summary: SESSIONS[1]!,
          filePath: "/session-b.jsonl",
          messageCount: 3,
          turnCount: 2,
          toolCount: 1,
          headSequence: 8,
          headEventHash: "abcd",
        },
      },
    }, {
      onSearch: () => {},
      onSelect: () => {},
      onInspect: () => {},
      onCancel: () => {},
    });
    const rendered = component.render(80).join("\n");
    expect(rendered).toContain("Session detail");
    expect(rendered).toContain("messages=3 turns=2 tools=1");
    expect(rendered).toContain("cwd: unknown");
  });
});
