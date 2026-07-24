import type { Component } from "../index.ts";
import type { SessionDetailState } from "../sessions/picker-reducer.ts";
import { fitLinesToWidth } from "./render-width.ts";

export class SessionDetailComponent implements Component {
  private readonly state: SessionDetailState;

  constructor(state: SessionDetailState) {
    this.state = state;
  }

  invalidate(): void {}

  handleInput(_data: string): void {}

  render(width: number): string[] {
    if (this.state.state === "idle") return [];
    if (this.state.state === "loading") {
      return fitLinesToWidth(["", "Session detail", "  Loading verified metadata…"], width);
    }
    if (this.state.state === "error") {
      return fitLinesToWidth(["", "Session detail", `  ✗ ${this.state.message}`], width);
    }
    const detail = this.state.value;
    const summary = detail.summary;
    return fitLinesToWidth([
      "",
      "Session detail",
      `  id: ${summary.id}`,
      `  cwd: ${summary.cwd ?? "unknown"}`,
      `  created: ${formatTimestamp(summary.createdAt)}`,
      `  modified: ${formatTimestamp(summary.modifiedAt)}`,
      `  format: ${summary.format}`,
      `  lifecycle: ${summary.lifecycle}`,
      `  compatibility: ${summary.compatibility}`,
      `  counts: messages=${numberOrUnknown(detail.messageCount)} turns=${numberOrUnknown(detail.turnCount)} tools=${numberOrUnknown(detail.toolCount)}`,
      `  runtime: ${detail.provider ?? "unknown"}/${detail.model ?? "unknown"} · think:${detail.thinkingLevel ?? "unknown"}`,
      `  head: ${detail.headSequence ?? "unknown"} ${detail.headEventHash ?? ""}`.trimEnd(),
      `  parent: ${detail.parentSessionId ?? "none"}`,
    ], width);
  }
}

function numberOrUnknown(value: number | undefined): string {
  return value === undefined ? "unknown" : String(value);
}

function formatTimestamp(value: number): string {
  return Number.isFinite(value) ? new Date(value).toISOString() : "unknown";
}
