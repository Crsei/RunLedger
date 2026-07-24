import type { TuiBootstrapSnapshot } from "../presentation/types.ts";

export type Loadable<T> =
  | { state: "idle" }
  | { state: "loading"; requestId: string }
  | { state: "ready"; value: T }
  | { state: "empty" }
  | { state: "error"; message: string; retryable: boolean };

export type QueryGuard =
  | { state: "idle" }
  | { state: "dispatching"; correlationId: string; effectId: string }
  | { state: "running"; correlationId: string; effectId: string };

export type TuiTerminalState =
  | { state: "succeeded"; summary?: string }
  | { state: "failed"; message: string; retryable: boolean }
  | { state: "cancelled"; reason?: string }
  | { state: "aborted"; reason: string };

export type TuiExecutionState =
  | { state: "pending"; summary?: string }
  | { state: "running"; effectId: string }
  | TuiTerminalState;

export interface TuiCommandRecord {
  invocationId: string;
  canonicalName: string;
  normalizedArgs: readonly string[];
  execution: TuiExecutionState;
}

export interface TuiQueueItem {
  id: string;
  kind: "prompt" | "follow-up" | "slash" | "bash";
  text: string;
  commandInvocationId?: string;
}

export type TuiOverlayState =
  | { state: "closed" }
  | { state: "command-palette"; sourceInvocationId: string };

export interface TuiState {
  bootstrap: TuiBootstrapSnapshot;
  queryGuard: QueryGuard;
  commandsById: Readonly<Record<string, TuiCommandRecord>>;
  commandOrder: readonly string[];
  queue: readonly TuiQueueItem[];
  overlay: TuiOverlayState;
  activeTurn?: number;
  steeringCount: number;
  followUpCount: number;
  transitionFrozen: boolean;
  recoveryRequired: boolean;
}

export type TuiEffect =
  | {
      type: "prompt";
      effectId: string;
      correlationId: string;
      text: string;
      behavior?: "steer" | "followUp";
    }
  | {
      type: "command.compatibility";
      effectId: string;
      correlationId: string;
      canonicalName: string;
      normalizedArgs: readonly string[];
    };

export type TuiAction =
  | {
      type: "effect.dispatch";
      effect: TuiEffect;
      command?: Omit<TuiCommandRecord, "execution">;
    }
  | { type: "effect.started"; effectId: string; correlationId: string }
  | {
      type: "command.terminal";
      command: Omit<TuiCommandRecord, "execution">;
      terminal: TuiTerminalState;
    }
  | {
      type: "command.pending";
      command: Omit<TuiCommandRecord, "execution">;
      summary?: string;
    }
  | { type: "queue.add"; item: TuiQueueItem }
  | { type: "queue.shift"; itemId: string }
  | { type: "overlay.set"; overlay: TuiOverlayState }
  | { type: "turn.set"; turn?: number }
  | { type: "queue.counts"; steering: number; followUp: number }
  | { type: "transition.freeze"; frozen: boolean }
  | { type: "recovery.set"; required: boolean };

export type TuiResult =
  | {
      type: "effect.completed";
      effectId: string;
      correlationId: string;
      terminal: TuiTerminalState;
    }
  | {
      type: "effect.stale";
      effectId: string;
      correlationId: string;
      reason: string;
    };

export interface TuiReduceOutput {
  state: TuiState;
  effects: readonly TuiEffect[];
}
