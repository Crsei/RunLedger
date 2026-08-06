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
import type { InteractiveSessionControllerPort } from "../runtime/interactive-session-controller.ts";

import { adaptAgentEvent, type FooterSnapshotProvider, type TuiEvent } from "./types.ts";
import { loadTheme, applyEnvOverrides, type Theme } from "./theme/theme.ts";
import { makeEditorTheme, makeSelectListTheme } from "./theme/factories.ts";
import { CustomEditor, type CustomEditorProps } from "./components/custom-editor.ts";
import { Footer } from "./components/footer.ts";
import { KeybindingHints } from "./components/keybinding-hints.ts";
import { LoadedResourcesComponent } from "./components/loaded-resources.ts";
import { ChatContainer } from "./components/chat-container.ts";
import { AuthInputModal } from "./components/auth-input-modal.ts";
import { SearchableSelectorModal } from "./components/searchable-selector-modal.ts";
import { StatusComponent } from "./components/status.ts";
import { SelectorModal } from "./components/selector-modal.ts";
import type { SelectItem } from "./index.ts";
import type { Component, OverlayOptions } from "./primitives.ts";
import type { TuiOverlayState } from "./application/state.ts";
import { createAppKeyListener } from "./keybindings/app-keys.ts";
import type { ExecutionId } from "../runtime/protocol/ids.ts";
import type { HostFrameEnvelope } from "../runtime/host/types.ts";
import type { ProcessOverlayController, ProcessOverlayHostClient } from "./process/controller-adapter.ts";
import { ProcessOverlayComponent } from "./process/overlay-component.ts";
import { createProcessPassiveBridge } from "./process/passive-bridge.ts";
import { DeltaCoalescer, type AppendTextDelta } from "./opentui/delta-coalescer.ts";
import type { TuiPerformanceObserver } from "./opentui/performance-observer.ts";
import { approvalDecisionBody, parseApprovalReverseRequest, type ApprovalDecision } from "./approval.ts";
import type { TuiBootstrapSnapshot } from "./presentation/types.ts";
import type { TuiState } from "./application/state.ts";
import { createInitialTuiState } from "./application/initial-state.ts";
import type { TimelineEvent } from "./timeline/types.ts";
import { TimelineEventProjector } from "./timeline/event-projector.ts";
import { timelineToBlocks } from "./timeline/selectors.ts";
import type { TuiStore } from "./application/store.ts";
import { createTuiStore } from "./application/store.ts";
import type { TuiDomainPorts } from "./application/ports.ts";
import { capabilitiesFromPorts } from "./application/ports.ts";
import { createInteractiveSessionAdapter, type InteractiveSessionAdapter } from "./adapters/interactive-session.ts";
import { createHostDomainPorts } from "./adapters/host-domain.ts";
import type { EffectRunner } from "./application/effect-runner.ts";
import { createEffectRunner } from "./application/effect-runner.ts";
import type { TuiEffect } from "./application/effect.ts";
import type { CorrelatedRequestRef } from "./application/common.ts";

/** InteractiveMode 装配参数。 */
export interface InteractiveModeOptions {
  /** 新 CLI 使用统一 controller;agent 仅保留 demo 兼容。 */
  controller?: InteractiveSessionControllerPort;
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
  /** R9:由 Host facade 提供的 safe process list/output/mutation adapter。 */
  processOverlayController?: ProcessOverlayController;
  /** B7:process output 的真实 Host client（composition root 注入；缺失时 bridge 只读）。 */
  processOverlayClient?: ProcessOverlayHostClient;
  /** P6:workspace/path 能力标签（真实 runner 证据矩阵），Footer 右侧显示；缺省不显示。 */
  workspaceCapability?: string;
  /** 可选的分层渲染 telemetry sink；不参与 UI 调度决策。 */
  performanceObserver?: TuiPerformanceObserver;
  /** B1:显式 bootstrap snapshot；缺省由 controller/agent 派生。 */
  initialBootstrap?: TuiBootstrapSnapshot;
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
  private readonly controller: InteractiveSessionControllerPort | undefined;
  private readonly processOverlayController: ProcessOverlayController | undefined;
  private readonly performanceObserver: TuiPerformanceObserver | undefined;
  private theme: Theme;
  private readonly kb: KeybindingsManager;
  private readonly refs: ContainerRefs;
  private unsubscribe?: () => void;
  private unsubscribeThemeMode?: () => void;
  private unsubscribeRenderPreparation?: () => void;

  // FooterSnapshotProvider 状态(只有 handleEvent 路径写)
  private streaming = false;
  private stopReason: string | undefined = undefined;
  private streamingGeneration = 0;
  private readonly streamingDeltas = new DeltaCoalescer({
    softByteLimit: 256 * 1024,
    hardByteLimit: 1024 * 1024,
    softEventLimit: 512,
    hardEventLimit: 4096,
  });
  // B2:帧前 flush 时按 correlationId 累积完整正文快照，再发 message_update
  private readonly pendingMessageBuffers = new Map<string, { text: string; thinking: string }>();

  // B2:Timeline 为 chat 内容的唯一业务 owner；DeltaCoalescer 只做 lossless append/帧前 drain。
  private timelineProjector = new TimelineEventProjector();

  // B3:client-local store 为 interaction/presentation 的唯一 owner
  private store: TuiStore;
  private lastTimelineGeneration = -1;
  private unsubscribeStore: (() => void) | undefined;

  // B4:EffectRunner + 领域 ports（capability 缺失 = undefined 端口，不发 effect）
  private readonly ports: TuiDomainPorts;
  private readonly runner: EffectRunner;
  private effectSequence = 0;
  private correlationSequence = 0;

  // 失败护栏状态(M1 不主动触发)
  private consecutiveInitFailures = 0;

  // B5:model/thinking 状态由 workflow 唯一持有（controller 是 authority）
  private readonly workspaceCapability?: string;
  private authAdapter: InteractiveSessionAdapter;
  private lastIdleCtrlC = 0;
  private quitting = false;
  private readonly exitPromise: Promise<void>;
  private readonly resolveExit: () => void;
  private processOverlayComponent: ProcessOverlayComponent | undefined;
  private readonly initialBootstrap?: TuiBootstrapSnapshot;

  /** B1-B3:TuiState 由 store 唯一持有（此字段已由 store 取代，防止误用）。 */
  private readonly storeRef: undefined = undefined;

