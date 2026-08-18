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
 *   4. run() / quit() 对接 TUI.start / stop；外部控制不拥有进程级 singleton；
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
import type { InteractiveSessionControllerPort, SessionRecoveryStatus, SessionTitleChangedEvent } from "../runtime/interactive-session-controller.ts";

import { adaptAgentEvent, type FooterSnapshotProvider, type TuiEvent } from "./types.ts";
import { loadTheme, applyEnvOverrides, type Theme } from "./theme/theme.ts";
import { makeEditorTheme, makeSelectListTheme } from "./theme/factories.ts";
import { editorBackgroundFromTerminal } from "./theme/editor-background.ts";
import { CustomEditor, type CustomEditorProps } from "./components/custom-editor.ts";
import { Footer } from "./components/footer.ts";
import { LoadedResourcesComponent } from "./components/loaded-resources.ts";
import { ChatContainer } from "./components/chat-container.ts";
import { AuthInputModal } from "./components/auth-input-modal.ts";
import { SearchableSelectorModal } from "./components/searchable-selector-modal.ts";
import { SessionPickerModal, buildSessionPickerItems } from "./components/session-picker-modal.ts";
import { ListSelectionModal, type ListSelectionItem } from "./components/list-selection-modal.ts";
import { ExtensionToggleModal, type ExtensionToggleItem } from "./components/extension-toggle-modal.ts";
import { McpServersModal, type McpServerViewItem } from "./components/mcp-servers-modal.ts";
import { StatusComponent } from "./components/status.ts";
import { SelectorModal } from "./components/selector-modal.ts";
import { PermissionRequestView } from "./components/permission-request-view.ts";
import { SelectionView } from "./components/selection-view.ts";
import type { SelectItem, RgbColor } from "./index.ts";
import type { Component, InputListenerResult, OverlayHandle, OverlayOptions } from "./primitives.ts";
import { matchesKey } from "./index.ts";
import { findCommand, commandsForContext, type RegisteredSlashCommand } from "./commands/registry.ts";
import { SlashCommandPopup } from "./components/slash-command-popup.ts";
import type { TuiOverlayState } from "./application/state.ts";
import type { ExecutionId } from "../runtime/protocol/ids.ts";
import type { ExtensionResourceView } from "./extensions/types.ts";
import type { HostFrameEnvelope } from "../runtime/host/types.ts";
import type { SessionFrameEnvelope } from "../runtime/session-server/protocol.ts";
import { decodeAuthEvent, decodeAuthPrompt } from "../runtime/session-runtime/credential-reverse-request.ts";
import type { ProcessOverlayController, ProcessOverlayHostClient } from "./process/controller-adapter.ts";
import { ProcessOverlayComponent } from "./process/overlay-component.ts";
import { createProcessPassiveBridge } from "./process/passive-bridge.ts";
import { DeltaCoalescer, type AppendTextDelta } from "./opentui/delta-coalescer.ts";
import type { TuiPerformanceObserver } from "./opentui/performance-observer.ts";
import { approvalChoices, approvalDecisionBody, parseApprovalReverseRequest, type ApprovalDecision } from "./approval.ts";
import type { TuiBootstrapSnapshot } from "./presentation/types.ts";
import type { TuiState } from "./application/state.ts";
import { createInitialTuiState } from "./application/initial-state.ts";
import type { TimelineEvent } from "./timeline/types.ts";
import { TimelineEventProjector } from "./timeline/event-projector.ts";
import { projectInteractivePresentation } from "./presentation/projectors.ts";
import type { TuiStore } from "./application/store.ts";
import { createTuiStore } from "./application/store.ts";
import type { TuiDomainPorts } from "./application/ports.ts";
import { capabilitiesFromPorts } from "./application/ports.ts";
import { createInteractiveSessionAdapter, type InteractiveSessionAdapter } from "./adapters/interactive-session.ts";
import { createSessionResourcePortsFromController } from "./adapters/session-resources.ts";
import { commandSessionController, createSessionDomainPortFromController, querySessionController, sessionAuthorityGeneration } from "./adapters/session-domain.ts";
import type { EffectRunner } from "./application/effect-runner.ts";
import { createEffectRunner } from "./application/effect-runner.ts";
import type { TuiEffect } from "./application/effect.ts";
import type { CorrelatedRequestRef } from "./application/common.ts";
import type { SessionCatalogResult, SessionTitleResult, SessionTransitionResult } from "./sessions/types.ts";
import type { TuiPreferencesDocument, TuiPreferencesPort } from "./preferences/types.ts";
import { normalizeSessionTitle } from "../runtime/session-owner/title.ts";
import { BUILTIN_SYNTAX_THEME_NAMES, SyntaxThemeController } from "./highlight/theme-controller.ts";
import { STATUS_INDICATOR_FRAME_MS } from "./opentui/block-layout.ts";
import { projectStatusIndicator } from "./presentation/projectors.ts";
import { projectTranscriptOverlay, TranscriptOverlayComponent } from "./transcript-view.ts";
import { projectToolUsage } from "./presentation/tools/projector.ts";
import type { SafeUsageQuantity } from "./presentation/tools/types.ts";

export interface SyntaxThemeSettingsPort {
  save(name: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: string }>;
}

/** InteractiveMode 装配参数。 */
export interface InteractiveModeOptions {
  /** 新 CLI 使用统一 controller;agent 仅保留 demo 兼容。 */
  controller?: InteractiveSessionControllerPort;
  agent?: Agent;
  /** 终端实现,默认 ProcessTerminal;可传入 mock 终端用于单测。 */
  terminal?: Terminal;
  /** 主题名，默认 dark；运行时由 OpenTUI theme_mode 更新。 */
  themeName?: "dark" | "light";
  syntaxThemeName?: string;
  syntaxThemeController?: SyntaxThemeController;
  syntaxThemeSettingsPort?: SyntaxThemeSettingsPort;
  syntaxThemeWarnings?: readonly string[];
  /** R9:由 Host facade 提供的 safe process list/output/mutation adapter。 */
  processOverlayController?: ProcessOverlayController;
  /** B7:process output 的真实 Host client（composition root 注入；缺失时 bridge 只读）。 */
  processOverlayClient?: ProcessOverlayHostClient;
  /** P6:workspace/path 能力标签（真实 runner 证据矩阵）；仅 unverified 值进入启动 warning notice。 */
  workspaceCapability?: string;
  /** agent 运行时绝对地址：sanitize + 有界但保留绝对路径；仅本机 footer，不进公共 DTO/remote snapshot。 */
  workspaceDisplayAbsolutePath?: string;
  gitBranchLabel?: string;
  /** 可选的分层渲染 telemetry sink；不参与 UI 调度决策。 */
  performanceObserver?: TuiPerformanceObserver;
  /** B1:显式 bootstrap snapshot；缺省由 controller/agent 派生。 */
  initialBootstrap?: TuiBootstrapSnapshot;
  /** CLI composition 注入的本地 presentation preference 初值。 */
  initialPreferences?: TuiPreferencesDocument;
  /** 只负责 presentation preference 的持久化；TUI 不接触 layout/path。 */
  preferencesPort?: TuiPreferencesPort;
}

export interface SessionSwitchTarget {
  readonly sessionId: string;
}

/** /model 弹窗模型条目(model.list workflow 值的投影)。 */
export interface ModelPickerModel {
  readonly providerId: string;
  readonly modelId: string;
  readonly label: string;
}

export type InteractiveExitIntent =
  | { readonly kind: "quit" }
  | { readonly kind: "switch"; readonly action: "new" | "resume" | "fork"; readonly target: SessionSwitchTarget };

export type HostConnectionUiState = "ready" | "reconnecting" | "stopped" | "build_mismatch" | "recovery_required";

/** 组件树引用,挂在 InteractiveMode 实例上以便 handleEvent 路由 mutation。 */
interface ContainerRefs {
  header: Container;
  loadedResources: LoadedResourcesComponent;
  chat: ChatContainer;
  status: StatusComponent;
  editor: CustomEditor;
  footer: Footer;
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
  private unsubscribeSessionTitle?: () => void;
  private unsubscribeIdleRecap?: () => void;
  private idleRecapRequestId: string | undefined;
  private idleRecapActivityGeneration = 0;
  private unsubscribeThemeMode?: () => void;
  private unsubscribeTerminalBackground?: () => void;
  private unsubscribeRenderPreparation?: () => void;
  private unsubscribeBoundaryActions?: () => void;

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
  private readonly workspaceDisplayAbsolutePath?: string;
  private readonly gitBranchLabel?: string;
  private authAdapter: InteractiveSessionAdapter;
  private quitting = false;

  // /model 二级弹窗缓存:workflow ready 快照投影,供二级 Esc 返回一级复用。
  private modelPickSource: {
    readonly models: readonly ModelPickerModel[];
    readonly currentProviderId?: string;
    readonly currentModelId?: string;
  } | undefined;
	private hostConnectionState: HostConnectionUiState = "ready";
  private readonly exitPromise: Promise<InteractiveExitIntent>;
  private readonly resolveExit: (intent: InteractiveExitIntent) => void;
  private processOverlayComponent: ProcessOverlayComponent | undefined;
  private readonly initialBootstrap?: TuiBootstrapSnapshot;
  private readonly preferencesPort?: TuiPreferencesPort;
  private readonly syntaxThemeController: SyntaxThemeController;
  private readonly syntaxThemeSettingsPort?: SyntaxThemeSettingsPort;
  private lastTranscriptScrollbarVisible: boolean | undefined;
  private activePermissionView: PermissionRequestView | undefined;
  private unsubscribePermissionInput: (() => void) | undefined;
  private transcriptOverlay: TranscriptOverlayComponent | undefined;
  private unsubscribeTranscriptInput: (() => void) | undefined;

  // P3:slash 输入期补全弹窗(nonCapturing overlay;editor 文本/光标变化驱动)
  private slashPopup: SlashCommandPopup | undefined;
  private slashOverlayHandle: OverlayHandle | undefined;
  /** Esc 关闭后记忆当前命令 token;token 变化才恢复弹窗(对照 codex dismissed_command_token)。 */
  private dismissedCommandToken: string | undefined;

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
    this.workspaceDisplayAbsolutePath = opts.workspaceDisplayAbsolutePath;
    this.gitBranchLabel = opts.gitBranchLabel;
    this.initialBootstrap = opts.initialBootstrap;
    this.preferencesPort = opts.preferencesPort;
    this.syntaxThemeController = opts.syntaxThemeController ?? new SyntaxThemeController({
      availableThemes: BUILTIN_SYNTAX_THEME_NAMES,
      configuredName: opts.syntaxThemeName,
      terminalMode: "unknown",
    });
    this.syntaxThemeSettingsPort = opts.syntaxThemeSettingsPort;
    // B4:ports 聚合 controller + Session domain；runner 只执行 effect 并回送 TuiResult
    this.authAdapter = createInteractiveSessionAdapter(this.controller);
    const sessionPort = createSessionDomainPortFromController(this.controller);
    this.ports = {
      ...this.authAdapter.ports,
      ...(sessionPort === undefined ? {} : { session: sessionPort }),
      ...createSessionResourcePortsFromController(this.controller),
    };
    // B7:process passive bridge 复用既有 overlay facade（无第二 manager）
    const bridge = createProcessPassiveBridge(this.processOverlayController, opts.processOverlayClient);
    if (bridge !== undefined) this.ports = { ...this.ports, process: bridge };
    this.store = createTuiStore(createInitialTuiState({
      bootstrap: this.deriveBootstrap(),
      capabilities: {
		...capabilitiesFromPorts(this.ports, {
			sessionCatalog: this.authAdapter.supports("session.catalog.list"),
			sessionMutation: ["session.create", "session.resume", "session.fork", "session.title.set"].some((operation) => this.authAdapter.supports(operation)),
			process: this.authAdapter.supports("session.process.list") && this.authAdapter.supports("session.process.output"),
		}),
      },
      preferences: {
        transcriptScrollbarVisible: opts.initialPreferences?.transcript.scrollbar === "visible",
      },
    }));
    this.runner = createEffectRunner({
      ports: this.ports,
      currentGeneration: () => this.store.getState().authorityGeneration,
      onResult: (result) => this.store.dispatch({ type: "query.result", result }),
    });
    let resolveExit: ((intent: InteractiveExitIntent) => void) | undefined;
    this.exitPromise = new Promise<InteractiveExitIntent>((resolve) => {
      resolveExit = resolve;
    });
    this.resolveExit = (intent) => resolveExit?.(intent);

