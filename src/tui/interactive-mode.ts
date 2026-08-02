/**
 * InteractiveMode —— TUI 主控，组装 pure presentation tree 并接通 Agent 事件流。
 *
 * 对照 development-doc/tui/02-component-spec.md §1 与 07-roadmap.md M1。
 *
 * M1 阶段("空骨架")目标:
 *   1. 装配组件树(header / loadedResources / chat / status / editor / footer)
 *      与 M2+ 的真实业务组件不同,M1 各 container 暂用 Spacer 占位;
 *   2. 实现 FooterSnapshotProvider 三个方法(isStreaming / getStopReason / getModelId / getSessionId);
 *   3. handleEvent 把 TuiEvent 路由到各 container,M1 阶段除 agent_end / message_end
 *      更新 stopReason 之外其余 case 留 noop 占位(M2 起逐 case 落实);
 *   4. run() / quit() 对接 TUI.start / stop,并注册到 ReplHandle 单例(M8 远期任务接入);
 *   5. 失败护栏常量 MAX_CONSECUTIVE_INIT_FAILURES / INIT_FAILURE_BACKOFF_MS 在 spec 已定义,
 *      M1 不实际触发(无 init 重试路径)。
 *
 * 本 M1 阶段:
 *   - main 入口由 examples/tui-demo.ts 实例化 InteractiveMode 并 run;
 *   - 实际接 CLI 入口 src/cli/main.ts 留给 M7;
 *   - 与 Agent 的耦合只在 prompt 提交,不修改 agent._state.messages(对照 01 §6.1)。
 */

import {
  Container,
  ProcessTerminal,
  TUI,
  type Terminal,
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
  type EditorTheme,
  type SelectListTheme,
} from "./index.ts";

import type { Agent } from "../runtime/agent.ts";
import type { AgentEvent, AgentMessage } from "../runtime/types.ts";
import type { AssistantMessage, ModelThinkingLevel } from "../types.ts";
import { getSupportedThinkingLevels } from "../models.ts";
import type { AuthEvent, AuthInteraction, AuthPrompt, AuthType } from "../auth/types.ts";
import type { InteractiveSessionController } from "../runtime/interactive-session-controller.ts";

import { adaptAgentEvent, type FooterSnapshotProvider, type TuiEvent } from "./types.ts";
import { loadTheme, applyEnvOverrides, type Theme } from "./theme/theme.ts";
import { makeEditorTheme, makeSelectListTheme } from "./theme/factories.ts";
import { CustomEditor, type CustomEditorProps } from "./components/custom-editor.ts";
import { Footer } from "./components/footer.ts";
import { KeybindingHints } from "./components/keybinding-hints.ts";
import { LoadedResourcesComponent } from "./components/loaded-resources.ts";
import { ChatContainer } from "./components/chat-container.ts";
import { UserMessageComponent } from "./components/user-message.ts";
import { AssistantMessageComponent, extractToolCalls } from "./components/assistant-message.ts";
import { ToolCallComponent } from "./components/tool-call.ts";
import { ToolResultComponent } from "./components/tool-result.ts";
import { CustomMessageComponent } from "./components/custom-message.ts";
import { AuthInputModal } from "./components/auth-input-modal.ts";
import { BashExecutionComponent } from "./components/bash-execution.ts";
import { DiffPreviewComponent } from "./components/diff-preview.ts";
import { SearchableSelectorModal } from "./components/searchable-selector-modal.ts";
import { StatusComponent } from "./components/status.ts";
import { SelectorModal } from "./components/selector-modal.ts";
import type { SelectItem } from "./index.ts";
import type { AgentToolResult } from "../runtime/types.ts";
import { createAppKeyListener } from "./keybindings/app-keys.ts";

/** InteractiveMode 装配参数。 */
export interface InteractiveModeOptions {
  /** 新 CLI 使用统一 controller;agent 仅保留 demo 兼容。 */
  controller?: InteractiveSessionController;
  agent?: Agent;
  /** 终端实现,默认 ProcessTerminal;可传入 mock 终端用于单测。 */
  terminal?: Terminal;
  /** 主题名，默认 dark；运行时由 OpenTUI theme_mode 更新。 */
  themeName?: "dark" | "light";
  /** 调试模式:onError 时把堆栈写到 stderr。 */
  debug?: boolean;
  /** M8d:/model 选择器候选列表;空则 selector 不可用。 */
  modelRegistry?: ModelSwitchEntry[];
  /** M8e:thinking level 初始值,默认 "minimal"。 */
  initialThinkingLevel?: ModelThinkingLevel;
  /** M8e:thinking level change 回调,由 caller 决定如何传给 agent streamFn。 */
  onThinkingChange?: (level: ModelThinkingLevel) => void;
}

/** M8d:/model 切换条目;由 caller(demo)注入候选。 */
export interface ModelSwitchEntry {
  /** 内部 ID(也是 SelectItem.value) */
  id: string;
  /** 显示 label */
  label: string;
  /** description */
  description?: string;
  /** 真正的 Model instance,将传给 agent.setModel */
  model: Agent["state"]["model"];
}

