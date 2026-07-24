import type { Component } from "../index.ts";
import { matchesKey } from "../index.ts";
import type { SessionPickerState } from "../sessions/picker-reducer.ts";
import type { SessionSummary } from "../sessions/types.ts";
import { fitLinesToWidth } from "./render-width.ts";

export interface SessionPickerCallbacks {
  onSearch(query: string): void;
  onSelect(sessionId: string): void;
  onInspect(sessionId: string): void;
  onCancel(): void;
}

export class SessionPickerComponent implements Component {
  private state: SessionPickerState;
  private readonly callbacks: SessionPickerCallbacks;

  constructor(state: SessionPickerState, callbacks: SessionPickerCallbacks) {
    this.state = state;
    this.callbacks = callbacks;
  }

  setState(state: SessionPickerState): void {
    this.state = state;
  }

  invalidate(): void {}

  handleInput(data: string): void {
    const sessions = visibleSessions(this.state);
    const selectedIndex = selectedSessionIndex(this.state, sessions);
    if (matchesKey(data, "up")) {
      if (sessions.length > 0) {
        const index = (selectedIndex - 1 + sessions.length) % sessions.length;
        this.callbacks.onSelect(sessions[index]!.id);
      }
      return;
    }
    if (matchesKey(data, "down")) {
      if (sessions.length > 0) {
        const index = (selectedIndex + 1) % sessions.length;
        this.callbacks.onSelect(sessions[index]!.id);
      }
      return;
    }
    if (matchesKey(data, "enter")) {
      const selected = sessions[selectedIndex];
      if (selected) this.callbacks.onInspect(selected.id);
      return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.callbacks.onCancel();
      return;
    }
    if (matchesKey(data, "backspace")) {
      this.callbacks.onSearch(Array.from(this.state.query).slice(0, -1).join(""));
      return;
    }
    if (!/[\u0000-\u001f\u007f]/u.test(data)) {
      this.callbacks.onSearch(this.state.query + data);
    }
  }

  render(width: number): string[] {
    const lines = ["/sessions — read-only", `/ ${this.state.query}`];
    if (this.state.list.state === "loading") lines.push("  Loading sessions…");
    else if (this.state.list.state === "error") lines.push(`✗ ${this.state.list.message}`);
    else if (this.state.list.state === "empty") {
      lines.push("  No matching sessions");
      appendDiagnostics(lines, this.state.list.diagnostics.length);
    } else if (this.state.list.state === "ready") {
      const sessions = this.state.list.value.sessions;
      const selectedIndex = selectedSessionIndex(this.state, sessions);
      for (let index = 0; index < sessions.length; index++) {
        const session = sessions[index]!;
        lines.push(renderSessionRow(session, index === selectedIndex));
      }
      appendDiagnostics(lines, this.state.list.value.diagnostics.length);
      lines.push(`  (${selectedIndex + 1}/${sessions.length})  Enter inspect · Esc close`);
    }
    return fitLinesToWidth(lines, width);
  }
}

function visibleSessions(state: SessionPickerState): readonly SessionSummary[] {
  return state.list.state === "ready" ? state.list.value.sessions : [];
}

function selectedSessionIndex(
  state: SessionPickerState,
  sessions: readonly SessionSummary[],
): number {
  if (sessions.length === 0) return 0;
  const found = sessions.findIndex((session) => session.id === state.selectedSessionId);
  return found >= 0 ? found : 0;
}

function renderSessionRow(session: SessionSummary, selected: boolean): string {
  const current = session.isCurrent ? " · current" : "";
  return `${selected ? "→" : " "} ${session.title}  ${session.id}  ${session.format}${current}  ${formatModified(session.modifiedAt)}`;
}

function formatModified(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return "unknown";
  return new Date(timestamp).toISOString().replace("T", " ").slice(0, 16);
}

function appendDiagnostics(lines: string[], count: number): void {
  if (count > 0) lines.push(`  ${count} unavailable session file${count === 1 ? "" : "s"}`);
}
