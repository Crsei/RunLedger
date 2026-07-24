/**
 * InteractiveMode —— TUI 主控,组装 pi-tui 组件树并接通 Agent 事件流。
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
 *      M1 不实际触发(无 init 重试路径),M6 起 OSC 11 探测时启用。
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
import type { AgentEvent, AgentMessage, UserAgentMessage } from "../runtime/types.ts";
import type { ModelThinkingLevel } from "../types.ts";
import { getSupportedThinkingLevels } from "../models.ts";
import type { AuthEvent, AuthInteraction, AuthPrompt, AuthType } from "../auth/types.ts";
import type {
  InteractiveExtensionMutationAction,
  InteractiveExtensionResourceView,
  InteractiveSessionControllerPort,
} from "../runtime/interactive-session-controller.ts";

import type { FooterSnapshotProvider, TuiEvent } from "./types.ts";
import { loadTheme, applyEnvOverrides, type Theme } from "./theme/theme.ts";
import { makeEditorTheme, makeSelectListTheme } from "./theme/factories.ts";
import { CustomEditor, type CustomEditorProps } from "./components/custom-editor.ts";
import { Footer } from "./components/footer.ts";
import { KeybindingHints } from "./components/keybinding-hints.ts";
import { LoadedResourcesComponent } from "./components/loaded-resources.ts";
import { AuthInputModal } from "./components/auth-input-modal.ts";
import { SearchableSelectorModal } from "./components/searchable-selector-modal.ts";
import { StatusComponent } from "./components/status.ts";
import { SelectorModal } from "./components/selector-modal.ts";
import type { SelectItem } from "./index.ts";
import { createAppKeyListener } from "./keybindings/app-keys.ts";
import { detectScheme } from "./theme/osc-detector.ts";
import type {
  TuiBootstrapSnapshot,
  CommandSuggestionView,
  CommandTimelineView,
} from "./presentation/types.ts";
import { ContextHeader } from "./components/context-header.ts";
import { ActiveState } from "./components/active-state.ts";
import { TimelineComponent } from "./components/timeline.ts";
import { CommandPalette } from "./components/command-palette.ts";
import { createInitialTuiState } from "./application/reducer.ts";
import { EffectRunner } from "./application/effect-runner.ts";
import { InteractiveShell } from "./application/interactive-shell.ts";
import { OverlayController } from "./application/overlay-controller.ts";
import type { TuiState, TuiTerminalState } from "./application/types.ts";
import { adaptRuntimeEvent } from "./application/event-adapter.ts";
import { CommandRegistry } from "./commands/registry.ts";
import { builtinCommandDefinitions, COMPATIBILITY_COMMAND_NAMES } from "./commands/builtins.ts";
import { parseCommand } from "./commands/parser.ts";
import { executeCommand } from "./commands/executor.ts";
import { createCommandAutocompleteProvider } from "./commands/autocomplete-provider.ts";
import {
  MappedCompatibilityCommandPort,
  type CompatibilityCommandHandler,
} from "./commands/compatibility-port.ts";
import {
  createTimelineProjectionCursor,
  projectLive,
  projectReplay,
} from "./timeline/projector.ts";
import {
  clearTimelineViewport,
  createTimelineState,
  reduceTimeline,
} from "./timeline/tool-reducer.ts";
import type { TimelineProjectionCursor, TimelineState } from "./timeline/types.ts";
import type { SessionCatalogPort } from "./sessions/catalog.ts";
import { SessionPickerComponent } from "./components/session-picker.ts";

/** InteractiveMode 装配参数。 */
export interface InteractiveModeOptions {
  /** 新 CLI 使用统一 controller;agent 仅保留 demo 兼容。 */
  controller?: InteractiveSessionControllerPort;
  agent?: Agent;
  /** 终端实现,默认 ProcessTerminal;可传入 mock 终端用于单测。 */
  terminal?: Terminal;
  /** 主题名,默认 dark;M6 接入 env / OSC 11 自动切换。 */
  themeName?: "dark" | "light";
  /** 调试模式:onError 时把堆栈写到 stderr。 */
  debug?: boolean;
  /** M8d:/model 选择器候选列表;空则 selector 不可用。 */
  modelRegistry?: ModelSwitchEntry[];
  /** M8e:thinking level 初始值,默认 "minimal"。 */
  initialThinkingLevel?: ModelThinkingLevel;
  /** M8e:thinking level change 回调,由 caller 决定如何传给 agent streamFn。 */
  onThinkingChange?: (level: ModelThinkingLevel) => void;
  /** CLI composition 提供的真实 workspace/session 快照。 */
  bootstrap?: TuiBootstrapSnapshot;
  /** CLI 注入的只读 session catalog；demo 缺失时 /sessions 显示 disabled reason。 */
  sessionCatalog?: SessionCatalogPort;
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
  header: ContextHeader;
  loadedResources: LoadedResourcesComponent;
  chat: TimelineComponent;
  status: ActiveState;
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
  private readonly controller: InteractiveSessionControllerPort | undefined;
  private theme: Theme;
  private readonly kb: KeybindingsManager;
  private readonly refs: ContainerRefs;
  private readonly bootstrap: TuiBootstrapSnapshot;
  private readonly registry: CommandRegistry;
  private readonly shell: InteractiveShell;
  private readonly overlays: OverlayController;
  private sessionPickerComponent: SessionPickerComponent | undefined;
  private timelineState: TimelineState = createTimelineState();
  private timelineCursor: TimelineProjectionCursor = createTimelineProjectionCursor();
  private appliedViewportClearRevision = 0;
  private nextInvocation = 0;
  private drainScheduled = false;
  private unsubscribe?: () => void;

