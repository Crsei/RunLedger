import type { SessionInfo } from "../storage/session-manager.ts";
import { Container, ProcessTerminal, TUI, type Component } from "./index.ts";
import { SessionPickerComponent } from "./components/session-picker.ts";
import { createSessionPickerState } from "./sessions/picker-reducer.ts";
import type { SessionSummary } from "./sessions/types.ts";

interface SessionSelectorUi {
  addChild(component: Container): void;
  clear(): void;
  hideOverlay(): void;
  requestRender(force?: boolean): void;
  showOverlay(component: Component, options: { anchor: "bottom-left" }): void;
  start(): void;
  stop(): void;
}

export interface SessionSelectorDependencies {
  createUi(): SessionSelectorUi;
}

const DEFAULT_DEPENDENCIES: SessionSelectorDependencies = {
  createUi: () => {
    const terminal = new ProcessTerminal();
    return new TUI(terminal, false);
  },
};

/** CLI --resume 启动前选择器;取消时不打开或创建任何 ledger。 */
export async function selectSessionInTui(
  sessions: readonly SessionInfo[],
  dependencies: SessionSelectorDependencies = DEFAULT_DEPENDENCIES,
): Promise<SessionInfo | undefined> {
  if (sessions.length === 0) return undefined;
  const ui = dependencies.createUi();
  ui.addChild(new Container());
  return new Promise((resolve) => {
    let settled = false;
    const finish = async (session: SessionInfo | undefined): Promise<void> => {
      if (settled) return;
      settled = true;
      ui.hideOverlay();
      ui.clear();
      ui.requestRender(true);
      await new Promise((rendered) => setTimeout(rendered, 25));
      ui.stop();
      resolve(session);
    };
    const summaries = sessions.map(toSummary).sort((left, right) =>
      right.modifiedAt - left.modifiedAt
    );
    const byId = new Map(sessions.map((session) => [session.id, session]));
    let pickerState = {
      ...createSessionPickerState(),
      generation: 1,
      selectedSessionId: summaries[0]?.id,
      list: summaries.length > 0
        ? { state: "ready" as const, value: { sessions: summaries, diagnostics: [] } }
        : { state: "empty" as const, diagnostics: [] },
    };
    let modal: SessionPickerComponent;
    const update = (query: string): void => {
      const normalized = query.trim().toLocaleLowerCase();
      const filtered = normalized.length === 0
        ? summaries
        : summaries.filter((summary) =>
          `${summary.id} ${summary.title}`.toLocaleLowerCase().includes(normalized)
        );
      pickerState = {
        ...pickerState,
        generation: pickerState.generation + 1,
        query,
        selectedSessionId: filtered[0]?.id,
        list: filtered.length > 0
          ? { state: "ready", value: { sessions: filtered, diagnostics: [] } }
          : { state: "empty", diagnostics: [] },
      };
      modal.setState(pickerState);
      ui.requestRender();
    };
    modal = new SessionPickerComponent(pickerState, {
      onSearch: update,
      onSelect: (sessionId) => {
        pickerState = { ...pickerState, selectedSessionId: sessionId };
        modal.setState(pickerState);
        ui.requestRender();
      },
      onInspect: (sessionId) => void finish(byId.get(sessionId)),
      onCancel: () => void finish(undefined),
    });
    ui.showOverlay(modal, { anchor: "bottom-left" });
    ui.start();
  });
}

function toSummary(session: SessionInfo): SessionSummary {
  const format = session.version === 1
    ? "v1"
    : session.version === 3 || session.format === "v3"
      ? "v3"
      : "v2";
  return {
    id: session.id,
    title: "Untitled session",
    ...(session.cwd ? { cwd: session.cwd } : {}),
    createdAt: session.createdAt,
    modifiedAt: session.modifiedMs,
    format,
    compatibility: format === "v1" ? "migration-required" : "read-only",
    lifecycle: "unknown",
    isCurrent: false,
  };
}