/** 组件树引用,挂在 InteractiveMode 实例上以便 handleEvent 路由 mutation。 */
interface ContainerRefs {
  header: Container;
  loadedResources: LoadedResourcesComponent;
  chat: ChatContainer;
  status: StatusComponent;
  editor: CustomEditor;
  footer: Footer;
  hints: KeybindingHints;
}

/** 失败护栏常量(对照 02-spec §1 与 03-event-binding §5.1)。 */
const MAX_CONSECUTIVE_INIT_FAILURES = 3;
const INIT_FAILURE_BACKOFF_MS = 10_000;

export class InteractiveMode implements FooterSnapshotProvider {
  private readonly ui: TUI;
  private readonly terminal: Terminal;
  private readonly agent: Agent | undefined;
  private readonly controller: InteractiveSessionController | undefined;
  private theme: Theme;
  private readonly kb: KeybindingsManager;
  private readonly refs: ContainerRefs;
  private unsubscribe?: () => void;
  private unsubscribeThemeMode?: () => void;

  // FooterSnapshotProvider 状态(只有 handleEvent 路径写)
  private streaming = false;
  private stopReason: string | undefined = undefined;

  // M3 toolExecution 映射:toolCallId -> ToolCallComponent;tool_execution_end 后移除。
  private readonly toolCallComponents: Map<
    string,
    ToolCallComponent | BashExecutionComponent | DiffPreviewComponent
  > = new Map();

  // 失败护栏状态(M1 不主动触发)
  private consecutiveInitFailures = 0;

  // M8d/e:modelRegistry + thinking level 切换状态
  private modelRegistry: ModelSwitchEntry[];
  private thinkingLevel: ModelThinkingLevel;
  private readonly onThinkingChange?: (level: ModelThinkingLevel) => void;
  private lastIdleCtrlC = 0;
  private quitting = false;
  private readonly exitPromise: Promise<void>;
  private readonly resolveExit: () => void;

  constructor(opts: InteractiveModeOptions) {
    if (!opts.controller && !opts.agent) {
      throw new Error("InteractiveMode requires controller or agent");
    }
    this.controller = opts.controller;
    this.agent = opts.agent;
    this.terminal = opts.terminal ?? new ProcessTerminal();
    this.theme = applyEnvOverrides(loadTheme(opts.themeName ?? "dark"));
    this.modelRegistry = opts.modelRegistry ?? [];
    this.thinkingLevel = opts.controller?.currentSelection.thinkingLevel ?? opts.initialThinkingLevel ?? "off";
    this.onThinkingChange = opts.onThinkingChange;
    let resolveExit: (() => void) | undefined;
    this.exitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    this.resolveExit = () => resolveExit?.();

    // TUI 使用 showHardwareCursor=false,Editor 自身以 CURSOR_MARKER 通知光标位置
    this.ui = new TUI(this.terminal, false);

    // KeybindingsManager:本期安装默认 TUI_KEYBINDINGS,后续 M6 在此挂 user bindings
    this.kb = new KeybindingsManager(TUI_KEYBINDINGS);
    setKeybindings(this.kb);

    // 装配组件树
    this.refs = this.assembleTree();
    this.replayInitialHistory();

    // 注册到 RunLedger 进程级单例 handle(M8 远期接通);M1 阶段 setReplHandle 仍 noop
    // 此处仅保留 hook 点,不在本期调用 setReplHandle,避免引入运行时副作用。
    void MAX_CONSECUTIVE_INIT_FAILURES;
    void INIT_FAILURE_BACKOFF_MS;
  }

  /** 装配组件树并返回引用;M2 起把 LoadedResources / Chat 等 container 换成真实组件。 */
  private assembleTree(): ContainerRefs {
    const header = new Container();
    const loadedResources = new LoadedResourcesComponent({
      activeLedgerSessionId: this.getSessionId(),
    });
    // 把已注册工具数填到 loadedResources
    loadedResources.setResource("tools", this.controller?.toolCount ?? this.agent?.state.tools.length ?? 0);
    const chat = new ChatContainer();
    const status = new StatusComponent({});
    const editorTheme: EditorTheme = makeEditorTheme(this.theme, this.makeSelectListTheme());
    const editorProps: CustomEditorProps = {
      theme: this.theme,
      selectListTheme: this.makeSelectListTheme(),
      onSubmit: (text) => this.handleSubmit(text),
      onFollowUp: (text) => this.handleFollowUpSubmit(text),
      onDequeue: () => this.restoreQueuesToEditor(),
    };
    const editor = new CustomEditor(this.ui, editorTheme, editorProps);
    const footer = new Footer({ theme: this.theme, provider: this });
    const hints = new KeybindingHints({ theme: this.theme, hints: [] });

    // 组件树结构(对照 02 §1):
    //   header / loadedResources / chat / status / editor / footer / hints
    this.ui.addChild(header);
    this.ui.addChild(loadedResources);
    this.ui.addChild(chat);
    this.ui.addChild(status);
    this.ui.addChild(editor);
    this.ui.addChild(footer);
    this.ui.addChild(hints);

    // Editor 拿焦点
    this.ui.setFocus(editor);

    return { header, loadedResources, chat, status, editor, footer, hints };
  }

