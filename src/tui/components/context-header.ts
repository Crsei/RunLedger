import type { Component } from "../index.ts";
import type { ContextHeaderView } from "../presentation/types.ts";
import { fitToWidth } from "./render-width.ts";

export class ContextHeader implements Component {
  private view: ContextHeaderView;

  constructor(view: ContextHeaderView) {
    this.view = view;
  }

  setView(view: ContextHeaderView): void {
    this.view = view;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const session = this.view.sessionTitle?.trim() || this.view.sessionId.slice(0, 12);
    return [fitToWidth(
      `${this.view.workspace}  session:${session}  [${this.view.format}/${this.view.lifecycle}]`,
      width,
    )];
  }
}