  // FooterSnapshotProvider 状态(只有 handleEvent 路径写)
  private streaming = false;
  private stopReason: string | undefined = undefined;

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
    this.bootstrap = opts.bootstrap ?? {
      workspace: process.cwd(),
      session: {
        id: opts.controller?.sessionId ?? opts.agent?.sessionId ?? "<no-session>",
        format: opts.agent && !opts.controller ? "demo" : "unknown",
        lifecycle: "active",
      },
    };
    let resolveExit: (() => void) | undefined;
    this.exitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    this.resolveExit = () => resolveExit?.();

    // TUI 使用 showHardwareCursor=false,Editor 自身以 CURSOR_MARKER 通知光标位置
    this.ui = new TUI(this.terminal, false);
    this.overlays = new OverlayController(this.ui);
    this.registry = new CommandRegistry(builtinCommandDefinitions());
    const compatibility = new MappedCompatibilityCommandPort(this.compatibilityHandlers());
    const runner = new EffectRunner({
      prompt: {
        run: async (text, behavior, signal) => {
          if (signal.aborted) throw signal.reason;
          if (this.controller) {
            await this.controller.prompt(text, behavior);
          } else {
            await this.agent!.prompt(text);
          }
        },
      },
      compatibility,
      sessionCatalog: opts.sessionCatalog,
    });
    this.shell = new InteractiveShell({
      initialState: createInitialTuiState(this.bootstrap, {
        sessionCatalog: opts.sessionCatalog
          ? { available: true }
          : {
              available: false,
              reason: "Session browsing is unavailable because no read-only catalog was configured.",
            },
      }),
      runner,
      onState: (state) => this.syncApplicationState(state),
    });

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

