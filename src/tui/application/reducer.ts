import type {
  TuiAction,
  TuiCommandRecord,
  TuiReduceOutput,
  TuiResult,
  TuiState,
} from "./types.ts";
import type { TuiBootstrapSnapshot } from "../presentation/types.ts";
import { createSessionPickerState } from "../sessions/picker-reducer.ts";
import type { TuiCapabilitySnapshot, TuiEffect } from "./types.ts";

export function createInitialTuiState(
  bootstrap: TuiBootstrapSnapshot,
  capabilities: TuiCapabilitySnapshot = {
    sessionCatalog: {
      available: false,
      reason: "Session catalog is unavailable in this TUI.",
    },
  },
): TuiState {
  return {
    bootstrap,
    capabilities,
    queryGuard: { state: "idle" },
    commandsById: {},
    commandOrder: [],
    queue: [],
    overlay: { state: "closed" },
    sessionPicker: createSessionPickerState(),
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
      return {
        state: {
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
        },
        effects: [],
      };
    }
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

function updateCommandExecution(
  commands: Readonly<Record<string, TuiCommandRecord>>,
  invocationId: string,
  execution: TuiCommandRecord["execution"],
): Readonly<Record<string, TuiCommandRecord>> {
  const current = commands[invocationId];
  if (!current) return commands;
  return { ...commands, [invocationId]: { ...current, execution } };
}