  /** 用 dark 主题色拼一个最小 SelectListTheme 占位;M6 阶段补完整色槽。 */
  private makeSelectListTheme(): SelectListTheme {
    return makeSelectListTheme(this.theme);
  }

  /** 启动 TUI;Promise 在 quit() 完成终端清理后 resolve。 */
  async run(): Promise<void> {
    if (this.quitting) return;
    this.unsubscribe = this.controller
      ? this.controller.subscribe((ev) => this.handleAgentEvent(ev))
      : this.agent?.subscribe((ev) => this.handleAgentEvent(ev));
    // 注册全局 app.* 键位拦截(M6):在 Editor listener 之前注册,确保优先级
    this.ui.addInputListener(
      createAppKeyListener({
        onInterrupt: () => {
          if (this.ui.hasOverlay()) return false;
          this.handleInterrupt();
          return true;
        },
        onExit: () => this.ui.hasOverlay() ? false : this.handleCtrlD(),
        onRefresh: () => this.ui.invalidate(),
      }),
    );
    this.unsubscribeThemeMode = this.ui.addThemeModeListener((mode) => this.maybeSwitchTheme(mode));
    try {
      await this.ui.start();
    } catch (error) {
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      this.unsubscribeThemeMode?.();
      this.unsubscribeThemeMode = undefined;
      this.resolveExit();
      throw error;
    }
    await this.exitPromise;
  }

  /** 中断当前 turn;M8c:真接 agent.interrupt()。 */
  private handleInterrupt(): void {
    if (this.streaming || this.inFlight()) {
      const restored = this.controller?.clearAllQueues();
      const queued = [
        ...(restored?.steering ?? []),
        ...(restored?.followUp ?? []),
      ].map(messageText).filter((text) => text.length > 0);
      if (queued.length > 0) {
        const current = this.refs.editor.getText();
        this.refs.editor.setText([...queued, current].filter((text) => text.trim()).join("\n\n"));
      }
      this.controller?.interrupt();
      this.agent?.interrupt();
      this.ui.requestRender();
      return;
    }
    const text = this.refs.editor.getText();
    if (text.length > 0) {
      this.refs.editor.setText("");
      this.lastIdleCtrlC = Date.now();
      this.ui.requestRender();
      return;
    }
    const now = Date.now();
    if (now - this.lastIdleCtrlC <= 500) {
      void this.requestQuit();
    } else {
      this.lastIdleCtrlC = now;
    }
  }

  private handleCtrlD(): boolean {
    if (!this.inFlight() && this.refs.editor.getText().length === 0) {
      void this.requestQuit();
      return true;
    }
    return false;
  }

  /** OpenTUI theme_mode 变更后刷新共享 ThemeRef。 */
  private maybeSwitchTheme(scheme: "dark" | "light"): void {
    Object.assign(this.theme, applyEnvOverrides(loadTheme(scheme)));
    this.ui.invalidate();
  }

  /** 退出 TUI。 */
  quit(): void {
    void this.requestQuit();
  }

  private async requestQuit(): Promise<void> {
    if (this.quitting) return;
    this.quitting = true;
    if (this.inFlight()) {
      this.controller?.interrupt();
      this.agent?.interrupt();
      await (this.controller?.waitForIdle() ?? this.agent?.waitForIdle() ?? Promise.resolve());
    }
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
    this.unsubscribeThemeMode?.();
    this.unsubscribeThemeMode = undefined;
    this.controller?.dispose();
    this.ui.stop();
    this.resolveExit();
  }

  /**
   * 公共 prompt 注入入口;demo 与未来 ReplHandle.sendText 走同一通道。
   *
   * 实现:把 Editor onSubmit 流转过来即可——等价于"程序模拟一键回车提交"。
   * 不调 agent.prompt 直绕,保证 handleSubmit 中 _前_ push UserMessageComponent 一致路径。
   */
  echoPrompt(text: string): void {
    this.handleSubmit(text);
  }

  /**
   * 打开 slash 命令选择器(M5 占位,M6 键位 / 触发接通)。
   * 选中 / xxx 后,把 / xxx 当 user prompt 注入(目前 mock 占位)。
   */
  openSlashCommands(): void {
    const items: SelectItem[] = [
      { value: "/help", label: "/help", description: "Show help" },
      { value: "/clear", label: "/clear", description: "Clear chat" },
      { value: "/provider", label: "/provider", description: "Configure provider" },
      { value: "/login", label: "/login", description: "Authenticate provider" },
      { value: "/logout", label: "/logout", description: "Remove credential" },
      { value: "/model", label: "/model", description: "Switch model" },
      { value: "/thinking", label: "/thinking", description: "Switch thinking level" },
      { value: "/quit", label: "/quit", description: "Exit safely" },
      { value: "/mcp", label: "/mcp", description: "Switch mcp server" },
      { value: "/prompt", label: "/prompt", description: "Pick prompt template" },
    ];
    const modal = new SelectorModal({
      theme: this.theme,
      selectListTheme: makeSelectListTheme(this.theme),
      title: "/commands",
      items,
      onSelect: (item) => {
        this.ui.hideOverlay();
        // 二级 selector 派发
        switch (item.value) {
          case "/model":
            this.openModelSelector();
            break;
          case "/thinking":
            this.openThinkingSelector();
            break;
          case "/provider":
            void this.openProviderSelector();
            break;
          case "/login":
            void this.openLoginSelector();
            break;
          default:
            this.echoPrompt(item.value);
        }
      },
      onCancel: () => this.ui.hideOverlay(),
    });
    this.ui.showOverlay(modal, { anchor: "bottom-left" });
  }