    // TUI 使用 showHardwareCursor=false,Editor 自身以 CURSOR_MARKER 通知光标位置
    this.ui = new TUI(this.terminal, false, {
      performanceObserver: opts.performanceObserver,
      syntaxThemeName: opts.syntaxThemeName,
      syntaxThemeController: this.syntaxThemeController,
    });
    this.refreshTranscriptScrollPresentation();
    this.unsubscribeRenderPreparation = this.ui.addBeforeRenderListener(() => {
      this.flushStreamingDeltas();
      this.refreshStatusIndicator();
    });
    this.unsubscribeTranscriptInput = this.ui.addInputListener((data) => this.handleTranscriptInput(data));
    this.unsubscribeBoundaryActions = this.ui.addActionListener((actions) => {
      for (const action of actions) this.store.dispatch(action);
      if (actions.some((action) => action.type === "interaction.focus-changed")) this.ui.requestRender();
    });
    this.ui.setAppIntentHandler({
      onInterrupt: () => {
        // nonCapturing 弹窗(如 slash 补全)不拦截 Ctrl+C
        if (this.ui.hasCapturingOverlay() || this.activePermissionView !== undefined) return false;
        this.handleInterrupt();
        return true;
      },
      onExit: () => this.ui.hasOverlay() || this.activePermissionView !== undefined ? false : this.handleCtrlD(),
      onRefresh: () => this.ui.invalidate(),
    });

    // KeybindingsManager:本期安装默认 TUI_KEYBINDINGS,后续 M6 在此挂 user bindings
    this.kb = new KeybindingsManager(TUI_KEYBINDINGS);
    setKeybindings(this.kb);

    // 装配组件树
    this.refs = this.assembleTree();
    // B3:store 订阅驱动 chat presentation（timeline generation 变化才重投影）
    this.unsubscribeStore = this.store.subscribe((next) => {
      if (next.timeline.generation !== this.lastTimelineGeneration) {
        this.lastTimelineGeneration = next.timeline.generation;
        const presentation = projectInteractivePresentation(next);
        this.refs.chat.setTimelineBlocks(presentation.timeline, next.timeline.generation);
      }
      if (this.transcriptOverlay !== undefined && this.ui.getOverlay() === this.transcriptOverlay) {
        this.transcriptOverlay.update(projectTranscriptOverlay(next.timeline, this.syntaxThemeController.snapshot().revision));
      }
      if (next.interaction.transcriptScrollbarVisible !== this.lastTranscriptScrollbarVisible) {
        this.refreshTranscriptScrollPresentation();
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
    this.replayInitialHistory(opts.syntaxThemeWarnings ?? []);

    void MAX_CONSECUTIVE_INIT_FAILURES;
    void INIT_FAILURE_BACKOFF_MS;
  }

	public setHostConnectionState(state: HostConnectionUiState): void {
		if (this.hostConnectionState === state) return;
		this.hostConnectionState = state;
		const presentation = state === "ready"
			? { text: "Host reconnected.", kind: "note" as const }
			: state === "reconnecting"
				? { text: "Host reconnecting; new mutations are paused.", kind: "note" as const }
				: state === "stopped"
					? { text: "Host stopped; this client will not reconnect.", kind: "error" as const }
					: state === "build_mismatch"
						? { text: "Host build mismatch; run `runledger host restart` with the current build.", kind: "error" as const }
						: { text: "Host recovery required; command outcome could not be proven.", kind: "error" as const };
		this.showNotice(presentation.text, presentation.kind);
	}

  /** 装配组件树并返回引用;M2 起把 LoadedResources / Chat 等 container 换成真实组件。 */
  private assembleTree(): ContainerRefs {
    const header = new Container();
    const loadedResources = new LoadedResourcesComponent({});
    const chat = new ChatContainer();
    const status = new StatusComponent({});
    const editorTheme: EditorTheme = makeEditorTheme(this.theme, this.makeSelectListTheme());
    const editorProps: CustomEditorProps = {
      theme: this.theme,
      selectListTheme: this.makeSelectListTheme(),
      onSubmit: (text) => this.handleSubmit(text),
      onChange: (text) => {
        this.clearIdleRecapStatus();
        this.controller?.notifyEditorActivity?.(text.trim().length === 0);
        this.syncSlashPopup();
      },
      onSlashPopupKey: (data) => this.handleSlashPopupKey(data),
      onFollowUp: (text) => this.handleFollowUpSubmit(text),
      onDequeue: () => this.restoreQueuesToEditor(),
    };
    const editor = new CustomEditor(this.ui, editorTheme, editorProps);
    const footer = new Footer({ theme: this.theme, provider: this });

    // 组件树结构(对照 02 §1):
    //   header / loadedResources / chat / status / editor / footer
    this.ui.addChild(header);
    this.ui.addChild(loadedResources);
    this.ui.addChild(chat);
    this.ui.addChild(status);
    this.ui.addChild(editor);
    this.ui.addChild(footer);

    // Editor 拿焦点
    this.ui.setFocus(editor);

    return { header, loadedResources, chat, status, editor, footer };
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
      authorityGeneration: sessionAuthorityGeneration(this.controller),
    };
  }

  /** B3:只读暴露 TuiState（store 为唯一 owner）。 */
  getTuiState(): TuiState {
    return this.store.getState();
  }

  /** B3:overlay 状态意图写入 store；组件/焦点仍由 renderer 管理（view side-effect）。 */
  private showOverlayModal(component: Component, options?: OverlayOptions, kind: Exclude<TuiOverlayState["state"], "closed"> = "command"): void {
    // 真实 modal 抢占 overlay 槽;slash 补全弹窗随之失效(防止幽灵引用)
    this.slashPopup = undefined;
    this.slashOverlayHandle = undefined;
    this.transcriptOverlay = undefined;
    this.store.dispatch({
      type: "overlay.open",
      overlay: { state: kind, requestId: `overlay-${this.store.getState().interaction.generation + 1}` },
    });
    this.ui.showOverlay(component, options);
    this.ui.requestRender();
  }

  /** B3:overlay 关闭意图写入 store。 */
  private closeOverlay(): void {
    if (this.ui.getOverlay() === this.slashPopup) {
      this.slashPopup = undefined;
      this.slashOverlayHandle = undefined;
    }
    if (this.ui.getOverlay() === this.transcriptOverlay) this.transcriptOverlay = undefined;
    this.store.dispatch({ type: "overlay.close" });
    this.ui.hideOverlay();
  }

  /** Ctrl+T 的只读 transcript overlay；不改变主对话 ScrollBox 的位置或内容。 */
  private openTranscriptOverlay(): void {
    if (this.quitting || this.ui.hasOverlay() || this.activePermissionView !== undefined) return;
    const overlay = new TranscriptOverlayComponent(projectTranscriptOverlay(this.store.getState().timeline, this.syntaxThemeController.snapshot().revision), {
      getViewportHeight: () => Math.max(4, this.terminal.rows - 2),
      onClose: () => this.closeOverlay(),
    });
    this.showOverlayModal(overlay, { anchor: "center", variant: "transcript" }, "transcript");
    this.transcriptOverlay = overlay;
  }

  /** transcript overlay 捕获期间所有键都不应落入 composer；未知键保持只读。 */
  private handleTranscriptInput(data: string): InputListenerResult {
    if (this.transcriptOverlay !== undefined && this.ui.getOverlay() === this.transcriptOverlay) {
      this.transcriptOverlay.handleInput(data);
      return { consume: true };
    }
    if (!matchesKey(data, "ctrl+t")) return undefined;
    if (this.ui.hasOverlay() || this.activePermissionView !== undefined) return undefined;
    this.openTranscriptOverlay();
    return { consume: true };
  }

  /** 用 dark 主题色拼一个最小 SelectListTheme 占位;M6 阶段补完整色槽。 */
  private makeSelectListTheme(): SelectListTheme {
    return makeSelectListTheme(this.theme);
  }

  /** 启动 TUI;Promise 在 quit() 完成终端清理后 resolve。 */
  async run(): Promise<InteractiveExitIntent> {
    if (this.quitting) return this.exitPromise;
    this.unsubscribe = this.controller
      ? this.controller.subscribe((ev) => this.handleAgentEvent(ev))
      : this.agent?.subscribe((ev) => this.handleAgentEvent(ev));
    this.unsubscribeSessionTitle = this.controller?.subscribeSessionTitleChanged?.((event) => this.handleSessionTitleChanged(event));
    this.unsubscribeIdleRecap = this.controller?.subscribeIdleRecap?.((event) => {
      if (event.cleared === true) {
        if (event.requestId !== this.idleRecapRequestId) return;
        this.clearIdleRecapStatus();
      } else {
        if (event.text === undefined) return;
        if (event.activityGeneration !== undefined && event.activityGeneration < this.idleRecapActivityGeneration) return;
        this.idleRecapRequestId = event.requestId;
        if (event.activityGeneration !== undefined) this.idleRecapActivityGeneration = event.activityGeneration;
        this.refs.status.setIdleRecap(event.text);
      }
      this.ui.requestRender();
    });
    this.unsubscribeThemeMode = this.ui.addThemeModeListener((mode) => this.maybeSwitchTheme(mode));
    this.unsubscribeTerminalBackground = this.ui.addTerminalBackgroundListener((rgb) => this.refreshEditorAppearance(rgb));
	    try {
		  const recoverySync = this.syncRecoveryState();
		  if (recoverySync !== undefined) await recoverySync;
	      await this.ui.start();
      await this.syncThinkingWorkflow();
      this.ui.requestRender();
      // 启动即按当前主题(+已缓存的 OSC 11)下发一次输入区外观。
      this.refreshEditorAppearance();
    } catch (error) {
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      this.unsubscribeSessionTitle?.();
      this.unsubscribeSessionTitle = undefined;
      this.unsubscribeIdleRecap?.();
      this.unsubscribeIdleRecap = undefined;
      this.unsubscribeThemeMode?.();
      this.unsubscribeThemeMode = undefined;
      this.unsubscribeTerminalBackground?.();
      this.unsubscribeTerminalBackground = undefined;
      this.resolveExit({ kind: "quit" });
      throw error;
    }
    return this.exitPromise;
  }

  /**
   * 输入区外观重算:终端背景(OSC 11 优先,缺失回退 theme.background)经 blend
   * 得到输入区背景;theme_mode 切换与 OSC 11 回复都会触发。OpenTUI 路径由帧驱动即时生效。
   */
  private refreshEditorAppearance(rgb?: RgbColor): void {
    this.ui.setEditorAppearance({
      backgroundColor: editorBackgroundFromTerminal(this.theme, rgb ?? this.ui.getTerminalBackgroundRgb()),
      promptColor: this.theme.accent,
      placeholderColor: this.theme.hint,
    });
  }

  /**
   * Ctrl+C 三态:流式中断当前 turn;空闲有草稿清空输入区;
   * 空闲且输入区为空退出 TUI。
   */
  private handleInterrupt(): void {
    if (this.streaming || this.inFlight()) {
      this.interruptCurrentTurn();
      return;
    }
    const text = this.refs.editor.getText();
    if (text.length > 0) {
      this.refs.editor.setText("");
      this.ui.requestRender();
      return;
    }
    void this.requestQuit();
  }

  /** Permission deny 与 Ctrl+C 共用同一 canonical turn 中断和队列恢复路径。 */
  private interruptCurrentTurn(): void {
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
  }

  private handleCtrlD(): boolean {
    if (!this.inFlight() && this.refs.editor.getText().length === 0) {
      void this.requestQuit();
      return true;
    }
    return false;
  }

  /** OpenTUI theme_mode 变更后刷新共享 ThemeRef,并重算输入区外观。 */
  private maybeSwitchTheme(scheme: "dark" | "light"): void {
    Object.assign(this.theme, applyEnvOverrides(loadTheme(scheme)));
    this.refreshEditorAppearance();
    this.refreshTranscriptScrollPresentation();
    this.ui.invalidate();
  }

  private refreshTranscriptScrollPresentation(): void {
    const visible = this.store.getState().interaction.transcriptScrollbarVisible;
    this.lastTranscriptScrollbarVisible = visible;
    this.ui.setTranscriptScrollPresentation({
      visible,
      trackColor: this.theme.surface,
      thumbColor: this.theme.border,
    });
  }

  /** 退出 TUI。 */
  quit(): void {
    void this.requestQuit();
  }

  private async requestQuit(): Promise<void> {
	return this.requestExit({ kind: "quit" });
  }

  private async requestExit(intent: InteractiveExitIntent): Promise<void> {
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
    this.unsubscribeSessionTitle?.();
    this.unsubscribeSessionTitle = undefined;
    this.unsubscribeIdleRecap?.();
    this.unsubscribeIdleRecap = undefined;
    this.unsubscribeStore?.();
    this.unsubscribeStore = undefined;
    this.unsubscribeThemeMode?.();
    this.unsubscribeThemeMode = undefined;
    this.unsubscribeTerminalBackground?.();
    this.unsubscribeTerminalBackground = undefined;
    this.unsubscribeRenderPreparation?.();
    this.unsubscribeRenderPreparation = undefined;
    this.unsubscribeTranscriptInput?.();
    this.unsubscribeTranscriptInput = undefined;
    this.transcriptOverlay = undefined;
    this.unsubscribeBoundaryActions?.();
    this.unsubscribeBoundaryActions = undefined;
    this.ui.setAppIntentHandler(undefined);
    this.ui.stop();
    this.resolveExit(intent);
  }

  /**
   * 公共 prompt 注入入口；内部调用走同一通道。
   *
   * 实现:把 Editor onSubmit 流转过来即可——等价于"程序模拟一键回车提交"。
   * 不调 agent.prompt 直绕，保证 handleSubmit 先投影 canonical user Timeline row。
   */
  echoPrompt(text: string): void {
    this.handleSubmit(text);
  }

  /** Host 逆向 approval 请求：只收集并返回决策；Host receipt 未接入前不更新 approval workflow。 */
  handleReverseRequest(frame: HostFrameEnvelope, signal: AbortSignal): Promise<Record<string, unknown>> {
    return this.handleApprovalReverseRequest(frame.body, signal);
  }

  /** Session reverse-request 的唯一 TUI 分派：approval 与 credential 共用既有 UI authority。 */
  handleSessionReverseRequest(frame: SessionFrameEnvelope, signal: AbortSignal): Promise<Record<string, unknown>> {
    const requestKind = typeof frame.body.kind === "string" ? frame.body.kind : undefined;
    if (requestKind === "approval_prompt") {
      const body = isRecord(frame.body.body) ? frame.body.body : undefined;
      return body === undefined
        ? Promise.resolve({ ok: false, code: "reverse_request_invalid" })
        : this.handleApprovalReverseRequest(body, signal);
    }
    if (requestKind === "credential_prompt" || requestKind === "credential_event") {
      return this.handleCredentialReverseRequest(frame, signal);
    }
    return Promise.resolve({ ok: false, code: "reverse_request_invalid" });
  }

  private handleApprovalReverseRequest(body: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    const view = parseApprovalReverseRequest(body);
    if (!view) return Promise.resolve({ ok: false, code: "reverse_request_invalid" });
    if (this.activePermissionView !== undefined) return Promise.resolve({ ok: false, code: "approval_busy" });
    if (signal.aborted) return Promise.resolve({ ok: false, code: "approval_aborted" });
    return new Promise<Record<string, unknown>>((resolve) => {
      let settled = false;
      const finish = (responseBody: Record<string, unknown>): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        this.unsubscribePermissionInput?.();
        this.unsubscribePermissionInput = undefined;
        this.refs.chat.clearReplacement(permissionView);
        if (this.activePermissionView === permissionView) this.activePermissionView = undefined;
        this.ui.setFocus(this.refs.editor);
        this.ui.requestRender(true);
        resolve(responseBody);
      };
      const onAbort = (): void => {
        finish({ ok: false, code: "approval_aborted" });
      };
      const choose = (decision: ApprovalDecision): void => {
        // 这里只记录用户决策意图；Host 是否接受由 reverse response 的调用方确认。
        this.dispatchTimeline([{
          type: "notice",
          generation: 0,
          correlationId: `approval-${this.store.getState().timeline.committedRows.length}`,
          severity: "info",
          message: { text: `approval ${decision.decision} for ${view.toolName}`, truncated: false, byteLength: new TextEncoder().encode(`approval ${decision.decision} for ${view.toolName}`).byteLength },
        }]);
        finish(approvalDecisionBody(decision));
        if (decision.decision === "deny") {
          // 先让 reverse response 的 continuation 发送 deny，再中断 canonical turn，
          // 避免模型把单次拒绝当成可继续重试的新 permission 请求。
          queueMicrotask(() => this.interruptCurrentTurn());
        }
      };
	  const choices = approvalChoices(view);
	  const permissionView = new PermissionRequestView({
	    request: view,
	    choices,
	    onSelect: (choice) => choose(choice.decision),
	    onCancel: () => choose({ decision: "cancel" }),
	    onChange: () => this.ui.requestRender(true),
	  });
      signal.addEventListener("abort", onAbort, { once: true });
	  if (this.ui.hasOverlay()) this.closeOverlay();
	  this.activePermissionView = permissionView;
	  this.refs.chat.setReplacement(permissionView, "permission-request");
	  this.unsubscribePermissionInput = this.ui.addInputListener((data) => {
	    if (this.activePermissionView !== permissionView) return undefined;
	    permissionView.handleInput(data);
	    return { consume: true };
	  });
	  this.ui.requestRender(true);
    });
  }

