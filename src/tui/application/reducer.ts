import type {
  TuiAction,
  TuiCommandRecord,
  TuiReduceOutput,
  TuiResult,
  TuiState,
  TuiTerminalState,
} from "./types.ts";
import type { TuiBootstrapSnapshot } from "../presentation/types.ts";
import { createSessionPickerState } from "../sessions/picker-reducer.ts";
import type { TuiCapabilitySnapshot, TuiEffect } from "./types.ts";
import {
  providerModelKey,
  type ProviderWorkflowState,
} from "../providers/types.ts";
import type { Api, Model } from "../../types.ts";

export function createInitialTuiState(
  bootstrap: TuiBootstrapSnapshot,
  capabilities: Partial<TuiCapabilitySnapshot> = {},
): TuiState {
  return {
    bootstrap,
    capabilities: {
      sessionCatalog: capabilities.sessionCatalog ?? {
        available: false,
        reason: "Session catalog is unavailable in this TUI.",
      },
      providerWorkflow: capabilities.providerWorkflow ?? {
        available: false,
        reason: "Provider configuration is unavailable in this TUI.",
      },
    },
    queryGuard: { state: "idle" },
    commandsById: {},
    commandOrder: [],
    queue: [],
    overlay: { state: "closed" },
    sessionPicker: createSessionPickerState(),
    currentSessionDetail: {
      generation: 0,
      detail: { state: "idle" },
    },
    providerWorkflow: { state: "idle", generation: 0 },
    viewportClearRevision: 0,
    steeringCount: 0,
    followUpCount: 0,
    transitionFrozen: false,
    recoveryRequired: bootstrap.session.lifecycle === "recovery-required",
  };
}

function putCommand(state: TuiState, record: TuiCommandRecord): TuiState {
  const exists = state.commandsById[record.invocationId] !== undefined;
  return {
    ...state,
    commandsById: { ...state.commandsById, [record.invocationId]: record },
    commandOrder: exists ? state.commandOrder : [...state.commandOrder, record.invocationId],
  };
}

