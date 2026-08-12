/**
 * B1：createInitialTuiState —— 完整 TuiState initial fixture。
 *
 * 验收点：
 *   - 完整 fixture 能区分 known / unknown / unavailable / empty；
 *   - capability 未提供时 workflow 显式 unavailable（不显示 0/空/伪 connected）；
 *   - capability available 时 workflow idle(generation 0)。
 */

import { describe, expect, it } from "vitest";
import { createInitialTuiState, defaultCapabilities } from "../../../src/tui/application/initial-state.ts";
import type { TuiBootstrapSnapshot } from "../../../src/tui/presentation/types.ts";

const bootstrap: TuiBootstrapSnapshot = {
  workspaceLabel: "acme/runledger",
  session: { id: "session-1", format: "current-canonical", lifecycle: "active" },
  authorityGeneration: 7,
};

describe("B1 createInitialTuiState", () => {
  it("builds a complete TuiState with every workflow having an explicit initial state", () => {
    const state = createInitialTuiState({ bootstrap });
    expect(state.bootstrap).toBe(bootstrap);
    expect(state.authorityGeneration).toBe(7);
    expect(state.capabilities.sessionCatalog.state).toBe("unavailable");
    expect(state.timeline.generation).toBe(0);
    expect(state.timeline.committedRows).toEqual([]);
    expect(state.timeline.activeOrder).toEqual([]);
    expect(state.interaction.overlay).toEqual({ state: "closed" });
    expect(state.interaction.transcriptScrollbarVisible).toBe(false);
    expect(state.commandsById).toEqual({});
    expect(state.commandOrder).toEqual([]);
    expect(state.transientInputQueue).toEqual([]);
    expect(state.queryGuard).toEqual({ state: "idle" });
    expect(state.transitionFrozen).toBe(false);
    expect(state.recoveryRequired).toBe(false);
  });

  it("initializes the transcript scrollbar only from an explicit TUI preference", () => {
    const state = createInitialTuiState({
      bootstrap,
      preferences: { transcriptScrollbarVisible: true },
    } as Parameters<typeof createInitialTuiState>[0]);
    expect(state.interaction.transcriptScrollbarVisible).toBe(true);
    expect(structuredClone(state)).toEqual(state);
    expect(state.interaction).not.toHaveProperty("scrollTop");
  });

  it("distinguishes known vs unknown vs unavailable vs empty", () => {
    const state = createInitialTuiState({
      bootstrap,
      capabilities: { provider: { state: "available" }, process: { state: "unavailable", reason: "no-facade" } },
    });
    // known：bootstrap 提供的事实
    expect(state.bootstrap.session.id).toBe("session-1");
    // unknown：尚未查询的计数类字段
    expect(state.activeTurn.state).toBe("unknown");
    expect(state.steeringCount.state).toBe("unknown");
    expect(state.interaction.search.state).toBe("unknown");
    // unavailable：capability 缺失的 workflow
    expect(state.processWorkflow.state).toBe("unavailable");
    expect(state.processWorkflow).toEqual({ state: "unavailable", reason: "no-facade" });
    expect(state.promptWorkflow.state).toBe("unavailable");
    // empty：显式空集合
    expect(state.timeline.committedRows).toHaveLength(0);
    expect(state.commandsById).toEqual({});
  });

  it("maps available capability to idle workflow initial state", () => {
    const state = createInitialTuiState({
      bootstrap,
      capabilities: {
        provider: { state: "available" },
        model: { state: "available" },
        thinking: { state: "available" },
      },
    });
    expect(state.providerWorkflow).toEqual({ state: "idle", generation: 0 });
    expect(state.modelWorkflow.state).toBe("idle");
    expect(state.thinkingWorkflow.state).toBe("idle");
    expect(state.sessionWorkflow).toEqual({ state: "idle", generation: 0 });
  });

  it("default capabilities are all explicit unavailable with reasons", () => {
    const capabilities = defaultCapabilities();
    for (const [key, value] of Object.entries(capabilities)) {
      expect(value.state, key).toBe("unavailable");
      expect(value.reason.length, key).toBeGreaterThan(0);
    }
    expect(Object.keys(capabilities)).toHaveLength(21);
  });

  it("never fabricates a connected host or zeroed counts", () => {
    const state = createInitialTuiState({ bootstrap });
    for (const field of [state.activeTurn, state.steeringCount, state.followUpCount, state.claimedQueueCount, state.pendingApprovalCount]) {
      expect(field.state).toBe("unknown");
      expect(field.state === "known").toBe(false);
    }
  });
});