  /**
   * 打开预设 prompt 选择器(M5 占位,M7+ 真实模板接入)。
   */
  openPromptSelector(): void {
    const items: SelectItem[] = [
      { value: "Summarize this repo", label: "Summarize this repo" },
      { value: "Run tests", label: "Run tests" },
    ];
    const modal = new SelectorModal({
      theme: this.theme,
      selectListTheme: makeSelectListTheme(this.theme),
      title: "/prompt templates",
      items,
      onSelect: (item) => this.echoPrompt(item.label),
      onCancel: () => this.ui.hideOverlay(),
    });
    this.ui.showOverlay(modal, { anchor: "bottom-left" });
  }

  /**
   * 打开 mcp server 选择器(M5 占位,真实 mcp 注册表接入留 M5+ 远期)。
   */
  openMcpServerSelector(): void {
    const items: SelectItem[] = [];
    const modal = new SelectorModal({
      theme: this.theme,
      selectListTheme: makeSelectListTheme(this.theme),
      title: "/mcp servers (none loaded)",
      items,
      onSelect: () => this.ui.hideOverlay(),
      onCancel: () => this.ui.hideOverlay(),
    });
    this.ui.showOverlay(modal, { anchor: "bottom-left" });
  }

  /**
   * 打开 /model 选择器(M8d)。从 modelRegistry 取候选 SelectItem;
   * 选中后调 agent.setModel(modelEntry.model),Footer 下次 pull 自动反映新 modelId。
   */
  openModelSelector(): void {
    if (this.controller) {
      void this.openControllerModelSelector();
      return;
    }
    const items: SelectItem[] = this.modelRegistry.map((entry) => ({
      value: entry.id,
      label: entry.label,
      description: entry.description,
    }));
    const modal = new SelectorModal({
      theme: this.theme,
      selectListTheme: makeSelectListTheme(this.theme),
      title: "/model — switch model",
      items,
      onSelect: (item) => {
        const entry = this.modelRegistry.find((e) => e.id === item.value);
        if (entry) {
          this.agent?.setModel(entry.model);
        }
        this.ui.hideOverlay();
      },
      onCancel: () => this.ui.hideOverlay(),
    });
    this.ui.showOverlay(modal, { anchor: "bottom-left" });
  }

  /**
   * 打开 /thinking 选择器(M8e)。候选 ThinkingLevel;
   * 选中后注入到当前 thinkingLevel,触发 agent.setState 透传到下次 prompt。
   * 注:thinking level 切换是 streamFn options 责任;对用 createAnthropicAgent 装的 agent,
   *   其 streamFn 包络读取 thinkingLevel closure;改 thinking 需要 streamFn 重建。
   *   M8 简化:thinkingLevel 切换通过 hook 注入(由 caller 注册 onThinkingChange 回调);
   *   默认实现仅记录到 this.thinkingLevel 供 Footer 显示。
   */
  openThinkingSelector(): void {
    const model = this.controller?.currentSelection.model ?? this.agent?.state.model;
    if (!model) {
      this.showNotice("Select a model before configuring thinking.", "error");
      return;
    }
    const items: SelectItem[] = getSupportedThinkingLevels(model).map((level) => ({
      value: level,
      label: level,
      description: level === "off" ? "reasoning disabled" : "provider-supported reasoning",
    }));
    const modal = new SelectorModal({
      theme: this.theme,
      selectListTheme: makeSelectListTheme(this.theme),
      title: "/thinking — switch thinking level",
      items,
      onSelect: (item) => {
        void this.setThinkingLevel(item.value as ModelThinkingLevel);
        this.ui.hideOverlay();
      },
      onCancel: () => this.ui.hideOverlay(),
    });
    this.ui.showOverlay(modal, { anchor: "bottom-left" });
  }

  /**
   * 切换 thinking level:记录到 this.thinkingLevel + 调可选 onThinkingChange 钩子。
   * 默认钩子(由 demo 注入)负责 agent.streamFn 重建或 AgentLoopConfig 透传。
   */
  async setThinkingLevel(level: ModelThinkingLevel): Promise<void> {
    this.thinkingLevel = this.controller
      ? await this.controller.setThinkingLevel(level)
      : this.agent?.setThinkingLevel(level) ?? level;
    this.onThinkingChange?.(this.thinkingLevel);
    this.ui.requestRender();
  }

  getThinkingLevel(): ModelThinkingLevel {
    return this.thinkingLevel;
  }

  /** FooterSnapshotProvider:由 Footer.render 周期性 pull。 */
  isStreaming(): boolean {
    return this.streaming;
  }
  getStopReason(): string | undefined {
    return this.stopReason;
  }
  getModelId(): string {
    const st = this.controller?.currentSelection.model ?? this.agent?.state.model;
    if (!st) return "<no-model>";
    return typeof st === "string" ? st : (st as { id?: string }).id ?? "<unknown-model>";
  }
  getProviderId(): string {
    return this.controller?.currentSelection.provider ?? this.agent?.state.model.provider ?? "<no-provider>";
  }
  getSessionId(): string {
    return this.controller?.sessionId ?? this.agent?.sessionId ?? "<no-ledger>";
  }