export function reduceTui(
  state: TuiState,
  input: TuiAction | TuiResult,
): TuiReduceOutput {
  switch (input.type) {
    case "effect.dispatch": {
      if (state.queryGuard.state !== "idle" || state.transitionFrozen || state.recoveryRequired) {
        if (!input.command) return { state, effects: [] };
        return {
          state: putCommand(state, {
            ...input.command,
            execution: {
              state: "failed",
              message: state.recoveryRequired
                ? "recovery required"
                : state.transitionFrozen
                  ? "session transition is frozen"
                  : "another query is active",
              retryable: !state.recoveryRequired,
            },
          }),
          effects: [],
        };
      }
      const reserved: TuiState = {
        ...state,
        queryGuard: {
          state: "dispatching",
          correlationId: input.effect.correlationId,
          effectId: input.effect.effectId,
        },
        ...(input.effect.type === "session.current.enrich"
          ? {
              overlay: {
                state: "current-session-detail" as const,
                sourceInvocationId: input.effect.correlationId,
              },
              currentSessionDetail: {
                generation: input.effect.generation,
                invocationId: input.effect.correlationId,
                requestId: input.effect.enrichRequestId,
                sessionId: input.effect.sessionId,
                detail: {
                  state: "loading" as const,
                  requestId: input.effect.enrichRequestId,
                  sessionId: input.effect.sessionId,
                },
              },
            }
          : {}),
        ...(input.effect.type === "provider.status"
          ? {
              overlay: {
                state: "provider-workflow" as const,
                sourceInvocationId: input.effect.correlationId,
              },
              providerWorkflow: {
                state: "loading-providers" as const,
                generation: input.effect.generation,
                invocationId: input.effect.correlationId,
                statusRequestId: input.effect.statusRequestId,
              },
            }
          : {}),
      };
      return {
        state: input.command
          ? putCommand(reserved, { ...input.command, execution: { state: "pending" } })
          : reserved,
        effects: [input.effect],
      };
    }
    case "effect.started":
      if (
        state.queryGuard.state !== "dispatching" ||
        state.queryGuard.effectId !== input.effectId ||
        state.queryGuard.correlationId !== input.correlationId
      ) return { state, effects: [] };
      return {
        state: {
          ...state,
          queryGuard: {
            state: "running",
            effectId: input.effectId,
            correlationId: input.correlationId,
          },
          commandsById: updateCommandExecution(
            state.commandsById,
            input.correlationId,
            { state: "running", effectId: input.effectId },
          ),
        },
        effects: [],
      };
    case "effect.completed":
      if (
        state.queryGuard.state === "idle" ||
        state.queryGuard.effectId !== input.effectId ||
        state.queryGuard.correlationId !== input.correlationId
      ) return { state, effects: [] };
      return {
        state: {
          ...state,
          queryGuard: { state: "idle" },
          commandsById: updateCommandExecution(
            state.commandsById,
            input.correlationId,
            input.terminal,
          ),
        },
        effects: [],
      };
    case "effect.stale":
      return { state, effects: [] };
    case "session.picker.open":
      return beginSessionList(state, "", input.sourceInvocationId, {
        state: "session-picker",
        sourceInvocationId: input.sourceInvocationId,
      });
    case "session.picker.search":
      if (state.overlay.state !== "session-picker") return { state, effects: [] };
      return beginSessionList(state, input.query, state.overlay.sourceInvocationId, state.overlay);
    case "session.picker.select":
    case "session.picker.inspect": {
      if (state.overlay.state !== "session-picker") return { state, effects: [] };
      const sessions = state.sessionPicker.list.state === "ready"
        ? state.sessionPicker.list.value.sessions
        : [];
      if (!sessions.some((session) => session.id === input.sessionId)) {
        return { state, effects: [] };
      }
      return beginSessionEnrich(state, input.sessionId);
    }
    case "session.picker.close": {
      if (state.overlay.state !== "session-picker") return { state, effects: [] };
      const ownedEffectId = ownedSessionEffectId(state);
      return {
        state: {
          ...state,
          overlay: { state: "closed" },
          queryGuard: ownedEffectId ? { state: "idle" } : state.queryGuard,
          sessionPicker: {
            ...state.sessionPicker,
            generation: state.sessionPicker.generation + 1,
            listRequestId: undefined,
            enrichRequestId: undefined,
            previewRequestId: undefined,
            list: { state: "idle" },
            detail: { state: "idle" },
            preview: { state: "idle" },
          },
        },
        effects: [],
        ...(ownedEffectId ? { abortEffectIds: [ownedEffectId] } : {}),
      };
    }
    case "session.list.completed": {
      if (
        state.overlay.state !== "session-picker" ||
        state.sessionPicker.generation !== input.generation ||
        state.sessionPicker.listRequestId !== input.listRequestId ||
        state.queryGuard.state === "idle" ||
        state.queryGuard.effectId !== input.effectId ||
        state.queryGuard.correlationId !== input.correlationId
      ) return { state, effects: [] };
      const list = input.result.ok
        ? input.result.value.sessions.length === 0
          ? { state: "empty" as const, diagnostics: input.result.value.diagnostics }
          : { state: "ready" as const, value: input.result.value }
        : {
            state: "error" as const,
            message: input.result.error.message,
            retryable: input.result.error.retryable,
          };
      const selectedSessionId = input.result.ok && input.result.value.sessions.length > 0
        ? input.result.value.sessions.some((session) =>
            session.id === state.sessionPicker.selectedSessionId
          )
          ? state.sessionPicker.selectedSessionId
          : input.result.value.sessions[0]!.id
        : undefined;
      const listedState: TuiState = {
          ...state,
          queryGuard: { state: "idle" },
          sessionPicker: {
            ...state.sessionPicker,
            list,
            selectedSessionId,
          },
      };
      return selectedSessionId
        ? beginSessionEnrich(listedState, selectedSessionId)
        : { state: listedState, effects: [] };
    }
    case "session.enrich.completed": {
      if (
        state.overlay.state !== "session-picker" ||
        state.sessionPicker.generation !== input.generation ||
        state.sessionPicker.selectedSessionId !== input.sessionId ||
        state.sessionPicker.enrichRequestId !== input.enrichRequestId ||
        state.queryGuard.state === "idle" ||
        state.queryGuard.effectId !== input.effectId ||
        state.queryGuard.correlationId !== input.correlationId
      ) return { state, effects: [] };
      const enrichedState: TuiState = {
          ...state,
          queryGuard: { state: "idle" },
          sessionPicker: {
            ...state.sessionPicker,
            detail: input.result.ok
              ? { state: "ready", value: input.result.value }
              : {
                  state: "error",
                  sessionId: input.sessionId,
                  message: input.result.error.message,
                  retryable: input.result.error.retryable,
                },
          },
      };
      return input.result.ok
        ? beginSessionPreview(enrichedState, input.sessionId)
        : { state: enrichedState, effects: [] };
    }
    case "session.preview.completed": {
      if (
        state.overlay.state !== "session-picker" ||
        state.sessionPicker.generation !== input.generation ||
        state.sessionPicker.selectedSessionId !== input.sessionId ||
        state.sessionPicker.previewRequestId !== input.previewRequestId ||
        state.queryGuard.state === "idle" ||
        state.queryGuard.effectId !== input.effectId ||
        state.queryGuard.correlationId !== input.correlationId
      ) return { state, effects: [] };
      return {
        state: {
          ...state,
          queryGuard: { state: "idle" },
          sessionPicker: {
            ...state.sessionPicker,
            preview: input.result.ok
              ? { state: "ready", value: input.result.value }
              : {
                  state: "error",
                  sessionId: input.sessionId,
                  message: input.result.error.message,
                  retryable: input.result.error.retryable,
                },
          },
        },
        effects: [],
      };
    }
    case "session.current.enrich.completed": {
      if (
        state.overlay.state !== "current-session-detail" ||
        state.currentSessionDetail.generation !== input.generation ||
        state.currentSessionDetail.invocationId !== input.correlationId ||
        state.currentSessionDetail.requestId !== input.enrichRequestId ||
        state.currentSessionDetail.sessionId !== input.sessionId ||
        state.queryGuard.state === "idle" ||
        state.queryGuard.effectId !== input.effectId ||
        state.queryGuard.correlationId !== input.correlationId
      ) return { state, effects: [] };
      const terminal: TuiTerminalState = input.result.ok
        ? { state: "succeeded", summary: "current session details loaded" }
        : {
            state: "failed",
            message: input.result.error.message,
            retryable: input.result.error.retryable,
          };
      return {
        state: {
          ...state,
          queryGuard: { state: "idle" },
          commandsById: updateCommandExecution(
            state.commandsById,
            input.correlationId,
            terminal,
          ),
          currentSessionDetail: {
            ...state.currentSessionDetail,
            detail: input.result.ok
              ? { state: "ready", value: input.result.value }
              : {
                  state: "error",
                  sessionId: input.sessionId,
                  message: input.result.error.message,
                  retryable: input.result.error.retryable,
                },
          },
        },
        effects: [],
      };
    }
    case "session.current.close": {
      if (state.overlay.state !== "current-session-detail") return { state, effects: [] };
      const owns = state.queryGuard.state !== "idle" &&
        state.queryGuard.effectId === state.currentSessionDetail.requestId &&
        state.queryGuard.correlationId === state.currentSessionDetail.invocationId;
      const invocationId = state.currentSessionDetail.invocationId;
      return {
        state: {
          ...state,
          overlay: { state: "closed" },
          queryGuard: owns ? { state: "idle" } : state.queryGuard,
          commandsById: owns && invocationId
            ? updateCommandExecution(state.commandsById, invocationId, {
                state: "cancelled",
                reason: "current session detail closed",
              })
            : state.commandsById,
          currentSessionDetail: {
            generation: state.currentSessionDetail.generation + 1,
            detail: { state: "idle" },
          },
        },
        effects: [],
        ...(owns && state.currentSessionDetail.requestId
          ? { abortEffectIds: [state.currentSessionDetail.requestId] }
          : {}),
      };
    }
    case "provider.status.completed": {
      const workflow = state.providerWorkflow;
      if (
        state.overlay.state !== "provider-workflow" ||
        workflow.state !== "loading-providers" ||
        workflow.generation !== input.generation ||
        workflow.invocationId !== input.correlationId ||
        workflow.statusRequestId !== input.statusRequestId ||
        state.queryGuard.state === "idle" ||
        state.queryGuard.effectId !== input.effectId ||
        state.queryGuard.correlationId !== input.correlationId
      ) return { state, effects: [] };
      if (!input.result.ok || input.result.value.statuses.length === 0) {
        const message = input.result.ok
          ? "No providers are available."
          : input.result.error.message;
        const retryable = input.result.ok ? false : input.result.error.retryable;
        return providerFailure(state, workflow.invocationId, workflow.generation, message, retryable);
      }
      const statusValue = input.result.value;
      const statuses = statusValue.statuses;
      const selectedProviderId = statuses.some((status) =>
          status.id === statusValue.currentSelection.provider
        )
        ? statusValue.currentSelection.provider
        : statuses[0]!.id;
      return {
        state: {
          ...state,
          queryGuard: { state: "idle" },
          commandsById: updateCommandExecution(
            state.commandsById,
            workflow.invocationId,
            { state: "pending", summary: "awaiting provider selection" },
          ),
          providerWorkflow: {
            state: "choosing-provider",
            generation: workflow.generation,
            invocationId: workflow.invocationId,
            statuses,
            query: "",
            selectedProviderId,
            currentSelection: statusValue.currentSelection,
          },
        },
        effects: [],
      };
    }
    case "provider.search": {
      const workflow = state.providerWorkflow;
      if (workflow.state === "choosing-provider") {
        const statuses = filterProviderStatuses(workflow.statuses, input.query);
        return {
          state: {
            ...state,
            providerWorkflow: {
              ...workflow,
              query: input.query,
              selectedProviderId: statuses[0]?.id,
            },
          },
          effects: [],
        };
      }
      if (workflow.state === "choosing-model") {
        const models = filterProviderModels(workflow.models, input.query);
        return {
          state: {
            ...state,
            providerWorkflow: {
              ...workflow,
              query: input.query,
              selectedModelKey: models[0] ? providerModelKey(models[0]) : undefined,
            },
          },
          effects: [],
        };
      }
      return { state, effects: [] };
    }
    case "provider.highlight": {
      const workflow = state.providerWorkflow;
      if (
        workflow.state !== "choosing-provider" ||
        workflow.generation !== input.generation ||
        !filterProviderStatuses(workflow.statuses, workflow.query).some((status) =>
          status.id === input.providerId
        )
      ) return { state, effects: [] };
      return {
        state: {
          ...state,
          providerWorkflow: { ...workflow, selectedProviderId: input.providerId },
        },
        effects: [],
      };
    }
    case "provider.model.highlight": {
      const workflow = state.providerWorkflow;
      if (
        workflow.state !== "choosing-model" ||
        workflow.generation !== input.generation ||
        workflow.providerId !== input.providerId ||
        !filterProviderModels(workflow.models, workflow.query).some((model) =>
          providerModelKey(model) === input.modelKey
        )
      ) return { state, effects: [] };
      return {
        state: {
          ...state,
          providerWorkflow: { ...workflow, selectedModelKey: input.modelKey },
        },
        effects: [],
      };
    }
    case "provider.select": {
      const workflow = state.providerWorkflow;
      if (
        workflow.state !== "choosing-provider" ||
        workflow.generation !== input.generation
      ) return { state, effects: [] };
      const status = filterProviderStatuses(workflow.statuses, workflow.query)
        .find((entry) => entry.id === input.providerId);
      if (!status) return { state, effects: [] };
      if (status.configured) return beginProviderModels(state, workflow, status.id);
      if (status.interactiveAuthTypes.length > 0) {
        const handoffId = `provider-login:${workflow.generation}:${status.id}`;
        return {
          state: {
            ...state,
            overlay: { state: "closed" },
            commandsById: updateCommandExecution(
              state.commandsById,
              workflow.invocationId,
              {
                state: "succeeded",
                summary: `authentication required; handed off to /login ${status.id}`,
              },
            ),
            providerWorkflow: { state: "idle", generation: workflow.generation + 1 },
            providerLoginHandoff: { id: handoffId, providerId: status.id },
          },
          effects: [],
        };
      }
      return providerFailure(
        state,
        workflow.invocationId,
        workflow.generation,
        `${status.name} requires an environment/profile credential; configure it and reopen /provider.`,
        false,
      );
    }
    case "provider.models.completed": {
      const workflow = state.providerWorkflow;
      if (
        state.overlay.state !== "provider-workflow" ||
        workflow.state !== "loading-models" ||
        workflow.generation !== input.generation ||
        workflow.invocationId !== input.correlationId ||
        workflow.modelsRequestId !== input.modelsRequestId ||
        workflow.providerId !== input.providerId ||
        state.queryGuard.state === "idle" ||
        state.queryGuard.effectId !== input.effectId ||
        state.queryGuard.correlationId !== input.correlationId
      ) return { state, effects: [] };
      const models = input.result.ok
        ? input.result.value.models.filter((model) => model.provider === workflow.providerId)
        : [];
      if (!input.result.ok || models.length === 0) {
        return providerFailure(
          state,
          workflow.invocationId,
          workflow.generation,
          input.result.ok
            ? `No available models were returned for ${workflow.providerId}.`
            : input.result.error.message,
          input.result.ok ? false : input.result.error.retryable,
        );
      }
      return {
        state: {
          ...state,
          queryGuard: { state: "idle" },
          commandsById: updateCommandExecution(
            state.commandsById,
            workflow.invocationId,
            { state: "pending", summary: "awaiting model selection" },
          ),
          providerWorkflow: {
            state: "choosing-model",
            generation: workflow.generation,
            invocationId: workflow.invocationId,
            providerId: workflow.providerId,
            models,
            query: "",
            selectedModelKey: providerModelKey(models[0]!),
          },
        },
        effects: [],
      };
    }
    case "provider.model.select": {
      const workflow = state.providerWorkflow;
      if (
        workflow.state !== "choosing-model" ||
        workflow.generation !== input.generation ||
        workflow.providerId !== input.providerId
      ) return { state, effects: [] };
      const model = filterProviderModels(workflow.models, workflow.query)
        .find((entry) => providerModelKey(entry) === input.modelKey);
      if (!model) return { state, effects: [] };
      return beginProviderSelection(state, workflow, model);
    }
    case "provider.select-model.completed": {
      const workflow = state.providerWorkflow;
      if (
        state.overlay.state !== "provider-workflow" ||
        workflow.state !== "applying-selection" ||
        workflow.generation !== input.generation ||
        workflow.invocationId !== input.correlationId ||
        workflow.selectionRequestId !== input.selectionRequestId ||
        workflow.providerId !== input.providerId ||
        workflow.modelKey !== input.modelKey ||
        state.queryGuard.state === "idle" ||
        state.queryGuard.effectId !== input.effectId ||
        state.queryGuard.correlationId !== input.correlationId
      ) return { state, effects: [] };
      if (!input.result.ok) {
        return providerFailure(
          state,
          workflow.invocationId,
          workflow.generation,
          input.result.error.message,
          input.result.error.retryable,
        );
      }
      const selection = input.result.value.selection;
      if (
        selection.provider !== workflow.providerId ||
        !selection.model ||
        providerModelKey(selection.model) !== workflow.modelKey
      ) {
        return providerFailure(
          state,
          workflow.invocationId,
          workflow.generation,
          "provider selection result was not correlated with the requested model",
          false,
        );
      }
      return {
        state: {
          ...state,
          overlay: { state: "closed" },
          queryGuard: { state: "idle" },
          commandsById: updateCommandExecution(
            state.commandsById,
            workflow.invocationId,
            { state: "succeeded", summary: `selected ${workflow.modelKey}` },
          ),
          providerWorkflow: { state: "idle", generation: workflow.generation + 1 },
          providerSelection: {
            generation: workflow.generation,
            providerId: selection.provider,
            modelId: selection.model.id,
            thinkingLevel: selection.thinkingLevel,
          },
        },
        effects: [],
      };
    }
    case "provider.workflow.cancel": {
      const workflow = state.providerWorkflow;
      if (workflow.state === "idle" || workflow.state === "applying-selection") {
        return { state, effects: [] };
      }
      if (workflow.state === "failed" || workflow.state === "cancelled") {
        return {
          state: {
            ...state,
            overlay: { state: "closed" },
            providerWorkflow: { state: "idle", generation: workflow.generation + 1 },
          },
          effects: [],
        };
      }
      const ownedEffectId = providerOwnedEffectId(state, workflow.invocationId);
      return {
        state: {
          ...state,
          overlay: { state: "closed" },
          queryGuard: ownedEffectId ? { state: "idle" } : state.queryGuard,
          commandsById: updateCommandExecution(
            state.commandsById,
            workflow.invocationId,
            { state: "cancelled", reason: "provider selection cancelled" },
          ),
          providerWorkflow: {
            state: "cancelled",
            generation: workflow.generation + 1,
            invocationId: workflow.invocationId,
            reason: "provider selection cancelled",
          },
        },
        effects: [],
        ...(ownedEffectId ? { abortEffectIds: [ownedEffectId] } : {}),
      };
    }
    case "provider.login.handoff.consume":
      if (state.providerLoginHandoff?.id !== input.handoffId) {
        return { state, effects: [] };
      }
      return {
        state: { ...state, providerLoginHandoff: undefined },
        effects: [],
      };
    case "timeline.viewport.clear": {
      const retainedIds = state.commandOrder.filter((id) => {
        const execution = state.commandsById[id]?.execution;
        return execution?.state === "pending" || execution?.state === "running";
      });
      const retainedCommands: Record<string, TuiCommandRecord> = {};
      for (const id of retainedIds) {
        const command = state.commandsById[id];
        if (command) retainedCommands[id] = command;
      }
      return {
        state: {
          ...state,
          commandsById: retainedCommands,
          commandOrder: retainedIds,
          viewportClearRevision: state.viewportClearRevision + 1,
        },
        effects: [],
      };
    }
    case "command.terminal":
      return {
        state: putCommand(state, { ...input.command, execution: input.terminal }),
        effects: [],
      };
    case "command.pending":
      return {
        state: putCommand(state, {
          ...input.command,
          execution: { state: "pending", summary: input.summary },
        }),
        effects: [],
      };
    case "queue.add":
      return { state: { ...state, queue: [...state.queue, input.item] }, effects: [] };
    case "queue.shift":
      return {
        state: { ...state, queue: state.queue.filter((item) => item.id !== input.itemId) },
        effects: [],
      };
    case "overlay.set":
      return { state: { ...state, overlay: input.overlay }, effects: [] };
    case "turn.set":
      return { state: { ...state, activeTurn: input.turn }, effects: [] };
    case "queue.counts":
      return {
        state: {
          ...state,
          steeringCount: input.steering,
          followUpCount: input.followUp,
        },
        effects: [],
      };
    case "transition.freeze":
      return { state: { ...state, transitionFrozen: input.frozen }, effects: [] };
    case "recovery.set":
      return { state: { ...state, recoveryRequired: input.required }, effects: [] };
  }
}

