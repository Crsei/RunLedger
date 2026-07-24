import type { TuiAction, TuiCommandRecord, TuiState } from "../application/types.ts";
import type {
  CommandDecision,
  CommandExecutionOutput,
  CommandIntent,
  CommandRegistrySnapshot,
} from "./types.ts";
import { terminalDecision } from "./types.ts";

export function executeCommand(
  state: TuiState,
  snapshot: CommandRegistrySnapshot,
  intent: CommandIntent,
): CommandExecutionOutput {
  const definition = snapshot.byName[intent.canonicalName];
  const command = commandRecord(intent);
  if (intent.catalogGeneration !== snapshot.generation || !definition) {
    return terminal(command, "command catalog changed; reopen the palette", false);
  }
  const availability = definition.availability(state);
  if (availability.state === "hidden") return terminal(command, "command is hidden", false);
  if (availability.state === "disabled") return terminal(command, availability.reason, false);

  if (state.queryGuard.state !== "idle") {
    if (definition.activeQueryPolicy === "reject") {
      return terminal(command, "another query is active", true);
    }
    if (definition.activeQueryPolicy === "queue") {
      return {
        actions: [
          { type: "command.pending", command, summary: "queued" },
          {
            type: "queue.add",
            item: {
              id: `queue:${intent.commandInvocationId}`,
              kind: "slash",
              text: `/${intent.canonicalName}${intent.normalizedArgs.length > 0 ? ` ${intent.normalizedArgs.join(" ")}` : ""}`,
              commandInvocationId: intent.commandInvocationId,
            },
          },
        ],
      };
    }
  }

  const decision = definition.handler({ state }, intent);
  if (definition.activeQueryPolicy === "immediate" && (
    decision.state === "effect" || decision.state === "queued"
  )) {
    return terminal(command, "immediate command attempted an effect", false);
  }
  return mapDecision(command, decision);
}

function commandRecord(intent: CommandIntent): Omit<TuiCommandRecord, "execution"> {
  return {
    invocationId: intent.commandInvocationId,
    canonicalName: intent.canonicalName,
    normalizedArgs: intent.normalizedArgs,
  };
}

function terminal(
  command: Omit<TuiCommandRecord, "execution">,
  message: string,
  retryable: boolean,
): CommandExecutionOutput {
  return {
    actions: [{
      type: "command.terminal",
      command,
      terminal: { state: "failed", message, retryable },
    }],
  };
}

function mapDecision(
  command: Omit<TuiCommandRecord, "execution">,
  decision: CommandDecision,
): CommandExecutionOutput {
  switch (decision.state) {
    case "effect":
      return { actions: [{ type: "effect.dispatch", effect: decision.effect, command }] };
    case "action":
      return {
        actions: [
          decision.action,
          {
            type: "command.terminal",
            command,
            terminal: { state: "succeeded", summary: decision.summary },
          },
        ],
      };
    case "queued":
      return {
        actions: [
          { type: "command.pending", command, summary: "queued" },
          {
            type: "queue.add",
            item: {
              id: decision.queueItemId,
              kind: "slash",
              text: decision.text,
              commandInvocationId: command.invocationId,
            },
          },
        ],
      };
    default:
      return {
        actions: [{
          type: "command.terminal",
          command,
          terminal: terminalDecision(decision),
        }],
      };
  }
}
