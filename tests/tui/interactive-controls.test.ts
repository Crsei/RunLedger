import { describe, expect, it, vi } from "vitest";
import { Agent } from "../../src/runtime/agent.ts";
import { mockModel } from "../../src/runtime/providers/mock-stream.ts";
import type { StreamFn } from "../../src/runtime/types.ts";
import type { AssistantMessage, AssistantMessageEventStream } from "../../src/types.ts";
import { AuthInputModal } from "../../src/tui/components/auth-input-modal.ts";
import { CustomEditor } from "../../src/tui/components/custom-editor.ts";
import { InteractiveMode } from "../../src/tui/interactive-mode.ts";
import { TUI, type Terminal } from "../../src/tui/index.ts";
import { makeEditorTheme, makeSelectListTheme } from "../../src/tui/theme/factories.ts";
import { loadTheme } from "../../src/tui/theme/theme.ts";
import { createAssistantMessageEventStream } from "../../src/utils/event-stream.ts";
import { createRuntimeId } from "../../src/runtime/protocol/ids.ts";
import { createProcessOverlayController } from "../../src/tui/process/controller-adapter.ts";
import type { ProcessOverlayItem } from "../../src/tui/process/types.ts";
import { TranscriptOverlayComponent } from "../../src/tui/transcript-view.ts";
import type { EditorHint } from "../../src/tui/components/editor-hint.ts";
import type { TuiStore } from "../../src/tui/application/store.ts";
import type { TuiPreferencesDocument, TuiPreferencesPort } from "../../src/tui/preferences/types.ts";
import type { TuiEvent } from "../../src/tui/types.ts";

class FakeTerminal implements Terminal {
  private input: ((data: string) => void) | undefined;
  readonly writes: string[] = [];
  startCount = 0;
  stopCount = 0;

  get columns(): number {
    return 100;
  }

  get rows(): number {
    return 30;
  }

  get kittyProtocolActive(): boolean {
    return false;
  }

  start(onInput: (data: string) => void, _onResize: () => void): void {
    this.startCount++;
    this.input = onInput;
  }

  stop(): void {
    this.stopCount++;
    this.input = undefined;
  }

  async drainInput(): Promise<void> {}

  write(data: string): void {
    this.writes.push(data);
  }

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
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

function immediateStopStream(): StreamFn {
  return () => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const message = stoppedAssistant();
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
    });
    return stream;
  };
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
      const partial = stoppedAssistant();
      stream.push({ type: "start", partial });
      const finish = (): void => {
        const error = stoppedAssistant("aborted");
        stream.push({ type: "error", reason: "aborted", error });
        stream.end(error);
      };
      if (capturedSignal?.aborted) finish();
      else capturedSignal?.addEventListener("abort", finish, { once: true });
      markStarted?.();
    });
    return stream;
  };
  return { streamFn, started, signal: () => capturedSignal };
}