  constructor(opts: InteractiveModeOptions) {
    if (!opts.controller && !opts.agent) {
      throw new Error("InteractiveMode requires controller or agent");
    }
    this.controller = opts.controller;
    this.agent = opts.agent;
    this.processOverlayController = opts.processOverlayController;
    this.performanceObserver = opts.performanceObserver;
    this.terminal = opts.terminal ?? new ProcessTerminal();
    this.theme = applyEnvOverrides(loadTheme(opts.themeName ?? "dark"));
    this.workspaceCapability = opts.workspaceCapability;
    this.initialBootstrap = opts.initialBootstrap;
    // B4:ports 聚合 controller + Host domain；runner 只执行 effect 并回送 TuiResult
    this.authAdapter = createInteractiveSessionAdapter(this.controller);
    this.ports = {
      ...this.authAdapter.ports,
      ...createHostDomainPorts(this.controller?.queryHostDomain === undefined
        ? undefined
        : {
            query: (operation, body) => this.controller?.queryHostDomain!(operation, body ?? {}) ?? Promise.resolve({ ok: false as const, code: "host_unavailable" }),
            command: (operation, body) => this.controller?.commandHostDomain!(operation, body ?? {}) ?? Promise.resolve({ ok: false as const, code: "host_unavailable" }),
          }),
    };
    // B7:process passive bridge 复用既有 overlay facade（无第二 manager）
    const bridge = createProcessPassiveBridge(this.processOverlayController, opts.processOverlayClient);
    if (bridge !== undefined) this.ports = { ...this.ports, process: bridge };
    this.store = createTuiStore(createInitialTuiState({
      bootstrap: this.deriveBootstrap(),
      capabilities: {
        ...capabilitiesFromPorts(this.ports, { sessionCatalog: this.controller !== undefined, sessionMutation: this.controller !== undefined }),
      },
    }));
    this.runner = createEffectRunner({
      ports: this.ports,
      currentGeneration: () => this.store.getState().authorityGeneration,
      onResult: (result) => this.store.dispatch({ type: "query.result", result }),
    });
    let resolveExit: (() => void) | undefined;
    this.exitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    this.resolveExit = () => resolveExit?.();

    // TUI 使用 showHardwareCursor=false,Editor 自身以 CURSOR_MARKER 通知光标位置
    this.ui = new TUI(this.terminal, false, { performanceObserver: opts.performanceObserver });
    this.unsubscribeRenderPreparation = this.ui.addBeforeRenderListener(() => this.flushStreamingDeltas());

    // KeybindingsManager:本期安装默认 TUI_KEYBINDINGS,后续 M6 在此挂 user bindings
    this.kb = new KeybindingsManager(TUI_KEYBINDINGS);
    setKeybindings(this.kb);

    // 装配组件树
    this.refs = this.assembleTree();
    // B3:store 订阅驱动 chat presentation（timeline generation 变化才重投影）
    this.unsubscribeStore = this.store.subscribe((next) => {
      if (next.timeline.generation !== this.lastTimelineGeneration) {
        this.lastTimelineGeneration = next.timeline.generation;
        this.refs.chat.setTimelineBlocks(timelineToBlocks(next.timeline), next.timeline.generation);
      }
    });
    if (this.processOverlayController) {
      this.processOverlayComponent = new ProcessOverlayComponent({
        controller: this.processOverlayController,
        onClose: () => {
          this.closeOverlay();
          this.ui.setFocus(this.refs.editor);
          this.ui.requestRender();
        },
        onChange: () => this.ui.requestRender(),
        onNotice: (message) => this.showNotice(message, "error"),
        getHeight: () => Math.max(4, this.terminal.rows - 4),
        getTerminalSize: () => ({ columns: this.terminal.columns, rows: this.terminal.rows }),
      });
    }
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

  /** B1:bootstrap 派生；composition root 显式传入时优先。 */
  private deriveBootstrap(): TuiBootstrapSnapshot {
    if (this.initialBootstrap) return this.initialBootstrap;
    const sessionId = this.controller?.sessionId ?? this.agent?.sessionId;
    return {
      workspaceLabel: "unknown",
      session: {
        id: sessionId ?? "unknown-session",
        format: "current-canonical",
        lifecycle: sessionId ? "active" : "unknown",
      },
      authorityGeneration: 1,
    };
  }

  /** B3:只读暴露 TuiState（store 为唯一 owner）。 */
  getTuiState(): TuiState {
    return this.store.getState();
  }

  /** B3:overlay 状态意图写入 store；组件/焦点仍由 renderer 管理（view side-effect）。 */
  private showOverlayModal(component: Component, options?: OverlayOptions, kind: Exclude<TuiOverlayState["state"], "closed"> = "command"): void {
    this.store.dispatch({
      type: "overlay.open",
      overlay: { state: kind, requestId: `overlay-${this.store.getState().interaction.generation + 1}` },
    });
    this.ui.showOverlay(component, options);
    this.ui.requestRender();
  }

  /** B3:overlay 关闭意图写入 store。 */
  private closeOverlay(): void {
    this.store.dispatch({ type: "overlay.close" });
    this.ui.hideOverlay();
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
    this.flushStreamingDeltas();
    // B8:先取消所有 in-flight effects，再执行 lifecycle cleanup（防止 Host 查询在销毁后回写）
    this.runner.cancelAll();
    // P2-2:destroy 清理所有 active timeline rows
    this.dispatchTimeline(this.timelineProjector.project({ kind: "cleanup", reason: "destroy" }));
    if (this.inFlight()) {
      this.controller?.interrupt();
      this.agent?.interrupt();
      await (this.controller?.waitForIdle() ?? this.agent?.waitForIdle() ?? Promise.resolve());
    }
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
    this.unsubscribeStore?.();
    this.unsubscribeStore = undefined;
    this.unsubscribeThemeMode?.();
    this.unsubscribeThemeMode = undefined;
    this.unsubscribeRenderPreparation?.();
    this.unsubscribeRenderPreparation = undefined;
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

  /** Host 逆向 approval 请求：只收集并返回决策；Host receipt 未接入前不更新 approval workflow。 */
  handleReverseRequest(frame: HostFrameEnvelope, signal: AbortSignal): Promise<Record<string, unknown>> {
    const view = parseApprovalReverseRequest(frame.body);
    if (!view) return Promise.resolve({ ok: false, code: "reverse_request_invalid" });
    return new Promise<Record<string, unknown>>((resolve) => {
      let settled = false;
      const finish = (body: Record<string, unknown>): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        this.closeOverlay();
        resolve(body);
      };
      const onAbort = (): void => {
        finish({ ok: false, code: "approval_aborted" });
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      const choose = (decision: ApprovalDecision): void => {
        // 这里只记录用户决策意图；Host 是否接受由 reverse response 的调用方确认。
        this.dispatchTimeline([{
          type: "notice",
          generation: 0,
          correlationId: `approval-${this.store.getState().timeline.committedRows.length}`,
          severity: "info",
          message: { text: `approval ${decision} for ${view.toolName}`, truncated: false, byteLength: new TextEncoder().encode(`approval ${decision} for ${view.toolName}`).byteLength },
        }]);
        finish(approvalDecisionBody(decision));
      };
      const modal = new SelectorModal({
        theme: this.theme,
        selectListTheme: makeSelectListTheme(this.theme),
        title: `Approval required · ${view.toolName}: ${view.summary}`,
        items: [
          { value: "allow-once", label: "Allow once", description: view.cwd === undefined ? "Permit this request once" : `Permit once in ${view.cwd}` },
          { value: "deny", label: "Deny", description: "Reject without executing" },
          { value: "cancel", label: "Cancel", description: "Cancel this approval request" },
        ],
        onSelect: (item) => choose(item.value as ApprovalDecision),
        onCancel: () => choose("cancel"),
      });
      signal.addEventListener("abort", onAbort, { once: true });
      this.showOverlayModal(modal, { anchor: "center" }, "approval");
      this.ui.requestRender();
    });
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
      { value: "/processes", label: "/processes", description: "List managed processes" },
      { value: "/terminal", label: "/terminal <executionId>", description: "Open managed terminal" },
      { value: "/quit", label: "/quit", description: "Exit safely" },
      { value: "/mcp", label: "/mcp", description: "List connected MCP servers" },
      { value: "/plugins", label: "/plugins", description: "List discovered plugins" },
      { value: "/skills", label: "/skills", description: "List discovered skills" },
      { value: "/hooks", label: "/hooks", description: "List configured hooks" },
      { value: "/plan", label: "/plan", description: "Inspect Plan Mode state" },
      { value: "/compact", label: "/compact", description: "List compaction checkpoints" },
      { value: "/memory", label: "/memory", description: "Inspect memory store" },
      { value: "/remember", label: "/remember <text>", description: "Propose a memory record" },
      { value: "/prompt", label: "/prompt", description: "Pick prompt template" },
    ];
    const modal = new SelectorModal({
      theme: this.theme,
      selectListTheme: makeSelectListTheme(this.theme),
      title: "/commands",
      items,
      onSelect: (item) => {
        this.closeOverlay();
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
          case "/processes":
            this.openProcessList();
            break;
          case "/mcp":
            void this.openMcpServerSelector();
            break;
          case "/plugins":
            void this.openExtensionSelector("plugin.list", "plugins", "/plugins");
            break;
          case "/skills":
            void this.openExtensionSelector("skill.list", "skills", "/skills");
            break;
          case "/hooks":
            void this.openExtensionSelector("hook.list", "hooks", "/hooks");
            break;
          case "/plan":
            void this.openPlanWorkflow();
            break;
          case "/compact":
            void this.runDomainCommand("compaction.list", {}, "/compact", true);
            break;
          case "/memory":
            void this.runDomainCommand("memory.inspect", {}, "/memory", true);
            break;
          case "/remember":
            void this.runDomainCommand("memory.propose", { scope: "workspace", title: "remember", content: "remember" }, "/remember", false);
            break;
          case "/terminal":
            this.showNotice("Use /terminal <executionId> to open a managed terminal.");
            break;
          default:
            this.echoPrompt(item.value);
        }
      },
      onCancel: () => this.closeOverlay(),
    });
    this.showOverlayModal(modal, { anchor: "bottom-left" });
  }

