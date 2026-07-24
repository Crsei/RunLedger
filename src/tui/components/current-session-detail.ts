import type { Component } from "../index.ts";
import { matchesKey } from "../index.ts";
import type { CurrentSessionDetailState } from "../application/types.ts";
import { fitLinesToWidth } from "./render-width.ts";
import { SessionDetailComponent } from "./session-detail.ts";

export class CurrentSessionDetailComponent implements Component {
  private state: CurrentSessionDetailState;
  private readonly onCancel: () => void;

  constructor(state: CurrentSessionDetailState, onCancel: () => void) {
    this.state = state;
    this.onCancel = onCancel;
  }

  setState(state: CurrentSessionDetailState): void {
    this.state = state;
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.onCancel();
  }

  render(width: number): string[] {
    return [
      ...fitLinesToWidth(["/session — current canonical metadata", "  Esc close"], width),
      ...new SessionDetailComponent(this.state.detail).render(width),
    ];
  }
}
