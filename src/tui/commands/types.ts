import type {
  TuiAction,
  TuiEffect,
  TuiState,
  TuiTerminalState,
} from "../application/types.ts";

export type CommandAvailability =
  | { state: "available" }
  | { state: "disabled"; reason: string }
  | { state: "hidden" };

export interface CommandIntent {
  commandInvocationId: string;
  canonicalName: string;
  normalizedArgs: readonly string[];
  catalogGeneration: number;
}

export type CommandDecision =
  | { state: "handled"; summary?: string }
  | { state: "message"; text: string }
  | { state: "action"; action: TuiAction; summary?: string }
  | { state: "effect"; effect: TuiEffect }
  | { state: "queued"; queueItemId: string; text: string }
  | { state: "failed"; message: string; retryable: boolean }
  | { state: "cancelled"; reason?: string }
  | { state: "aborted"; reason: string };

export interface CommandArgumentSchema {
  min: number;
  max: number;
  usage?: string;
}

export interface CommandHandlerContext {
  state: TuiState;
}

export interface CommandDefinition {
  canonicalName: string;
  aliases: readonly string[];
  description: string;
  category: string;
  presentationOrder: number;
  arguments: CommandArgumentSchema;
  draftConsumption: "consume" | "preserve";
  historyPolicy: "ephemeral" | "session" | "audit";
  activeQueryPolicy: "immediate" | "queue" | "reject";
  executionStrategy: "native" | "compatibility";
  availability(state: TuiState): CommandAvailability;
  redact(args: readonly string[]): readonly string[];
  handler(context: CommandHandlerContext, intent: CommandIntent): CommandDecision;
}

export interface CommandRegistrySnapshot {
  generation: number;
  definitions: readonly CommandDefinition[];
  byName: Readonly<Record<string, CommandDefinition>>;
}

export type ParsedCommand =
  | { ok: true; intent: CommandIntent }
  | { ok: false; message: string; canonicalName?: string };

export interface CommandExecutionOutput {
  actions: readonly TuiAction[];
}

export function terminalDecision(decision: Exclude<
  CommandDecision,
  { state: "action" | "effect" | "queued" }
>): TuiTerminalState {
  switch (decision.state) {
    case "handled":
      return { state: "succeeded", summary: decision.summary };
    case "message":
      return { state: "succeeded", summary: decision.text };
    case "failed":
      return { state: "failed", message: decision.message, retryable: decision.retryable };
    case "cancelled":
      return { state: "cancelled", reason: decision.reason };
    case "aborted":
      return { state: "aborted", reason: decision.reason };
  }
}