  /**
   * 打开预设 prompt 选择器(M5 占位,M7+ 真实模板接入)。
   */
  /** B5:/prompt —— 本地 demo 无 prompt authority 时显示 unavailable，不回退内建模板。 */
  openPromptSelector(): void {
    if (this.store.getState().capabilities.prompt.state !== "available") {
      this.showNotice("Prompt templates are unavailable in this session.", "error");
      return;
    }
    this.showNotice("Prompt templates are unavailable in this session.", "error");
  }

  /**
   * B4:打开 mcp server 选择器；经 extension.inspect workflow 查询真实 catalog，
   * 不再直接解析 Host raw response。选择项只展示状态，不提供 client-local 启停。
   */
  openMcpServerSelector(): Promise<void> {
    return this.openExtensionWorkflowSelector("mcp-server", "/mcp");
  }

  /**
   * B4:打开 plugins/skills/hooks 资源选择器；经 extension.inspect workflow
   * 查询真实 snapshot。只读展示 enabled/trusted/ready 状态。
   */
  openExtensionSelector(operation: "plugin.list" | "skill.list" | "hook.list", _kindLabel: string, commandName: string): Promise<void> {
    const kind = operation === "plugin.list" ? "plugin" : operation === "skill.list" ? "skill" : "hook";
    return this.openExtensionWorkflowSelector(kind, commandName);
  }

  /** B4:extension workflow 驱动的资源选择器（loading → ready/empty/error/unavailable）。 */
  private async openExtensionWorkflowSelector(kind: "mcp-server" | "plugin" | "skill" | "hook", commandName: string): Promise<void> {
    if (this.store.getState().capabilities.extensions.state !== "available") {
      this.showNotice("Host domain query is unavailable in this session.", "error");
      return;
    }
    const effect = this.createEffect("extension.inspect");
    this.store.dispatch({ type: "query.start", effect });
    this.runner.dispatch(effect);
    const workflow = await this.waitForWorkflow("extensionWorkflow", effect.correlationId);
    if (workflow.state === "ready") {
      const value = workflow.value as { readonly resources?: readonly { readonly kind: string; readonly resourceId: string; readonly label: { readonly text: string }; readonly trust: string; readonly activation: string; readonly digestPrefix: { readonly text: string } }[] };
      const resources = (value.resources ?? []).filter((resource) => resource.kind === kind);
      if (resources.length === 0) {
        this.showNotice(`No ${kind} resources are discovered in the current snapshot.`, "note");
        return;
      }
      const items: SelectItem[] = resources.map((resource) => ({
        value: resource.resourceId,
        label: resource.label.text,
        description: `${resource.trust} · ${resource.activation}${resource.digestPrefix.text.length > 0 ? ` · ${resource.digestPrefix.text}` : ""}`,
      }));
      const modal = new SearchableSelectorModal({
        title: `${commandName} (${resources.length})`,
        items,
        maxVisible: 12,
        onSelect: () => this.closeOverlay(),
        onCancel: () => this.closeOverlay(),
      });
      this.showOverlayModal(modal, { anchor: "bottom-left" });
      return;
    }
    if (workflow.state === "empty") {
      this.showNotice(`No ${kind} resources are discovered in the current snapshot.`, "note");
      return;
    }
    if (workflow.state === "error") {
      this.showNotice(`${commandName} query failed: ${workflow.message}`, "error");
      return;
    }
    this.showNotice(`${commandName} query is unavailable: ${workflow.state === "unavailable" ? workflow.reason : "unknown outcome"}`, "error");
  }

