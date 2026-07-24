import type { TuiEffect } from "../application/types.ts";
import type { CommandDefinition, CommandIntent } from "./types.ts";

const COMPATIBILITY_COMMANDS = [
  ["clear", "Clear viewport", "view", "queue", 0, 0],
  ["provider", "Configure provider", "configuration", "reject", 0, 0],
  ["login", "Authenticate provider", "configuration", "reject", 0, 1],
  ["logout", "Remove credential", "configuration", "reject", 0, 1],
  ["model", "Switch model", "configuration", "reject", 0, 0],
  ["thinking", "Switch thinking level", "configuration", "reject", 0, 0],
  ["plugins", "Inspect exact plugin identities", "extensions", "queue", 0, 0],
  ["skills", "Inspect loaded skills", "extensions", "queue", 0, 0],
  ["hooks", "Inspect hook activation", "extensions", "queue", 0, 0],
  ["mcp", "Inspect MCP servers and tools", "extensions", "queue", 0, 0],
  ["reload-extensions", "Reload Extensions at an idle safe point", "extensions", "reject", 0, 0],
  ["prompt", "Pick prompt template", "view", "queue", 0, 0],
  ["quit", "Exit safely", "lifecycle", "reject", 0, 0],
] as const;

export const COMPATIBILITY_COMMAND_NAMES = COMPATIBILITY_COMMANDS.map((item) => item[0]);

export function builtinCommandDefinitions(): readonly CommandDefinition[] {
  const commands: CommandDefinition[] = [{
    canonicalName: "commands",
    aliases: ["help"],
    description: "Browse all available commands",
    category: "help",
    presentationOrder: 0,
    arguments: { min: 0, max: 0 },
    draftConsumption: "consume",
    historyPolicy: "ephemeral",
    activeQueryPolicy: "immediate",
    executionStrategy: "native",
    availability: () => ({ state: "available" }),
    redact: (args) => args,
    handler: (_context, intent) => ({
      state: "action",
      action: {
        type: "overlay.set",
        overlay: { state: "command-palette", sourceInvocationId: intent.commandInvocationId },
      },
      summary: "command palette opened",
    }),
  }];
  for (let index = 0; index < COMPATIBILITY_COMMANDS.length; index++) {
    const [name, description, category, policy, min, max] = COMPATIBILITY_COMMANDS[index]!;
    commands.push({
      canonicalName: name,
      aliases: [],
      description,
      category,
      presentationOrder: index + 1,
      arguments: {
        min,
        max,
        ...(max > 0 ? { usage: "[provider]" } : {}),
      },
      draftConsumption: "consume",
      historyPolicy: "ephemeral",
      activeQueryPolicy: policy,
      executionStrategy: "compatibility",
      availability: () => ({ state: "available" }),
      redact: (args) => args,
      handler: (_context, intent) => ({
        state: "effect",
        effect: compatibilityEffect(intent),
      }),
    });
  }
  return commands;
}

function compatibilityEffect(intent: CommandIntent): TuiEffect {
  return {
    type: "command.compatibility",
    effectId: `${intent.commandInvocationId}:effect:0`,
    correlationId: intent.commandInvocationId,
    canonicalName: intent.canonicalName,
    normalizedArgs: intent.normalizedArgs,
  };
}
