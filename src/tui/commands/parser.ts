import type { CommandRegistrySnapshot, ParsedCommand } from "./types.ts";

export function parseCommand(
  text: string,
  snapshot: CommandRegistrySnapshot,
  invocationId: string,
): ParsedCommand {
  if (!text.startsWith("/")) return { ok: false, message: "command must start with /" };
  const body = text.slice(1).trim();
  if (body.length === 0) return { ok: false, message: "command name is required" };
  const [rawName, ...args] = body.split(/[ \t\r\n]+/u);
  const definition = snapshot.byName[rawName ?? ""];
  if (!definition) return { ok: false, message: `Unknown command: /${rawName ?? ""}` };
  if (args.length < definition.arguments.min || args.length > definition.arguments.max) {
    const usage = definition.arguments.usage
      ? ` Usage: /${definition.canonicalName} ${definition.arguments.usage}`
      : "";
    return {
      ok: false,
      canonicalName: definition.canonicalName,
      message: `Invalid arguments for /${definition.canonicalName}.${usage}`,
    };
  }
  return {
    ok: true,
    intent: {
      commandInvocationId: invocationId,
      canonicalName: definition.canonicalName,
      normalizedArgs: args,
      catalogGeneration: snapshot.generation,
    },
  };
}
