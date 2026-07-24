import { describe, expect, it } from "vitest";
import { EffectRunner } from "../../src/tui/application/effect-runner.ts";
import { createInitialTuiState, reduceTui } from "../../src/tui/application/reducer.ts";
import type {
  TuiAction,
  TuiEffect,
  TuiResult,
  TuiTerminalState,
} from "../../src/tui/application/types.ts";

const BOOTSTRAP = {
  workspace: "/workspace",
  session: { id: "session-1", format: "v3" as const, lifecycle: "active" as const },
};

function effect(id: string): TuiEffect {
  return {
    type: "command.compatibility",
    effectId: `${id}:effect:0`,
    correlationId: id,
    canonicalName: "model",
    normalizedArgs: [],
  };
}

describe("canonical TUI reducer", () => {
  it("replays the same action/result log deterministically", () => {
    const log: Array<TuiAction | TuiResult> = [
      {
        type: "effect.dispatch",
        effect: effect("command:1"),
        command: { invocationId: "command:1", canonicalName: "model", normalizedArgs: [] },
      },
      { type: "effect.started", effectId: "command:1:effect:0", correlationId: "command:1" },
      {
        type: "effect.completed",
        effectId: "command:1:effect:0",
        correlationId: "command:1",
        terminal: { state: "succeeded", summary: "done" },
      },
    ];
    const replay = () => log.reduce(
      (state, input) => reduceTui(state, input).state,
      createInitialTuiState(BOOTSTRAP),
    );
    expect(replay()).toEqual(replay());
    expect(replay().queryGuard).toEqual({ state: "idle" });
    expect(replay().commandsById["command:1"]?.execution).toEqual({
      state: "succeeded",
      summary: "done",
    });
  });

  it("reserves synchronously so a second dispatch in the same stack gets no effect", () => {
    const initial = createInitialTuiState(BOOTSTRAP);
    const first = reduceTui(initial, {
      type: "effect.dispatch",
      effect: effect("command:1"),
      command: { invocationId: "command:1", canonicalName: "model", normalizedArgs: [] },
    });
    const second = reduceTui(first.state, {
      type: "effect.dispatch",
      effect: effect("command:2"),
      command: { invocationId: "command:2", canonicalName: "model", normalizedArgs: [] },
    });
    expect(first.effects).toHaveLength(1);
    expect(second.effects).toHaveLength(0);
    expect(second.state.commandsById["command:2"]?.execution).toMatchObject({
      state: "failed",
      message: "another query is active",
    });
  });

  it.each<TuiTerminalState>([
    { state: "succeeded" },
    { state: "failed", message: "failed", retryable: false },
    { state: "cancelled", reason: "operator" },
    { state: "aborted", reason: "signal" },
  ])("releases QueryGuard for terminal state $state", (terminal) => {
    const reserved = reduceTui(createInitialTuiState(BOOTSTRAP), {
      type: "effect.dispatch",
      effect: effect("command:1"),
    }).state;
    const running = reduceTui(reserved, {
      type: "effect.started",
      effectId: "command:1:effect:0",
      correlationId: "command:1",
    }).state;
    const completed = reduceTui(running, {
      type: "effect.completed",
      effectId: "command:1:effect:0",
      correlationId: "command:1",
      terminal,
    }).state;
    expect(completed.queryGuard).toEqual({ state: "idle" });
  });

  it("ignores duplicate, late, and unrelated results", () => {
    const initial = createInitialTuiState(BOOTSTRAP);
    const result: TuiResult = {
      type: "effect.completed",
      effectId: "missing",
      correlationId: "missing",
      terminal: { state: "succeeded" },
    };
    expect(reduceTui(initial, result).state).toBe(initial);
  });
});

describe("EffectRunner", () => {
  it("returns a correlated terminal result", async () => {
    const runner = new EffectRunner({
      prompt: { run: async () => undefined },
      compatibility: {
        execute: async (name) => ({ state: "succeeded", summary: name }),
      },
    });
    await expect(runner.execute(effect("command:1"), new AbortController().signal)).resolves.toMatchObject({
      effectId: "command:1:effect:0",
      correlationId: "command:1",
      terminal: { state: "succeeded", summary: "model" },
    });
  });
});