describe("TUI input components", () => {
  it("secret 输入只显示掩码，提交值保持原文", () => {
    let submitted = "";
    const modal = new AuthInputModal({
      title: "Secret",
      message: "Enter key",
      secret: true,
      onSubmit: (value) => {
        submitted = value;
      },
      onCancel: () => {},
    });

    modal.handleInput("s3cr3t");
    const rendered = modal.render(80).join("\n");
    expect(rendered).not.toContain("s3cr3t");
    expect(rendered).toContain("••••••");
    modal.handleInput("\r");
    expect(submitted).toBe("s3cr3t");
  });

  it("Alt+Enter 提交 follow-up 并清空编辑器，Alt+Up 恢复队列", () => {
    const terminal = new FakeTerminal();
    const tui = new TUI(terminal, false);
    const theme = loadTheme("dark");
    const follows: string[] = [];
    let restored = 0;
    const editor = new CustomEditor(
      tui,
      makeEditorTheme(theme, makeSelectListTheme(theme)),
      {
        theme,
        selectListTheme: makeSelectListTheme(theme),
        onFollowUp: (text) => follows.push(text),
        onDequeue: () => restored++,
      },
    );
    editor.setText("queued follow-up");

    editor.handleInput("\x1b[27;3;13~");
    editor.handleInput("\x1bp");

    expect(follows).toEqual(["queued follow-up"]);
    expect(editor.getText()).toBe("");
    expect(restored).toBe(1);
  });

  it("导航键(原始转义与 OpenTUI 归一化键名)不泄漏进编辑器文本", () => {
    const terminal = new FakeTerminal();
    const tui = new TUI(terminal, false);
    const theme = loadTheme("dark");
    const editor = new CustomEditor(tui, makeEditorTheme(theme, makeSelectListTheme(theme)), { theme, selectListTheme: makeSelectListTheme(theme) });
    editor.setText("abc");

    // 原始转义序列
    editor.handleInput("\x1b[A"); // up
    editor.handleInput("\x1b[B"); // down
    editor.handleInput("\x1b[C"); // right
    editor.handleInput("\x1b[D"); // left
    // OpenTUI 运行时归一化键名
    editor.handleInput("up");
    editor.handleInput("down");
    editor.handleInput("left");
    editor.handleInput("right");
    editor.handleInput("home");
    editor.handleInput("end");
    editor.handleInput("pageUp");
    editor.handleInput("tab");

    expect(editor.getText()).toBe("abc");
  });

  it("left/right/home/end 会移动模型光标并在当前位置编辑", () => {
    const terminal = new FakeTerminal();
    const tui = new TUI(terminal, false);
    const theme = loadTheme("dark");
    const editor = new CustomEditor(tui, makeEditorTheme(theme, makeSelectListTheme(theme)), { theme, selectListTheme: makeSelectListTheme(theme) });
    editor.setText("abcd");

    editor.handleInput("left");
    expect(editor.getCursor()).toEqual({ line: 0, col: 3 });
    editor.handleInput("X");
    expect(editor.getText()).toBe("abcXd");
    editor.handleInput("home");
    expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
    editor.handleInput("right");
    editor.handleInput("backspace");
    expect(editor.getText()).toBe("bcXd");
    editor.handleInput("end");
    expect(editor.getCursor()).toEqual({ line: 0, col: 4 });
  });
});

