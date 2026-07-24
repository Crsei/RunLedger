import type { TuiEffect } from "../application/types.ts";
import type { CommandDefinition, CommandIntent } from "./types.ts";

const COMPATIBILITY_COMMANDS = [
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
  }, {
    canonicalName: "sessions",
    aliases: [],
    description: "Browse sessions without opening writer authority",
    category: "session",
    presentationOrder: 1,
    arguments: { min: 0, max: 0 },
    draftConsumption: "consume",
    historyPolicy: "ephemeral",
    activeQueryPolicy: "reject",
    executionStrategy: "native",
    availability: (state) => state.capabilities.sessionCatalog.available
      ? { state: "available" }
      : {
          state: "disabled",
          reason: state.capabilities.sessionCatalog.reason ?? "Session catalog is unavailable.",
        },
    redact: (args) => args,
    handler: (_context, intent) => ({
      state: "action",
      action: {
        type: "session.picker.open",
        sourceInvocationId: intent.commandInvocationId,
      },
      summary: "read-only session browser opened",
    }),
  }, {
    canonicalName: "session",
    aliases: [],
    description: "Show canonical metadata for the current session",
    category: "session",
    presentationOrder: 2,
    arguments: { min: 0, max: 0 },
    draftConsumption: "consume",
    historyPolicy: "ephemeral",
    activeQueryPolicy: "reject",
    executionStrategy: "native",
    availability: (state) => state.capabilities.sessionCatalog.available
      ? { state: "available" }
      : {
          state: "disabled",
          reason: state.capabilities.sessionCatalog.reason ?? "Session catalog is unavailable.",
        },
    redact: (args) => args,
    handler: (context, intent) => {
      const generation = context.state.currentSessionDetail.generation + 1;
      const enrichRequestId = `${intent.commandInvocationId}:current-session:${generation}`;
      return {
        state: "effect",
        effect: {
          type: "session.current.enrich",
          effectId: enrichRequestId,
          correlationId: intent.commandInvocationId,
          generation,
          enrichRequestId,
          sessionId: context.state.bootstrap.session.id,
        },
      };
    },
  }, {
    canonicalName: "provider",
    aliases: [],
    description: "Configure provider",
    category: "configuration",
    presentationOrder: 4,
    arguments: { min: 0, max: 0 },
    draftConsumption: "consume",
    historyPolicy: "ephemeral",
    activeQueryPolicy: "reject",
    executionStrategy: "native",
    availability: (state) => state.capabilities.providerWorkflow.available
      ? { state: "available" }
      : {
          state: "disabled",
          reason: state.capabilities.providerWorkflow.reason ??
            "Provider configuration is unavailable.",
        },
    redact: (args) => args,
    handler: (context, intent) => {
      const generation = context.state.providerWorkflow.generation + 1;
      const statusRequestId = `${intent.commandInvocationId}:provider-status:${generation}`;
      return {
        state: "effect",
        effect: {
          type: "provider.status",
          effectId: statusRequestId,
          correlationId: intent.commandInvocationId,
          generation,
          statusRequestId,
        },
      };
    },
  }, {
    canonicalName: "clear",
    aliases: [],
    description: "Clear only committed viewport rows",
    category: "view",
    presentationOrder: 3,
    arguments: { min: 0, max: 0 },
    draftConsumption: "consume",
    historyPolicy: "ephemeral",
    activeQueryPolicy: "immediate",
    executionStrategy: "native",
    availability: () => ({ state: "available" }),
    redact: (args) => args,
    handler: () => ({
      state: "action",
      action: { type: "timeline.viewport.clear" },
      summary: "viewport cleared",
    }),
  }];
  for (let index = 0; index < COMPATIBILITY_COMMANDS.length; index++) {
    const [name, description, category, policy, min, max] = COMPATIBILITY_COMMANDS[index]!;
    commands.push({
      canonicalName: name,
      aliases: [],
      description,
      category,
      presentationOrder: index + 5,
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