function beginSessionList(
  state: TuiState,
  query: string,
  sourceInvocationId: string,
  overlay: TuiState["overlay"],
): TuiReduceOutput {
  const generation = state.sessionPicker.generation + 1;
  const listRequestId = `${sourceInvocationId}:session-list:${generation}`;
  const previousEffectId = ownedSessionEffectId(state);
  if (state.queryGuard.state !== "idle" && !previousEffectId) {
    return { state, effects: [] };
  }
  const effect: TuiEffect = {
    type: "session.list",
    effectId: listRequestId,
    correlationId: listRequestId,
    generation,
    listRequestId,
    query,
  };
  return {
    state: {
      ...state,
      overlay,
      queryGuard: {
        state: "dispatching",
        effectId: effect.effectId,
        correlationId: effect.correlationId,
      },
      sessionPicker: {
        ...state.sessionPicker,
        generation,
        query,
        selectedSessionId: undefined,
        listRequestId,
        enrichRequestId: undefined,
        previewRequestId: undefined,
        list: { state: "loading", requestId: listRequestId },
        detail: { state: "idle" },
        preview: { state: "idle" },
      },
    },
    effects: [effect],
    ...(previousEffectId ? { abortEffectIds: [previousEffectId] } : {}),
  };
}

function ownedSessionEffectId(state: TuiState): string | undefined {
  if (state.queryGuard.state === "idle") return undefined;
  return state.queryGuard.effectId === state.sessionPicker.listRequestId ||
      state.queryGuard.effectId === state.sessionPicker.enrichRequestId ||
      state.queryGuard.effectId === state.sessionPicker.previewRequestId
    ? state.queryGuard.effectId
    : undefined;
}

