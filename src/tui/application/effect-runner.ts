import type { TuiEffect, TuiResult, TuiTerminalState } from "./types.ts";
import type { TuiEffectPorts } from "./effects.ts";

export class EffectRunner {
  private readonly ports: TuiEffectPorts;

  constructor(ports: TuiEffectPorts) {
    this.ports = ports;
  }

  async execute(effect: TuiEffect, signal: AbortSignal): Promise<TuiResult> {
    try {
      let terminal: TuiTerminalState;
      if (effect.type === "prompt") {
        await this.ports.prompt.run(effect.text, effect.behavior, signal);
        terminal = { state: "succeeded" };
      } else {
        terminal = await this.ports.compatibility.execute(
          effect.canonicalName,
          effect.normalizedArgs,
          signal,
        );
      }
      return {
        type: "effect.completed",
        effectId: effect.effectId,
        correlationId: effect.correlationId,
        terminal,
      };
    } catch (error) {
      const terminal: TuiTerminalState = signal.aborted
        ? { state: "aborted", reason: String(signal.reason ?? "aborted") }
        : { state: "failed", message: String(error), retryable: false };
      return {
        type: "effect.completed",
        effectId: effect.effectId,
        correlationId: effect.correlationId,
        terminal,
      };
    }
  }
}
