import { describe, expect, it } from "vitest";
import type { ProviderStatus } from "../../src/runtime/interactive-session-controller.ts";
import { mockModel } from "../../src/runtime/providers/mock-stream.ts";
import { EffectRunner } from "../../src/tui/application/effect-runner.ts";
import { createInitialTuiState, reduceTui } from "../../src/tui/application/reducer.ts";
import type { TuiEffect } from "../../src/tui/application/types.ts";
import { ProviderPickerComponent } from "../../src/tui/components/provider-picker.ts";
import { executeCommand } from "../../src/tui/commands/executor.ts";
import { parseCommand } from "../../src/tui/commands/parser.ts";
import { CommandRegistry } from "../../src/tui/commands/registry.ts";
import { builtinCommandDefinitions } from "../../src/tui/commands/builtins.ts";

const BOOTSTRAP = {
  workspace: "/workspace",
  session: { id: "session-1", format: "v3" as const, lifecycle: "active" as const },
};

const CONFIGURED: ProviderStatus = {
  id: "mock",
  name: "Mock",
  configured: true,
  source: "auth.json",
  authTypes: ["api_key"],
  interactiveAuthTypes: ["api_key"],
};

const INTERACTIVE: ProviderStatus = {
  id: "oauth",
  name: "OAuth Provider",
  configured: false,
  authTypes: ["oauth"],
  interactiveAuthTypes: ["oauth"],
};

const AMBIENT: ProviderStatus = {
  id: "ambient",
  name: "Ambient Provider",
  configured: false,
  authTypes: ["api_key"],
  interactiveAuthTypes: [],
};

function providerState() {
  return createInitialTuiState(BOOTSTRAP, {
    providerWorkflow: { available: true },
  });
}

function dispatchProvider() {
  const registry = new CommandRegistry(builtinCommandDefinitions());
  const parsed = parseCommand("/provider", registry.snapshot, "command:provider");
  if (!parsed.ok) throw new Error("provider fixture did not parse");
  const output = executeCommand(providerState(), registry.snapshot, parsed.intent);
  const action = output.actions[0]!;
  if (action.type !== "effect.dispatch" || action.effect.type !== "provider.status") {
    throw new Error("provider did not dispatch typed status effect");
  }
  const dispatched = reduceTui(providerState(), action);
  return { dispatched, effect: action.effect };
}

function completeStatuses(
  statuses: readonly ProviderStatus[],
) {
  const { dispatched, effect } = dispatchProvider();
  const running = reduceTui(dispatched.state, {
    type: "effect.started",
    effectId: effect.effectId,
    correlationId: effect.correlationId,
  }).state;
  return reduceTui(running, {
    type: "provider.status.completed",
    effectId: effect.effectId,
    correlationId: effect.correlationId,
    generation: effect.generation,
    statusRequestId: effect.statusRequestId,
    result: {
      ok: true,
      value: {
        statuses,
        currentSelection: { provider: "mock", model: mockModel, thinkingLevel: "off" },
      },
    },
  });
}

