import { describe, expect, it } from "vitest";
import { Agent } from "../../src/runtime/agent.ts";
import { mockModel } from "../../src/runtime/providers/mock-stream.ts";
import type { StreamFn } from "../../src/runtime/types.ts";
import type { AssistantMessage, AssistantMessageEventStream } from "../../src/types.ts";
import type { SessionInfo } from "../../src/storage/session-manager.ts";
import { AuthInputModal } from "../../src/tui/components/auth-input-modal.ts";
import { CustomEditor } from "../../src/tui/components/custom-editor.ts";
import { SearchableSelectorModal } from "../../src/tui/components/searchable-selector-modal.ts";
import { InteractiveMode } from "../../src/tui/interactive-mode.ts";
import type { InteractiveSessionControllerPort } from "../../src/runtime/interactive-session-controller.ts";
import { Container, TUI, type Terminal } from "../../src/tui/index.ts";
import { selectSessionInTui } from "../../src/tui/session-selector.ts";
import { makeEditorTheme, makeSelectListTheme } from "../../src/tui/theme/factories.ts";
import { loadTheme } from "../../src/tui/theme/theme.ts";
import { createAssistantMessageEventStream } from "../../src/utils/event-stream.ts";
import { createCommandAutocompleteProvider } from "../../src/tui/commands/autocomplete-provider.ts";

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

  it("slash completion 在输入框下方渲染且 Backspace 持续编辑 draft", async () => {
    const terminal = new FakeTerminal();
    const tui = new TUI(terminal, false);
    const theme = loadTheme("dark");
    const submitted: string[] = [];
    const editor = new CustomEditor(
      tui,
      makeEditorTheme(theme, makeSelectListTheme(theme)),
      {
        theme,
        selectListTheme: makeSelectListTheme(theme),
        onSubmit: (text) => submitted.push(text),
      },
    );
    editor.setAutocompleteProvider(createCommandAutocompleteProvider(() => [{
      canonicalName: "commands",
      label: "/commands",
      description: "Browse commands",
    }]));

    editor.handleInput("/");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(editor.isShowingAutocomplete()).toBe(true);
    for (const width of [60, 80, 143]) {
      const rendered = editor.render(width);
      const suggestionIndex = rendered.findIndex((line) => line.includes("/commands"));
      const bottomBorderIndex = rendered.findLastIndex((line) => /^─+$/u.test(line));
      expect(suggestionIndex).toBeGreaterThan(bottomBorderIndex);
    }

    editor.handleInput("c");
    editor.handleInput("\x7f");
    expect(editor.getText()).toBe("/");
    editor.handleInput("\x7f");
    expect(editor.getText()).toBe("");

    editor.handleInput("/");
    await new Promise<void>((resolve) => setImmediate(resolve));
    editor.handleInput("\r");
    expect(editor.getText()).toBe("/commands");
    expect(submitted).toEqual([]);
    editor.handleInput("\r");
    expect(submitted).toEqual(["/commands"]);
  });
});

describe("startup session selector", () => {
  it("start 后保持 pending，选择或取消时才 stop 并 resolve", async () => {
    const sessions: SessionInfo[] = [{
      id: "session-1",
      filePath: "/tmp/session-1.jsonl",
      createdAt: 1,
      modifiedMs: 2,
      cwd: "/tmp/project",
    }];
    let modal: SearchableSelectorModal | undefined;
    let starts = 0;
    let stops = 0;
    const selection = selectSessionInTui(sessions, {
      createUi: () => ({
        addChild: (_component: Container) => {},
        clear: () => {},
        hideOverlay: () => {},
        requestRender: () => {},
        showOverlay: (component: SearchableSelectorModal) => {
          modal = component;
        },
        start: () => starts++,
        stop: () => stops++,
      }),
    });
    let settled = false;
    void selection.then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(starts).toBe(1);
    expect(stops).toBe(0);
    expect(settled).toBe(false);
    modal?.handleInput("\r");
    await expect(selection).resolves.toEqual(sessions[0]);
    expect(stops).toBe(1);
  });
});

describe("InteractiveMode lifecycle and global controls", () => {
  it("slash completion accept only updates the draft;second Enter executes and clears it", async () => {
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

    terminal.send("/");
    await new Promise<void>((resolve) => setImmediate(resolve));
    terminal.send("\r");
    terminal.send("\x04");
    await Promise.resolve();
    expect(settled).toBe(false);

    terminal.send("\r");
    terminal.send("\x1b");
    terminal.send("\x04");
    await running;
    expect(terminal.stopCount).toBe(1);
  });

  it("requires the exact resource digest before a governed Extension mutation", async () => {
    const terminal = new FakeTerminal();
    const digest = "c".repeat(64);
    const mutations: unknown[] = [];
    let reloads = 0;
    const controller = {
      sessionId: "session-extension-controls",
      inFlight: false,
      currentSelection: {
        provider: "mock",
        model: mockModel,
        thinkingLevel: "off",
      },
      messages: [],
      warnings: [],
      auditEntries: [],
      toolCount: 1,
      getExtensionSnapshot: () => ({
        snapshotId: "snapshot-extension-controls",
        generation: 1,
        resources: [{
          id: "plugin:project:team-tools",
          kind: "plugin",
          displayName: "Team Tools",
          enabled: false,
          trust: "untrusted",
          activation: "blocked",
          source: "project",
          componentCount: 2,
          digest,
          capabilities: ["required:filesystem-read"],
        }],
        diagnostics: [],
        counts: { ready: 0, blocked: 1, disabled: 0, error: 0 },
      }),
      mutateExtension: async (input: unknown) => {
        mutations.push(input);
        return { ok: true, status: "pending" as const, message: "accepted" };
      },
      reloadExtensions: async () => {
        reloads += 1;
        return { status: "applied" as const };
      },
      subscribe: () => () => {},
      dispose: () => {},
    } as unknown as InteractiveSessionControllerPort;
    const mode = new InteractiveMode({ controller, terminal });
    const running = mode.run();

    mode.echoPrompt("/plugins");
    terminal.send("\r");
    terminal.send("\x1b[B");
    terminal.send("\r");
    terminal.send(digest);
    terminal.send("\r");
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(mutations).toEqual([{
      action: "trust",
      kind: "plugin",
      resourceId: "plugin:project:team-tools",
      digest,
    }]);
    expect(reloads).toBe(1);

    terminal.send("\x04");
    await running;
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
});
