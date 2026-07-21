import type { SessionInfo } from "../storage/session-manager.ts";
import { Container, ProcessTerminal, TUI } from "./index.ts";
import { SearchableSelectorModal } from "./components/searchable-selector-modal.ts";

interface SessionSelectorUi {
  addChild(component: Container): void;
  clear(): void;
  hideOverlay(): void;
  requestRender(force?: boolean): void;
  showOverlay(component: SearchableSelectorModal, options: { anchor: "bottom-left" }): void;
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
    const byPath = new Map(sessions.map((session) => [session.filePath, session]));
    const modal = new SearchableSelectorModal({
      title: "Resume session",
      items: sessions.map((session) => ({
        value: session.filePath,
        label: `${session.id}  ${new Date(session.modifiedMs).toLocaleString()}`,
        description: session.cwd ?? session.filePath,
      })),
      maxVisible: 12,
      onSelect: (item) => void finish(byPath.get(item.value)),
      onCancel: () => void finish(undefined),
    });
    ui.showOverlay(modal, { anchor: "bottom-left" });
    ui.start();
  });
}