describe("native provider workflow reducer", () => {
  it("correlates configured provider status, model loading, and selection on one command row", () => {
    const statuses = completeStatuses([CONFIGURED, INTERACTIVE, AMBIENT]);
    expect(statuses.state.queryGuard).toEqual({ state: "idle" });
    expect(statuses.state.providerWorkflow).toMatchObject({
      state: "choosing-provider",
      invocationId: "command:provider",
      selectedProviderId: "mock",
    });
    expect(statuses.state.commandsById["command:provider"]?.execution).toMatchObject({
      state: "pending",
      summary: "awaiting provider selection",
    });

    const loadingModels = reduceTui(statuses.state, {
      type: "provider.select",
      generation: statuses.state.providerWorkflow.generation,
      providerId: "mock",
    });
    const modelEffect = loadingModels.effects[0]!;
    if (modelEffect.type !== "provider.models") throw new Error("expected provider.models");
    const modelsReady = reduceTui(loadingModels.state, {
      type: "provider.models.completed",
      effectId: modelEffect.effectId,
      correlationId: modelEffect.correlationId,
      generation: modelEffect.generation,
      modelsRequestId: modelEffect.modelsRequestId,
      providerId: modelEffect.providerId,
      result: { ok: true, value: { models: [mockModel] } },
    }).state;
    expect(modelsReady.providerWorkflow).toMatchObject({
      state: "choosing-model",
      selectedModelKey: `${mockModel.provider}/${mockModel.id}`,
    });

    const applying = reduceTui(modelsReady, {
      type: "provider.model.select",
      generation: modelsReady.providerWorkflow.generation,
      providerId: "mock",
      modelKey: `${mockModel.provider}/${mockModel.id}`,
    });
    const selectEffect = applying.effects[0]!;
    if (selectEffect.type !== "provider.select-model") {
      throw new Error("expected provider.select-model");
    }
    const selected = reduceTui(applying.state, {
      type: "provider.select-model.completed",
      effectId: selectEffect.effectId,
      correlationId: selectEffect.correlationId,
      generation: selectEffect.generation,
      selectionRequestId: selectEffect.selectionRequestId,
      providerId: selectEffect.providerId,
      modelKey: selectEffect.modelKey,
      result: {
        ok: true,
        value: {
          selection: { provider: "mock", model: mockModel, thinkingLevel: "off" },
        },
      },
    }).state;
    expect(selected.queryGuard).toEqual({ state: "idle" });
    expect(selected.overlay).toEqual({ state: "closed" });
    expect(selected.commandsById["command:provider"]?.execution).toEqual({
      state: "succeeded",
      summary: `selected ${mockModel.provider}/${mockModel.id}`,
    });
    expect(selected.providerSelection).toMatchObject({
      providerId: "mock",
      modelId: mockModel.id,
    });
  });

  it("hands interactive auth to a new canonical /login invocation and fails ambient-only selection", () => {
    const statuses = completeStatuses([INTERACTIVE, AMBIENT]);
    const handedOff = reduceTui(statuses.state, {
      type: "provider.select",
      generation: statuses.state.providerWorkflow.generation,
      providerId: "oauth",
    }).state;
    expect(handedOff.providerLoginHandoff).toMatchObject({ providerId: "oauth" });
    expect(handedOff.commandsById["command:provider"]?.execution).toEqual({
      state: "succeeded",
      summary: "authentication required; handed off to /login oauth",
    });

    const ambientStatuses = completeStatuses([AMBIENT]);
    const ambient = reduceTui(ambientStatuses.state, {
      type: "provider.select",
      generation: ambientStatuses.state.providerWorkflow.generation,
      providerId: "ambient",
    }).state;
    expect(ambient.commandsById["command:provider"]?.execution).toMatchObject({
      state: "failed",
      message: expect.stringContaining("environment/profile"),
    });
  });

  it("keeps cancellation, load errors, and stale generations on the original invocation", () => {
    const statuses = completeStatuses([CONFIGURED]);
    const stale = reduceTui(statuses.state, {
      type: "provider.select",
      generation: statuses.state.providerWorkflow.generation - 1,
      providerId: "mock",
    });
    expect(stale.state).toBe(statuses.state);
    expect(stale.effects).toHaveLength(0);

    const cancelled = reduceTui(statuses.state, { type: "provider.workflow.cancel" }).state;
    expect(cancelled.commandsById["command:provider"]?.execution).toMatchObject({
      state: "cancelled",
    });
    expect(cancelled.overlay).toEqual({ state: "closed" });

    const { dispatched, effect } = dispatchProvider();
    const failed = reduceTui(dispatched.state, {
      type: "provider.status.completed",
      effectId: effect.effectId,
      correlationId: effect.correlationId,
      generation: effect.generation,
      statusRequestId: effect.statusRequestId,
      result: { ok: false, error: { message: "status load failed", retryable: true } },
    }).state;
    expect(failed.commandsById["command:provider"]?.execution).toMatchObject({
      state: "failed",
      message: "status load failed",
    });
    expect(failed.providerWorkflow).toMatchObject({ state: "failed" });

    const pending = dispatchProvider();
    const cancelledLoad = reduceTui(pending.dispatched.state, {
      type: "provider.workflow.cancel",
    });
    expect(cancelledLoad.abortEffectIds).toEqual([pending.effect.effectId]);
    expect(reduceTui(cancelledLoad.state, {
      type: "provider.status.completed",
      effectId: pending.effect.effectId,
      correlationId: pending.effect.correlationId,
      generation: pending.effect.generation,
      statusRequestId: pending.effect.statusRequestId,
      result: {
        ok: true,
        value: {
          statuses: [CONFIGURED],
          currentSelection: { provider: "mock", model: mockModel, thinkingLevel: "off" },
        },
      },
    }).state).toBe(cancelledLoad.state);
  });

  it("correlates model discovery and selection persistence failures", () => {
    const statuses = completeStatuses([CONFIGURED]);
    const loadingModels = reduceTui(statuses.state, {
      type: "provider.select",
      generation: statuses.state.providerWorkflow.generation,
      providerId: "mock",
    });
    const modelEffect = loadingModels.effects[0]!;
    if (modelEffect.type !== "provider.models") throw new Error("expected provider.models");
    const modelFailure = reduceTui(loadingModels.state, {
      type: "provider.models.completed",
      effectId: modelEffect.effectId,
      correlationId: modelEffect.correlationId,
      generation: modelEffect.generation,
      modelsRequestId: modelEffect.modelsRequestId,
      providerId: modelEffect.providerId,
      result: { ok: false, error: { message: "model load failed", retryable: true } },
    }).state;
    expect(modelFailure.commandsById["command:provider"]?.execution).toMatchObject({
      state: "failed",
      message: "model load failed",
    });

    const secondStatuses = completeStatuses([CONFIGURED]);
    const secondLoading = reduceTui(secondStatuses.state, {
      type: "provider.select",
      generation: secondStatuses.state.providerWorkflow.generation,
      providerId: "mock",
    });
    const secondModelEffect = secondLoading.effects[0]!;
    if (secondModelEffect.type !== "provider.models") throw new Error("expected provider.models");
    const modelsReady = reduceTui(secondLoading.state, {
      type: "provider.models.completed",
      effectId: secondModelEffect.effectId,
      correlationId: secondModelEffect.correlationId,
      generation: secondModelEffect.generation,
      modelsRequestId: secondModelEffect.modelsRequestId,
      providerId: secondModelEffect.providerId,
      result: { ok: true, value: { models: [mockModel] } },
    }).state;
    const applying = reduceTui(modelsReady, {
      type: "provider.model.select",
      generation: modelsReady.providerWorkflow.generation,
      providerId: "mock",
      modelKey: `${mockModel.provider}/${mockModel.id}`,
    });
    const selectEffect = applying.effects[0]!;
    if (selectEffect.type !== "provider.select-model") throw new Error("expected select");
    const selectionFailure = reduceTui(applying.state, {
      type: "provider.select-model.completed",
      effectId: selectEffect.effectId,
      correlationId: selectEffect.correlationId,
      generation: selectEffect.generation,
      selectionRequestId: selectEffect.selectionRequestId,
      providerId: selectEffect.providerId,
      modelKey: selectEffect.modelKey,
      result: {
        ok: false,
        error: { message: "selection persistence failed", retryable: false },
      },
    }).state;
    expect(selectionFailure.commandsById["command:provider"]?.execution).toMatchObject({
      state: "failed",
      message: "selection persistence failed",
    });
  });
});