function beginSessionEnrich(
  state: TuiState,
  sessionId: string,
): TuiReduceOutput {
  const generation = state.sessionPicker.generation + 1;
  const enrichRequestId = `session-enrich:${sessionId}:${generation}`;
  const previousEffectId = ownedSessionEffectId(state);
  if (state.queryGuard.state !== "idle" && !previousEffectId) {
    return { state, effects: [] };
  }
  const effect: TuiEffect = {
    type: "session.enrich",
    effectId: enrichRequestId,
    correlationId: enrichRequestId,
    generation,
    enrichRequestId,
    sessionId,
  };
  return {
    state: {
      ...state,
      queryGuard: {
        state: "dispatching",
        effectId: effect.effectId,
        correlationId: effect.correlationId,
      },
      sessionPicker: {
        ...state.sessionPicker,
        generation,
        selectedSessionId: sessionId,
        enrichRequestId,
        previewRequestId: undefined,
        detail: { state: "loading", requestId: enrichRequestId, sessionId },
        preview: { state: "idle" },
      },
    },
    effects: [effect],
    ...(previousEffectId ? { abortEffectIds: [previousEffectId] } : {}),
  };
}

function beginSessionPreview(
  state: TuiState,
  sessionId: string,
): TuiReduceOutput {
  const generation = state.sessionPicker.generation + 1;
  const previewRequestId = `session-preview:${sessionId}:${generation}`;
  const previousEffectId = ownedSessionEffectId(state);
  if (state.queryGuard.state !== "idle" && !previousEffectId) {
    return { state, effects: [] };
  }
  const effect: TuiEffect = {
    type: "session.preview",
    effectId: previewRequestId,
    correlationId: previewRequestId,
    generation,
    previewRequestId,
    sessionId,
  };
  return {
    state: {
      ...state,
      queryGuard: {
        state: "dispatching",
        effectId: effect.effectId,
        correlationId: effect.correlationId,
      },
      sessionPicker: {
        ...state.sessionPicker,
        generation,
        previewRequestId,
        preview: { state: "loading", requestId: previewRequestId, sessionId },
      },
    },
    effects: [effect],
    ...(previousEffectId ? { abortEffectIds: [previousEffectId] } : {}),
  };
}

