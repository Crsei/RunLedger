import type {
  TuiAction,
  TuiCommandRecord,
  TuiReduceOutput,
  TuiResult,
  TuiState,
} from "./types.ts";
import type { TuiBootstrapSnapshot } from "../presentation/types.ts";

export function createInitialTuiState(bootstrap: TuiBootstrapSnapshot): TuiState {
  return {
    bootstrap,
    queryGuard: { state: "idle" },
    commandsById: {},
    commandOrder: [],
    queue: [],
    overlay: { state: "closed" },
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

function updateCommandExecution(
  commands: Readonly<Record<string, TuiCommandRecord>>,
  invocationId: string,
  execution: TuiCommandRecord["execution"],
): Readonly<Record<string, TuiCommandRecord>> {
  const current = commands[invocationId];
  if (!current) return commands;
  return { ...commands, [invocationId]: { ...current, execution } };
}