  /** Editor.onSubmit 回调;把文本作为 user prompt 投递给 Agent,同时落 UI。 */
  private handleSubmit(text: string): void {
    if (text.length === 0) return;
    if (text.startsWith("/")) {
      const [rawCommand, ...argParts] = text.slice(1).trim().split(/\s+/);
      const cmd = rawCommand ?? "";
      const arg = argParts.join(" ");
      switch (cmd) {
        case "provider":
          if (this.rejectConfigWhileRunning()) return;
          void this.openProviderSelector();
          return;
        case "login":
          if (this.rejectConfigWhileRunning()) return;
          void this.openLoginSelector(arg || undefined);
          return;
        case "logout":
          if (this.rejectConfigWhileRunning()) return;
          void this.handleLogout(arg || undefined);
          return;
        case "model":
          if (this.rejectConfigWhileRunning()) return;
          this.openModelSelector();
          return;
        case "thinking":
          if (this.rejectConfigWhileRunning()) return;
          this.openThinkingSelector();
          return;
        case "mcp":
          this.openMcpServerSelector();
          return;
        case "prompt":
          this.openPromptSelector();
          return;
        case "commands":
        case "help":
          this.openSlashCommands();
          return;
        case "clear":
          this.refs.chat.clear();
          this.ui.requestRender();
          return;
        case "quit":
          void this.requestQuit();
          return;
        default:
          this.showNotice(`Unknown command: /${cmd}`, "error");
          return;
      }
    }

    this.streaming = true;
    this.stopReason = undefined;
    this.ui.requestRender();
    const prompt = this.controller
      ? this.controller.prompt(text, this.inFlight() ? "steer" : undefined)
      : this.agent!.prompt(text).then(() => undefined);
    void prompt.then(
      () => {
        // 最终状态由 agent_end 路径写入。
      },
      (err: unknown) => {
        this.streaming = false;
        this.showNotice(String(err), "error");
      },
    );
  }

  private handleFollowUpSubmit(text: string): void {
    if (!this.inFlight()) {
      this.handleSubmit(text);
      return;
    }
    const prompt = this.controller
      ? this.controller.prompt(text, "followUp")
      : Promise.reject(new Error("Follow-up queue is unavailable in demo mode."));
    void prompt.catch((error: unknown) => this.showNotice(String(error), "error"));
  }

  private restoreQueuesToEditor(): void {
    const queues = this.controller?.clearAllQueues();
    if (!queues) {
      this.showNotice("No queued messages to restore.");
      return;
    }
    const queued = [...queues.steering, ...queues.followUp]
      .map(messageText)
      .filter((text) => text.length > 0);
    if (queued.length === 0) {
      this.showNotice("No queued messages to restore.");
      return;
    }
    const current = this.refs.editor.getText();
    this.refs.editor.setText([...queued, current].filter((text) => text.trim()).join("\n\n"));
    this.showNotice(`Restored ${queued.length} queued message${queued.length === 1 ? "" : "s"}.`);
  }

  private inFlight(): boolean {
    return this.controller?.inFlight ?? this.agent?.inFlight ?? false;
  }

  private rejectConfigWhileRunning(): boolean {
    if (!this.inFlight()) return false;
    this.showNotice("Configuration commands are available when the current turn is idle.", "note");
    return true;
  }

  private showNotice(text: string, kind: "note" | "error" = "note"): void {
    this.refs.chat.push(new CustomMessageComponent({
      theme: this.theme,
      kind,
      text,
      timestamp: Date.now(),
    }));
    this.ui.requestRender();
  }

  private async openControllerModelSelector(provider?: string): Promise<void> {
    const controller = this.controller;
    if (!controller) return;
    const models = await controller.getAvailableModels(provider).catch((error: unknown) => {
      this.showNotice(`Model discovery failed: ${String(error)}`, "error");
      return [];
    });
    if (models.length === 0) {
      this.showNotice(provider
        ? `No available models for ${provider}. Configure authentication first.`
        : "No available models. Use /provider or /login first.", "error");
      return;
    }
    const byKey = new Map(models.map((model) => [`${model.provider}/${model.id}`, model]));
    const modal = new SearchableSelectorModal({
      title: provider ? `/model — ${provider}` : "/model — configured providers",
      items: models.map((model) => ({
        value: `${model.provider}/${model.id}`,
        label: model.id,
        description: `[${model.provider}] ${model.name ?? ""}`,
      })),
      maxVisible: 12,
      onSelect: (item) => {
        this.ui.hideOverlay();
        const model = byKey.get(item.value);
        if (!model) return;
        void controller.selectModel(model).then(() => {
          this.thinkingLevel = controller.currentSelection.thinkingLevel;
          this.showNotice(`Model: ${model.provider}/${model.id}`);
        }, (error: unknown) => this.showNotice(String(error), "error"));
      },
      onCancel: () => this.ui.hideOverlay(),
    });
    this.ui.showOverlay(modal, { anchor: "bottom-left" });
  }