  /**
   * Session 协议 credential reverse-request:`/login` 的 secret/select 提示
   * 由 server 侧 domain 经 reverse_request 投递到这里渲染,并把用户输入
   * 经 reverse_response 送回;credential_event(info/auth_url/device_code)只展示。
   */
  handleCredentialReverseRequest(frame: SessionFrameEnvelope, signal: AbortSignal): Promise<Record<string, unknown>> {
    const body = frame.body;
    const requestKind = typeof body.kind === "string" ? body.kind : undefined;
    if (requestKind === "credential_prompt") {
      const prompt = decodeAuthPrompt(body.body);
      if (prompt === undefined) return Promise.resolve({ ok: false, code: "reverse_request_invalid" });
      // 提示用户 modal 已打开(部分终端下 overlay 渲染偶发不可见,notice 兜底)。
      this.showNotice(`Credential prompt: ${prompt.message}`, "note");
      return new Promise<Record<string, unknown>>((resolve) => {
        let settled = false;
        const finish = (result: Record<string, unknown>): void => {
          if (settled) return;
          settled = true;
          this.closeOverlay();
          resolve(result);
        };
        const onAbort = (): void => finish({ ok: false, code: "aborted" });
        void this.promptAuth(prompt, new AbortController()).then(
          (value) => finish({ ok: true, value }),
          () => finish({ ok: false, code: "aborted" }),
        );
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      });
    }
    if (requestKind === "credential_event") {
      const event = decodeAuthEvent(body.body);
      if (event === undefined) return Promise.resolve({ ok: false, code: "reverse_request_invalid" });
      this.showAuthEvent(event);
      return Promise.resolve({});
    }
    return Promise.resolve({ ok: false, code: "reverse_request_invalid" });
  }

