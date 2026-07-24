import type { Component } from "../index.ts";
import type { TimelineRow, TimelineState } from "../timeline/types.ts";
import type { CommandTimelineView } from "../presentation/types.ts";
import { fitLinesToWidth } from "./render-width.ts";

const STATUS_ICON: Record<TimelineRow["status"], string> = {
  pending: "⏳",
  running: "…",
  succeeded: "✓",
  failed: "✗",
  cancelled: "⊘",
  aborted: "!",
};

export class TimelineComponent implements Component {
  private state: TimelineState;
  private commands: readonly CommandTimelineView[] = [];

  constructor(state: TimelineState) {
    this.state = state;
  }

  setState(state: TimelineState): void {
    this.state = state;
  }

  setCommands(commands: readonly CommandTimelineView[]): void {
    this.commands = commands;
  }

  clear(): void {
    this.state = { committedRows: [], activeRowsByCorrelationId: {}, activeOrder: [] };
  }

  invalidate(): void {}

  render(width: number): string[] {
    const rows = [
      ...this.state.committedRows,
      ...this.state.activeOrder.flatMap((id) => {
        const row = this.state.activeRowsByCorrelationId[id];
        return row ? [row] : [];
      }),
    ];
    return fitLinesToWidth([
      ...rows.flatMap(renderRow),
      ...this.commands.map(renderCommand),
    ], width);
  }
}

function renderCommand(command: CommandTimelineView): string {
  const icons = {
    pending: "⏳",
    running: "…",
    succeeded: "✓",
    failed: "✗",
    cancelled: "⊘",
    aborted: "!",
  } as const;
  const args = command.args.length > 0 ? ` ${command.args.join(" ")}` : "";
  return `${icons[command.state]} /${command.canonicalName}${args}${command.summary ? ` — ${command.summary}` : ""}`;
}

function renderRow(row: TimelineRow): string[] {
  const icon = STATUS_ICON[row.status];
  if (row.kind === "user") return row.text.split(/\r?\n/u).map((line, index) => `${index === 0 ? "›" : " "} ${line}`);
  if (row.kind === "assistant") return row.text.split(/\r?\n/u).map((line) => `  ${line}`);
  if (row.kind === "notice") return [`[${row.level}] ${row.text}`];
  if (row.kind !== "tool") return [];
  const output = row.output.split(/\r?\n/u);
  const first = output[0]?.trim() ?? "";
  const suffix = row.truncated ? " …[truncated]" : "";
  return [`${icon} [${row.toolName}]${first ? ` ${first}` : ""}${suffix}`];
}