  private async openProviderSelector(): Promise<void> {
    const controller = this.controller;
    if (!controller) {
      this.showNotice("Provider configuration is unavailable in demo mode.", "error");
      return;
    }
    const statuses = await controller.getProviderStatuses();
    const byId = new Map(statuses.map((status) => [status.id, status]));
    const modal = new SearchableSelectorModal({
      title: "/provider — all built-ins",
      items: statuses.map((status) => ({
        value: status.id,
        label: status.name,
        description: status.configured
          ? `configured${status.source ? ` · ${status.source}` : ""}`
          : status.interactiveAuthTypes.length > 0
            ? `login: ${status.interactiveAuthTypes.join("/")}`
            : "ambient credential required",
      })),
      maxVisible: 12,
      onSelect: (item) => {
        this.ui.hideOverlay();
        const status = byId.get(item.value);
        if (!status) return;
        if (status.configured) {
          void this.openControllerModelSelector(status.id);
        } else if (status.interactiveAuthTypes.length > 0) {
          void this.startLogin(status.id, status.interactiveAuthTypes);
        } else {
          this.showNotice(
            `${status.name} uses ambient credentials. Configure its environment/profile, then reopen /provider.`,
            "error",
          );
        }
      },
      onCancel: () => this.ui.hideOverlay(),
    });
    this.ui.showOverlay(modal, { anchor: "bottom-left" });
  }

  private async openLoginSelector(providerId?: string): Promise<void> {
    const controller = this.controller;
    if (!controller) {
      this.showNotice("Login is unavailable in demo mode.", "error");
      return;
    }
    if (providerId) {
      const status = (await controller.getProviderStatuses()).find((entry) => entry.id === providerId);
      if (!status) {
        this.showNotice(`Unknown provider: ${providerId}`, "error");
        return;
      }
      await this.startLogin(status.id, status.interactiveAuthTypes);
      return;
    }
    const statuses = (await controller.getProviderStatuses())
      .filter((status) => status.interactiveAuthTypes.length > 0);
    const modal = new SearchableSelectorModal({
      title: "/login — provider",
      items: statuses.map((status) => ({
        value: status.id,
        label: status.name,
        description: status.interactiveAuthTypes.join("/"),
      })),
      maxVisible: 12,
      onSelect: (item) => {
        this.ui.hideOverlay();
        const status = statuses.find((entry) => entry.id === item.value);
        if (status) void this.startLogin(status.id, status.interactiveAuthTypes);
      },
      onCancel: () => this.ui.hideOverlay(),
    });
    this.ui.showOverlay(modal, { anchor: "bottom-left" });
  }

  private async startLogin(providerId: string, types: AuthType[]): Promise<void> {
    const controller = this.controller;
    if (!controller) return;
    if (types.length === 0) {
      this.showNotice(`${providerId} has no interactive login flow; configure ambient credentials.`, "error");
      return;
    }
    const type = types.length === 1 ? types[0]! : await this.selectAuthType(types);
    if (!type) return;
    const abortController = new AbortController();
    const interaction: AuthInteraction = {
      signal: abortController.signal,
      prompt: (prompt) => this.promptAuth(prompt, abortController),
      notify: (event) => this.showAuthEvent(event),
    };
    this.showNotice(`Starting ${type} login for ${providerId}…`);
    try {
      await controller.login(providerId, type, interaction);
      this.showNotice(`Authenticated ${providerId}.`);
      await this.openControllerModelSelector(providerId);
    } catch (error) {
      if (!abortController.signal.aborted) this.showNotice(`Login failed: ${String(error)}`, "error");
    }
  }

  private selectAuthType(types: AuthType[]): Promise<AuthType | undefined> {
    return new Promise((resolve) => {
      const modal = new SelectorModal({
        theme: this.theme,
        selectListTheme: makeSelectListTheme(this.theme),
        title: "Authentication method",
        items: types.map((type) => ({ value: type, label: type === "api_key" ? "API key" : "OAuth" })),
        onSelect: (item) => {
          this.ui.hideOverlay();
          resolve(item.value as AuthType);
        },
        onCancel: () => {
          this.ui.hideOverlay();
          resolve(undefined);
        },
      });
      this.ui.showOverlay(modal, { anchor: "bottom-left" });
    });
  }

  private promptAuth(prompt: AuthPrompt, owner: AbortController): Promise<string> {
    if (prompt.type === "select") {
      return new Promise((resolve, reject) => {
        const cancel = () => {
          this.ui.hideOverlay();
          reject(new Error("Authentication cancelled"));
        };
        const modal = new SelectorModal({
          theme: this.theme,
          selectListTheme: makeSelectListTheme(this.theme),
          title: prompt.message,
          items: prompt.options.map((option) => ({
            value: option.id,
            label: option.label,
            description: option.description,
          })),
          onSelect: (item) => {
            this.ui.hideOverlay();
            resolve(item.value);
          },
          onCancel: () => {
            owner.abort();
            cancel();
          },
        });
        prompt.signal?.addEventListener("abort", cancel, { once: true });
        this.ui.showOverlay(modal, { anchor: "bottom-left" });
      });
    }
    return new Promise((resolve, reject) => {
      const cancel = () => {
        this.ui.hideOverlay();
        reject(new Error("Authentication cancelled"));
      };
      const modal = new AuthInputModal({
        title: prompt.type === "secret" ? "Secret" : "Authentication input",
        message: prompt.message,
        placeholder: prompt.placeholder,
        secret: prompt.type === "secret",
        onSubmit: (value) => {
          this.ui.hideOverlay();
          resolve(value);
        },
        onCancel: () => {
          owner.abort();
          cancel();
        },
      });
      prompt.signal?.addEventListener("abort", cancel, { once: true });
      this.ui.showOverlay(modal, { anchor: "bottom-left" });
    });
  }

