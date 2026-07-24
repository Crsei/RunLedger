import { reduceTui } from "./reducer.ts";
import type { EffectRunner } from "./effect-runner.ts";
import type { TuiAction, TuiResult, TuiState } from "./types.ts";

export interface InteractiveShellOptions {
  initialState: TuiState;
  runner: EffectRunner;
  onState(state: TuiState): void;
}

export class InteractiveShell {
  private stateValue: TuiState;
  private readonly runner: EffectRunner;
  private readonly onState: (state: TuiState) => void;
  private readonly controllers = new Map<string, AbortController>();

  constructor(options: InteractiveShellOptions) {
    this.stateValue = options.initialState;
    this.runner = options.runner;
    this.onState = options.onState;
  }

  get state(): TuiState {
    return this.stateValue;
  }

  dispatch(input: TuiAction | TuiResult): void {
    const reduced = reduceTui(this.stateValue, input);
    this.stateValue = reduced.state;
    this.onState(this.stateValue);
    for (const effectId of reduced.abortEffectIds ?? []) {
      this.controllers.get(effectId)?.abort("replaced by newer TUI effect");
    }
    for (const effect of reduced.effects) {
      const controller = new AbortController();
      this.controllers.set(effect.effectId, controller);
      this.dispatch({
        type: "effect.started",
        effectId: effect.effectId,
        correlationId: effect.correlationId,
      });
      void this.runner.execute(effect, controller.signal).then((result) => {
        this.controllers.delete(effect.effectId);
        this.dispatch(result);
      });
    }
  }

  abort(effectId: string, reason: string): void {
    this.controllers.get(effectId)?.abort(reason);
  }
}