  /**
   * 打开 slash 命令选择器;清单唯一来源为命令注册表(commandsForContext)。
   * 选中项携带注册表 descriptor,经 dispatchCommand 统一派发(与 handleSubmit 同源)。
   */
  openSlashCommands(): void {
    this.hideSlashPopup();
    const entries = commandsForContext({});
    const view = new SelectionView({
      title: "/commands",
      items: entries.map((entry) => ({
        name: `/${entry.canonicalName}${entry.usage ? ` ${entry.usage}` : ""}`,
        description: entry.description,
        dismissOnSelect: true,
        action: () => this.dispatchCommand(entry, ""),
      })),
      selectListTheme: makeSelectListTheme(this.theme),
      maxVisible: 12,
      onDismiss: () => this.closeOverlay(),
      onCancel: () => this.closeOverlay(),
    });
    this.showOverlayModal(view, { anchor: "bottom-left" });
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
   * Session Owner 最小 recovery workflow：status/assess/verify/resume 全部走
   * typed controller facade，不在 TUI 猜测 durable outcome。
   */
  public async runRecoveryWorkflow(argument: string): Promise<void> {
    const controller = this.controller;
    if (controller?.recoveryStatus === undefined) {
      this.showNotice("Session recovery is unavailable in this client.", "error");
      return;
    }
    const [action = "status", ...rest] = argument.trim().split(/\s+/u).filter((part) => part.length > 0);
    try {
      if (action === "assess") {
        if (controller.recoveryAssess === undefined) throw new Error("recovery assessment is unavailable");
        const result = await controller.recoveryAssess();
        this.showNotice(`Recovery assessment: state=${result.state} unresolved=${result.unresolvedRemaining}.`);
		await this.syncRecoveryState();
        return;
      }
      if (action === "verify") {
        const attemptId = rest[0];
        if (attemptId === undefined || controller.recoveryVerify === undefined) {
          this.showNotice("Usage: /recovery verify <attemptId>", "error");
          return;
        }
        const result = await controller.recoveryVerify(attemptId);
        this.showNotice(`Recovery verification recorded: state=${result.state}.`);
		await this.syncRecoveryState();
        return;
      }
      if (action === "resume") {
        const reason = rest.join(" ").trim();
        if (reason.length === 0 || controller.recoveryResume === undefined) {
          this.showNotice("Usage: /recovery resume <reason>", "error");
          return;
        }
        const result = await controller.recoveryResume(reason);
        this.showNotice(`Uncertain recovery explicitly accepted: state=${result.state}.`);
		await this.syncRecoveryState();
        return;
      }
      if (action !== "status") {
        this.showNotice("Usage: /recovery [status|assess|verify <attemptId>|resume <reason>]", "error");
        return;
      }
      const status = await controller.recoveryStatus();
	  this.applyRecoveryStatus(status);
      this.showNotice(
        `Recovery: state=${status.state} barrier=${status.barrierState} unresolved=${status.unresolvedAttempts}. ` +
        "Use /recovery assess, /recovery verify <attemptId>, or /recovery resume <reason>.",
      );
    } catch (error) {
      this.showNotice(`Recovery command failed: ${String(error)}`, "error");
    }
  }

	private syncRecoveryState(): Promise<void> | undefined {
		const controller = this.controller;
		if (controller?.recoveryStatus === undefined) return;
		return controller.recoveryStatus().then((status) => {
			this.applyRecoveryStatus(status);
		}, (error: unknown) => {
			this.showNotice(`Recovery status unavailable: ${String(error)}`, "error");
		});
	}

	private applyRecoveryStatus(status: SessionRecoveryStatus): void {
		const required = status.state === "recovery_required" || status.barrierState === "open";
		this.store.dispatch({ type: "recovery.set", required });
		this.ui.requestRender();
	}

  /**
   * B4+:打开 MCP server 管理视图(/mcp)。经 mcp.list 查询真实 catalog,
   * r 重启走 mcp.restart,操作成功后重新查询刷新。
   */
  openMcpServerSelector(): Promise<void> {
    return this.openMcpServersModal();
  }

  /** B4+:打开 plugins/skills/hooks 管理视图(/plugins /skills /hooks)。 */
  openExtensionSelector(operation: "plugin.list" | "skill.list" | "hook.list", _kindLabel: string, commandName: string): Promise<void> {
    const kind = operation === "plugin.list" ? "plugin" : operation === "skill.list" ? "skill" : "hook";
    return this.openExtensionToggleModal(kind, commandName);
  }

  /** /mcp:server 列表 + Enter 详情 + r 重启,全部经 Session domain 通道。 */
  private async openMcpServersModal(): Promise<void> {
    if (this.store.getState().capabilities.mcp.state !== "available") {
      this.showNotice("MCP catalog is unavailable in this session.", "error");
      return;
    }
    const servers = await this.queryMcpServers();
    if (servers === undefined) return;
    let modal: McpServersModal | undefined;
    modal = new McpServersModal({
      title: `/mcp (${servers.length})`,
      servers,
      onRestart: (server) => {
        void this.restartMcpServer(server, modal);
      },
      onCancel: () => this.closeOverlay(),
    });
    this.showOverlayModal(modal, { anchor: "bottom-left" });
  }

  private async restartMcpServer(server: McpServerViewItem, modal: McpServersModal | undefined): Promise<void> {
    const { serverId } = server;
    const ok = await this.runSessionMutation("mcp.restart", { serverId }, "/mcp restart");
    if (!ok || modal === undefined) return;
    const fresh = await this.queryMcpServers();
    if (fresh !== undefined) {
      modal.update(fresh);
      this.showNotice(`/mcp: ${server.displayName} restarted.`, "note");
    }
  }

  /** /skillsproviders:只读 provider status 列表（mutation 仍走 authenticated Session command）。 */
  private async openSkillProvidersModal(): Promise<void> {
    const context = { correlationId: `corr-${this.correlationSequence + 1}`, effectId: `effect-${this.effectSequence + 1}` };
    const result = await querySessionController(this.controller, "skill.provider.list", {}, context).catch((error: unknown) => {
      this.showNotice(`/skillsproviders query failed: ${String(error)}`, "error");
      return undefined;
    });
    if (result === undefined) return;
    if (!result.ok) {
      this.showNotice(`/skillsproviders query failed: ${result.code}`, "error");
      return;
    }
    const rawItems = isRecordArray(result.value?.items) ? result.value.items : [];
    const items: SelectItem[] = rawItems.flatMap((item) => {
      if (!isRecord(item) || typeof item.providerId !== "string") return [];
      const state = typeof item.state === "string" ? item.state : "unknown";
      const candidateCount = typeof item.candidateCount === "number" ? item.candidateCount : 0;
      const activeCount = typeof item.activeCount === "number" ? item.activeCount : 0;
      const failedCount = typeof item.failedCount === "number" ? item.failedCount : 0;
      const label = `${item.providerId} — ${state}`;
      const description = `candidates=${candidateCount} active=${activeCount} failed=${failedCount}`;
      return [{ value: item.providerId, label, description }];
    });
    const modal = new SelectorModal({
      theme: this.theme,
      selectListTheme: makeSelectListTheme(this.theme),
      title: `/skillsproviders (${items.length})`,
      items,
      onCancel: () => this.closeOverlay(),
    });
    this.showOverlayModal(modal, { anchor: "bottom-left" });
  }

  private async queryMcpServers(): Promise<McpServerViewItem[] | undefined> {    const context = { correlationId: `corr-${this.correlationSequence + 1}`, effectId: `effect-${this.effectSequence + 1}` };
    const result = await querySessionController(this.controller, "mcp.list", {}, context).catch((error: unknown) => {
      this.showNotice(`/mcp query failed: ${String(error)}`, "error");
      return undefined;
    });
    if (result === undefined) return undefined;
    if (!result.ok) {
      this.showNotice(`/mcp query failed: ${result.code}`, "error");
      return undefined;
    }
    const items = isRecordArray(result.value?.items) ? result.value.items : isRecordArray(result.value?.servers) ? result.value.servers : [];
    return items.flatMap((item) => {
      if (!isRecord(item)) return [];
      const view = mcpServerViewFromDomain(item);
      return view === undefined ? [] : [view];
    });
  }

  /** /plugins /skills /hooks:codex 风格 toggle 视图,Space/Enter 切换 enable,t 信任。 */
  private async openExtensionToggleModal(kind: "plugin" | "skill" | "hook", commandName: string): Promise<void> {
    const resources = await this.queryExtensionResources(kind, commandName);
    if (resources === undefined) return;
    if (resources.length === 0) {
      this.showNotice(`No ${kind} resources are discovered in the current snapshot.`, "note");
      return;
    }
    const items: ExtensionToggleItem[] = resources.map(resourceToToggleItem);
    const showTrust = kind === "plugin" || kind === "hook";
    const showReload = kind === "plugin";
    let modal: ExtensionToggleModal | undefined;
    modal = new ExtensionToggleModal({
      title: `${commandName} (${items.length})`,
      subtitle: kind === "skill"
        ? "Turn skills on or off. Changes apply to the owning plugin and are saved automatically."
        : kind === "hook"
          ? "Toggle hooks and review their trust. Changes apply to the owning plugin."
          : "Enable, disable, trust or untrust plugins. Changes are saved automatically.",
      items,
      showTrust,
      showReload,
      onToggle: (item) => {
        void this.toggleExtensionItem(kind, item, modal);
      },
      onTrust: (item) => {
        void this.trustExtensionItem(kind, item, modal);
      },
      onReload: () => {
        void this.reloadExtensions(kind, commandName, modal);
      },
      onCancel: () => this.closeOverlay(),
    });
    this.showOverlayModal(modal, { anchor: "bottom-left" });
  }

  private async toggleExtensionItem(kind: "plugin" | "skill" | "hook", item: ExtensionToggleItem, modal: ExtensionToggleModal | undefined): Promise<void> {
    if (item.pluginId === undefined) {
      this.showNotice(`${kind} ${item.name} has no owning plugin and cannot be toggled.`, "error");
      return;
    }
    const ok = await this.runSessionMutation(item.enabled ? "plugin.disable" : "plugin.enable", { pluginId: item.pluginId }, `/${kind} toggle`);
    if (!ok || modal === undefined) return;
    const fresh = await this.queryExtensionResources(kind, `/${kind}`);
    if (fresh !== undefined) {
      modal.update(fresh.map(resourceToToggleItem));
      this.ui.requestRender();
    }
  }

  private async trustExtensionItem(kind: "plugin" | "skill" | "hook", item: ExtensionToggleItem, modal: ExtensionToggleModal | undefined): Promise<void> {
    if (item.pluginId === undefined) {
      this.showNotice(`${kind} ${item.name} has no owning plugin and cannot be re-trusted.`, "error");
      return;
    }
    const ok = await this.runSessionMutation(item.trusted ? "plugin.untrust" : "plugin.trust", { pluginId: item.pluginId }, `/${kind} trust`);
    if (!ok || modal === undefined) return;
    const fresh = await this.queryExtensionResources(kind, `/${kind}`);
    if (fresh !== undefined) modal.update(fresh.map(resourceToToggleItem));
  }

  private async reloadExtensions(kind: "plugin" | "skill" | "hook", commandName: string, modal: ExtensionToggleModal | undefined): Promise<void> {
    const ok = await this.runSessionMutation("extension.reload", {}, commandName);
    if (!ok || modal === undefined) return;
    const fresh = await this.queryExtensionResources(kind, commandName);
    if (fresh !== undefined) modal.update(fresh.map(resourceToToggleItem));
  }

  /** Session domain mutation 公共 runner;失败投影 typed notice,返回成功与否。 */
  private async runSessionMutation(operation: string, body: Record<string, unknown>, commandName: string): Promise<boolean> {
    if (this.inFlight()) {
      this.showNotice(`${commandName} is available when the current turn is idle.`, "note");
      return false;
    }
    this.effectSequence += 1;
    this.correlationSequence += 1;
    const context = { correlationId: `corr-${this.correlationSequence}`, effectId: `effect-${this.effectSequence}` };
    const result = await commandSessionController(this.controller, operation, body, { ...context, expectedRevision: 0 }).catch((error: unknown) => {
      this.showNotice(`${commandName} failed: ${String(error)}`, "error");
      return undefined;
    });
    if (result === undefined) return false;
    if (!result.ok) {
      this.showNotice(`${commandName} failed: ${result.code}`, "error");
      return false;
    }
    return true;
  }

  /** 经 extension.inspect workflow 查询快照并按 kind 过滤(只读)。 */
  private async queryExtensionResources(kind: "plugin" | "skill" | "hook", commandName: string): Promise<ExtensionResourceView[] | undefined> {
    if (this.store.getState().capabilities.extensions.state !== "available") {
      this.showNotice("Session domain query is unavailable in this session.", "error");
      return undefined;
    }
    const effect = this.createEffect("extension.inspect");
    this.store.dispatch({ type: "query.start", effect });
    this.runner.dispatch(effect);
    const workflow = await this.waitForWorkflow("extensionWorkflow", effect.correlationId);
    if (workflow.state === "ready") {
      const value = workflow.value as { readonly resources?: readonly ExtensionResourceView[] };
      return (value.resources ?? []).filter((resource) => resource.kind === kind);
    }
    if (workflow.state === "empty") {
      return [];
    }
    if (workflow.state === "error") {
      this.showNotice(`${commandName} query failed: ${workflow.message}`, "error");
      return undefined;
    }
    this.showNotice(`${commandName} query is unavailable: ${workflow.state === "unavailable" ? workflow.reason : "unknown outcome"}`, "error");
    return undefined;
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

  /** 执行已协商的 Session domain 命令并把 typed 结果投影成 notice。 */
  async runDomainCommand(
    operation: string,
    body: Record<string, unknown>,
    commandName: string,
    readOnly: boolean,
  ): Promise<void> {
    if (this.inFlight()) {
      this.showNotice(`${commandName} is available when the current turn is idle.`, "note");
      return;
    }
    this.effectSequence += 1;
    this.correlationSequence += 1;
    const context = { correlationId: `corr-${this.correlationSequence}`, effectId: `effect-${this.effectSequence}` };
    const expectedRevision = typeof body.expectedRevision === "number" && Number.isSafeInteger(body.expectedRevision) ? body.expectedRevision : 0;
    const result = await (readOnly
      ? querySessionController(this.controller, operation, body, context)
      : commandSessionController(this.controller, operation, body, { ...context, expectedRevision })).catch((error: unknown) => {
      this.showNotice(`${commandName} failed: ${String(error)}`, "error");
      return undefined;
    });
    if (result === undefined) return;
    if (!result.ok) {
      this.showNotice(`${commandName} failed: ${result.code}`, "error");
      return;
    }
    const text = compactDomainResult(operation, result.value);
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

  /** /model 二级弹窗的模型快照(workflow ready 值的投影)。 */
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
      const value = workflow.value as {
        readonly models?: readonly { readonly providerId: string; readonly modelId: string; readonly label: { readonly text: string } }[];
        readonly currentProviderId?: string;
        readonly currentModelId?: string;
      };
      const models: ModelPickerModel[] = (value.models ?? []).map((model) => ({
        providerId: model.providerId,
        modelId: model.modelId,
        label: model.label.text,
      }));
      if (models.length === 0) {
        this.showNotice(provider
          ? `No available models for ${provider}. Configure authentication first.`
          : "No available models. Use /provider or /login first.", "error");
        return;
      }
      this.modelPickSource = {
        models,
        currentProviderId: value.currentProviderId,
        currentModelId: value.currentModelId,
      };
      if (provider !== undefined) this.openModelListModal(provider, { back: false });
      else this.openModelQuickPickModal();
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

  /**
   * 一级弹窗(对照 codex open_model_popup_with_presets):配置了模型的 provider
   * 作为快速选择项,末尾固定 "All models" 进入全量列表。
   */
  private openModelQuickPickModal(): void {
    const source = this.modelPickSource;
    if (!source) return;
    const counts = new Map<string, number>();
    for (const model of source.models) {
      counts.set(model.providerId, (counts.get(model.providerId) ?? 0) + 1);
    }
    const providers = [...counts.keys()];
    const items: ListSelectionItem[] = providers.map((providerId) => ({
      value: providerId,
      name: providerId,
      description: `${counts.get(providerId) ?? 0} available models`,
      isCurrent: source.currentProviderId === providerId,
    }));
    const currentLabel = this.currentModelLabel(source);
    items.push({
      value: "all",
      name: "All models",
      description: currentLabel === undefined
        ? "Choose a specific model and provider"
        : `Choose a specific model and provider (current: ${currentLabel})`,
    });
    const modal = new ListSelectionModal({
      title: "Select Model",
      subtitle: "Pick a quick provider or browse all models.",
      items,
      selectListTheme: this.selectListTheme(),
      onSelect: (item) => {
        this.closeOverlay();
        if (item.value === "all") this.openModelListModal(undefined, { back: true });
        else this.openModelListModal(item.value, { back: true });
      },
      onCancel: () => this.closeOverlay(),
    });
    this.showOverlayModal(modal, { anchor: "bottom-left" });
  }

  /**
   * 二级弹窗(对照 codex open_all_models_popup):全量或单 provider 的模型列表,
   * 行尾 (current) 标记当前选择;Esc 返回一级(back 时),否则关闭。
   */
  private openModelListModal(providerId: string | undefined, opts: { readonly back: boolean }): void {
    const source = this.modelPickSource;
    if (!source) return;
    const models = providerId === undefined
      ? source.models
      : source.models.filter((model) => model.providerId === providerId);
    if (models.length === 0) {
      this.showNotice(`No available models for ${providerId}. Configure authentication first.`, "error");
      return;
    }
    const currentLabel = this.currentModelLabel(source);
    const items: ListSelectionItem[] = models.map((model) => ({
      value: `${model.providerId}/${model.modelId}`,
      name: model.label,
      description: providerId === undefined ? `[${model.providerId}]` : model.modelId,
      isCurrent: source.currentProviderId === model.providerId && source.currentModelId === model.modelId,
    }));
    const suffix = currentLabel === undefined ? "" : ` (current: ${currentLabel})`;
    const modal = new ListSelectionModal({
      title: providerId === undefined ? "Select Model and Provider" : `Select Model — ${providerId}`,
      subtitle: providerId === undefined
        ? `Choose a specific model and provider${suffix}`
        : `Choose a specific model${suffix}`,
      items,
      selectListTheme: this.selectListTheme(),
      onSelect: (item) => {
        this.closeOverlay();
        void this.selectModelByKey(item.value);
      },
      onCancel: () => {
        this.closeOverlay();
        if (opts.back) this.openModelQuickPickModal();
      },
    });
    this.showOverlayModal(modal, { anchor: "bottom-left" });
  }

  /** 当前模型在列表中的 label；不在列表时回退 modelId；都没有返回 undefined。 */
  private currentModelLabel(source: { readonly models: readonly ModelPickerModel[]; readonly currentProviderId?: string; readonly currentModelId?: string }): string | undefined {
    if (source.currentProviderId === undefined || source.currentModelId === undefined) return undefined;
    const match = source.models.find((model) =>
      model.providerId === source.currentProviderId && model.modelId === source.currentModelId,
    );
    return match?.label ?? source.currentModelId;
  }

  private selectListTheme(): SelectListTheme {
    return makeSelectListTheme(this.theme);
  }

  /** B5:model.select effect；controller/Host 返回 authoritative selection 后 Footer 自动反映。 */
  private async selectModelByKey(key: string): Promise<void> {
    const slash = key.indexOf("/");
    if (slash <= 0) return;
    const providerId = key.slice(0, slash);
    const modelId = key.slice(slash + 1);
    if (providerId.length === 0 || modelId.length === 0) return;
    const effect = this.createEffect("model.select", { providerId, modelId });
    this.store.dispatch({ type: "query.start", effect });
    this.runner.dispatch(effect);
	    const workflow = await this.waitForWorkflow("modelWorkflow", effect.correlationId);
	    if (workflow.state === "ready") {
      await this.syncThinkingWorkflow();
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
  getRunTiming(): { readonly state: "working" | "waiting" | "recovery_required"; readonly activeDurationMs: number; readonly lastResumedAtMs?: number } | undefined {
	if (this.store.getState().recoveryRequired) {
		const active = this.store.getState().timeline.activeRun;
		return { state: "recovery_required", activeDurationMs: active?.activeDurationMs ?? 0 };
	}
    const active = this.store.getState().timeline.activeRun;
    if (active === undefined) return undefined;
    return {
      state: active.state,
      activeDurationMs: active.activeDurationMs,
      ...(active.lastResumedAtMs === undefined ? {} : { lastResumedAtMs: active.lastResumedAtMs }),
    };
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


  getWorkspaceDisplayAbsolutePath(): string | undefined {
    return this.workspaceDisplayAbsolutePath;
  }

  getGitBranchLabel(): string | undefined {
    return this.gitBranchLabel;
  }

  /** FooterSnapshotProvider：优先 authoritative task snapshot，缺失时读取最新 safe plan presentation。 */
  getPlanProgress(): { readonly completed: number; readonly total: number } | undefined {
    const state = this.store.getState();
    const workflow = state.taskGoalWorkflow;
    if (workflow.state === "ready") {
      const tasks = workflow.value.tasks.filter((task) => task.status !== "deleted");
      if (tasks.length > 0) {
        return {
          completed: tasks.filter((task) => task.status === "completed").length,
          total: tasks.length,
        };
      }
    }
    const rows = [
      ...state.timeline.committedRows,
      ...state.timeline.activeOrder.flatMap((id) => {
        const row = state.timeline.activeRowsByCorrelationId[id];
        return row === undefined ? [] : [row];
      }),
    ];
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index];
      if (row?.kind !== "tool" || row.presentation.state !== "known") continue;
      const presentation = row.presentation.value;
      if (presentation.renderer !== "plan" || presentation.plan === undefined) continue;
      const steps = presentation.plan.steps;
      if (steps.length === 0) return undefined;
      return {
        completed: steps.filter((step) => step.status === "completed").length,
        total: steps.length,
      };
    }
    return undefined;
  }

  /** FooterSnapshotProvider：优先 runtime snapshot，缺失字段回退到已投影 usage 与当前 model。 */
  getContextUsage(): { readonly totalTokens?: number; readonly contextWindow?: number } | undefined {
    const state = this.store.getState();
    const workflow = state.runtimeSnapshotWorkflow;
    const snapshot = workflow.state === "ready"
      ? workflow.value
      : workflow.state === "loading" || workflow.state === "error"
        ? workflow.previous
        : undefined;
    let totalTokens = snapshot?.context.state === "known" && snapshot.context.value.totalTokens.state === "known"
      ? snapshot.context.value.totalTokens.value
      : undefined;
    let contextWindow = snapshot?.context.state === "known" && snapshot.context.value.contextWindow.state === "known"
      ? snapshot.context.value.contextWindow.value
      : undefined;
    if (totalTokens === undefined) {
      const rows = [
        ...state.timeline.committedRows,
        ...state.timeline.activeOrder.flatMap((id) => {
          const row = state.timeline.activeRowsByCorrelationId[id];
          return row === undefined ? [] : [row];
        }),
      ];
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        const row = rows[index];
        if (row?.kind !== "assistant" || row.usage === undefined) continue;
        const input = timelineUsageValue(row.usage.input);
        const output = timelineUsageValue(row.usage.output);
        if (input !== undefined && output !== undefined) {
          totalTokens = input + output;
          break;
        }
      }
    }
    if (contextWindow === undefined) {
      const model = this.controller?.currentSelection.model ?? this.agent?.state.model;
      if (typeof model === "object" && model !== null && Number.isFinite(model.contextWindow) && model.contextWindow > 0) {
        contextWindow = model.contextWindow;
      }
    }
    if (totalTokens === undefined && contextWindow === undefined) return undefined;
    return {
      ...(totalTokens === undefined ? {} : { totalTokens }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
    };
  }

  /** 当前 Session 的可读标题；未命名时不把 durable session id 暴露到 status line。 */
  getThreadLabel(): string | undefined {
    const title = this.store.getState().bootstrap.session.title;
    return title === undefined || title.trim().length === 0 ? undefined : title;
  }

  /** Editor.onSubmit 回调;空闲时作为 user prompt 投递,运行中自动排队为 follow-up 不打断当前 turn。 */
  private handleSubmit(text: string): void {
    if (text.length === 0) return;
    this.clearIdleRecapStatus();
    if (text.startsWith("/")) {
      const [rawCommand, ...argParts] = text.slice(1).trim().split(/\s+/);
      const name = rawCommand ?? "";
      const arg = argParts.join(" ");
      this.hideSlashPopup();
      // 注册表唯一事实源:未知命令 → 原 default 分支行为(报错提示)
      const command = findCommand(name);
      if (command === undefined) {
        this.showNotice(`Unknown command: /${name}`, "error");
        return;
      }
      this.dispatchCommand(command, arg);
      return;
    }

	if (this.hostConnectionState !== "ready") {
		this.showNotice(this.hostConnectionState === "reconnecting" ? "host_reconnecting" : `host_${this.hostConnectionState}`, "error");
		return;
	}
    this.streaming = true;
    this.stopReason = undefined;
    this.ui.requestRender();
    const prompt = this.controller
      ? this.controller.prompt(text, this.inFlight() ? "followUp" : undefined)
      : this.inFlight()
        ? Promise.resolve(this.agent!.followUp(text))
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
	if (this.hostConnectionState !== "ready") {
		this.showNotice(this.hostConnectionState === "reconnecting" ? "host_reconnecting" : `host_${this.hostConnectionState}`, "error");
		return;
	}
    if (!this.inFlight()) {
      this.handleSubmit(text);
      return;
    }
    const prompt = this.controller
      ? this.controller.prompt(text, "followUp")
      : Promise.resolve(this.agent!.followUp(text));
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

  /**
   * P4:注册表派发 —— handleSubmit 与 openSlashCommands 的共同出口。
   * 域逻辑(openXxxSelector / runDomainCommand / workflow)不动,只换入口形态;
   * 任务运行中禁用的命令(availableDuringTask=false)在此统一拦截。
   */
  private dispatchCommand(command: RegisteredSlashCommand, arg: string): void {
    this.hideSlashPopup();
    if (!command.availableDuringTask && this.inFlight()) {
      this.showNotice(command.unavailableDuringTaskMessage ?? `/${command.canonicalName} is available when the current turn is idle.`, "note");
      return;
    }
    switch (command.actionType) {
      case "session.create":
        void this.createNewSession();
        return;
      case "session.resume":
        void this.resumeSession(arg || undefined);
        return;
      case "session.fork":
        void this.forkCurrentSession();
        return;
      case "session.rename":
        void this.renameCurrentSession(arg);
        return;
      case "config.provider":
        void this.openProviderSelector();
        return;
      case "auth.login":
        void this.openLoginSelector(arg || undefined);
        return;
      case "auth.logout":
        void this.handleLogout(arg || undefined);
        return;
      case "config.model":
        this.openModelSelector();
        return;
      case "config.thinking":
        this.openThinkingSelector();
        return;
      case "config.theme":
        this.openSyntaxThemePicker();
        return;
      case "recovery.open":
        void this.runRecoveryWorkflow(arg);
        return;
      case "process.list":
        this.openProcessList();
        return;
      case "process.terminal":
        if (arg.length === 0) {
          this.showNotice("Use /terminal <executionId> to open a managed terminal.");
          return;
        }
        this.openProcessTerminal(arg);
        return;
      case "extension.mcp":
        void this.openMcpServerSelector();
        return;
      case "extension.plugins":
        void this.openExtensionSelector("plugin.list", "plugins", "/plugins");
        return;
      case "extension.skills":
        void this.openExtensionSelector("skill.list", "skills", "/skills");
        return;
      case "extension.skills.providers":
        void this.openSkillProvidersModal();
        return;
      case "extension.hooks":
        void this.openExtensionSelector("hook.list", "hooks", "/hooks");
        return;
      case "plan.inspect":
        void this.openPlanWorkflow();
        return;
      case "compaction.list":
        void this.runDomainCommand("compaction.list", {}, "/compact", true);
        return;
      case "memory.inspect":
        void this.runDomainCommand("memory.inspect", {}, "/memory", true);
        return;
      case "memory.propose":
        if (arg.length === 0) {
          this.showNotice("/remember <text> 需要提供要记住的内容。", "error");
          return;
        }
        void this.runDomainCommand("memory.propose", { scope: "workspace", title: arg.slice(0, 256), content: arg, sourceKind: "user" }, "/remember", false);
        return;
      case "prompt.select":
        this.openPromptSelector();
        return;
      case "ui.help":
        this.openSlashCommands();
        return;
      case "ui.clear":
        this.pendingMessageBuffers.clear();
        this.streamingDeltas.drain();
        this.timelineProjector.resetRows();
        this.refs.chat.clear();
        this.ui.requestRender();
        return;
      case "ui.scrollbar.toggle":
        void this.toggleTranscriptScrollbar();
        return;
      case "ui.quit":
        void this.requestQuit();
        return;
    }
  }

  private async toggleTranscriptScrollbar(): Promise<void> {
    const visible = !this.store.getState().interaction.transcriptScrollbarVisible;
    this.store.dispatch({ type: "interaction.transcript-scrollbar-set", visible });
    this.ui.requestRender();
    if (this.preferencesPort === undefined) return;
    const result = await this.preferencesPort.save({
      version: 1,
      transcript: { scrollbar: visible ? "visible" : "hidden" },
    });
    if (!result.ok) {
      this.showNotice("Scrollbar changed for this run but could not be saved.", "error");
    }
  }

  openSyntaxThemePicker(): void {
    this.hideSlashPopup();
    this.syntaxThemeController.cancelPreview();
    const opening = this.syntaxThemeController.snapshot();
    const modal = new ListSelectionModal({
      title: "Select Syntax Theme",
      subtitle: "Preview with arrows; Enter saves, Esc restores.",
      items: this.syntaxThemeController.themeEntries().map((entry) => ({
		value: entry.name,
		name: entry.name,
		description: entry.available ? entry.kind : "load error",
		isCurrent: entry.name === opening.activeName,
		disabled: !entry.available,
	  })),
      initialSelectedValue: opening.activeName,
      onSelectionChange: (item) => {
        this.syntaxThemeController.preview(item.value);
        this.ui.requestRender();
      },
      selectListTheme: this.selectListTheme(),
      onSelect: (item) => { void this.persistSyntaxTheme(item.value); },
      onCancel: () => {
        this.syntaxThemeController.cancelPreview();
        this.closeOverlay();
        this.ui.requestRender();
      },
    });
    this.showOverlayModal(modal, { anchor: "bottom-left" });
  }

  private async persistSyntaxTheme(name: string): Promise<void> {
    if (this.syntaxThemeController.snapshot().previewName !== name) {
      const preview = this.syntaxThemeController.preview(name);
      if (!preview.ok) return;
    }
    const saved = this.syntaxThemeSettingsPort === undefined
      ? { ok: false as const, code: "theme_settings_unavailable" }
      : await this.syntaxThemeSettingsPort.save(name);
    if (!saved.ok) {
      this.syntaxThemeController.cancelPreview();
      this.closeOverlay();
      this.showNotice("Syntax theme could not be saved; the previous theme was restored.", "error");
      return;
    }
    this.syntaxThemeController.commitPreview();
    this.closeOverlay();
    this.ui.requestRender();
  }

  // ─── P3:slash 输入期补全弹窗(对照 codex sync_command_popup / slash_input) ───

  /** 编辑器文本变化后同步弹窗状态:是否在编辑首行命令名、过滤串、dismiss 记忆。 */
  private syncSlashPopup(): void {
    const editing = this.editingSlashCommandName();
    if (editing === undefined) {
      this.hideSlashPopup();
      return;
    }
    // Esc 关闭后同一 token 不再弹,token 变化才恢复
    if (this.dismissedCommandToken !== undefined && editing.token === this.dismissedCommandToken) return;
    this.dismissedCommandToken = undefined;
    const popup = this.slashPopup ?? this.createSlashPopup();
    popup.setFilter(editing.filter);
    this.ui.requestRender();
  }

  /** 解析首行 `/name` 片段:光标在命令名编辑态返回 { token, filter },否则 undefined。 */
  private editingSlashCommandName(): { readonly token: string; readonly filter: string } | undefined {
    const text = this.refs.editor.getText();
    const cursor = this.refs.editor.getCursor();
    const firstLine = text.split("\n")[0] ?? "";
    if (!firstLine.startsWith("/")) return undefined;
    if (cursor.line !== 0) return undefined;
    const nameEnd = firstLine.indexOf(" ", 1) === -1 ? firstLine.length : firstLine.indexOf(" ", 1);
    if (cursor.col > nameEnd) return undefined;
    const fragment = firstLine.slice(1, Math.min(nameEnd, cursor.col === 0 ? nameEnd : cursor.col));
    return { token: firstLine.slice(1, nameEnd), filter: `/${fragment}` };
  }

  /** 当前首行 `/token`(Esc dismiss 记忆用)。 */
  private currentSlashToken(): string | undefined {
    const firstLine = (this.refs.editor.getText().split("\n")[0] ?? "");
    if (!firstLine.startsWith("/")) return undefined;
    const nameEnd = firstLine.indexOf(" ", 1) === -1 ? firstLine.length : firstLine.indexOf(" ", 1);
    return firstLine.slice(1, nameEnd);
  }

  private createSlashPopup(): SlashCommandPopup {
    const popup = new SlashCommandPopup({
      commands: commandsForContext({}),
      theme: this.makeSelectListTheme(),
    });
    this.slashPopup = popup;
    this.slashOverlayHandle = this.ui.showOverlay(popup, { anchor: "bottom-left", nonCapturing: true });
    this.ui.requestRender();
    return popup;
  }

  private hideSlashPopup(): void {
    this.slashOverlayHandle = undefined;
    if (this.ui.getOverlay() !== this.slashPopup) {
      // overlay 槽已被真实 modal 抢占,只清引用
      this.slashPopup = undefined;
      return;
    }
    this.slashPopup = undefined;
    this.ui.hideOverlay();
    this.ui.requestRender();
  }

  /** 弹窗激活期按键拦截(挂在 CustomEditor.handleInput 最前);返回 true 表示已消费。 */
  private handleSlashPopupKey(data: string): boolean {
    const popup = this.slashPopup;
    if (popup === undefined) return false;
    if (matchesKey(data, "up") || matchesKey(data, "ctrl+p")) {
      popup.moveUp();
      this.ui.requestRender();
      return true;
    }
    if (matchesKey(data, "down") || matchesKey(data, "ctrl+n")) {
      popup.moveDown();
      this.ui.requestRender();
      return true;
    }
    if (matchesKey(data, "tab") || matchesKey(data, "/")) {
      this.completeSelectedSlashCommand(popup.selectedItem(), popup.selectedName());
      this.ui.requestRender();
      return true;
    }
    if (matchesKey(data, "enter")) {
      const selected = popup.selectedItem();
      if (selected === undefined) return false; // 无选中回退默认提交路径
      this.acceptSelectedSlashCommand(selected, popup.selectedName());
      this.ui.requestRender();
      return true;
    }
    if (matchesKey(data, "escape")) {
      this.dismissedCommandToken = this.currentSlashToken();
      this.hideSlashPopup();
      this.ui.requestRender();
      return true;
    }
    return false;
  }

  /**
   * Tab/`/` 补全:内联参数命令保留草稿尾(/re + "view the diff" → /review view the diff),
   * 其余命令整串替换为 `/cmd `(对照 codex selected_command_completion)。
   */
  private completeSelectedSlashCommand(command: RegisteredSlashCommand | undefined, selectedName?: string): void {
    if (command === undefined) return;
    const completionName = selectedName ?? command.canonicalName;
    const editor = this.refs.editor;
    const text = editor.getText();
    const firstLineEnd = text.indexOf("\n") === -1 ? text.length : text.indexOf("\n");
    const whitespace = text.indexOf(" ", 1);
    const tokenEnd = whitespace === -1 ? firstLineEnd : Math.min(whitespace, firstLineEnd);
    const tail = text.slice(tokenEnd);
    if (command.supportsInlineArgs && tail.trim().length > 0) {
      const tailStartsWithSpace = /^\s/u.test(tail);
      editor.setText(tailStartsWithSpace
        ? `/${completionName}${tail}`
        : `/${completionName} ${tail}`);
      return;
    }
    editor.setText(`/${completionName} `);
  }

  /**
   * Enter 接受高亮命令:内联参数命令先补全再带参派发,其余直接派发;
   * 派发统一走 dispatchCommand(对照 codex InputResult::Command / CommandWithArgs)。
   */
  private acceptSelectedSlashCommand(command: RegisteredSlashCommand, selectedName?: string): void {
    const editor = this.refs.editor;
    if (command.supportsInlineArgs) {
      const text = editor.getText();
      const firstLineEnd = text.indexOf("\n") === -1 ? text.length : text.indexOf("\n");
      const whitespace = text.indexOf(" ", 1);
      const tokenEnd = whitespace === -1 ? firstLineEnd : Math.min(whitespace, firstLineEnd);
      const arg = text.slice(tokenEnd).trim();
      this.hideSlashPopup();
      editor.addToHistory(`/${selectedName ?? command.canonicalName}${arg.length > 0 ? ` ${arg}` : ""}`);
      editor.setText("");
      this.dispatchCommand(command, arg);
      return;
    }
    this.hideSlashPopup();
    editor.setText("");
    this.dispatchCommand(command, "");
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

  /** S2:/resume 从 SQLite authority 拉取 catalog，不读取旧 JSONL selector。 */
  async openSessionCatalog(): Promise<void> {
    const catalog = await this.loadSessionCatalog();
    if (catalog === undefined) return;
    if (catalog.items.length === 0) {
      this.showNotice("No canonical sessions are available.", "error");
      return;
    }
    const current = catalog.items.find((item) => item.current);
    const modal = new SessionPickerModal({
      title: "/resume",
      items: buildSessionPickerItems(catalog.items, Date.now()),
      currentWorkspaceId: current?.workspaceId,
      onSelect: (item) => {
        this.closeOverlay();
        const selected = catalog.items.find((candidate) => candidate.sessionId === item.value);
        if (selected === undefined) return;
        if (selected.current) {
          this.showNotice(`${selected.sessionId} is already current.`);
          return;
        }
        void this.resumeSession(selected.sessionId, catalog.revision);
      },
      onCancel: () => this.closeOverlay(),
    });
    this.showOverlayModal(modal, { anchor: "bottom-left" }, "session");
  }

  /** S2:/new 使用刚读取的 catalog revision 做 CAS，成功后只返回 switch intent。 */
  async createNewSession(): Promise<void> {
    if (this.rejectSessionTransition()) return;
    const catalog = await this.loadSessionCatalog();
    if (catalog === undefined) return;
    const transition = await this.runSessionTransition("session.create", { expectedRevision: catalog.revision });
    if (transition !== undefined) await this.requestExit({ kind: "switch", action: "new", target: { sessionId: transition.targetSessionId } });
  }

  /** S2:/resume [sessionId]；无参数时复用 canonical catalog selector。 */
  async resumeSession(targetSessionId?: string, knownRevision?: number): Promise<void> {
    if (this.rejectSessionTransition()) return;
    if (targetSessionId === undefined) {
      await this.openSessionCatalog();
      return;
    }
    let revision = knownRevision;
    if (revision === undefined) {
      const catalog = await this.loadSessionCatalog();
      if (catalog === undefined) return;
      const target = catalog.items.find((item) => item.sessionId === targetSessionId);
      if (target === undefined) {
        this.showNotice(`Session not found: ${targetSessionId}`, "error");
        return;
      }
      revision = catalog.revision;
    }
    const transition = await this.runSessionTransition("session.resume", { targetSessionId, expectedRevision: revision });
    if (transition !== undefined) await this.requestExit({ kind: "switch", action: "resume", target: { sessionId: transition.targetSessionId } });
  }

  /** S2:/fork 从 catalog 的 current row 读取 durable head，并同时 fence catalog/head。 */
  async forkCurrentSession(): Promise<void> {
    if (this.rejectSessionTransition()) return;
    const catalog = await this.loadSessionCatalog();
    if (catalog === undefined) return;
    const current = catalog.items.find((item) => item.current && item.sessionId === this.getSessionId());
    if (current === undefined) {
      this.showNotice("Current Session is missing from the canonical catalog.", "error");
      return;
    }
    const transition = await this.runSessionTransition("session.fork", {
      sourceSessionId: current.sessionId,
      expectedSourceHeadSequence: current.headSequence,
      expectedRevision: catalog.revision,
    });
    if (transition !== undefined) await this.requestExit({ kind: "switch", action: "fork", target: { sessionId: transition.targetSessionId } });
  }

	/** `/rename <title>` uses the typed Session Domain effect workflow and catalog CAS. */
	async renameCurrentSession(title: string): Promise<void> {
		const normalizedTitle = normalizeSessionTitle(title);
		if (normalizedTitle === null || /[\u0000-\u001F\u007F-\u009F]/u.test(title) || /\u001B(?:\[[0-?]*[ -\/]*[@-~]|\][^\u0007]*(?:\u0007|$))/u.test(title)) {
			this.showNotice("Usage: /rename <title>", "error");
			return;
		}
		if (this.rejectSessionTransition()) return;
		const catalog = await this.loadSessionCatalog();
		if (catalog === undefined) return;
		const current = catalog.items.find((item) => item.sessionId === this.getSessionId());
		if (current === undefined) {
			this.showNotice("Current Session is missing from the canonical catalog.", "error");
			return;
		}
		const port = this.ports.session;
		if (port === undefined) {
			this.showNotice("Session title mutation is unavailable on this connection.", "error");
			return;
		}
		const effect = this.createEffect("session.rename", {
			title: normalizedTitle,
			expectedRevision: catalog.revision,
			expectedTitle: current.title ?? null,
		});
		this.store.dispatch({ type: "query.start", effect });
		this.runner.dispatch(effect);
		const workflow = await this.waitForWorkflow("sessionWorkflow", effect.correlationId);
		if (workflow.state !== "ready" || !isSessionTitleResult(workflow.value)) {
			if (workflow.state === "error") this.showNotice(`/rename failed: ${workflow.message ?? "unknown outcome"}`, "error");
			else this.showNotice("/rename did not complete.", "error");
			return;
		}
		const result = workflow.value;
		this.store.dispatch({
			type: "session.title.changed",
			generation: this.store.getState().authorityGeneration,
			sessionId: result.sessionId,
			title: result.title,
		});
		// The mutation result is authoritative for the immediate header; requery
		// the catalog so picker/workflow state is refreshed from the same domain.
		await this.loadSessionCatalog();
		this.showNotice(`Session renamed: ${result.title}`);
		this.ui.requestRender();
	}

  private rejectSessionTransition(): boolean {
    if (this.inFlight()) {
      this.showNotice("Session transitions are available when the current turn is idle.", "note");
      return true;
    }
    if (this.store.getState().capabilities.sessionMutation.state !== "available") {
      this.showNotice("Session mutation is unavailable on this connection.", "error");
      return true;
    }
    return false;
  }

  private async loadSessionCatalog(): Promise<SessionCatalogResult | undefined> {
    if (this.store.getState().capabilities.sessionCatalog.state !== "available") {
      this.showNotice("Session catalog is unavailable on this connection.", "error");
      return undefined;
    }
    const effect = this.createEffect("session.list");
    this.store.dispatch({ type: "query.start", effect });
    this.runner.dispatch(effect);
    const workflow = await this.waitForWorkflow("sessionWorkflow", effect.correlationId);
    if (workflow.state === "ready") {
      const value = workflow.value as SessionCatalogResult;
      if (value.kind === "catalog") return value;
    }
    if (workflow.state === "error") this.showNotice(`Session catalog failed: ${workflow.message ?? "unknown"}`, "error");
    else this.showNotice("Session catalog is empty or unavailable.", "error");
    return undefined;
  }

  private async runSessionTransition(
    type: "session.create" | "session.resume" | "session.fork",
    payload: Record<string, unknown>,
  ): Promise<SessionTransitionResult | undefined> {
    const effect = this.createEffect(type, payload);
    this.store.dispatch({ type: "query.start", effect });
    this.runner.dispatch(effect);
    const workflow = await this.waitForWorkflow("sessionWorkflow", effect.correlationId);
    if (workflow.state === "ready") {
      const value = workflow.value as SessionTransitionResult;
      if (value.kind === "transition") return value;
    }
    if (workflow.state === "error") this.showNotice(`Session transition failed: ${workflow.message ?? "unknown"}`, "error");
    else this.showNotice("Session transition did not complete.", "error");
    return undefined;
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

	private replayInitialHistory(syntaxThemeWarnings: readonly string[] = []): void {
		if (this.workspaceCapability?.endsWith("-unverified") === true) this.dispatchTimeline([{
			type: "notice",
			generation: 0,
			correlationId: `workspace-capability-${this.store.getState().timeline.committedRows.length}`,
			severity: "warning",
			message: { text: this.workspaceCapability, truncated: false, byteLength: new TextEncoder().encode(this.workspaceCapability).byteLength },
		}]);
		if (this.controller !== undefined) for (const warning of this.controller.warnings) this.dispatchTimeline([{
			type: "notice",
			generation: 0,
			correlationId: `warning-${this.store.getState().timeline.committedRows.length}`,
			severity: "warning",
			message: { text: warning, truncated: false, byteLength: new TextEncoder().encode(warning).byteLength },
		}]);
		for (const warning of syntaxThemeWarnings) this.dispatchTimeline([{
			type: "notice",
			generation: 0,
			correlationId: `syntax-theme-warning-${this.store.getState().timeline.committedRows.length}`,
			severity: "warning",
			message: { text: warning, truncated: false, byteLength: new TextEncoder().encode(warning).byteLength },
		}]);
		if (!this.controller) return;
		for (let index = 0; index < this.controller.messages.length; index += 1) {
      const message = this.controller.messages[index];
      if (message === undefined) continue;
      this.dispatchTimeline(this.timelineProjector.project({ kind: "replay-message", message, index }));
    }
    // 对齐 projector 计数，保证后续 live 行 id 不与 replay 冲突
    this.timelineProjector.setMessageIndex(this.controller.messages.length);
    for (const run of this.controller.agentRuns ?? []) {
      this.dispatchTimeline([{
        type: "run_restore",
        generation: 0,
        runId: run.runId,
        timestamp: run.startedAtMs,
        status: run.status,
        ...(run.stopReason === undefined ? {} : { stopReason: run.stopReason }),
        ...(run.elapsedMs === undefined ? {} : { elapsedMs: run.elapsedMs }),
        ...(run.activeDurationMs === undefined ? {} : { activeDurationMs: run.activeDurationMs }),
        ...(run.messageCountAtEnd === undefined ? {} : { messageCountAtEnd: run.messageCountAtEnd }),
      }]);
    }
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

  /** 首帧前同步当前 controller 的 authoritative thinking selection。 */
  private async syncThinkingWorkflow(): Promise<void> {
    if (this.store.getState().capabilities.thinking.state !== "available") return;
    const effect = this.createEffect("thinking.inspect");
    this.store.dispatch({ type: "query.start", effect });
    this.runner.dispatch(effect);
    await this.waitForWorkflow("thinkingWorkflow", effect.correlationId);
  }

	  /** B4:等待指定 workflow 离开 loading（结果落地或失败），返回其终态。 */
  private waitForWorkflow(key: "sessionWorkflow" | "extensionWorkflow" | "providerWorkflow" | "modelWorkflow" | "thinkingWorkflow" | "authWorkflow" | "promptWorkflow" | "keymapWorkflow" | "runtimeSnapshotWorkflow" | "processWorkflow" | "taskGoalWorkflow" | "planWorkflow" | "agentWorkflow" | "securityModeWorkflow" | "workspaceGitWorkflow" | "updateWorkflow" | "queueWorkflow" | "approvalWorkflow" | "shutdownWorkflow", requestId: string): Promise<{
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

  /** Durable title events update the immediate strip and requery catalog state. */
  private handleSessionTitleChanged(event: SessionTitleChangedEvent): void {
		if (this.quitting || event.sessionId !== this.getSessionId()) return;
		this.store.dispatch({
			type: "session.title.changed",
			generation: this.store.getState().authorityGeneration,
			sessionId: event.sessionId,
			title: event.title,
		});
		this.ui.requestRender();
		const workflow = this.store.getState().sessionWorkflow;
		if (workflow.state === "loading") return;
		if (workflow.state === "ready" && isSessionCatalogResult(workflow.value)) {
			const current = workflow.value.items.find((item) => item.sessionId === event.sessionId);
			if (current?.title === event.title && (event.sequence === undefined || current.headSequence >= event.sequence)) return;
		}
    void this.loadSessionCatalog();
  }

  /** Clears the local-only recap slot and advances its client-side stale fence. */
  private clearIdleRecapStatus(): void {
    this.idleRecapRequestId = undefined;
    this.idleRecapActivityGeneration += 1;
    this.refs.status.setIdleRecap(undefined);
  }

  /**
   * 主控 switch：message_* 统一投影到 canonical Timeline 并流式更新；
   * user 消息块在 handleSubmit 阶段已 push,事件流不再处理 user 分支;
   * 其余 case 留 noop 占位,M3 起逐 case 落实(对照 03-event-binding §1 表)。
   */
  private handleEvent(ev: TuiEvent): void {
    try {
      switch (ev.type) {
        case "agent_start":
          this.flushStreamingDeltas();
          this.clearIdleRecapStatus();
          this.streamingGeneration += 1;
          this.streaming = true;
          this.stopReason = undefined;
          this.dispatchTimeline([{
            type: "run_start",
            generation: 0,
            runId: ev.runId ?? `legacy-live-${ev.timestamp}`,
            timestamp: ev.timestamp,
            activeDurationMs: 0,
          }]);
          this.scheduleStatusIndicatorFrame();
          break;
        case "agent_end":
          {
          const activeRunId = this.store.getState().timeline.activeRun?.runId;
          if (activeRunId === undefined || (ev.runId !== undefined && ev.runId !== activeRunId)) break;
          this.flushStreamingDeltas();
          this.streaming = false;
          this.stopReason = ev.stopReason ?? this.stopReason ?? "stop";
          this.refs.status.setStopReason(this.stopReason);
          if (isRunStopReason(this.stopReason)) {
            this.dispatchTimeline([{
              type: "run_end",
              generation: 0,
              runId: ev.runId ?? activeRunId,
              timestamp: ev.timestamp,
              stopReason: this.stopReason,
              ...(ev.elapsedMs === undefined ? {} : { elapsedMs: ev.elapsedMs }),
              ...(ev.activeDurationMs === undefined ? {} : { activeDurationMs: ev.activeDurationMs }),
              ...(ev.messageCountAtEnd === undefined ? {} : { messageCountAtEnd: ev.messageCountAtEnd }),
            }]);
          }
          break;
          }
        case "agent_work_pause":
          this.dispatchTimeline([{ type: "run_pause", generation: 0, runId: ev.runId, waitId: ev.waitId, reason: ev.reason, timestamp: ev.timestamp, activeDurationMs: ev.activeDurationMs }]);
          this.scheduleStatusIndicatorFrame();
          break;
        case "agent_work_resume":
          this.dispatchTimeline([{ type: "run_resume", generation: 0, runId: ev.runId, waitId: ev.waitId, timestamp: ev.timestamp, activeDurationMs: ev.activeDurationMs }]);
          this.scheduleStatusIndicatorFrame();
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
            const finalEvents: TimelineEvent[] = [{
              type: "message_update",
              generation: 0,
              correlationId,
              text: { text, truncated: false, byteLength: new TextEncoder().encode(text).byteLength },
              ...(thinking.length > 0 ? { thinking: { text: thinking, truncated: false, byteLength: new TextEncoder().encode(thinking).byteLength } } : {}),
            }];
            if (ev.message.usage !== undefined) {
              const usage = projectToolUsage(ev.message.usage.input, ev.message.usage.output);
              finalEvents.push({
                type: "usage",
                generation: 0,
                correlationId,
                usage: { input: usage.input, output: usage.output },
              });
            }
            this.dispatchTimeline(finalEvents);
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

  private scheduleStatusIndicatorFrame(): void {
    if (this.quitting) return;
    this.ui.scheduleFrameIn(STATUS_INDICATOR_FRAME_MS);
  }

  private refreshStatusIndicator(): void {
    const nowMs = Date.now();
    const activeRun = this.store.getState().timeline.activeRun;
    this.ui.setStatusIndicator(projectStatusIndicator(activeRun, {
      nowMs,
      animationFrame: Math.floor(nowMs / STATUS_INDICATOR_FRAME_MS),
      interruptKey: this.statusInterruptKey(),
    }));
    if (activeRun?.state === "working" || activeRun?.state === "waiting") {
      this.scheduleStatusIndicatorFrame();
    }
  }

  private statusInterruptKey(): string | undefined {
    const configured = this.kb.getResolvedBindings()["tui.input.interrupt"];
    const key = Array.isArray(configured) ? configured[0] : configured;
    if (key === undefined) return undefined;
    const control = /^ctrl\+([a-z])$/iu.exec(key);
    return control === null ? key : `^${control[1]!.toUpperCase()}`;
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

function isRunStopReason(value: string | undefined): value is "stop" | "length" | "toolUse" | "error" | "aborted" {
  return value === "stop" || value === "length" || value === "toolUse" || value === "error" || value === "aborted";
}

function timelineUsageValue(quantity: SafeUsageQuantity): number | undefined {
  return quantity.state === "exact" || quantity.state === "estimated" ? quantity.value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSessionTitleResult(value: unknown): value is SessionTitleResult {
	return isRecord(value)
		&& typeof value.sessionId === "string" && value.sessionId.length > 0
		&& typeof value.title === "string" && value.title.length > 0
		&& (value.titleSource === "auto" || value.titleSource === "user")
		&& typeof value.titleUpdatedAtMs === "number"
		&& Number.isSafeInteger(value.titleUpdatedAtMs)
		&& value.titleUpdatedAtMs >= 0
		&& typeof value.catalogRevision === "number"
		&& Number.isSafeInteger(value.catalogRevision)
		&& value.catalogRevision >= 0;
}

function isSessionCatalogResult(value: unknown): value is SessionCatalogResult {
	return isRecord(value)
		&& value.kind === "catalog"
		&& typeof value.revision === "number"
		&& Number.isSafeInteger(value.revision)
		&& Array.isArray(value.items);
}

function isRecordArray(value: unknown): value is readonly Record<string, unknown>[] {
  return Array.isArray(value) && value.every((item) => isRecord(item));
}

/** mcp.list raw snapshot -> McpServersModal 视图项(bounded,缺失字段落缺省)。 */
function mcpServerViewFromDomain(value: Record<string, unknown>): McpServerViewItem | undefined {
  const serverId = typeof value.serverId === "string" ? value.serverId : "";
  const displayName = typeof value.displayName === "string" ? value.displayName : serverId;
  if (displayName.length === 0) return undefined;
  const tools = isRecordArray(value.tools) ? value.tools.map((tool) => ({
    rawName: typeof tool.rawName === "string" ? tool.rawName : typeof tool.name === "string" ? tool.name : "unknown",
    ...(typeof tool.description === "string" && tool.description.length > 0 ? { description: tool.description.slice(0, 200) } : {}),
    isReadOnly: tool.isReadOnly === true,
    isDestructive: tool.isDestructive !== false,
  })) : [];
  const diagnostics = isRecordArray(value.diagnostics) ? value.diagnostics.map((item) => ({
    code: typeof item.code === "string" ? item.code : "mcp.diagnostic",
    message: typeof item.message === "string" ? item.message : "",
    severity: typeof item.severity === "string" ? item.severity : "error",
  })).filter((item) => item.message.length > 0) : [];
  return {
    serverId: serverId || `mcp-server:${displayName}`,
    displayName,
    transport: typeof value.transport === "string" ? value.transport : "unknown",
    required: value.required === true,
    state: typeof value.state === "string" ? value.state : "stopped",
    generation: typeof value.generation === "number" ? value.generation : 0,
    tools,
    diagnostics,
  };
}

/** ExtensionResourceView(typed adapter 投影)-> ExtensionToggleModal 项。 */
function resourceToToggleItem(resource: ExtensionResourceView): ExtensionToggleItem {
  return {
    resourceId: resource.resourceId,
    name: resource.label.text,
    ...(resource.description === undefined ? {} : { description: resource.description.text }),
    ...(resource.pluginId === undefined ? {} : { pluginId: resource.pluginId.text }),
    enabled: resource.enabled,
    trusted: resource.trusted,
    ready: resource.ready,
    trustLabel: resource.trust,
  };
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
