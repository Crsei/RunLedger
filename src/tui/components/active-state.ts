import type { Component } from "../index.ts";
import type { ActiveStateView } from "../presentation/types.ts";
import { fitToWidth } from "./render-width.ts";

export class ActiveState implements Component {
  private view: ActiveStateView;

  constructor(view: ActiveStateView) {
    this.view = view;
  }

  setView(view: ActiveStateView): void {
    this.view = view;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const parts = [`query:${this.view.query}`];
    if (this.view.recoveryRequired) parts.push("recovery-required");
    if (this.view.frozen) parts.push("frozen");
    if (this.view.activeTurn !== undefined) parts.push(`turn:${this.view.activeTurn}`);
    if (this.view.steeringCount > 0 || this.view.followUpCount > 0) {
      parts.push(`queue:s${this.view.steeringCount}/f${this.view.followUpCount}`);
    }
    return [fitToWidth(parts.join("  "), width)];
  }
}