  /** B7:/plan 走 plan.inspect workflow（typed adapter 投影，不再 raw 解析）。 */
  private async openPlanWorkflow(): Promise<void> {
    if (this.store.getState().capabilities.plan.state !== "available") {
      this.showNotice("/plan requires an authenticated Host connection.", "error");
      return;
    }
    if (this.inFlight()) {
      this.showNotice("/plan is available when the current turn is idle.", "note");
      return;
    }
    const effect = this.createEffect("plan.inspect", { planId: "", expectedRevision: 0 });
    this.store.dispatch({ type: "query.start", effect });
    this.runner.dispatch(effect);
    const workflow = await this.waitForWorkflow("planWorkflow", effect.correlationId);
    if (workflow.state === "ready") {
      const view = workflow.value as { readonly reference?: { readonly planId: string; readonly revision: number; readonly digestPrefix: { readonly text: string } }; readonly title: { readonly text: string }; readonly status: string; readonly summary: { readonly text: string } };
      this.showNotice(
        `/plan: ${view.title.text} · ${view.status} · rev=${view.reference?.revision ?? 0}${view.summary.text.length > 0 ? ` · ${view.summary.text}` : ""}`,
      );
      return;
    }
    if (workflow.state === "error") {
      this.showNotice(`/plan failed: ${workflow.message}`, "error");
      return;
    }
    this.showNotice("/plan state is unavailable in this session.", "error");
  }

  /**
   * 执行 Host-owned compact/memory domain 命令并把结果投影成 notice。mutation
   * 命令经 commandHostDomain（Host 持有 durable intent/receipt 与 driver fence）；
   * 只读查询走 queryHostDomain。plan.inspect 已迁移到 plan workflow（B7）。
   */
  async runDomainCommand(
    operation: string,
    body: Record<string, unknown>,
    commandName: string,
    readOnly: boolean,
  ): Promise<void> {
    const controller = this.controller;
    const channel = readOnly ? controller?.queryHostDomain : controller?.commandHostDomain;
    if (controller === undefined || channel === undefined) {
      this.showNotice(`${commandName} requires an authenticated Host connection.`, "error");
      return;
    }
    if (this.inFlight()) {
      this.showNotice(`${commandName} is available when the current turn is idle.`, "note");
      return;
    }
    const result = await channel.call(controller, operation, body).catch((error: unknown) => {
      this.showNotice(`${commandName} failed: ${String(error)}`, "error");
      return undefined;
    });
    if (result === undefined) return;
    const text = compactDomainResult(operation, result);
    this.showNotice(`${commandName}: ${text}`, "note");
  }

  /** R9:打开 Host-owned managed process list；没有 facade 时保持显式不可用。 */
  openProcessList(): void {
    const overlay = this.processOverlayComponent;
    if (!overlay) {
      this.showNotice("Managed process view is unavailable in this session.", "error");
      return;
    }
    this.showOverlayModal(overlay, { anchor: "center" }, "process");
    void overlay.openList();
  }

  /** R9:按 safe execution id 打开 terminal overlay，不连接 raw PTY endpoint。 */
  openProcessTerminal(executionId: string): void {
    const overlay = this.processOverlayComponent;
    if (!overlay || !isSafeExecutionId(executionId)) {
      this.showNotice("A valid managed execution id is required.", "error");
      return;
    }
    this.showOverlayModal(overlay, { anchor: "center" }, "process");
    void overlay.openTerminal(executionId as ExecutionId);
  }

  /** 仅暴露给测试/上层 command router 的状态查询，不暴露 backend。 */
  isProcessOverlayOpen(): boolean {
    return this.processOverlayController?.snapshot().open ?? false;
  }

  /**
   * B5:/model 选择器走 model workflow；controller 返回 authoritative selection
   * 后再更新 view。local demo（无 controller）显示 unavailable，不回退假 registry。
   */
  openModelSelector(provider?: string): void {
    void this.openModelWorkflowSelector(provider);
  }

  private async openModelWorkflowSelector(provider?: string): Promise<void> {
    if (this.store.getState().capabilities.model.state !== "available") {
      this.showNotice("Model selection is unavailable in this session.", "error");
      return;
    }
    const effect = this.createEffect("model.list", { providerId: provider ?? "" });
    this.store.dispatch({ type: "query.start", effect });
    this.runner.dispatch(effect);
    const workflow = await this.waitForWorkflow("modelWorkflow", effect.correlationId);
    if (workflow.state === "ready") {
      const models = (workflow.value as { readonly models?: readonly { readonly providerId: string; readonly modelId: string; readonly label: { readonly text: string }; readonly availability: string }[] }).models ?? [];
      if (models.length === 0) {
        this.showNotice(provider
          ? `No available models for ${provider}. Configure authentication first.`
          : "No available models. Use /provider or /login first.", "error");
        return;
      }
      const items: SelectItem[] = models.map((model) => ({
        value: `${model.providerId}/${model.modelId}`,
        label: model.label.text,
        description: `[${model.providerId}]`,
      }));
      const modal = new SearchableSelectorModal({
        title: provider ? `/model — ${provider}` : "/model — configured providers",
        items,
        maxVisible: 12,
        onSelect: (item) => {
          this.closeOverlay();
          void this.selectModelByKey(item.value);
        },
        onCancel: () => this.closeOverlay(),
      });
      this.showOverlayModal(modal, { anchor: "bottom-left" });
      return;
    }
    if (workflow.state === "empty") {
      this.showNotice("No available models. Use /provider or /login first.", "error");
      return;
    }
    if (workflow.state === "error") {
      this.showNotice(`Model discovery failed: ${workflow.message}`, "error");
      return;
    }
    this.showNotice(`Model selection is unavailable: ${workflow.state === "unavailable" ? workflow.reason : "unknown outcome"}`, "error");
  }