function beginProviderModels(
  state: TuiState,
  workflow: Extract<ProviderWorkflowState, { state: "choosing-provider" }>,
  providerId: string,
): TuiReduceOutput {
  if (state.queryGuard.state !== "idle") return { state, effects: [] };
  const generation = workflow.generation + 1;
  const modelsRequestId = `${workflow.invocationId}:provider-models:${providerId}:${generation}`;
  const effect: TuiEffect = {
    type: "provider.models",
    effectId: modelsRequestId,
    correlationId: workflow.invocationId,
    generation,
    modelsRequestId,
    providerId,
  };
  return {
    state: {
      ...state,
      queryGuard: {
        state: "dispatching",
        effectId: effect.effectId,
        correlationId: effect.correlationId,
      },
      providerWorkflow: {
        state: "loading-models",
        generation,
        invocationId: workflow.invocationId,
        providerId,
        modelsRequestId,
      },
    },
    effects: [effect],
  };
}

function beginProviderSelection(
  state: TuiState,
  workflow: Extract<ProviderWorkflowState, { state: "choosing-model" }>,
  model: Model<Api>,
): TuiReduceOutput {
  if (state.queryGuard.state !== "idle") return { state, effects: [] };
  const generation = workflow.generation + 1;
  const modelKey = providerModelKey(model);
  const selectionRequestId =
    `${workflow.invocationId}:provider-selection:${modelKey}:${generation}`;
  const effect: TuiEffect = {
    type: "provider.select-model",
    effectId: selectionRequestId,
    correlationId: workflow.invocationId,
    generation,
    selectionRequestId,
    providerId: workflow.providerId,
    modelKey,
    model,
  };
  return {
    state: {
      ...state,
      queryGuard: {
        state: "dispatching",
        effectId: effect.effectId,
        correlationId: effect.correlationId,
      },
      providerWorkflow: {
        state: "applying-selection",
        generation,
        invocationId: workflow.invocationId,
        providerId: workflow.providerId,
        modelKey,
        selectionRequestId,
      },
    },
    effects: [effect],
  };
}

