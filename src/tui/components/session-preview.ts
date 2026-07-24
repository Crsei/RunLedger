import type { Component } from "../index.ts";
import type { SessionPreviewState } from "../sessions/picker-reducer.ts";
import { fitLinesToWidth } from "./render-width.ts";
import { TimelineComponent } from "./timeline.ts";

export class SessionPreviewComponent implements Component {
  private readonly state: SessionPreviewState;

  constructor(state: SessionPreviewState) {
    this.state = state;
  }

  invalidate(): void {}

  handleInput(_data: string): void {}

  render(width: number): string[] {
    if (this.state.state === "idle") return [];
    if (this.state.state === "loading") {
      return fitLinesToWidth(["", "Transcript preview", "  Loading verified preview…"], width);
    }
    if (this.state.state === "error") {
      return fitLinesToWidth(["", "Transcript preview", `  ✗ ${this.state.message}`], width);
    }
    const header = [
      "",
      `Transcript preview${this.state.value.truncated ? " · last bounded messages" : ""}`,
    ];
    return [
      ...fitLinesToWidth(header, width),
      ...new TimelineComponent(this.state.value.timeline).render(width),
    ];
  }
}
