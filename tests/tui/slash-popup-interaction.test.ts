import { describe, expect, it } from "vitest";
import { Agent } from "../../src/runtime/agent.ts";
import { mockModel } from "../../src/runtime/providers/mock-stream.ts";
import type { AssistantMessage, AssistantMessageEventStream } from "../../src/types.ts";
import type { StreamFn } from "../../src/runtime/types.ts";
import { InteractiveMode } from "../../src/tui/interactive-mode.ts";
import { TUI, type Terminal } from "../../src/tui/index.ts";
import { SlashCommandPopup } from "../../src/tui/components/slash-command-popup.ts";
import { SelectionView } from "../../src/tui/components/selection-view.ts";
import type { CustomEditor } from "../../src/tui/components/custom-editor.ts";
import { createAssistantMessageEventStream } from "../../src/utils/event-stream.ts";

class FakeTerminal implements Terminal {
  private input: ((data: string) => void) | undefined;
  readonly writes: string[] = [];
  startCount = 0;
  stopCount = 0;

  get columns(): number { return 100; }
  get rows(): number { return 30; }
  get kittyProtocolActive(): boolean { return false; }

  start(onInput: (data: string) => void): void {
    this.startCount += 1;
    this.input = onInput;
  }
  stop(): void {
    this.stopCount += 1;
    this.input = undefined;
  }
  async drainInput(): Promise<void> {}
  write(data: string): void { this.writes.push(data); }
  moveBy(_lines: number): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(_title: string): void {}
  setProgress(_active: boolean): void {}

  send(data: string): void {
    this.input?.(data);
  }
}

function stoppedAssistant(stopReason: "stop" | "aborted" = "stop"): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: mockModel.api,
    provider: mockModel.provider,
    model: mockModel.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    ...(stopReason === "aborted" ? { stopReason: "aborted" as const } : {}),
  };
}

function immediateStopStream(): StreamFn {
  return async (_ctx, _signal): Promise<AssistantMessageEventStream> =>
    createAssistantMessageEventStream([{ type: "message_start" }, { type: "done", message: stoppedAssistant() }]);
}

function interruptibleStream(): {
  streamFn: StreamFn;
  started: Promise<void>;
  signal(): AbortSignal | undefined;
} {
  let capturedSignal: AbortSignal | undefined;
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const streamFn: StreamFn = (_model, _context, options) => {
    const stream: AssistantMessageEventStream = createAssistantMessageEventStream();
    capturedSignal = options?.signal;
    queueMicrotask(() => {
      stream.push({ type: "start", partial: stoppedAssistant() });
      const finish = (): void => {
        stream.push({ type: "error", reason: "aborted", error: stoppedAssistant("aborted") });
        stream.end(stoppedAssistant("aborted"));
      };
      if (capturedSignal?.aborted) finish();
      else capturedSignal?.addEventListener("abort", finish, { once: true });
      markStarted?.();
    });
    return stream;
  };
  return { streamFn, started, signal: () => capturedSignal };
}

interface ModeInternals {
  refs: { editor: CustomEditor };
  slashPopup: SlashCommandPopup | undefined;
  dismissedCommandToken: string | undefined;
}

function setupMode(): { terminal: FakeTerminal; mode: InteractiveMode; internals: ModeInternals } {
  const terminal = new FakeTerminal();
  const agent = new Agent({ initialState: { systemPrompt: "test", model: mockModel }, streamFn: immediateStopStream() });
  const mode = new InteractiveMode({ agent, terminal });
  const internals = mode as unknown as ModeInternals;
  return { terminal, mode, internals };
}

function timelineText(mode: InteractiveMode): string {
  const state = mode.getTuiState();
  return state.timeline.committedRows
    .map((row) => (row.kind === "notice" ? row.message.text : ""))
    .join("\n");
}

async function quit(mode: InteractiveMode, internals: ModeInternals, terminal: FakeTerminal, running: Promise<unknown>): Promise<void> {
  const ui = (mode as unknown as { ui: TUI }).ui;
  // 捕获型 modal overlay 打开时先 Esc 关闭,否则 Ctrl+D 到不了 handleCtrlD
  if (ui.hasOverlay()) terminal.send("\x1b");
  internals.refs.editor.setText("");
  terminal.send("\x04");
  await running;
}

