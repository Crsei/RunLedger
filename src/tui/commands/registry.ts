import type { CommandDefinition, CommandRegistrySnapshot } from "./types.ts";

export class CommandRegistry {
  private generation = 0;
  private snapshotValue: CommandRegistrySnapshot = {
    generation: 0,
    definitions: [],
    byName: {},
  };

  constructor(definitions: readonly CommandDefinition[] = []) {
    this.replace(definitions);
  }

  get snapshot(): CommandRegistrySnapshot {
    return this.snapshotValue;
  }

  replace(definitions: readonly CommandDefinition[]): CommandRegistrySnapshot {
    const byName: Record<string, CommandDefinition> = {};
    const ordered = [...definitions].sort((a, b) =>
      a.presentationOrder - b.presentationOrder ||
      a.canonicalName.localeCompare(b.canonicalName)
    );
    for (const definition of ordered) {
      const names = [definition.canonicalName, ...definition.aliases];
      for (const name of names) {
        if (byName[name]) throw new Error(`duplicate command name or alias: ${name}`);
        byName[name] = definition;
      }
    }
    this.generation += 1;
    this.snapshotValue = {
      generation: this.generation,
      definitions: ordered,
      byName: Object.freeze(byName),
    };
    return this.snapshotValue;
  }
}