function providerFailure(
  state: TuiState,
  invocationId: string,
  generation: number,
  message: string,
  retryable: boolean,
): TuiReduceOutput {
  return {
    state: {
      ...state,
      queryGuard: { state: "idle" },
      commandsById: updateCommandExecution(
        state.commandsById,
        invocationId,
        { state: "failed", message, retryable },
      ),
      providerWorkflow: {
        state: "failed",
        generation,
        invocationId,
        message,
        retryable,
      },
    },
    effects: [],
  };
}

function providerOwnedEffectId(state: TuiState, invocationId: string): string | undefined {
  return state.queryGuard.state !== "idle" &&
      state.queryGuard.correlationId === invocationId &&
      (
        state.providerWorkflow.state === "loading-providers" ||
        state.providerWorkflow.state === "loading-models"
      )
    ? state.queryGuard.effectId
    : undefined;
}

function filterProviderStatuses(
  statuses: Extract<ProviderWorkflowState, { state: "choosing-provider" }>["statuses"],
  query: string,
) {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return statuses;
  return statuses.filter((status) =>
    `${status.id} ${status.name} ${status.source ?? ""}`.toLocaleLowerCase().includes(normalized)
  );
}

function filterProviderModels(
  models: Extract<ProviderWorkflowState, { state: "choosing-model" }>["models"],
  query: string,
) {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return models;
  return models.filter((model) =>
    `${model.provider} ${model.id} ${model.name ?? ""}`.toLocaleLowerCase().includes(normalized)
  );
}

function updateCommandExecution(
  commands: Readonly<Record<string, TuiCommandRecord>>,
  invocationId: string,
  execution: TuiCommandRecord["execution"],
): Readonly<Record<string, TuiCommandRecord>> {
  const current = commands[invocationId];
  if (!current) return commands;
  return { ...commands, [invocationId]: { ...current, execution } };
}