  private showAuthEvent(event: AuthEvent): void {
    if (event.type === "info") {
      const links = event.links?.map((link) => link.url).join(" ") ?? "";
      this.showNotice(`${event.message}${links ? ` ${links}` : ""}`);
    } else if (event.type === "auth_url") {
      this.showNotice(`${event.instructions ?? "Open this URL:"} ${event.url}`);
    } else if (event.type === "device_code") {
      this.showNotice(`Open ${event.verificationUri} and enter code ${event.userCode}`);
    } else {
      this.showNotice(event.message);
    }
  }

  private async handleLogout(providerId?: string): Promise<void> {
    const controller = this.controller;
    if (!controller) return;
    const id = providerId ?? controller.currentSelection.provider;
    if (!id) {
      this.showNotice("No provider selected.", "error");
      return;
    }
    await controller.logout(id);
    this.showNotice(`Logged out ${id}.`);
  }

  private replayInitialHistory(): void {
    if (!this.controller) return;
    for (const warning of this.controller.warnings) this.showNotice(warning, "note");
    for (const message of this.controller.messages) this.renderHistoricalMessage(message);
    if (this.controller.warnings.length > 0) {
      for (const entry of this.controller.auditEntries) {
        const name = typeof entry.payload.toolName === "string" ? entry.payload.toolName : "tool";
        const content = typeof entry.payload.content === "string" ? `: ${entry.payload.content}` : "";
        this.showNotice(`${entry.type} ${name}${content}`);
      }
    }
  }

  private renderHistoricalMessage(message: AgentMessage): void {
    if (message.role === "user") {
      this.refs.chat.push(new UserMessageComponent({
        theme: this.theme,
        text: messageText(message),
        timestamp: Date.now(),
      }));
      return;
    }
    if (message.role === "assistant") {
      const component = new AssistantMessageComponent({
        theme: this.theme,
        partial: message as AssistantMessage,
      });
      component.finalize();
      this.refs.chat.push(component);
      for (const toolCall of message.content.filter((content) => content.type === "toolCall")) {
        const call = new ToolCallComponent({
          theme: this.theme,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          args: toolCall.arguments,
          initialStatus: "ok",
        });
        this.refs.chat.push(call);
      }
      return;
    }
    for (const result of message.content) {
      this.refs.chat.push(new ToolResultComponent({
        theme: this.theme,
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        result: { content: result.content, details: result.details, isError: result.isError },
        isError: result.isError === true,
        timestamp: Date.now(),
      }));
    }
  }

  /** Agent.subscribe 回调,适配为 TuiEvent 后分发。 */
  private handleAgentEvent(ev: AgentEvent): void {
    let adapted: TuiEvent;
    try {
      adapted = adaptAgentEvent(ev);
    } catch (e) {
      process.stderr.write(`[interactive-mode] adaptAgentEvent failed: ${String(e)}\n`);
      return;
    }
    this.handleEvent(adapted);
  }

