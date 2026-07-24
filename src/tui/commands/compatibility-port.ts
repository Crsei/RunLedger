import type { TuiTerminalState } from "../application/types.ts";
import type { CompatibilityEffectPort } from "../application/effects.ts";

export type CompatibilityCommandHandler = (
  args: readonly string[],
  signal: AbortSignal,
) => Promise<TuiTerminalState> | TuiTerminalState;

export class MappedCompatibilityCommandPort implements CompatibilityEffectPort {
  private readonly handlers: Readonly<Record<string, CompatibilityCommandHandler>>;

  constructor(handlers: Readonly<Record<string, CompatibilityCommandHandler>>) {
    this.handlers = { ...handlers };
  }

  execute(
    canonicalName: string,
    normalizedArgs: readonly string[],
    signal: AbortSignal,
  ): Promise<TuiTerminalState> {
    const handler = this.handlers[canonicalName];
    if (!handler) {
      return Promise.resolve({
        state: "failed",
        message: `compatibility command is not wired: /${canonicalName}`,
        retryable: false,
      });
    }
    return Promise.resolve(handler(normalizedArgs, signal));
  }
}
