import type { TuiTerminalState } from "./types.ts";
import type { SessionCatalogPort } from "../sessions/catalog.ts";

export interface PromptEffectPort {
  run(
    text: string,
    behavior: "steer" | "followUp" | undefined,
    signal: AbortSignal,
  ): Promise<void>;
}

export interface CompatibilityEffectPort {
  execute(
    canonicalName: string,
    normalizedArgs: readonly string[],
    signal: AbortSignal,
  ): Promise<TuiTerminalState>;
}

export interface TuiEffectPorts {
  prompt: PromptEffectPort;
  compatibility: CompatibilityEffectPort;
  sessionCatalog?: SessionCatalogPort;
}