describe("slash popup 输入期状态机(对照 codex slash_popup_model_first_for_mo_ui)", () => {
  it("/ → /m → /mo 弹窗出现并随键入过滤,选中 model", async () => {
    const { terminal, internals, mode } = setupMode();
    const running = mode.run();
    try {
      expect(internals.slashPopup).toBeUndefined();

      terminal.send("/");
      expect(internals.slashPopup).toBeDefined();
      expect(internals.slashPopup?.getVisibleRows().length).toBeGreaterThan(20);
      expect(internals.slashPopup?.getVisibleRows().some((row) => row.command.canonicalName === "help")).toBe(false);

      terminal.send("m");
      const rows = internals.slashPopup!.getVisibleRows().map((row) => row.command.canonicalName);
      expect(rows.every((name) => name.startsWith("m"))).toBe(true);
      expect(rows[0]).toBe("model");

      terminal.send("o");
      const rows2 = internals.slashPopup!.getVisibleRows().map((row) => row.command.canonicalName);
      expect(rows2).toEqual(["model"]);
      expect(internals.slashPopup?.selectedItem()?.canonicalName).toBe("model");
    } finally {
      await quit(mode, internals, terminal, running);
    }
  });

  it("Tab 补全为 /cmd + 空格,非内联命令整串替换", async () => {
    const { terminal, internals, mode } = setupMode();
    const running = mode.run();
    try {
      terminal.send("/");
      terminal.send("mo");
      terminal.send("\t");
      expect(internals.refs.editor.getText()).toBe("/model ");
    } finally {
      await quit(mode, internals, terminal, running);
    }
  });

  it("隐藏 /help 后不通过 /commands 别名暴露补全项", async () => {
    const { terminal, internals, mode } = setupMode();
    const running = mode.run();
    try {
      terminal.send("/");
      terminal.send("co");
      expect(internals.slashPopup?.getVisibleRows().map((row) => row.name)).toEqual(["compact"]);
    } finally {
      await quit(mode, internals, terminal, running);
    }
  });

  it("Esc 关闭;同一 token 不重弹(空格/回退),token 变化后恢复", async () => {
    const { terminal, internals, mode } = setupMode();
    const running = mode.run();
    try {
      terminal.send("/");
      terminal.send("mo");
      expect(internals.slashPopup).toBeDefined();

      terminal.send("\x1b");
      expect(internals.slashPopup).toBeUndefined();
      expect(internals.dismissedCommandToken).toBe("mo");

      // 空格与回退不改变 token:保持关闭
      terminal.send(" ");
      expect(internals.slashPopup).toBeUndefined();
      terminal.send("\x7f");
      expect(internals.slashPopup).toBeUndefined();

      // token 变化:恢复弹窗
      terminal.send("d");
      expect(internals.slashPopup).toBeDefined();
      expect(internals.slashPopup!.selectedItem()?.canonicalName).toBe("model");
    } finally {
      await quit(mode, internals, terminal, running);
    }
  });

  it("离开命令名(空格)弹窗隐藏", async () => {
    const { terminal, internals, mode } = setupMode();
    const running = mode.run();
    try {
      terminal.send("/");
      terminal.send("mo");
      expect(internals.slashPopup).toBeDefined();
      terminal.send(" ");
      expect(internals.slashPopup).toBeUndefined();
    } finally {
      await quit(mode, internals, terminal, running);
    }
  });

  it("直接输入隐藏命令 /help 仍打开不含自身的通用 SelectionView", async () => {
    const { terminal, internals, mode } = setupMode();
    const running = mode.run();
    try {
      terminal.send("/");
      terminal.send("help");
      terminal.send("\r");
      const ui = (mode as unknown as { ui: TUI }).ui;
      const overlay = ui.getOverlay();
      expect(overlay).toBeInstanceOf(SelectionView);
      const options = overlay?.present?.()[0];
      expect(options?.kind).toBe("select");
      if (options?.kind === "select") {
        expect(options.options.some((option) => option.label === "/help")).toBe(false);
      }
    } finally {
      await quit(mode, internals, terminal, running);
    }
  });

  it("Enter 派发 inline 参数命令并保留草稿尾(光标在命令名内)", async () => {
    const { terminal, internals, mode } = setupMode();
    const running = mode.run();
    try {
      internals.refs.editor.setText("/rec view the diff");
      internals.refs.editor.setCursor(4);
      expect(internals.slashPopup).toBeDefined();
      expect(internals.slashPopup?.selectedItem()?.canonicalName).toBe("recovery");
      terminal.send("\r");
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(internals.refs.editor.getText()).toBe("");
      // agent-only 模式:recovery 不可用 → notice 说明
      expect(timelineText(mode)).toContain("Session recovery is unavailable");
    } finally {
      await quit(mode, internals, terminal, running);
    }
  });

  it("无选中 Enter 回退默认提交路径(未知命令提示)", async () => {
    const { terminal, internals, mode } = setupMode();
    const running = mode.run();
    try {
      terminal.send("/");
      terminal.send("zz");
      terminal.send("z");
      terminal.send("\r");
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(timelineText(mode)).toContain("Unknown command: /zzz");
    } finally {
      await quit(mode, internals, terminal, running);
    }
  });
});

describe("slash 派发统一(对照 P4 四路径)", () => {
  it("未知命令 → Unknown command 提示", async () => {
    const { terminal, internals, mode } = setupMode();
    const running = mode.run();
    try {
      terminal.send("/nosuch");
      terminal.send("\r");
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(timelineText(mode)).toContain("Unknown command: /nosuch");
    } finally {
      await quit(mode, internals, terminal, running);
    }
  });

  it("别名解析:/commands 等价 /help 打开通用 SelectionView", async () => {
    const { terminal, internals, mode } = setupMode();
    const running = mode.run();
    try {
      terminal.send("/commands");
      terminal.send("\r");
      const ui = (mode as unknown as { ui: TUI }).ui;
      expect(ui.getOverlay()).toBeInstanceOf(SelectionView);
    } finally {
      await quit(mode, internals, terminal, running);
    }
  });

  it("/quit 派发退出", async () => {
    const { terminal, mode } = setupMode();
    const running = mode.run();
    terminal.send("/q");
    terminal.send("uit");
    terminal.send("\r");
    await running;
    expect(terminal.stopCount).toBe(1);
  });

  it("任务运行中配置命令被拒(availableDuringTask 门控)", async () => {
    const terminal = new FakeTerminal();
    const controlled = interruptibleStream();
    const agent = new Agent({ initialState: { systemPrompt: "test", model: mockModel }, streamFn: controlled.streamFn });
    const mode = new InteractiveMode({ agent, terminal });
    const running = mode.run();
    try {
      mode.echoPrompt("long request");
      await controlled.started;
      expect(agent.inFlight).toBe(true);
      mode.echoPrompt("/model");
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(timelineText(mode)).toContain("Configuration commands are available when the current turn is idle.");
    } finally {
      terminal.send("\x03");
      await agent.waitForIdle();
      terminal.send("\x04");
      await running;
    }
  });
});