  /** B5:model.select effect；controller/Host 返回 authoritative selection 后 Footer 自动反映。 */
  private async selectModelByKey(key: string): Promise<void> {
    const [providerId, modelId] = key.split("/");
    if (providerId === undefined || modelId === undefined) return;
    const effect = this.createEffect("model.select", { providerId, modelId });
    this.store.dispatch({ type: "query.start", effect });
    this.runner.dispatch(effect);
    const workflow = await this.waitForWorkflow("modelWorkflow", effect.correlationId);
    if (workflow.state === "ready") {
      const selection = workflow.value as { readonly providerId?: string; readonly modelId?: string };
      this.showNotice(`Model: ${selection.providerId ?? providerId}/${selection.modelId ?? modelId}`);
    } else if (workflow.state === "error") {
      this.showNotice(`Model switch failed: ${workflow.message}`, "error");
    }
  }

  /**
   * B5:/thinking 选择器走 thinking workflow；level 由 controller.setThinkingLevel
   * 持久化（authority），Footer 从 workflow 读取。
   */
  openThinkingSelector(): void {
    void this.openThinkingWorkflowSelector();
  }

  private async openThinkingWorkflowSelector(): Promise<void> {
    if (this.store.getState().capabilities.thinking.state !== "available") {
      this.showNotice("Thinking configuration is unavailable in this session.", "error");
      return;
    }
    const effect = this.createEffect("thinking.inspect");
    this.store.dispatch({ type: "query.start", effect });
    this.runner.dispatch(effect);
    const workflow = await this.waitForWorkflow("thinkingWorkflow", effect.correlationId);
    if (workflow.state !== "ready") {
      this.showNotice("Thinking configuration is unavailable in this session.", "error");
      return;
    }
    const snapshot = workflow.value as { readonly level: string; readonly availableLevels: readonly string[] };
    const levels = snapshot.availableLevels.length > 0 ? snapshot.availableLevels : [snapshot.level];
    const items: SelectItem[] = levels.map((level) => ({
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
        this.closeOverlay();
        void this.setThinkingLevel(item.value as ModelThinkingLevel);
      },
      onCancel: () => this.closeOverlay(),
    });
    this.showOverlayModal(modal, { anchor: "bottom-left" });
  }

  /** B5:thinking.select effect；authoritative level 由 controller 返回。 */
  async setThinkingLevel(level: ModelThinkingLevel): Promise<void> {
    if (this.store.getState().capabilities.thinking.state !== "available") {
      this.showNotice("Thinking configuration is unavailable in this session.", "error");
      return;
    }
    const effect = this.createEffect("thinking.select", { level });
    this.store.dispatch({ type: "query.start", effect });
    this.runner.dispatch(effect);
    const workflow = await this.waitForWorkflow("thinkingWorkflow", effect.correlationId);
    if (workflow.state === "error") {
      this.showNotice(`Thinking switch failed: ${workflow.message}`, "error");
    }
    this.ui.requestRender();
  }

  /** FooterSnapshotProvider:thinking level 从 thinking workflow 读取（ready 时）。 */
  getThinkingLevel(): ModelThinkingLevel {
    const workflow = this.store.getState().thinkingWorkflow;
    if (workflow.state === "ready") {
      const level = (workflow.value as { readonly level: ModelThinkingLevel | "unknown" }).level;
      if (level !== "unknown") return level;
    }
    return "off";
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
    // B1:session identity 由 TuiState bootstrap 唯一持有
    return this.store.getState().bootstrap.session.id;
  }

  /** FooterSnapshotProvider：workspace/path 能力标签（P6，不宣称 sandbox）。 */
  getWorkspaceCapability(): string | undefined {
    return this.workspaceCapability;
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
        case "processes":
          this.openProcessList();
          return;
        case "terminal":
          this.openProcessTerminal(arg);
          return;
        case "mcp":
          void this.openMcpServerSelector();
          return;
        case "plugins":
          void this.openExtensionSelector("plugin.list", "plugins", "/plugins");
          return;
        case "skills":
          void this.openExtensionSelector("skill.list", "skills", "/skills");
          return;
        case "hooks":
          void this.openExtensionSelector("hook.list", "hooks", "/hooks");
          return;
        case "plan":
          void this.openPlanWorkflow();
          return;
        case "compact":
          void this.runDomainCommand("compaction.list", {}, "/compact", true);
          return;
        case "memory":
          void this.runDomainCommand("memory.inspect", {}, "/memory", true);
          return;
        case "remember":
          if (arg.length === 0) {
            this.showNotice("/remember <text> 需要提供要记住的内容。", "error");
            return;
          }
          void this.runDomainCommand("memory.propose", { scope: "workspace", title: arg.slice(0, 256), content: arg, sourceKind: "user" }, "/remember", false);
          return;
        case "prompt":
          this.openPromptSelector();
          return;
        case "commands":
        case "help":
          this.openSlashCommands();
          return;
        case "clear":
          this.pendingMessageBuffers.clear();
          this.streamingDeltas.drain();
          this.timelineProjector.resetRows();
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
    const severity = kind === "error" ? "error" : "info";
    this.dispatchTimeline([{
      type: "notice",
      generation: 0,
      correlationId: `notice-${this.store.getState().timeline.committedRows.length}-${this.store.getState().timeline.activeOrder.length}`,
      severity,
      message: { text, truncated: false, byteLength: new TextEncoder().encode(text).byteLength },
    }]);
    this.ui.requestRender();
  }

  /** B5:/provider 走 provider workflow；configured → model selector，否则 auth 流。 */
  private async openProviderSelector(): Promise<void> {
    if (this.store.getState().capabilities.provider.state !== "available") {
      this.showNotice("Provider configuration is unavailable in this session.", "error");
      return;
    }
    const effect = this.createEffect("provider.list");
    this.store.dispatch({ type: "query.start", effect });
    this.runner.dispatch(effect);
    const workflow = await this.waitForWorkflow("providerWorkflow", effect.correlationId);
    if (workflow.state !== "ready") {
      this.showNotice("Provider configuration is unavailable in this session.", "error");
      return;
    }
    const providers = (workflow.value as { readonly providers?: readonly { readonly providerId: string; readonly label: { readonly text: string }; readonly status: string; readonly authKinds: readonly string[] }[] }).providers ?? [];
    const modal = new SearchableSelectorModal({
      title: "/provider — all built-ins",
      items: providers.map((provider) => ({
        value: provider.providerId,
        label: provider.label.text,
        description: provider.status === "ready"
          ? "configured"
          : provider.authKinds.length > 0
            ? `login: ${provider.authKinds.join("/")}`
            : "ambient credential required",
      })),
      maxVisible: 12,
      onSelect: (item) => {
        this.closeOverlay();
        const provider = providers.find((entry) => entry.providerId === item.value);
        if (!provider) return;
        if (provider.status === "ready") {
          this.openModelSelector(provider.providerId);
        } else if (provider.authKinds.length > 0) {
          void this.startLogin(provider.providerId);
        } else {
          this.showNotice(
            `${provider.label.text} uses ambient credentials. Configure its environment/profile, then reopen /provider.`,
            "error",
          );
        }
      },
      onCancel: () => this.closeOverlay(),
    });
    this.showOverlayModal(modal, { anchor: "bottom-left" });
  }