  /** 装配当前 canonical TUI 组件树并返回引用。 */
  private assembleTree(): ContainerRefs {
    const header = new ContextHeader({
      workspace: this.bootstrap.workspace,
      sessionId: this.bootstrap.session.id,
      sessionTitle: this.bootstrap.session.title,
      format: this.bootstrap.session.format,
      lifecycle: this.bootstrap.session.lifecycle,
    });
    const loadedResources = new LoadedResourcesComponent({});
    // 把已注册工具数填到 loadedResources
    loadedResources.setResource("tools", this.controller?.toolCount ?? this.agent?.state.tools.length ?? 0);
    this.refreshExtensionResourceCounts(loadedResources);
    loadedResources.setResource("slash", this.registry.snapshot.definitions.length);
    const chat = new TimelineComponent(this.timelineState);
    const status = new ActiveState({
      query: "idle",
      steeringCount: 0,
      followUpCount: 0,
      frozen: false,
      recoveryRequired: this.bootstrap.session.lifecycle === "recovery-required",
    });
    const editorTheme: EditorTheme = makeEditorTheme(this.theme, this.makeSelectListTheme());
    const editorProps: CustomEditorProps = {
      theme: this.theme,
      selectListTheme: this.makeSelectListTheme(),
      onSubmit: (text) => this.handleSubmit(text),
      onFollowUp: (text) => this.handleFollowUpSubmit(text),
      onDequeue: () => this.restoreQueuesToEditor(),
    };
    const editor = new CustomEditor(this.ui, editorTheme, editorProps);
    editor.setAutocompleteMaxVisible(12);
    editor.setAutocompleteProvider(createCommandAutocompleteProvider(() => this.commandSuggestions()));
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
          if (this.overlays.isOpen) return false;
          this.handleInterrupt();
          return true;
        },
        onExit: () => this.overlays.isOpen ? false : this.handleCtrlD(),
        onRefresh: () => this.ui.invalidate(),
      }),
    );
    //OSC 11 自动探测 dark/light(M6):异步探测,响应到达后切换 theme-factory 生效下次 invalidate
    void detectScheme(this.terminal).then((scheme) => {
      this.maybeSwitchTheme(scheme);
    });
    try {
      this.ui.start();
    } catch (error) {
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      this.resolveExit();
      throw error;
    }
    await this.exitPromise;
  }

  /** 中断当前 turn;M8c:真接 agent.interrupt()。 */
  private handleInterrupt(): void {
    if (this.streaming || this.inFlight()) {
      // 先发 abort，阻止 loop 在 cancellation barrier 等待期间继续 drain；随后
      // 只有 queue.cancelled 全部 durable 后才把正文放回 editor。
      this.controller?.interrupt();
      this.agent?.interrupt();
      void this.cancelQueues("operator interrupted active turn").then(
        (queues) => this.restoreCancelledQueues(queues, false),
        (error: unknown) => this.showNotice(`Queued messages were not cleared: ${String(error)}`, "error"),
      );
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

  /** OSC 11 探测返回 scheme 后切换 theme;M6 真实装 env 覆盖已不依赖 scheme 路径。 */
  private maybeSwitchTheme(scheme: "dark" | "light"): void {
    if (scheme === "dark") {
      // 默认已 dark,无需切换
      return;
    }
    // light:重新 build theme 与 factories;但编辑器主题已被 Editor 实例消费,
    // 替换需要 Editor 暴露 setTheme;本期 M6 暂只刷新 footer / loadedResources 主题;
    // 下次 polish 会做完整 swap。
    this.theme.primary = "#1a1a1a";
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
    this.controller?.dispose();
    this.ui.stop();
    this.resolveExit();
  }

  /**
   * 公共 prompt 注入入口;demo 与未来 ReplHandle.sendText 走同一通道。
   *
   * 实现:把 Editor onSubmit 流转过来即可——等价于"程序模拟一键回车提交"。
   * 不调 agent.prompt 直绕,保证所有输入经过同一个 action/effect 通道。
   */
  echoPrompt(text: string): void {
    this.handleSubmit(text);
  }

  /**
   * 打开 slash 命令选择器(M5 占位,M6 键位 / 触发接通)。
   * 选中 / xxx 后,把 / xxx 当 user prompt 注入(目前 mock 占位)。
   */
  openSlashCommands(): void {
    this.showCommandPalette();
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
      onCancel: () => this.overlays.close(),
    });
    this.overlays.show(modal);
  }

  /**
   * 打开 mcp server 选择器(M5 占位,真实 mcp 注册表接入留 M5+ 远期)。
   */
  openMcpServerSelector(): void {
    this.openExtensionResourceSelector("/mcp", ["mcp-server", "mcp-tool"]);
  }

  private openExtensionResourceSelector(title: string, kinds: readonly string[]): void {
    const snapshot = this.controller?.getExtensionSnapshot?.();
    if (!snapshot) {
      this.showNotice("Production Extension runtime is not available for this session.", "error");
      return;
    }
    const resources = snapshot.resources.filter((resource) => kinds.includes(resource.kind));
    if (resources.length === 0) {
      this.showNotice(`${title}: no resources in generation ${snapshot.generation}.`);
      return;
    }
    const byId = new Map(resources.map((resource) => [resource.id, resource]));
    const modal = new SelectorModal({
      theme: this.theme,
      selectListTheme: makeSelectListTheme(this.theme),
      title: `${title} — generation ${snapshot.generation}`,
      items: resources.map((resource) => ({
        value: resource.id,
        label: resource.displayName,
        description: `${resource.kind} · ${resource.source} · ${resource.trust} · ${resource.activation}${resource.componentCount ? ` · ${resource.componentCount} components` : ""}${resource.diagnostic ? ` · ${resource.diagnostic}` : ""}${resource.enabled ? "" : " · disabled"}`,
      })),
      onSelect: (item) => {
        this.overlays.close();
        const resource = byId.get(item.value);
        if (resource) this.openExtensionResourceActions(resource);
      },
      onCancel: () => this.overlays.close(),
    });
    this.overlays.show(modal);
  }

  private openExtensionResourceActions(resource: InteractiveExtensionResourceView): void {
    const items: SelectItem[] = [{
      value: "details",
      label: "details",
      description: "Show exact identity, digest, capabilities, and current state",
    }];
    if (resource.trust === "trusted") {
      items.push({ value: "untrust", label: "revoke trust", description: "Revoke the exact digest-bound trust receipt" });
    } else {
      items.push({ value: "trust", label: "grant trust", description: "Grant trust to this exact identity and digest" });
    }
    if (resource.kind === "plugin" || resource.kind === "hook" || resource.kind === "mcp-server") {
      items.push(resource.enabled
        ? { value: "disable", label: "disable", description: "Disable this exact resource" }
        : { value: "enable", label: "enable", description: "Enable this exact resource" });
    }
    if (resource.kind === "mcp-server") {
      items.push(
        { value: "login", label: "login", description: "Start governed MCP OAuth login" },
        { value: "logout", label: "logout", description: "Revoke the MCP credential and close its client" },
      );
    }
    const modal = new SelectorModal({
      theme: this.theme,
      selectListTheme: makeSelectListTheme(this.theme),
      title: resource.id,
      items,
      onSelect: (item) => {
        this.overlays.close();
        if (item.value === "details") {
          this.showNotice(
            `${resource.id}\nsource=${resource.source}\ntrust=${resource.trust} activation=${resource.activation} enabled=${resource.enabled}\ndigest=${resource.digest}\ncapabilities=${resource.capabilities.length > 0 ? resource.capabilities.join(", ") : "none declared"}\ncomponents=${resource.componentCount}${resource.diagnostic ? `\ndiagnostic=${resource.diagnostic}` : ""}`,
          );
          return;
        }
        this.confirmExtensionMutation(
          resource,
          item.value as InteractiveExtensionMutationAction,
        );
      },
      onCancel: () => this.overlays.close(),
    });
    this.overlays.show(modal);
  }

  private confirmExtensionMutation(
    resource: InteractiveExtensionResourceView,
    action: InteractiveExtensionMutationAction,
  ): void {
    if (this.rejectConfigWhileRunning()) return;
    if (!this.controller?.mutateExtension) {
      this.showNotice("Governed Extension mutation ports are not available.", "error");
      return;
    }
    const modal = new AuthInputModal({
      title: `Confirm ${action}`,
      message: [
        `identity=${resource.id}`,
        `digest=${resource.digest}`,
        `capabilities=${resource.capabilities.length > 0 ? resource.capabilities.join(", ") : "none declared"}`,
        "Type the exact digest to continue.",
      ].join("\n"),
      placeholder: resource.digest,
      onSubmit: (value) => {
        this.overlays.close();
        if (value.trim() !== resource.digest) {
          this.showNotice("Digest confirmation did not match; no Extension state changed.", "error");
          return;
        }
        void this.applyExtensionMutation(resource, action);
      },
      onCancel: () => this.overlays.close(),
    });
    this.overlays.show(modal);
  }

  private async applyExtensionMutation(
    resource: InteractiveExtensionResourceView,
    action: InteractiveExtensionMutationAction,
  ): Promise<void> {
    const result = await this.controller?.mutateExtension?.({
      action,
      kind: resource.kind,
      resourceId: resource.id,
      digest: resource.digest,
    });
    if (!result) {
      this.showNotice("Governed Extension mutation ports are not available.", "error");
      return;
    }
    if (!result.ok) {
      this.showNotice(result.message, "error");
      return;
    }
    const reload = await this.controller?.reloadExtensions?.();
    this.refreshExtensionResourceCounts();
    this.showNotice(
      reload
        ? `${result.message}; reload ${reload.status}${reload.reason ? `: ${reload.reason}` : ""}`
        : result.message,
      reload?.status === "failed" ? "error" : "note",
    );
  }

  private async reloadExtensions(): Promise<void> {
    if (this.rejectConfigWhileRunning()) return;
    const reload = this.controller?.reloadExtensions;
    if (!reload) {
      this.showNotice("Production Extension runtime is not available for this session.", "error");
      return;
    }
    const result = await reload.call(this.controller);
    this.refreshExtensionResourceCounts();
    this.showNotice(
      result.status === "failed"
        ? `Extension reload failed: ${result.reason ?? "unknown failure"}`
        : `Extension reload ${result.status}${result.reason ? `: ${result.reason}` : "."}`,
      result.status === "failed" ? "error" : "note",
    );
  }

  private refreshExtensionResourceCounts(target?: LoadedResourcesComponent): void {
    const component = target ?? this.refs?.loadedResources;
    if (!component) return;
    const snapshot = this.controller?.getExtensionSnapshot?.();
    const resources = snapshot?.resources ?? [];
    component.setResource("skills", resources.filter((resource) => resource.kind === "skill").length);
    component.setResource("hooks", resources.filter((resource) => resource.kind === "hook").length);
    component.setResource("mcp", resources.filter((resource) => resource.kind === "mcp-server").length);
    if (snapshot) {
      const { ready, blocked, error, disabled } = snapshot.counts;
      component.setResource(
        "extensions",
        ready + blocked + error + disabled,
        `ready=${ready}/blocked=${blocked}/error=${error}/disabled=${disabled}`,
      );
    } else {
      component.setResource("extensions", 0);
    }
    if (this.controller) component.setResource("tools", this.controller.toolCount);
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
        this.overlays.close();
      },
      onCancel: () => this.overlays.close(),
    });
    this.overlays.show(modal);
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
        this.overlays.close();
      },
      onCancel: () => this.overlays.close(),
    });
    this.overlays.show(modal);
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
    if (text.includes("\0")) {
      this.showNotice("Input contains a NUL byte and was rejected.", "error");
      return;
    }
    this.refs.editor.setText("");
    if (text.startsWith("!")) {
      this.showNotice("Direct bash input is disabled because no governed bash port is configured.", "error");
      return;
    }
    if (text.startsWith("/")) {
      this.submitCommand(text);
      return;
    }
    if (this.shell.state.queryGuard.state !== "idle") {
      this.shell.dispatch({
        type: "queue.add",
        item: { id: `queue:prompt:${this.nextInvocation++}`, kind: "prompt", text },
      });
      return;
    }
    this.dispatchPrompt(text);
  }

  private dispatchPrompt(text: string): void {
    const correlationId = `prompt:${this.nextInvocation++}`;
    this.streaming = true;
    this.stopReason = undefined;
    this.shell.dispatch({
      type: "effect.dispatch",
      effect: {
        type: "prompt",
        effectId: `${correlationId}:effect:0`,
        correlationId,
        text,
      },
    });
  }

  private submitCommand(text: string): void {
    const invocationId = `command:${this.nextInvocation++}`;
    const snapshot = this.registry.snapshot;
    const parsed = parseCommand(text, snapshot, invocationId);
    if (!parsed.ok) {
      const rawName = text.slice(1).trim().split(/[ \t\r\n]+/u)[0] || "unknown";
      this.shell.dispatch({
        type: "command.terminal",
        command: {
          invocationId,
          canonicalName: parsed.canonicalName ?? rawName,
          normalizedArgs: [],
        },
        terminal: { state: "failed", message: parsed.message, retryable: false },
      });
      return;
    }
    const output = executeCommand(this.shell.state, snapshot, parsed.intent);
    for (const action of output.actions) this.shell.dispatch(action);
  }

  private showCommandPalette(): void {
    const suggestions = this.commandSuggestions();
    const modal = new CommandPalette({
      suggestions,
      onSelect: (command) => {
        this.overlays.close();
        this.shell.dispatch({ type: "overlay.set", overlay: { state: "closed" } });
        this.handleSubmit(command);
      },
      onCancel: () => {
        this.overlays.close();
        this.shell.dispatch({ type: "overlay.set", overlay: { state: "closed" } });
      },
    });
    this.overlays.show(modal);
  }

  private commandSuggestions(): readonly CommandSuggestionView[] {
    const state = this.shell.state;
    return this.registry.snapshot.definitions.flatMap((definition) => {
      const availability = definition.availability(state);
      if (availability.state === "hidden") return [];
      return [{
        canonicalName: definition.canonicalName,
        label: `/${definition.canonicalName}`,
        description: definition.description,
        ...(availability.state === "disabled" ? { disabledReason: availability.reason } : {}),
      }];
    });
  }

  private syncApplicationState(state: TuiState): void {
    if (state.viewportClearRevision !== this.appliedViewportClearRevision) {
      this.appliedViewportClearRevision = state.viewportClearRevision;
      this.timelineState = clearTimelineViewport(this.timelineState);
      this.refs?.chat.setState(this.timelineState);
    }
    const commands: CommandTimelineView[] = state.commandOrder.flatMap((id) => {
      const record = state.commandsById[id];
      if (!record) return [];
      const execution = record.execution;
      const summary = execution.state === "failed"
        ? execution.message
        : execution.state === "cancelled"
          ? execution.reason
          : execution.state === "aborted"
            ? execution.reason
            : execution.state === "running"
              ? undefined
              : execution.summary;
      return [{
        invocationId: record.invocationId,
        canonicalName: record.canonicalName,
        args: record.normalizedArgs,
        state: execution.state,
        ...(summary ? { summary } : {}),
      }];
    });
    this.refs?.chat.setCommands(commands);
    this.refs?.status.setView({
      query: state.queryGuard.state,
      activeTurn: state.activeTurn,
      steeringCount: state.steeringCount,
      followUpCount: state.followUpCount,
      frozen: state.transitionFrozen,
      recoveryRequired: state.recoveryRequired,
    });
    if (state.overlay.state === "command-palette" && !this.overlays.isOpen && this.refs) {
      this.showCommandPalette();
    }
    if (state.overlay.state === "session-picker") {
      if (!this.sessionPickerComponent) this.showSessionPicker();
      this.sessionPickerComponent?.setState(state.sessionPicker);
    } else if (this.sessionPickerComponent) {
      this.overlays.close();
      this.sessionPickerComponent = undefined;
    }
    this.ui.requestRender();
    this.scheduleQueueDrain(state);
  }

  private showSessionPicker(): void {
    const component = new SessionPickerComponent(this.shell.state.sessionPicker, {
      onSearch: (query) => this.shell.dispatch({ type: "session.picker.search", query }),
      onSelect: (sessionId) => this.shell.dispatch({ type: "session.picker.select", sessionId }),
      onInspect: (sessionId) => this.shell.dispatch({ type: "session.picker.inspect", sessionId }),
      onCancel: () => {
        this.overlays.close();
        this.sessionPickerComponent = undefined;
        this.shell.dispatch({ type: "session.picker.close" });
      },
    });
    this.sessionPickerComponent = component;
    this.overlays.show(component);
  }

  private scheduleQueueDrain(state: TuiState): void {
    if (
      this.drainScheduled ||
      state.queryGuard.state !== "idle" ||
      state.overlay.state !== "closed" ||
      this.overlays.isOpen ||
      state.transitionFrozen ||
      state.recoveryRequired ||
      state.queue.length === 0
    ) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      const current = this.shell.state;
      const item = current.queue[0];
      if (
        !item ||
        current.queryGuard.state !== "idle" ||
        current.overlay.state !== "closed" ||
        this.overlays.isOpen ||
        current.transitionFrozen ||
        current.recoveryRequired
      ) return;
      this.shell.dispatch({ type: "queue.shift", itemId: item.id });
      if (item.commandInvocationId) {
        const previous = current.commandsById[item.commandInvocationId];
        if (previous) {
          this.shell.dispatch({
            type: "command.terminal",
            command: {
              invocationId: previous.invocationId,
              canonicalName: previous.canonicalName,
              normalizedArgs: previous.normalizedArgs,
            },
            terminal: { state: "succeeded", summary: "dequeued as a new execution attempt" },
          });
        }
      }
      if (item.kind === "slash") this.submitCommand(item.text);
      else if (item.kind === "prompt") this.dispatchPrompt(item.text);
    });
  }

  private compatibilityHandlers(): Readonly<Record<string, CompatibilityCommandHandler>> {
    const succeeded = (summary: string): TuiTerminalState => ({ state: "succeeded", summary });
    const handlers: Record<string, CompatibilityCommandHandler> = {
      provider: async () => {
        await this.openProviderSelector();
        return succeeded("provider selector opened");
      },
      login: async (args) => {
        await this.openLoginSelector(args[0]);
        return succeeded("login flow opened");
      },
      logout: async (args) => {
        await this.handleLogout(args[0]);
        return succeeded("logout completed");
      },
      model: () => {
        this.openModelSelector();
        return succeeded("model selector opened");
      },
      thinking: () => {
        this.openThinkingSelector();
        return succeeded("thinking selector opened");
      },
      plugins: () => {
        this.openExtensionResourceSelector("/plugins", ["plugin"]);
        return succeeded("plugin view opened");
      },
      skills: () => {
        this.openExtensionResourceSelector("/skills", ["skill"]);
        return succeeded("skill view opened");
      },
      hooks: () => {
        this.openExtensionResourceSelector("/hooks", ["hook"]);
        return succeeded("hook view opened");
      },
      mcp: () => {
        this.openMcpServerSelector();
        return succeeded("MCP view opened");
      },
      "reload-extensions": async () => {
        await this.reloadExtensions();
        return succeeded("Extension reload completed");
      },
      prompt: () => {
        this.openPromptSelector();
        return succeeded("prompt selector opened");
      },
      quit: async () => {
        await this.requestQuit();
        return succeeded("shutdown requested");
      },
    };
    for (const name of COMPATIBILITY_COMMAND_NAMES) {
      if (!handlers[name]) throw new Error(`missing compatibility handler: ${name}`);
    }
    return handlers;
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
    void this.cancelQueues("operator restored queued messages").then(
      (queues) => this.restoreCancelledQueues(queues, true),
      (error: unknown) => this.showNotice(`Queued messages were not cleared: ${String(error)}`, "error"),
    );
  }

  private cancelQueues(
    reason: string,
  ): Promise<{ steering: UserAgentMessage[]; followUp: UserAgentMessage[] }> {
    if (this.controller) return this.controller.cancelAllQueues(reason);
    if (this.agent) return this.agent.cancelAllQueues(reason);
    return Promise.resolve({ steering: [], followUp: [] });
  }

  private restoreCancelledQueues(
    queues: { steering: readonly UserAgentMessage[]; followUp: readonly UserAgentMessage[] },
    showSuccess: boolean,
  ): void {
    const queued = [...queues.steering, ...queues.followUp]
      .map(messageText)
      .filter((text) => text.length > 0);
    if (queued.length === 0) {
      this.showNotice("No queued messages to restore.");
      return;
    }
    const current = this.refs.editor.getText();
    this.refs.editor.setText([...queued, current].filter((text) => text.trim()).join("\n\n"));
    if (showSuccess) {
      this.showNotice(`Restored ${queued.length} queued message${queued.length === 1 ? "" : "s"}.`);
    }
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
    this.timelineState = reduceTimeline(this.timelineState, {
      type: "notice",
      id: `notice:${this.nextInvocation++}`,
      timestamp: Date.now(),
      level: kind,
      text,
    });
    this.refs.chat.setState(this.timelineState);
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
        this.overlays.close();
        const model = byKey.get(item.value);
        if (!model) return;
        void controller.selectModel(model).then(() => {
          this.thinkingLevel = controller.currentSelection.thinkingLevel;
          this.showNotice(`Model: ${model.provider}/${model.id}`);
        }, (error: unknown) => this.showNotice(String(error), "error"));
      },
      onCancel: () => this.overlays.close(),
    });
    this.overlays.show(modal);
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
        this.overlays.close();
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
      onCancel: () => this.overlays.close(),
    });
    this.overlays.show(modal);
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
        this.overlays.close();
        const status = statuses.find((entry) => entry.id === item.value);
        if (status) void this.startLogin(status.id, status.interactiveAuthTypes);
      },
      onCancel: () => this.overlays.close(),
    });
    this.overlays.show(modal);
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
          this.overlays.close();
          resolve(item.value as AuthType);
        },
        onCancel: () => {
          this.overlays.close();
          resolve(undefined);
        },
      });
      this.overlays.show(modal);
    });
  }

  private promptAuth(prompt: AuthPrompt, owner: AbortController): Promise<string> {
    if (prompt.type === "select") {
      return new Promise((resolve, reject) => {
        const cancel = () => {
          this.overlays.close();
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
            this.overlays.close();
            resolve(item.value);
          },
          onCancel: () => {
            owner.abort();
            cancel();
          },
        });
        prompt.signal?.addEventListener("abort", cancel, { once: true });
        this.overlays.show(modal);
      });
    }
    return new Promise((resolve, reject) => {
      const cancel = () => {
        this.overlays.close();
        reject(new Error("Authentication cancelled"));
      };
      const modal = new AuthInputModal({
        title: prompt.type === "secret" ? "Secret" : "Authentication input",
        message: prompt.message,
        placeholder: prompt.placeholder,
        secret: prompt.type === "secret",
        onSubmit: (value) => {
          this.overlays.close();
          resolve(value);
        },
        onCancel: () => {
          owner.abort();
          cancel();
        },
      });
      prompt.signal?.addEventListener("abort", cancel, { once: true });
      this.overlays.show(modal);
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
    for (const event of projectReplay(this.controller.messages)) {
      this.timelineState = reduceTimeline(this.timelineState, event);
    }
    this.timelineCursor = {
      ...this.timelineCursor,
      nextMessageIndex: this.controller.messages.filter((message) =>
        message.role === "user" || message.role === "assistant"
      ).length,
    };
    this.refs.chat.setState(this.timelineState);
    if (this.controller.warnings.length > 0) {
      for (const entry of this.controller.auditEntries) {
        const name = typeof entry.payload.toolName === "string" ? entry.payload.toolName : "tool";
        const content = typeof entry.payload.content === "string" ? `: ${entry.payload.content}` : "";
        this.showNotice(`${entry.type} ${name}${content}`);
      }
    }
  }

  /** Agent.subscribe 回调,适配为 TuiEvent 后分发。 */
  private handleAgentEvent(ev: AgentEvent): void {
    let adapted: TuiEvent;
    try {
      adapted = adaptRuntimeEvent(ev);
    } catch (e) {
      process.stderr.write(`[interactive-mode] adaptAgentEvent failed: ${String(e)}\n`);
      return;
    }
    this.handleEvent(adapted);
  }

  /** 把 Runtime 事件归约到 canonical application state 与共享 Timeline。 */
  private handleEvent(ev: TuiEvent): void {
    try {
      switch (ev.type) {
        case "agent_start":
          this.streaming = true;
          this.stopReason = undefined;
          break;
        case "agent_end":
          this.streaming = false;
          this.timelineState = reduceTimeline(this.timelineState, {
            type: "cleanup",
            timestamp: ev.timestamp + 30_000,
          });
          break;
        case "turn_start":
          this.shell.dispatch({ type: "turn.set", turn: ev.turn });
          break;
        case "turn_end":
          this.shell.dispatch({ type: "turn.set", turn: ev.turn });
          if (ev.stopReason) this.stopReason = ev.stopReason;
          break;
        case "message_end":
          this.stopReason = ev.stopReason ?? this.stopReason;
          break;
        case "queue_update":
          this.shell.dispatch({
            type: "queue.counts",
            steering: ev.steering.length,
            followUp: ev.followUp.length,
          });
          break;
        default:
          break;
      }
      const projected = projectLive(this.timelineCursor, ev);
      this.timelineCursor = projected.cursor;
      for (const event of projected.events) {
        this.timelineState = reduceTimeline(this.timelineState, event);
      }
      this.refs.chat.setState(this.timelineState);
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