  /**
   * 主控 switch;M2 阶段:message_* 路由把 AssistantMessageComponent 挂上 chat 并流式更新;
   * user 消息块在 handleSubmit 阶段已 push,事件流不再处理 user 分支;
   * 其余 case 留 noop 占位,M3 起逐 case 落实(对照 03-event-binding §1 表)。
   */
  private handleEvent(ev: TuiEvent): void {
    try {
      switch (ev.type) {
        case "agent_start":
          this.streaming = true;
          this.stopReason = undefined;
          break;
        case "agent_end":
          this.streaming = false;
          // agent_end 不带 stopReason,保留最近一次 turn_end / message_end 的 stopReason
          break;
        case "turn_start":
          this.refs.status.setTurn(ev.turn);
          break;
        case "turn_end":
          this.refs.status.setTurn(ev.turn);
          if (ev.stopReason) this.refs.status.setStopReason(ev.stopReason);
          break;
        case "message_start":
          if (ev.role === "user" && ev.message?.role === "user") {
            this.refs.chat.push(new UserMessageComponent({
              theme: this.theme,
              text: messageText(ev.message),
              timestamp: ev.timestamp,
            }));
          } else if (ev.role === "assistant") {
            // push 一个新的 AssistantMessageComponent,流式阶段 partial 为空(等 message_update)
            const comp = new AssistantMessageComponent({ theme: this.theme });
            this.refs.chat.push(comp);
          }
          break;
        case "message_end":
          this.stopReason = ev.stopReason ?? this.stopReason;
          this.refs.status.setStopReason(this.stopReason);
          if (ev.role === "assistant") {
            // finalize:从 chat 末位调 finalize,通知 Markdown layout flush
            const last = this.refs.chat.last();
            if (last instanceof AssistantMessageComponent) {
              if (ev.message?.role === "assistant") {
                last.setPartial(ev.message as AssistantMessage);
              }
              last.finalize();
            } else if (ev.message?.role === "assistant") {
              const component = new AssistantMessageComponent({
                theme: this.theme,
                partial: ev.message as AssistantMessage,
              });
              component.finalize();
              this.refs.chat.push(component);
            }
          }
          break;
        case "message_update": {
          const e = ev.assistantMessageEvent;
          if (e.type === "done" || e.type === "error") {
            // done/error 即 stream fan-in 终点;final 已在 message_end 路径处理
            break;
          }
          const partial = (e as { partial?: AssistantMessage }).partial;
          if (partial === undefined) break;
          if (partial.role !== "assistant") break;
          // 找 chat 末位的 AssistantMessageComponent;若没有则补 push 一份
          let last = this.refs.chat.last();
          if (!(last instanceof AssistantMessageComponent)) {
            const comp = new AssistantMessageComponent({ theme: this.theme, partial });
            this.refs.chat.push(comp);
            last = comp;
          } else {
            last.setPartial(partial);
          }
          // M3 临时:从 partial 抽 toolCalls 占位记录(本期不在 UI 中渲染);后续 M3 路由
          void extractToolCalls(partial);
          break;
        }
        case "tool_execution_start": {
          const args = isRecord(ev.args) ? ev.args : {};
          const comp = ev.toolName === "bash"
            ? new BashExecutionComponent({
                command: typeof args.command === "string" ? args.command : "<command>",
                runInBackground: args.run_in_background === true,
                initialStatus: "running",
              })
            : isDiffTool(ev.toolName)
              ? new DiffPreviewComponent({
                  verb: ev.toolName === "write" ? "write" : "edit",
                  path: typeof args.path === "string"
                    ? args.path
                    : typeof args.filePath === "string"
                      ? args.filePath
                      : "<path>",
                  initialStatus: "running",
                })
              : new ToolCallComponent({
                  theme: this.theme,
                  toolCallId: ev.toolCallId,
                  toolName: ev.toolName,
                  args: ev.args,
                  initialStatus: "running",
                });
          this.toolCallComponents.set(ev.toolCallId, comp);
          this.refs.chat.push(comp);
          break;
        }
        case "tool_execution_update": {
          const comp = this.toolCallComponents.get(ev.toolCallId);
          if (comp) {
            const partial = ev.partialResult as AgentToolResult;
            if (comp instanceof BashExecutionComponent) {
              const details = isRecord(partial.details) ? partial.details : {};
              if (typeof details.stdoutChunk === "string") comp.appendOutput(details.stdoutChunk, "stdout");
              if (typeof details.stderrChunk === "string") comp.appendOutput(details.stderrChunk, "stderr");
            } else if (comp instanceof ToolCallComponent) {
              comp.setPartialResult(partial);
            }
          }
          break;
        }
        case "tool_execution_end": {
          const comp = this.toolCallComponents.get(ev.toolCallId);
          if (comp) {
            const finalResult: AgentToolResult = {
              content: ev.result.content,
              details: ev.result.details,
              isError: ev.isError,
            };
            if (comp instanceof BashExecutionComponent) {
              const details = isRecord(finalResult.details) ? finalResult.details : {};
              comp.finalize(
                typeof details.exitCode === "number" ? details.exitCode : ev.isError ? 1 : 0,
                typeof details.durationMs === "number" ? details.durationMs : 0,
                ev.isError,
                ev.isError ? toolResultText(finalResult) : undefined,
              );
            } else if (comp instanceof DiffPreviewComponent) {
              if (ev.isError) comp.setError(toolResultText(finalResult));
              else comp.setStatus("ok");
            } else {
              comp.finalize(finalResult, ev.isError);
            }
            // ToolResultComponent 也追加一份(显式 done 行)
            const resultComp = new ToolResultComponent({
              theme: this.theme,
              toolCallId: ev.toolCallId,
              toolName: ev.toolName,
              result: finalResult,
              isError: ev.isError,
              timestamp: ev.timestamp,
            });
            this.refs.chat.push(resultComp);
            this.toolCallComponents.delete(ev.toolCallId);
          }
          break;
        }
        case "queue_update":
          this.refs.status.setQueueCounts(ev.steering.length, ev.followUp.length);
          break;
      }
    } catch (e) {
      // 异常不外抛(对照 02 §1 不可变契约);记 stderr
      process.stderr.write(`[interactive-mode] handleEvent ${ev.type} failed: ${String(e)}\n`);
    }
    // 任何事件后都请求一次合帧
    this.ui.requestRender();
  }
}

function messageText(message: AgentMessage): string {
  if (message.role !== "user") return "";
  return message.content.map((content) => content.text).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDiffTool(name: string): boolean {
  return name === "write" || name === "edit" || name === "MultiEdit";
}

function toolResultText(result: AgentToolResult): string {
  return result.content
    .filter((content): content is { type: "text"; text: string } => content.type === "text")
    .map((content) => content.text)
    .join("");
}