  /** B5:/login 走 auth workflow（auth.inspect 找 provider，再 auth.login effect）。 */
  private async openLoginSelector(providerId?: string): Promise<void> {
    if (this.store.getState().capabilities.auth.state !== "available") {
      this.showNotice("Login is unavailable in this session.", "error");
      return;
    }
    const effect = this.createEffect("auth.inspect");
    this.store.dispatch({ type: "query.start", effect });
    this.runner.dispatch(effect);
    const workflow = await this.waitForWorkflow("authWorkflow", effect.correlationId);
    if (workflow.state !== "ready") {
      this.showNotice("Login is unavailable in this session.", "error");
      return;
    }
    const providers = (workflow.value as { readonly providers?: readonly { readonly providerId: string; readonly providerLabel: { readonly text: string }; readonly configured: string; readonly authKind: string }[] }).providers ?? [];
    if (providerId) {
      const provider = providers.find((entry) => entry.providerId === providerId);
      if (!provider) {
        this.showNotice(`Unknown provider: ${providerId}`, "error");
        return;
      }
      await this.startLogin(provider.providerId);
      return;
    }
    const loginable = providers.filter((provider) => provider.authKind !== "unknown" && provider.configured !== "yes");
    if (loginable.length === 0) {
      this.showNotice("No providers require interactive login.", "note");
      return;
    }
    const modal = new SearchableSelectorModal({
      title: "/login — provider",
      items: loginable.map((provider) => ({
        value: provider.providerId,
        label: provider.providerLabel.text,
        description: provider.authKind,
      })),
      maxVisible: 12,
      onSelect: (item) => {
        this.closeOverlay();
        const provider = loginable.find((entry) => entry.providerId === item.value);
        if (provider) void this.startLogin(provider.providerId);
      },
      onCancel: () => this.closeOverlay(),
    });
    this.showOverlayModal(modal, { anchor: "bottom-left" });
  }

  /** B5:auth.login effect；interaction（secret/URL 提示）是短生命周期 owner。 */
  private async startLogin(providerId: string): Promise<void> {
    if (this.store.getState().capabilities.auth.state !== "available") {
      this.showNotice("Login is unavailable in this session.", "error");
      return;
    }
    const authKind = await this.providerAuthKind(providerId);
    if (authKind === undefined) {
      this.showNotice(`${providerId} has no interactive login flow; configure ambient credentials.`, "error");
      return;
    }
    const abortController = new AbortController();
    const interaction: AuthInteraction = {
      signal: abortController.signal,
      prompt: (prompt) => this.promptAuth(prompt, abortController),
      notify: (event) => this.showAuthEvent(event),
    };
    this.authAdapter.setAuthInteraction(interaction);
    this.showNotice(`Starting ${authKind} login for ${providerId}…`);
    const effect = this.createEffect("auth.login", { providerId, authKind });
    this.store.dispatch({ type: "query.start", effect });
    this.runner.dispatch(effect);
    const workflow = await this.waitForWorkflow("authWorkflow", effect.correlationId);
    this.authAdapter.setAuthInteraction(undefined);
    if (workflow.state === "ready") {
      this.showNotice(`Authenticated ${providerId}.`);
      this.openModelSelector(providerId);
    } else if (workflow.state === "error") {
      if (!abortController.signal.aborted) this.showNotice(`Login failed: ${workflow.message}`, "error");
    } else {
      this.showNotice(`Login is unavailable: ${workflow.state === "unavailable" ? workflow.reason : "unknown outcome"}`, "error");
    }
  }

  /** B5:从 auth workflow 读 provider 的 authKind（避免直接调 controller）。 */
  private async providerAuthKind(providerId: string): Promise<"api-key" | "oauth" | undefined> {
    const effect = this.createEffect("auth.inspect");
    this.store.dispatch({ type: "query.start", effect });
    this.runner.dispatch(effect);
    const workflow = await this.waitForWorkflow("authWorkflow", effect.correlationId);
    if (workflow.state !== "ready") return undefined;
    const providers = (workflow.value as { readonly providers?: readonly { readonly providerId: string; readonly authKind: string }[] }).providers ?? [];
    const kind = providers.find((entry) => entry.providerId === providerId)?.authKind;
    return kind === "oauth" ? "oauth" : kind === "api-key" ? "api-key" : undefined;
  }

  private selectAuthType(types: AuthType[]): Promise<AuthType | undefined> {
    return new Promise((resolve) => {
      const modal = new SelectorModal({
        theme: this.theme,
        selectListTheme: makeSelectListTheme(this.theme),
        title: "Authentication method",
        items: types.map((type) => ({ value: type, label: type === "api_key" ? "API key" : "OAuth" })),
        onSelect: (item) => {
          this.closeOverlay();
          resolve(item.value as AuthType);
        },
        onCancel: () => {
          this.closeOverlay();
          resolve(undefined);
        },
      });
      this.showOverlayModal(modal, { anchor: "bottom-left" });
    });
  }