describe("ProviderPickerComponent", () => {
  it.each([60, 80, 143])("filters and cancels without controller access at %i columns", (width) => {
    const ready = completeStatuses([CONFIGURED, INTERACTIVE]).state;
    const filtered = reduceTui(ready, { type: "provider.search", query: "oauth" }).state;
    const actions: string[] = [];
    const component = new ProviderPickerComponent(filtered.providerWorkflow, {
      onSearch: (query) => actions.push(`search:${query}`),
      onHighlightProvider: () => {},
      onHighlightModel: () => {},
      onSelectProvider: (providerId, generation) =>
        actions.push(`provider:${providerId}:${generation}`),
      onSelectModel: () => {},
      onCancel: () => actions.push("cancel"),
    });
    const rendered = component.render(width);
    expect(rendered.every((line) => line.length <= width)).toBe(true);
    expect(rendered.join("\n")).toContain("OAuth Provider");
    expect(rendered.join("\n")).not.toContain("Mock");
    component.handleInput("\x7f");
    component.handleInput("\r");
    component.handleInput("\x1b");
    expect(actions).toEqual([
      "search:oaut",
      `provider:${INTERACTIVE.id}:${filtered.providerWorkflow.generation}`,
      "cancel",
    ]);
  });
});

describe("provider EffectRunner", () => {
  it("normalizes select failures into the matching typed result", async () => {
    const providerEffect: TuiEffect = {
      type: "provider.select-model",
      effectId: "select:1",
      correlationId: "command:provider",
      generation: 3,
      selectionRequestId: "select:1",
      providerId: "mock",
      modelKey: `${mockModel.provider}/${mockModel.id}`,
      model: mockModel,
    };
    const runner = new EffectRunner({
      prompt: { run: async () => undefined },
      compatibility: {
        execute: async () => ({ state: "succeeded" }),
      },
      providerWorkflow: {
        currentSelection: { provider: "mock", model: mockModel, thinkingLevel: "off" },
        getProviderStatuses: async () => [CONFIGURED],
        getAvailableModels: async () => [mockModel],
        login: async () => {
          throw new Error("not used");
        },
        selectModel: async () => {
          throw new Error("selection persistence failed");
        },
      },
    });
    await expect(
      runner.execute(providerEffect, new AbortController().signal),
    ).resolves.toMatchObject({
      type: "provider.select-model.completed",
      selectionRequestId: "select:1",
      result: {
        ok: false,
        error: { message: expect.stringContaining("selection persistence failed") },
      },
    });
  });
});