describe("InteractiveMode lifecycle and global controls", () => {
  it("projects the initial scrollbar preference and persists /scrollbar without touching the draft", async () => {
    const terminal = new FakeTerminal();
    const agent = new Agent({
      initialState: { systemPrompt: "test", model: mockModel },
      streamFn: immediateStopStream(),
    });
    const saved: TuiPreferencesDocument[] = [];
    const preferencesPort: TuiPreferencesPort = {
      load: async () => ({
        preferences: { version: 1, transcript: { scrollbar: "visible" } },
      }),
      save: async (next) => {
        saved.push(next);
        return { ok: true };
      },
    };
    const mode = new InteractiveMode({
      agent,
      terminal,
      initialPreferences: { version: 1, transcript: { scrollbar: "visible" } },
      preferencesPort,
    } as ConstructorParameters<typeof InteractiveMode>[0]);
    const internals = mode as unknown as {
      refs: { editor: { setText(text: string): void; getText(): string } };
      ui: { transcriptScrollPresentation?: { visible: boolean; trackColor: string; thumbColor: string } };
    };

    expect(mode.getTuiState().interaction.transcriptScrollbarVisible).toBe(true);
    expect(internals.ui.transcriptScrollPresentation).toEqual({
      visible: true,
      trackColor: "#11151c",
      thumbColor: "#2b3340",
    });
    internals.refs.editor.setText("draft remains");
    mode.echoPrompt("/scrollbar");
    await vi.waitFor(() => expect(saved).toHaveLength(1));

    expect(mode.getTuiState().interaction.transcriptScrollbarVisible).toBe(false);
    expect(internals.refs.editor.getText()).toBe("draft remains");
    expect(saved).toEqual([{ version: 1, transcript: { scrollbar: "hidden" } }]);
    expect(internals.ui.transcriptScrollPresentation?.visible).toBe(false);
  });

  it("keeps the current scrollbar state and shows a bounded note when persistence fails", async () => {
    const terminal = new FakeTerminal();
    const agent = new Agent({
      initialState: { systemPrompt: "test", model: mockModel },
      streamFn: immediateStopStream(),
    });
    const preferencesPort: TuiPreferencesPort = {
      load: async () => ({ preferences: { version: 1, transcript: { scrollbar: "hidden" } } }),
      save: async () => ({ ok: false, code: "tui_preferences_save_failed" }),
    };
    const mode = new InteractiveMode({ agent, terminal, preferencesPort } as ConstructorParameters<typeof InteractiveMode>[0]);

    mode.echoPrompt("/scrollbar");
    await vi.waitFor(() => {
      const notices = mode.getTuiState().timeline.committedRows
        .filter((row) => row.kind === "notice")
        .map((row) => row.message.text)
        .join("\n");
      expect(notices).toContain("Scrollbar changed for this run but could not be saved.");
      expect(notices).not.toContain("tui_preferences_save_failed");
    });
    expect(mode.getTuiState().interaction.transcriptScrollbarVisible).toBe(true);
  });

  it("refreshes native scrollbar colors when the terminal theme changes", () => {
    const terminal = new FakeTerminal();
    const agent = new Agent({
      initialState: { systemPrompt: "test", model: mockModel },
      streamFn: immediateStopStream(),
    });
    const mode = new InteractiveMode({ agent, terminal });
    const internals = mode as unknown as {
      maybeSwitchTheme(scheme: "dark" | "light"): void;
      ui: { transcriptScrollPresentation?: { visible: boolean; trackColor: string; thumbColor: string } };
    };

    internals.maybeSwitchTheme("light");
    expect(internals.ui.transcriptScrollPresentation).toEqual({
      visible: false,
      trackColor: "#f5f5f5",
      thumbColor: "#cccccc",
    });
  });

  it("terminal blur 后隐藏 editor hint,focus 恢复后重新显示", () => {
    const terminal = new FakeTerminal();
    const agent = new Agent({
      initialState: { systemPrompt: "test", model: mockModel },
      streamFn: immediateStopStream(),
    });
    const mode = new InteractiveMode({ agent, terminal });
    const internals = mode as unknown as {
      refs: { editorHint: EditorHint };
      store: TuiStore;
    };

    expect(internals.refs.editorHint.render(80)).toHaveLength(1);
    internals.store.dispatch({ type: "interaction.focus-changed", focused: false });
    expect(internals.refs.editorHint.render(80)).toEqual([]);
    internals.store.dispatch({ type: "interaction.focus-changed", focused: true });
    expect(internals.refs.editorHint.render(80)).toHaveLength(1);
  });

  it("terminal focus boundary 触发重绘,blur 帧不再包含 editor hint", async () => {
    const terminal = new FakeTerminal();
    const agent = new Agent({
      initialState: { systemPrompt: "test", model: mockModel },
      streamFn: immediateStopStream(),
    });
    const mode = new InteractiveMode({ agent, terminal });
    const running = mode.run();
    const ui = (mode as unknown as {
      ui: { emitActions(actions: readonly { readonly type: "interaction.focus-changed"; readonly focused: boolean }[]): void };
    }).ui;
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      const writesBeforeBlur = terminal.writes.length;

      ui.emitActions([{ type: "interaction.focus-changed", focused: false }]);
      await new Promise<void>((resolve) => setTimeout(resolve, 20));

      expect(terminal.writes.length).toBeGreaterThan(writesBeforeBlur);
      expect(terminal.writes.at(-1)).not.toContain("enter:send");
    } finally {
      terminal.send("\x04");
      await running;
    }
  });

  it("theme_mode 与 OSC 11 背景输入重算 production editor appearance", () => {
    const terminal = new FakeTerminal();
    const agent = new Agent({
      initialState: { systemPrompt: "test", model: mockModel },
      streamFn: immediateStopStream(),
    });
    const mode = new InteractiveMode({ agent, terminal });
    const internals = mode as unknown as {
      maybeSwitchTheme(scheme: "dark" | "light"): void;
      refreshEditorAppearance(rgb?: { readonly r: number; readonly g: number; readonly b: number }): void;
      ui: { editorAppearance?: { readonly backgroundColor: string; readonly promptColor: string; readonly placeholderColor: string } };
    };

    internals.maybeSwitchTheme("light");
    expect(internals.ui.editorAppearance).toEqual({
      backgroundColor: "#f4f4f4",
      promptColor: "#0066cc",
      placeholderColor: "#888888",
    });

    internals.maybeSwitchTheme("dark");
    internals.refreshEditorAppearance({ r: 255, g: 255, b: 255 });
    expect(internals.ui.editorAppearance?.backgroundColor).toBe("#f4f4f4");
  });

  it("overlay 打开时 Ctrl+C 交给 modal 取消，不触发主对话中断或退出", async () => {
    const terminal = new FakeTerminal();
    const agent = new Agent({
      initialState: { systemPrompt: "test", model: mockModel },
      streamFn: immediateStopStream(),
    });
    const mode = new InteractiveMode({ agent, terminal });
    const running = mode.run();
    mode.openSlashCommands();

    terminal.send("\x03");
    await Promise.resolve();
    expect(terminal.stopCount).toBe(0);

    terminal.send("\x04");
    await running;
    expect(terminal.stopCount).toBe(1);
  });

  it("Ctrl+T 打开只读 transcript overlay，Esc 关闭后恢复主对话", async () => {
    const terminal = new FakeTerminal();
    const agent = new Agent({
      initialState: { systemPrompt: "test", model: mockModel },
      streamFn: immediateStopStream(),
    });
    const mode = new InteractiveMode({ agent, terminal });
    const running = mode.run();
    const internals = mode as unknown as {
      ui: {
        hasOverlay(): boolean;
        getOverlay(): unknown;
      };
    };

    mode.echoPrompt("committed question");
    await vi.waitFor(() => expect(mode.getTuiState().timeline.committedRows.length).toBeGreaterThan(0));

    terminal.send("\x14");
    expect(internals.ui.hasOverlay()).toBe(true);
    expect(internals.ui.getOverlay()).toBeInstanceOf(TranscriptOverlayComponent);
    expect((internals.ui.getOverlay() as TranscriptOverlayComponent).render(80).join("\n")).toContain("committed question");

    terminal.send("\x1b");
    expect(internals.ui.hasOverlay()).toBe(false);

    terminal.send("\x04");
    await running;
  });

  it("derives footer plan progress from the live safe timeline when taskGoal is not wired", () => {
    const mode = new InteractiveMode({
      agent: new Agent({ initialState: { systemPrompt: "test", model: mockModel }, streamFn: immediateStopStream() }),
      terminal: new FakeTerminal(),
    });
    const internals = mode as unknown as { handleEvent(event: TuiEvent): void };

    internals.handleEvent({
      type: "tool_execution_start",
      timestamp: 1,
      toolCallId: "todo-1",
      toolName: "TodoWrite",
      args: {
        todos: [
          { content: "done", status: "completed" },
          { content: "next", status: "pending" },
        ],
      },
    });

    expect(mode.getPlanProgress()).toEqual({ completed: 1, total: 2 });
  });

  it("derives footer usage and context limit from completed assistant messages", () => {
    const mode = new InteractiveMode({
      agent: new Agent({ initialState: { systemPrompt: "test", model: mockModel }, streamFn: immediateStopStream() }),
      terminal: new FakeTerminal(),
    });
    const internals = mode as unknown as { handleEvent(event: TuiEvent): void };
    const message: AssistantMessage = {
      ...stoppedAssistant(),
      usage: {
        input: 100,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 120,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };

    internals.handleEvent({ type: "message_start", timestamp: 1, role: "assistant", message });
    internals.handleEvent({ type: "message_end", timestamp: 2, role: "assistant", stopReason: "stop", message });

    expect(mode.getContextUsage()).toEqual({ totalTokens: 120, contextWindow: mockModel.contextWindow });
  });

  it("run 持续到退出；非空 Ctrl+D 不退出，Ctrl+C 清稿后空 Ctrl+D 退出", async () => {
    const terminal = new FakeTerminal();
    const agent = new Agent({
      initialState: { systemPrompt: "test", model: mockModel },
      streamFn: immediateStopStream(),
    });
    const mode = new InteractiveMode({ agent, terminal });
    const running = mode.run();
    let settled = false;
    void running.then(() => {
      settled = true;
    });

    terminal.send("draft");
    terminal.send("\x04");
    await Promise.resolve();
    expect(settled).toBe(false);

    terminal.send("\x03");
    terminal.send("\x04");
    await running;
    expect(terminal.startCount).toBe(1);
    expect(terminal.stopCount).toBe(1);
  });

  it("非空 Ctrl+C 只清空输入区不退出,空输入再按 Ctrl+C 退出", async () => {
    const terminal = new FakeTerminal();
    const agent = new Agent({
      initialState: { systemPrompt: "test", model: mockModel },
      streamFn: immediateStopStream(),
    });
    const mode = new InteractiveMode({ agent, terminal });
    const running = mode.run();
    let settled = false;
    void running.then(() => {
      settled = true;
    });
    const internals = mode as unknown as {
      refs: { editor: { getText(): string } };
    };

    terminal.send("draft");
    terminal.send("\x03");
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(internals.refs.editor.getText()).toBe("");

    terminal.send("\x03");
    await running;
    expect(terminal.stopCount).toBe(1);
  });

  it("空闲且输入区为空时 Ctrl+C 单次直接退出", async () => {
    const terminal = new FakeTerminal();
    const agent = new Agent({
      initialState: { systemPrompt: "test", model: mockModel },
      streamFn: immediateStopStream(),
    });
    const mode = new InteractiveMode({ agent, terminal });
    const running = mode.run();

    terminal.send("\x03");
    await running;
    expect(terminal.stopCount).toBe(1);
  });


	it("流式 Ctrl+C 中断当前 provider，但不退出 TUI", async () => {
    const terminal = new FakeTerminal();
    const controlled = interruptibleStream();
    const agent = new Agent({
      initialState: { systemPrompt: "test", model: mockModel },
      streamFn: controlled.streamFn,
    });
    const mode = new InteractiveMode({ agent, terminal });
    const running = mode.run();
    mode.echoPrompt("long request");
    await controlled.started;

    terminal.send("\x03");
    await agent.waitForIdle();
    expect(controlled.signal()?.aborted).toBe(true);
    expect(terminal.stopCount).toBe(0);

    terminal.send("\x04");
    await running;
		expect(terminal.stopCount).toBe(1);
	});

	it("routes /processes and /terminal through the safe Host facade and restores editor focus", async () => {
		const terminal = new FakeTerminal();
		const executionId = createRuntimeId("execution", "interactive-process");
		const process: ProcessOverlayItem = {
			executionId,
			attemptId: createRuntimeId("attempt", "interactive-process_1"),
			state: "running",
			outputCursor: { sequence: 0, byteOffset: 0 },
			outputSize: 0,
			canWrite: true,
			canResize: true,
			canStop: true,
		};
		const processOverlay = createProcessOverlayController({
			listProcesses: async () => [process],
			processOutput: async (_id, cursor) => ({ ok: true as const, text: "terminal output", startCursor: cursor, endCursor: { sequence: 1, byteOffset: 15 }, nextCursor: { sequence: 1, byteOffset: 15 }, truncated: false, head: { sequence: 1, byteOffset: 15 } }),
		}, { driver: true });
		const agent = new Agent({
			initialState: { systemPrompt: "test", model: mockModel },
			streamFn: immediateStopStream(),
		});
		const mode = new InteractiveMode({ agent, terminal, processOverlayController: processOverlay });
		const running = mode.run();

		mode.echoPrompt("/processes");
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(processOverlay.snapshot().open).toBe(true);
		expect(processOverlay.snapshot().mode).toBe("list");

		mode.echoPrompt(`/terminal ${executionId}`);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(processOverlay.snapshot().mode).toBe("terminal");
		expect(processOverlay.snapshot().output).toContain("terminal output");

		terminal.send("\x1b");
		expect(processOverlay.snapshot().open).toBe(false);
		expect(processOverlay.snapshot().editorFocusRestored).toBe(true);
		terminal.send("\x04");
		await running;
	});
});