  private promptAuth(prompt: AuthPrompt, owner: AbortController): Promise<string> {
    if (prompt.type === "select") {
      return new Promise((resolve, reject) => {
        const cancel = () => {
          this.closeOverlay();
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
            this.closeOverlay();
            resolve(item.value);
          },
          onCancel: () => {
            owner.abort();
            cancel();
          },
        });
        prompt.signal?.addEventListener("abort", cancel, { once: true });
        this.showOverlayModal(modal, { anchor: "bottom-left" });
      });
    }
    return new Promise((resolve, reject) => {
      const cancel = () => {
        this.closeOverlay();
        reject(new Error("Authentication cancelled"));
      };
      const modal = new AuthInputModal({
        title: prompt.type === "secret" ? "Secret" : "Authentication input",
        message: prompt.message,
        placeholder: prompt.placeholder,
        secret: prompt.type === "secret",
        onSubmit: (value) => {
          this.closeOverlay();
          resolve(value);
        },
        onCancel: () => {
          owner.abort();
          cancel();
        },
      });
      prompt.signal?.addEventListener("abort", cancel, { once: true });
      this.showOverlayModal(modal, { anchor: "bottom-left" });
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

  /** B5:/logout 走 auth.logout effect；controller/Host 返回 authoritative 结果。 */
  private async handleLogout(providerId?: string): Promise<void> {
    if (this.store.getState().capabilities.auth.state !== "available") {
      this.showNotice("Logout is unavailable in this session.", "error");
      return;
    }
    const id = providerId ?? this.controller?.currentSelection.provider;
    if (!id) {
      this.showNotice("No provider selected.", "error");
      return;
    }
    const effect = this.createEffect("auth.logout", { providerId: id });
    this.store.dispatch({ type: "query.start", effect });
    this.runner.dispatch(effect);
    const workflow = await this.waitForWorkflow("authWorkflow", effect.correlationId);
    if (workflow.state === "ready") {
      this.showNotice(`Logged out ${id}.`);
    } else if (workflow.state === "error") {
      this.showNotice(`Logout failed: ${workflow.message}`, "error");
    }
  }

  private replayInitialHistory(): void {
    if (!this.controller) return;
    for (const warning of this.controller.warnings) this.dispatchTimeline([{
      type: "notice",
      generation: 0,
      correlationId: `warning-${this.store.getState().timeline.committedRows.length}`,
      severity: "warning",
      message: { text: warning, truncated: false, byteLength: new TextEncoder().encode(warning).byteLength },
    }]);
    for (let index = 0; index < this.controller.messages.length; index += 1) {
      const message = this.controller.messages[index];
      if (message === undefined) continue;
      this.dispatchTimeline(this.timelineProjector.project({ kind: "replay-message", message, index }));
    }
    // 对齐 projector 计数，保证后续 live 行 id 不与 replay 冲突
    this.timelineProjector.setMessageIndex(this.controller.messages.length);
    if (this.controller.warnings.length > 0) {
      for (const entry of this.controller.auditEntries) {
        const name = typeof entry.payload.toolName === "string" ? entry.payload.toolName : "tool";
        const content = typeof entry.payload.content === "string" ? `: ${entry.payload.content}` : "";
        this.dispatchTimeline([{
          type: "notice",
          generation: 0,
          correlationId: `audit-${this.store.getState().timeline.committedRows.length}`,
          severity: "info",
          message: { text: `${entry.type} ${name}${content}`, truncated: false, byteLength: new TextEncoder().encode(`${entry.type} ${name}${content}`).byteLength },
        }]);
      }
    }
  }

  /** B4:生成唯一 effect（generation = authority generation；effectId/correlationId 递增）。 */
  private createEffect(type: TuiEffect["type"], extra?: Record<string, unknown>): TuiEffect {
    this.effectSequence += 1;
    this.correlationSequence += 1;
    const ref: CorrelatedRequestRef = {
      generation: this.store.getState().authorityGeneration,
      effectId: `effect-${this.effectSequence}`,
      correlationId: `corr-${this.correlationSequence}`,
    };
    const effect = { type, ...ref } as TuiEffect;
    if (extra !== undefined) {
      Object.assign(effect as unknown as Record<string, unknown>, extra);
    }
    return effect;
  }

  /** B4:等待指定 workflow 离开 loading（结果落地或失败），返回其终态。 */
  private waitForWorkflow(key: "extensionWorkflow" | "providerWorkflow" | "modelWorkflow" | "thinkingWorkflow" | "authWorkflow" | "promptWorkflow" | "keymapWorkflow" | "runtimeSnapshotWorkflow" | "processWorkflow" | "taskGoalWorkflow" | "planWorkflow" | "agentWorkflow" | "securityModeWorkflow" | "workspaceGitWorkflow" | "updateWorkflow" | "queueWorkflow" | "approvalWorkflow" | "shutdownWorkflow", requestId: string): Promise<{
    readonly state: string;
    readonly value?: unknown;
    readonly message?: string;
    readonly reason?: string;
  }> {
    return new Promise((resolve) => {
      const check = (): void => {
        const workflow = this.store.getState()[key] as { readonly state: string; readonly requestId?: string; readonly value?: unknown; readonly message?: string; readonly reason?: string };
        if (workflow.state !== "loading" || workflow.requestId !== requestId) {
          unsubscribe();
          resolve(workflow);
        }
      };
      const unsubscribe = this.store.subscribe(check);
      check();
    });
  }

  /** B2/B3:TimelineEvent -> store（reducer 更新 timeline，订阅者投影到 ChatContainer）。 */
  private timelineEventGeneration = 0;
  private dispatchTimeline(events: readonly TimelineEvent[]): void {
    for (const event of events) {
      this.timelineEventGeneration += 1;
      this.store.dispatch({ type: "timeline.event", event: { ...event, generation: this.timelineEventGeneration } });
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
          this.flushStreamingDeltas();
          this.streamingGeneration += 1;
          this.streaming = true;
          this.stopReason = undefined;
          break;
        case "agent_end":
          this.flushStreamingDeltas();
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
          this.flushStreamingDeltas();
          this.dispatchTimeline(this.timelineProjector.project({ kind: "tui-event", event: ev }));
          break;
        case "message_end": {
          this.stopReason = ev.stopReason ?? this.stopReason;
          this.refs.status.setStopReason(this.stopReason);
          // 1) 先把帧前累积的 delta 快照送入
          this.flushStreamingDeltas();
          // 2) 用完整消息正文覆盖最后一次 delta 快照
          if (ev.message?.role === "assistant") {
            const text = messageAssistantText(ev.message);
            const thinking = messageAssistantThinking(ev.message);
            const correlationId = this.timelineProjector.currentAssistantCorrelationId();
            this.dispatchTimeline([{
              type: "message_update",
              generation: 0,
              correlationId,
              text: { text, truncated: false, byteLength: new TextEncoder().encode(text).byteLength },
              ...(thinking.length > 0 ? { thinking: { text: thinking, truncated: false, byteLength: new TextEncoder().encode(thinking).byteLength } } : {}),
            }]);
          }
          // 3) 提交行
          this.dispatchTimeline(this.timelineProjector.project({ kind: "tui-event", event: ev }));
          this.pendingMessageBuffers.delete(this.timelineProjector.currentAssistantCorrelationId());
          break;
        }
        case "message_update": {
          const e = ev.assistantMessageEvent;
          if (e.type === "done" || e.type === "error") {
            // done/error 即 stream fan-in 终点;先把已接受正文送入最终 frame。
            this.flushStreamingDeltas();
            break;
          }
          const partial = "partial" in e ? e.partial : undefined;
          if (partial !== undefined && partial.role !== "assistant") break;
          switch (e.type) {
            case "text_delta":
              this.queueAssistantDelta({
                kind: "append-text",
                entryId: "assistant",
                partId: `text:${e.contentIndex}`,
                channel: "text",
                generation: this.streamingGeneration,
                text: e.delta,
                receivedAt: Date.now(),
              });
              break;
            case "thinking_delta":
              this.queueAssistantDelta({
                kind: "append-text",
                entryId: "assistant",
                partId: `thinking:${e.contentIndex}`,
                channel: "thinking",
                generation: this.streamingGeneration,
                text: e.delta,
                receivedAt: Date.now(),
              });
              break;
            default:
              break;
          }
          break;
        }
        case "tool_execution_start":
          this.flushStreamingDeltas();
          this.dispatchTimeline(this.timelineProjector.project({ kind: "tui-event", event: ev }));
          break;
        case "tool_execution_update":
          this.dispatchTimeline(this.timelineProjector.project({ kind: "tui-event", event: ev }));
          break;
        case "tool_execution_end": {
          this.flushStreamingDeltas();
          this.dispatchTimeline(this.timelineProjector.project({ kind: "tui-event", event: ev }));
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
    // 任何事件后都请求一次合帧；stream backlog 超过预算时由 scheduler 提前让出一帧。
    const pressure = this.streamingDeltas.pressure;
    this.ui.requestRender(false, {
      queuedEvents: pressure.queuedEvents,
      queuedBytes: pressure.queuedBytes,
      oldestAgeMs: pressure.oldestAgeMs,
    });
  }

  private queueAssistantDelta(delta: AppendTextDelta): void {
    const before = this.streamingDeltas.stats;
    this.performanceObserver?.recordQueued({
      events: 1,
      bytes: new TextEncoder().encode(delta.text).byteLength,
    });
    this.streamingDeltas.push(delta);
    const after = this.streamingDeltas.stats;
    this.performanceObserver?.recordCoalesced({
      textEvents: after.mergedTextEvents - before.mergedTextEvents,
      supersededStatusEvents: after.supersededStatusEvents - before.supersededStatusEvents,
    });
    this.recordStreamingQueueDepth();
    if (!this.ui.isStarted) this.flushStreamingDeltas();
  }

  private flushStreamingDeltas(): void {
    let changed = false;
    for (const delta of this.streamingDeltas.drain()) {
      if (delta.kind !== "append-text") continue;
      const buffer = this.pendingMessageBuffers.get(this.timelineProjector.currentAssistantCorrelationId()) ?? { text: "", thinking: "" };
      if (delta.channel === "thinking") buffer.thinking += delta.text;
      else buffer.text += delta.text;
      this.pendingMessageBuffers.set(this.timelineProjector.currentAssistantCorrelationId(), buffer);
      changed = true;
    }
    if (changed) {
      // 每次 flush 发完整快照（单调累积；行正文只会增长），buffer 在 message_end 时清除
      const correlationId = this.timelineProjector.currentAssistantCorrelationId();
      const buffer = this.pendingMessageBuffers.get(correlationId);
      if (buffer !== undefined && (buffer.text.length > 0 || buffer.thinking.length > 0)) {
        this.dispatchTimeline([{
          type: "message_update",
          generation: 0,
          correlationId,
          text: { text: buffer.text, truncated: false, byteLength: new TextEncoder().encode(buffer.text).byteLength },
          ...(buffer.thinking.length > 0 ? { thinking: { text: buffer.thinking, truncated: false, byteLength: new TextEncoder().encode(buffer.thinking).byteLength } } : {}),
        }]);
      }
    }
    this.recordStreamingQueueDepth();
  }

  private recordStreamingQueueDepth(): void {
    const pressure = this.streamingDeltas.pressure;
    this.performanceObserver?.recordQueueDepth({
      events: pressure.queuedEvents,
      bytes: pressure.queuedBytes,
      oldestAgeMs: pressure.oldestAgeMs,
      pressureLevel: pressure.level,
    });
  }
}

function isSafeExecutionId(value: string): boolean {
  return /^execution_[A-Za-z0-9._~-]{1,128}$/u.test(value);
}

function messageText(message: AgentMessage): string {
  if (message.role !== "user") return "";
  return message.content.map((content) => content.text).join("");
}

function messageAssistantText(message: AgentMessage): string {
  if (message.role !== "assistant") return "";
  return message.content
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join("");
}

function messageAssistantThinking(message: AgentMessage): string {
  if (message.role !== "assistant") return "";
  return message.content
    .filter((content) => content.type === "thinking")
    .map((content) => content.thinking)
    .join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 把 domain 命令结果压缩为单行 notice 文本（只读展示，不解析执行）。 */
function compactDomainResult(operation: string, body: Record<string, unknown>): string {
  if (body.ok === false) {
    return typeof body.code === "string" ? `rejected: ${body.code}` : "rejected";
  }
  const short = (value: unknown, max = 240): string => {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.length > max ? `${text.slice(0, max)}…` : text;
  };
  switch (operation) {
    case "plan.inspect": {
      const state = isRecord(body.state) ? body.state : undefined;
      if (state === undefined) return "no plan state";
      return `status=${String(state.status ?? "?")} revision=${String(state.revision ?? "?")}${state.approval === undefined ? "" : ` approval=${String((state.approval as { status?: string }).status ?? "?")}`}`;
    }
    case "compaction.list": {
      const checkpoints = Array.isArray(body.checkpoints) ? body.checkpoints : [];
      return `checkpoints=${checkpoints.length}${checkpoints.length === 0 ? "" : ` latest=${String((checkpoints.at(-1) as { status?: string } | undefined)?.status ?? "?")}`}`;
    }
    case "memory.inspect": {
      const memory = isRecord(body.memory) ? body.memory : undefined;
      if (memory === undefined) return "no memory state";
      return `records=${String(memory.recordCount ?? "?")} proposals=${String(memory.proposalCount ?? "?")} generation=${String(memory.generation ?? "?")}`;
    }
    case "memory.propose": {
      const proposal = isRecord(body.proposal) ? body.proposal : undefined;
      return proposal === undefined ? "proposal created" : `proposal ${String(proposal.proposalId ?? "?")} pending approval`;
    }
    default:
      return short(body);
  }
}
