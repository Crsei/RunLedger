import { TrajectoryPanel } from "./trajectory/panel.ts";
import { agentModeIdentityPresentation, agentModeToolsSummary } from "../runtime/harness-profiles/agent-mode.ts";
/**
 * InteractiveMode —— TUI 主控 facade。
 *
 * S7 拆分后实现位于 `interactive/`:
 * - `session-workflow.ts`      new/resume/fork/rename/catalog;
 * - `model-workflow.ts`        provider/model/thinking 选择;
 * - `auth-workflow.ts`         provider/login/logout 与 credential 交互;
 * - `extension-workflow.ts`    MCP/plugins/skills/hooks 管理;
 * - `plan-workflow.ts`         plan.inspect 与 domain command adapter;
 * - `process-workflow.ts`      managed process list/terminal;
 * - `approval-workflow.ts`     approval/credential reverse-request;
 * - `streaming-controller.ts`  delta 队列/usage/flush;
 * - `event-controller.ts`      TuiEvent → state/effect/timeline;
 * - `input-controller.ts`      submit/follow-up/slash 弹窗/主题选择;
 * - `types.ts`                 InteractiveModePorts 契约。
 *
 * 本文件保留:生命周期/装配/命令注册表派发/公开查询与 FooterSnapshotProvider,
 * 不再拥有 provider/auth/session/extension 的具体业务实现。
 */

import {
  Container,
  ProcessTerminal,
  Spacer,
  TUI,
  type Terminal,
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
  type EditorTheme,
  type SelectListTheme,
} from "./primitives.ts";

import type { Agent } from "../runtime/agent.ts";
import type { ModelThinkingLevel } from "../types.ts";
import type { InteractiveSessionControllerPort, SessionRecoveryStatus } from "../runtime/interactive-session-controller.ts";

import { type FooterSnapshotProvider, type TuiEvent } from "./types.ts";
import type { Theme } from "./theme/theme.ts";
import type { UiThemeSettings } from "../contracts/ui-theme.ts";
import { resolveUiTheme, type UiThemeSnapshot } from "./theme/ui-theme.ts";
import { makeEditorTheme, makeSelectListTheme } from "./theme/factories.ts";
import { editorBackgroundFromTerminal } from "./theme/editor-background.ts";
import { CustomEditor, type CustomEditorProps } from "./components/custom-editor.ts";
import { Footer } from "./components/footer.ts";
import {
  createDefaultFooterFieldRegistry,
  type FooterFieldDefinition,
  type FooterFieldRegistrationResult,
  type FooterFieldRegistry,
  type FooterSnapshot,
} from "./footer/field-registry.ts";
import { LoadedResourcesComponent } from "./components/loaded-resources.ts";
import { ChatContainer } from "./components/chat-container.ts";
import { SelectionView } from "./components/selection-view.ts";
import { PermissionRequestView } from "./components/permission-request-view.ts";
import { StatusComponent } from "./components/status.ts";
import { WelcomeComponent } from "./components/welcome.ts";
import { FOOTER_INDENT } from "./footer/layout.ts";
import { SessionProfileHeaderComponent } from "./components/session-profile-header.ts";
import { TranscriptOverlayComponent, projectTranscriptOverlay } from "./transcript-view.ts";
import type { TuiPerformanceObserver } from "./opentui/performance-observer.ts";
import type { UsageSnapshot } from "../runtime/usage/index.ts";
import { projectInteractivePresentation } from "./presentation/projectors.ts";
import { commandsForContext, isCommandAvailable, unavailableCommandMessage, type RegisteredSlashCommand } from "./commands/registry.ts";
import { SlashCommandPopup } from "./components/slash-command-popup.ts";
import type { Component, InputListenerResult, OverlayOptions } from "./primitives.ts";
import { matchesKey } from "./primitives.ts";
import type { RgbColor } from "./primitives.ts";
import type { TuiOverlayState } from "./application/state.ts";
import type { TuiState } from "./application/state.ts";
import { createInitialTuiState } from "./application/initial-state.ts";
import type { TimelineEvent } from "./timeline/types.ts";
import type { TuiStore } from "./application/store.ts";
import { createTuiStore } from "./application/store.ts";
import type { TuiDomainPorts } from "./application/ports.ts";
import { capabilitiesFromPorts } from "./application/ports.ts";
import { createInteractiveSessionAdapter, type InteractiveSessionAdapter } from "./adapters/interactive-session.ts";
import { createSessionResourcePortsFromController } from "./adapters/session-resources.ts";
import { createSessionDomainPortFromController, sessionAuthorityGeneration } from "./adapters/session-domain.ts";
import type { EffectRunner } from "./application/effect-runner.ts";
import { createEffectRunner } from "./application/effect-runner.ts";
import type { TuiEffect } from "./application/effect.ts";
import type { CorrelatedRequestRef } from "./application/common.ts";
import type {
  TuiPreferencesDocument,
  TuiPreferencesPort,
  TuiShimmerMode,
} from "./preferences/types.ts";
import { BUILTIN_SYNTAX_THEME_NAMES, SyntaxThemeController } from "./highlight/theme-controller.ts";
import { createProcessPassiveBridge } from "./process/passive-bridge.ts";
import { ProcessOverlayComponent } from "./process/overlay-component.ts";
import type { ProcessOverlayController, ProcessOverlayHostClient } from "./process/controller-adapter.ts";
import type { HostFrameEnvelope } from "../runtime/host/types.ts";
import type { SessionFrameEnvelope } from "../runtime/session-server/protocol.ts";
import type { TuiBootstrapSnapshot } from "./presentation/types.ts";
import { messageText } from "./interactive/input-helpers.ts";
import type { InteractiveModePorts, WorkflowKey, WorkflowResult } from "./interactive/types.ts";
import { SessionWorkflow } from "./interactive/session-workflow.ts";
import { ModelWorkflow } from "./interactive/model-workflow.ts";
import { AuthWorkflow } from "./interactive/auth-workflow.ts";
import { ExtensionWorkflow } from "./interactive/extension-workflow.ts";
import { PlanWorkflow } from "./interactive/plan-workflow.ts";
import { ProcessWorkflow } from "./interactive/process-workflow.ts";
import { ApprovalWorkflow } from "./interactive/approval-workflow.ts";
import { PermissionsWorkflow } from "./permissions/workflow.ts";
import { StreamingController } from "./interactive/streaming-controller.ts";
import { EventController } from "./interactive/event-controller.ts";
import { InputController } from "./interactive/input-controller.ts";

export interface SyntaxThemeSettingsPort {
  save(name: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: string }>;
}

export interface HideThinkingSettingsPort {
	save(hidden: boolean): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: string }>;
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
  uiTheme?: UiThemeSettings;
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
  /** `hideThinkingBlock` 的 canonical settings 写端口；TUI 不持有 layout/path。 */
  hideThinkingSettingsPort?: HideThinkingSettingsPort;
  /** thinking blocks 的启动展示状态；仅影响 projection。 */
  hideThinkingBlock?: boolean;
  /** 当前 Session 的 durable Harness ref；只读展示，不提供 mutation。 */
  harnessProfile?: { readonly id: "standard" | "minimal" | "plan"; readonly version: 1 | 2 };
  harnessToolNames?: readonly string[];
  /** 当前 Session Security 的 effective profile；与 Harness/Thinking 分栏。 */
  permissionProfile?: string;
  /** 仅全新启动视图展示 welcome；resume/continue/fork 传 false。 */
  showWelcome?: boolean;
  /** welcome 顶边框版本号。 */
  version?: string;
  /** welcome Logo 字母；由 canonical settings 的 `logo` 传入。 */
  logoLetters?: string;
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
  welcome: WelcomeComponent | undefined;
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
  private readonly uiThemeSettings: UiThemeSettings;
  private uiThemeSnapshot: UiThemeSnapshot;
  private uiThemeGeneration = 0;
  private readonly kb: KeybindingsManager;
  // S7:协作者经 port.refs 访问;assembleTree 只填充成员,不替换对象
  private readonly refs: ContainerRefs = {} as ContainerRefs;
  private unsubscribe?: () => void;
  private unsubscribeWarnings?: () => void;
  private unsubscribeSessionTitle?: () => void;
  private unsubscribeIdleRecap?: () => void;
  private idleRecapRequestId: string | undefined;
  private idleRecapActivityGeneration = 0;
  private unsubscribeThemeMode?: () => void;
  private unsubscribeTerminalBackground?: () => void;
  private unsubscribeRenderPreparation?: () => void;
  private unsubscribeBoundaryActions?: () => void;
  private readonly footerRegistry: FooterFieldRegistry;
  private unsubscribeFooterRegistry?: () => void;

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
  private hostConnectionState: HostConnectionUiState = "ready";
  private readonly exitPromise: Promise<InteractiveExitIntent>;
  private readonly resolveExit: (intent: InteractiveExitIntent) => void;
  private processOverlayComponent: ProcessOverlayComponent | undefined;
  private readonly initialBootstrap?: TuiBootstrapSnapshot;
  private readonly preferencesPort?: TuiPreferencesPort;
  private readonly shimmerMode: TuiShimmerMode;
  private readonly hideThinkingSettingsPort?: HideThinkingSettingsPort;
	private hideThinkingBlock: boolean;
	private readonly showWelcome: boolean;
	private readonly version: string;
  private readonly logoLetters?: string;
	private readonly harnessProfile?: InteractiveModeOptions["harnessProfile"];
	private readonly harnessToolNames?: readonly string[];
	private permissionProfile?: string;
	private unsubscribePermissionProfile?: () => void;
	private readonly syntaxThemeController: SyntaxThemeController;
  private readonly syntaxThemeSettingsPort?: SyntaxThemeSettingsPort;
  private lastTranscriptScrollbarVisible: boolean | undefined;
  private transcriptOverlay: TranscriptOverlayComponent | undefined;
  private trajectoryPanel: TrajectoryPanel | undefined;
  private unsubscribeTranscriptInput: (() => void) | undefined;

  // S7 协作者
  private readonly sessionWorkflow: SessionWorkflow;
  private readonly modelWorkflow: ModelWorkflow;
  private readonly authWorkflow: AuthWorkflow;
  private readonly extensionWorkflow: ExtensionWorkflow;
  private readonly planWorkflow: PlanWorkflow;
  private readonly processWorkflow: ProcessWorkflow;
  private readonly approvalWorkflow: ApprovalWorkflow;
  private readonly permissionsWorkflow: PermissionsWorkflow;
  private readonly streaming: StreamingController;
  private readonly eventController: EventController;
  private readonly inputController: InputController;
  private readonly port: InteractiveModePorts;

  constructor(opts: InteractiveModeOptions) {
    if (!opts.controller && !opts.agent) {
      throw new Error("InteractiveMode requires controller or agent");
    }
    this.controller = opts.controller;
    this.agent = opts.agent;
    const initialMessages = this.controller?.messages ?? this.agent?.state.messages ?? [];
    this.processOverlayController = opts.processOverlayController;
    this.performanceObserver = opts.performanceObserver;
    this.terminal = opts.terminal ?? new ProcessTerminal();
    this.uiThemeSettings = opts.uiTheme ?? {};
    this.uiThemeSnapshot = resolveUiTheme(this.uiThemeSettings, opts.themeName ?? "dark");
    this.theme = { ...this.uiThemeSnapshot.colors };
    this.workspaceCapability = opts.workspaceCapability;
    this.workspaceDisplayAbsolutePath = opts.workspaceDisplayAbsolutePath;
    this.gitBranchLabel = opts.gitBranchLabel;
    this.initialBootstrap = opts.initialBootstrap;
    this.preferencesPort = opts.preferencesPort;
    this.shimmerMode = opts.initialPreferences?.display.shimmer ?? "classic";
    this.hideThinkingSettingsPort = opts.hideThinkingSettingsPort;
    this.hideThinkingBlock = opts.hideThinkingBlock ?? false;
    this.showWelcome = opts.showWelcome ?? false;
    this.version = opts.version ?? "unknown";
    this.logoLetters = opts.logoLetters;
	this.harnessProfile = opts.harnessProfile;
	this.harnessToolNames = opts.harnessToolNames;
	this.permissionProfile = opts.permissionProfile;
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
    this.footerRegistry = createDefaultFooterFieldRegistry();
    this.unsubscribeFooterRegistry = this.footerRegistry.subscribe(() => this.ui.requestRender(true));

    // S7:装配协作者(port 由本实例实现)
    const port: InteractiveModePorts = this.createPort();
    this.getUsageSnapshot = this.getUsageSnapshot.bind(this);
    this.port = port;
    this.streaming = new StreamingController(port, initialMessages, opts.performanceObserver);
    this.eventController = new EventController(port, this.streaming);
    this.inputController = new InputController(port);
    this.sessionWorkflow = new SessionWorkflow(port);
    this.modelWorkflow = new ModelWorkflow(port);
    this.authWorkflow = new AuthWorkflow(port);
    this.extensionWorkflow = new ExtensionWorkflow(port);
    this.planWorkflow = new PlanWorkflow(port);
    this.processWorkflow = new ProcessWorkflow(port);
    this.approvalWorkflow = new ApprovalWorkflow(port);
    this.permissionsWorkflow = new PermissionsWorkflow({
      onApplied: (profile) => { this.permissionProfile = profile; this.ui.requestRender(); },
      controller: this.controller,
      theme: this.theme,
      showOverlay: (component) => this.showOverlayModal(component, { anchor: "bottom-left" }),
      getOverlay: () => this.ui.getOverlay(),
      closeOverlay: () => this.closeOverlay(),
      showNotice: (message, kind) => this.showNotice(message, kind),
      requestRender: () => this.ui.requestRender(),
      nextRequest: () => {
        this.correlationSequence += 1;
        this.effectSequence += 1;
        return {
          correlationId: `corr-${this.correlationSequence}`,
          effectId: `effect-${this.effectSequence}`,
        };
      },
    });

    this.refreshTranscriptScrollPresentation();
    this.unsubscribeRenderPreparation = this.ui.addBeforeRenderListener(() => {
      this.streaming.flushStreamingDeltas();
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
        if (this.approvalWorkflow.hasActivePermissionView()) {
          this.approvalWorkflow.activePermissionView?.handleInput("escape");
          return true;
        }
        if (this.ui.hasCapturingOverlay()) return false;
        this.handleInterrupt();
        return true;
      },
      onExit: () => this.ui.hasOverlay() || this.approvalWorkflow.hasActivePermissionView() ? false : this.handleCtrlD(),
      onRefresh: () => this.ui.invalidate(),
    });

    // KeybindingsManager:本期安装默认 TUI_KEYBINDINGS,后续 M6 在此挂 user bindings
    this.kb = new KeybindingsManager(TUI_KEYBINDINGS);
    setKeybindings(this.kb);

    // 装配组件树(只填充 this.refs 成员,协作者持有的 port.refs 是同一对象)
    this.assembleTree();
    // B3:store 订阅驱动 chat presentation（timeline generation 变化才重投影）
    this.unsubscribeStore = this.store.subscribe((next) => {
      if (next.timeline.generation !== this.lastTimelineGeneration) {
        this.lastTimelineGeneration = next.timeline.generation;
        const presentation = projectInteractivePresentation(next, { hideThinking: this.hideThinkingBlock });
        this.refs.chat.setTimelineBlocks(presentation.timeline, next.timeline.generation);
      }
      if (this.transcriptOverlay !== undefined && this.ui.getOverlay() === this.transcriptOverlay) {
        this.transcriptOverlay.update(projectTranscriptOverlay(next.timeline, this.syntaxThemeController.snapshot().revision + this.uiThemeGeneration, { hideThinking: this.hideThinkingBlock }));
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
    this.ui.setUiTheme(this.uiThemeSnapshot);
    this.replayInitialHistory([...(opts.syntaxThemeWarnings ?? []), ...this.uiThemeSnapshot.diagnostics.map(field => `Invalid UI theme field: ${field}`)]);
    void this.sessionWorkflow.refreshWelcomeSessions();

    void MAX_CONSECUTIVE_INIT_FAILURES;
    void INIT_FAILURE_BACKOFF_MS;
  }

  private createPort(): InteractiveModePorts {
    const instance = this;
    return {
      ui: this.ui,
      store: this.store,
      runner: this.runner,
      // controller/agent 可能在装配后由测试/上层替换 → 实时 getter
      get controller(): InteractiveSessionControllerPort | undefined { return instance.controller; },
      get agent(): Agent | undefined { return instance.agent; },
      authAdapter: this.authAdapter,
      theme: this.theme,
      refs: this.refs,
      get quitting(): boolean { return instance.quitting; },
      hideThinkingSettingsPort: this.hideThinkingSettingsPort,
      preferencesPort: this.preferencesPort,
      shimmerMode: this.shimmerMode,
      syntaxThemeController: this.syntaxThemeController,
      syntaxThemeSettingsPort: this.syntaxThemeSettingsPort,
      get processOverlayComponent(): ProcessOverlayComponent | undefined { return instance.processOverlayComponent; },
      get hostConnectionState(): HostConnectionUiState { return instance.hostConnectionState; },
      sessionPort: this.ports.session,
      showNotice: (text, kind) => this.showNotice(text, kind),
      showOverlayModal: (component, options, kind) => this.showOverlayModal(component, options, kind),
      openPermissions: (onCancel) => { void this.permissionsWorkflow.open(onCancel); },
      closeOverlay: () => this.closeOverlay(),
      createEffect: (type, extra) => this.createEffect(type, extra),
      waitForWorkflow: (key, requestId) => this.waitForWorkflow(key, requestId),
      dispatchTimeline: (events) => this.eventController.dispatchTimeline(events),
      requestExit: (intent) => this.requestExit(intent),
      inFlight: () => this.inFlight(),
      getSessionId: () => this.getSessionId(),
      getHarnessToolNames: () => this.getHarnessToolNames(),
      hideSlashPopup: () => this.inputController.hideSlashPopup(),
      uiRequestRender: () => this.ui.requestRender(),
      syncThinkingWorkflow: () => this.syncThinkingWorkflow(),
      openModelSelector: (provider) => this.modelWorkflow.openModelSelector(provider),
      nextCorrelationId: () => { this.correlationSequence += 1; return this.correlationSequence; },
      nextEffectId: () => { this.effectSequence += 1; return this.effectSequence; },
      processOverlaySnapshot: () => this.processOverlayController?.snapshot().open,
      interruptCurrentTurn: () => this.interruptCurrentTurn(),
      clearIdleRecapStatus: () => this.clearIdleRecapStatus(),
      keyBindings: () => this.kb.getResolvedBindings(),
      refreshSessionCatalog: async () => { await this.sessionWorkflow.loadSessionCatalog(); },
      setStreaming: (value) => { this.streaming.setStreaming(value); },
      setStopReason: (value) => { this.streaming.setStopReason(value); },
      dispatchCommand: (command, arg) => this.dispatchCommand(command as RegisteredSlashCommand, arg),
    };
  }

	  /** 测试/路由查询暴露:Agent 事件适配后的主控入口(委托 EventController)。 */
  public handleEvent(ev: TuiEvent): void {
    this.eventController.handleEvent(ev);
  }

  /** 测试/路由查询暴露:timeline 事件投影(委托 EventController)。 */
  public dispatchTimeline(events: readonly TimelineEvent[]): void {
    this.eventController.dispatchTimeline(events);
  }

  /** 测试/路由查询暴露:plan/compact/memory domain 命令(委托 PlanWorkflow)。 */
  public runDomainCommand(operation: string, body: Record<string, unknown>, commandName: string, readOnly: boolean): Promise<void> {
    return this.planWorkflow.runDomainCommand(operation, body, commandName, readOnly);
  }

  /** 测试/路由查询暴露:模型选择(委托 ModelWorkflow)。 */
  public selectModelByKey(key: string): Promise<void> {
    return this.modelWorkflow.selectModelByKey(key);
  }

  /** 测试/路由查询暴露:模型选择器(委托 ModelWorkflow)。 */
  public openModelSelector(provider?: string): void {
    this.modelWorkflow.openModelSelector(provider);
  }

  /** 测试/路由查询暴露:session catalog(委托 SessionWorkflow)。 */
  public openSessionCatalog(): Promise<void> {
    return this.sessionWorkflow.openSessionCatalog();
  }

  /** 测试/路由查询暴露:/new(委托 SessionWorkflow)。 */
  public switchAgentMode(mode?: string): Promise<void> {
    return this.sessionWorkflow.switchAgentMode(mode);
  }

  public createNewSession(profile?: string): Promise<void> {
	return this.sessionWorkflow.createNewSession(profile);
  }

  /** 测试/路由查询暴露:/fork(委托 SessionWorkflow)。 */
  public forkCurrentSession(): Promise<void> {
    return this.sessionWorkflow.forkCurrentSession();
  }

  /** 测试/路由查询暴露:/rename(委托 SessionWorkflow)。 */
  public renameCurrentSession(title: string): Promise<void> {
    return this.sessionWorkflow.renameCurrentSession(title);
  }

  /** 测试/路由查询暴露:thinking 选择器(委托 ModelWorkflow)。 */
  public openThinkingSelector(): void {
    this.modelWorkflow.openThinkingSelector();
  }

  /** 测试/路由查询暴露:MCP 管理视图(委托 ExtensionWorkflow)。 */
  public openMcpServerSelector(): Promise<void> {
    return this.extensionWorkflow.openMcpServerSelector();
  }

  /** 测试/路由查询暴露:plugins/skills/hooks 视图(委托 ExtensionWorkflow)。 */
  public openExtensionSelector(operation: "plugin.list" | "skill.list" | "hook.list", kindLabel: string, commandName: string): Promise<void> {
    return this.extensionWorkflow.openExtensionSelector(operation, kindLabel, commandName);
  }

  /** 测试/路由查询暴露:credential reverse-request(委托 ApprovalWorkflow)。 */
  public handleCredentialReverseRequest(frame: SessionFrameEnvelope, signal: AbortSignal): Promise<Record<string, unknown>> {
    return this.approvalWorkflow.handleCredentialReverseRequest(frame, signal);
  }

  /** 活跃 permission view 读取(approval 测试)。 */
  get activePermissionView(): PermissionRequestView | undefined {
    return this.approvalWorkflow.activePermissionView;
  }

  /** slash 弹窗实例读取(弹窗状态机测试)。 */
  get slashPopup(): SlashCommandPopup | undefined {
    return this.inputController.slashPopup;
  }

  /** Esc dismiss 记忆读取(slash 弹窗测试)。 */
  get dismissedCommandToken(): string | undefined {
    return this.inputController.dismissedCommandToken;
  }

  /** /theme 选择器(委托 InputController)。 */
  public openSyntaxThemePicker(): void {
    this.inputController.openSyntaxThemePicker();
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

  /** 装配组件树并填充 this.refs;M2 起把 LoadedResources / Chat 等 container 换成真实组件。 */
  private assembleTree(): void {
    const header = new Container();
	if (this.harnessProfile !== undefined) {
		const permissionProfile = () => this.permissionProfile ?? "unknown";
		header.addChild(new SessionProfileHeaderComponent({
			harnessProfile: this.harnessProfile,
			get permissionProfile() { return permissionProfile(); },
			thinkingLevel: () => this.controller?.currentSelection.thinkingLevel ?? this.getThinkingLevel(),
		}));
	}
    let welcome: WelcomeComponent | undefined;
    if (this.showWelcome) {
		welcome = new WelcomeComponent({
			version: this.version,
			theme: this.theme,
			logoLetters: this.logoLetters,
			modelLabel: this.getModelId(),
			providerLabel: this.getProviderId(),
			thinkingLabel: this.getThinkingLevel(),
			directoryLabel: this.workspaceDisplayAbsolutePath,
			branchLabel: this.gitBranchLabel,
			getAvailableHeight: () => {
				const width = Math.max(1, this.terminal.columns);
				const footerWidth = Math.max(1, width - FOOTER_INDENT.length);
				// 模型 context、recap 等会增加 footer 行数，预算读取本帧真实组件投影。
				const footerHeight = Math.max(1, status.render(footerWidth).length + footer.present(footerWidth).length);
				const headerHeight = header.children.filter((child) => child !== welcome)
					.reduce((height, child) => height + child.render(width).length, 0);
				return this.terminal.rows - editor.desiredHeight(width) - footerHeight - headerHeight - loadedResources.render(width).length;
			},
		});
		header.addChild(new Spacer(1));
		header.addChild(welcome);
		header.addChild(new Spacer(1));
	}
    const loadedResources = new LoadedResourcesComponent({});
    const chat = new ChatContainer();
    const status = new StatusComponent({});
    const editorTheme: EditorTheme = makeEditorTheme(this.theme, this.makeSelectListTheme());
    const editorProps: CustomEditorProps = {
      theme: this.theme,
      selectListTheme: this.makeSelectListTheme(),
      onSubmit: (text) => this.inputController.handleSubmit(text),
      onChange: (text) => {
        this.clearIdleRecapStatus();
        this.controller?.notifyEditorActivity?.(text.trim().length === 0);
        this.inputController.syncSlashPopup();
      },
      onSlashPopupKey: (data) => this.inputController.handleSlashPopupKey(data),
      onFollowUp: (text) => this.inputController.handleFollowUpSubmit(text),
      onDequeue: () => this.inputController.restoreQueuesToEditor(),
    };
    const editor = new CustomEditor(this.ui, editorTheme, editorProps);
    const footer = new Footer({ theme: this.theme, provider: this, registry: this.footerRegistry });

    // 组件树结构(对照 02 §1):
    //   header / loadedResources / chat / editor / status / footer
    // status 放在 editor 后，使 transient recap 进入 footer 分区而不是 transcript body。
    this.ui.addChild(header);
    this.ui.addChild(loadedResources);
    this.ui.addChild(chat);
    this.ui.addChild(editor);
    this.ui.addChild(status);
    this.ui.addChild(footer);

    // Editor 拿焦点
    this.ui.setFocus(editor);

    Object.assign(this.refs, { header, welcome, loadedResources, chat, status, editor, footer });
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
    this.inputController.hideSlashPopup();
    this.transcriptOverlay = undefined;
    if (component !== this.trajectoryPanel) { this.trajectoryPanel?.dispose(); this.trajectoryPanel = undefined; }
    this.store.dispatch({
      type: "overlay.open",
      overlay: { state: kind, requestId: `overlay-${this.store.getState().interaction.generation + 1}` },
    });
    this.ui.showOverlay(component, options);
    this.ui.requestRender();
  }

  /** B3:overlay 关闭意图写入 store。 */
  private closeOverlay(): void {
    this.inputController.hideSlashPopup();
    if (this.ui.getOverlay() === this.transcriptOverlay) this.transcriptOverlay = undefined;
    this.trajectoryPanel?.dispose(); this.trajectoryPanel = undefined;
    this.store.dispatch({ type: "overlay.close" });
    this.ui.hideOverlay();
  }

  private openTrajectory(arg: string): void {
    if (arg === "close") { if (this.trajectoryPanel !== undefined) this.closeOverlay(); return; }
    if (arg !== "" && arg !== "status") { this.showNotice("/trajectory [close|status]", "error"); return; }
    const client = this.controller?.trajectory;
    if (!client) { this.showNotice("Trajectory is unavailable for this session.", "error"); return; }
    if (arg === "status") {
      void client.page({ pageSize: 1 }).then((result) => {
        if (!result.ok) { this.showNotice(result.code, "error"); return; }
        const { status, watermark } = result.value;
        this.showNotice(`Recording ${status.mode} / ${status.health} · ${status.historyCoverage} · ${status.recordedBytes} bytes · session ${watermark.sessionSequence} / trace ${watermark.traceRevision}${status.diagnostics.length ? ` · ${status.diagnostics.join(", ")}` : ""}`);
      });
      return;
    }
    if (this.quitting || this.ui.hasOverlay() || this.approvalWorkflow.hasActivePermissionView()) return;
    const panel = new TrajectoryPanel({ client, sessionId: this.controller!.sessionId,
      preferences: this.preferencesPort, getHeight: () => Math.max(8, this.terminal.rows - 2),
      onChange: () => this.ui.requestRender(), onClose: () => this.closeOverlay(),
    });
    this.trajectoryPanel = panel;
    this.showOverlayModal(panel, { anchor: "center", variant: "trajectory" }, "transcript");
    void panel.open();
  }

  /** Ctrl+T 的只读 transcript overlay；不改变主对话 ScrollBox 的位置或内容。 */
  private openTranscriptOverlay(): void {
    if (this.quitting || this.ui.hasOverlay() || this.approvalWorkflow.hasActivePermissionView()) return;
    const overlay = new TranscriptOverlayComponent(projectTranscriptOverlay(this.store.getState().timeline, this.syntaxThemeController.snapshot().revision + this.uiThemeGeneration, { hideThinking: this.hideThinkingBlock }), {
      getViewportHeight: () => Math.max(4, this.terminal.rows - 2),
      theme: this.theme,
      onClose: () => this.closeOverlay(),
    });
    this.showOverlayModal(overlay, { anchor: "center", variant: "transcript" }, "transcript");
    this.transcriptOverlay = overlay;
  }

  /** transcript overlay 捕获期间所有键都不应落入 composer；未知键保持只读。 */
  private handleTranscriptInput(data: string): InputListenerResult {
    if (this.trajectoryPanel !== undefined && this.ui.getOverlay() === this.trajectoryPanel) {
      this.trajectoryPanel.handleInput(data);
      return { consume: true };
    }
    if (this.transcriptOverlay !== undefined && this.ui.getOverlay() === this.transcriptOverlay) {
      this.transcriptOverlay.handleInput(data);
      return { consume: true };
    }
	if (this.kb.matches(data, "tui.thinking.toggle")) {
		if (this.ui.hasOverlay() || this.approvalWorkflow.hasActivePermissionView()) return undefined;
		this.toggleThinkingVisibility();
		return { consume: true };
	}
    if (!matchesKey(data, "ctrl+t")) return undefined;
    if (this.ui.hasOverlay() || this.approvalWorkflow.hasActivePermissionView()) return undefined;
    this.openTranscriptOverlay();
    return { consume: true };
  }

  /** display-only 切换；Timeline 与 provider 请求保持不变。 */
  private toggleThinkingVisibility(): boolean {
	this.hideThinkingBlock = !this.hideThinkingBlock;
	const state = this.store.getState();
	const presentation = projectInteractivePresentation(state, { hideThinking: this.hideThinkingBlock });
	this.refs.chat.setTimelineBlocks(presentation.timeline, state.timeline.generation);
	if (this.transcriptOverlay !== undefined && this.ui.getOverlay() === this.transcriptOverlay) {
		this.transcriptOverlay.update(projectTranscriptOverlay(
			state.timeline,
			this.syntaxThemeController.snapshot().revision + this.uiThemeGeneration,
			{ hideThinking: this.hideThinkingBlock },
		));
	}
	this.showNotice(this.hideThinkingBlock ? "Thinking blocks hidden (display only)." : "Thinking blocks visible.");
	this.ui.requestRender();
	return this.hideThinkingBlock;
  }

  /** 用 dark 主题色拼一个最小 SelectListTheme 占位;M6 阶段补完整色槽。 */
  private makeSelectListTheme(): SelectListTheme {
    return makeSelectListTheme(this.theme);
  }

  /** 启动 TUI;Promise 在 quit() 完成终端清理后 resolve。 */
  async run(): Promise<InteractiveExitIntent> {
    if (this.quitting) return this.exitPromise;
    this.unsubscribe = this.controller
      ? this.controller.subscribe((ev) => this.eventController.handleAgentEvent(ev))
      : this.agent?.subscribe((ev) => this.eventController.handleAgentEvent(ev));
    this.unsubscribeSessionTitle = this.controller?.subscribeSessionTitleChanged?.((event) => this.eventController.handleSessionTitleChanged(event));
    this.unsubscribePermissionProfile = this.controller?.subscribePermissionProfile?.((profile) => { this.permissionProfile = profile; this.ui.requestRender(); });
    this.unsubscribeWarnings = this.controller?.subscribeWarnings?.((warning) => {
      if (!this.quitting) this.showNotice(warning, "error");
    });
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
    this.unsubscribeTerminalBackground = this.ui.addTerminalBackgroundListener((rgb) => {
      this.ui.setTerminalBackground(rgb);
      this.refreshEditorAppearance(rgb);
    });
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
      this.unsubscribeWarnings?.();
      this.unsubscribeWarnings = undefined;
      this.unsubscribeSessionTitle?.();
      this.unsubscribeSessionTitle = undefined;
      this.unsubscribePermissionProfile?.();
      this.unsubscribePermissionProfile = undefined;
      this.unsubscribeIdleRecap?.();
      this.unsubscribeIdleRecap = undefined;
      this.unsubscribeThemeMode?.();
      this.unsubscribeThemeMode = undefined;
      this.unsubscribeTerminalBackground?.();
      this.unsubscribeTerminalBackground = undefined;
      this.disposeFooterRegistry();
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
      backgroundColor: this.uiThemeSnapshot.editorBackgroundExplicit ? this.theme.editorBackground : editorBackgroundFromTerminal(this.theme, this.uiThemeSnapshot.backgroundExplicit ? undefined : rgb ?? this.ui.getTerminalBackgroundRgb()),
      promptColor: this.theme.accent,
      placeholderColor: this.theme.hint,
    });
  }

  /**
   * Ctrl+C 三态:流式中断当前 turn;空闲有草稿清空输入区;
   * 空闲且输入区为空退出 TUI。
   */
  private handleInterrupt(): void {
    if (this.streaming.isStreaming() || this.inFlight()) {
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
    ].map((message) => messageText(message)).filter((text) => text.length > 0);
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
    const next = resolveUiTheme(this.uiThemeSettings, scheme);
    if (next.revision === this.uiThemeSnapshot.revision) return;
    this.uiThemeSnapshot = next;
    this.uiThemeGeneration += 1;
    Object.assign(this.theme, next.colors);
    this.ui.setUiTheme(next);
    this.transcriptOverlay?.update(projectTranscriptOverlay(this.store.getState().timeline, this.syntaxThemeController.snapshot().revision + this.uiThemeGeneration, { hideThinking: this.hideThinkingBlock }));
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

  /** 可信内部模块的实例级 Footer 字段贡献入口。 */
  registerFooterField(definition: FooterFieldDefinition): FooterFieldRegistrationResult {
    return this.footerRegistry.register(definition);
  }

  private async requestQuit(): Promise<void> {
	return this.requestExit({ kind: "quit" });
  }

  private async requestExit(intent: InteractiveExitIntent): Promise<void> {
    if (this.quitting) return;
    this.quitting = true;
    this.streaming.flushStreamingDeltas();
    // B8:先取消所有 in-flight effects，再执行 lifecycle cleanup（防止 Host 查询在销毁后回写）
    this.runner.cancelAll();
    // P2-2:destroy 清理所有 active timeline rows
    this.eventController.dispatchTimeline(this.streaming.project({ kind: "cleanup", reason: "destroy" }));
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
    this.unsubscribePermissionProfile?.();
    this.unsubscribePermissionProfile = undefined;
    this.unsubscribeWarnings?.();
    this.unsubscribeWarnings = undefined;
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
    this.trajectoryPanel?.dispose(); this.trajectoryPanel = undefined;
    this.unsubscribeTranscriptInput?.();
    this.unsubscribeTranscriptInput = undefined;
    this.transcriptOverlay = undefined;
    this.unsubscribeBoundaryActions?.();
    this.unsubscribeBoundaryActions = undefined;
    this.disposeFooterRegistry();
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
    this.inputController.handleSubmit(text);
  }

  /** Host 逆向 approval 请求：只收集并返回决策；Host receipt 未接入前不更新 approval workflow。 */
  handleReverseRequest(frame: HostFrameEnvelope, signal: AbortSignal): Promise<Record<string, unknown>> {
    return this.approvalWorkflow.handleReverseRequest(frame, signal);
  }

  /** Session reverse-request 的唯一 TUI 分派：approval 与 credential 共用既有 UI authority。 */
  handleSessionReverseRequest(frame: SessionFrameEnvelope, signal: AbortSignal): Promise<Record<string, unknown>> {
    return this.approvalWorkflow.handleSessionReverseRequest(frame, signal);
  }

  /**
   * 打开 slash 命令选择器;清单唯一来源为命令注册表(commandsForContext)。
   * 选中项携带注册表 descriptor,经 dispatchCommand 统一派发(与 handleSubmit 同源)。
   */
  public openSlashCommands(): void {
    this.inputController.hideSlashPopup();
    const entries = commandsForContext({ supportsOperation: this.authAdapter.supports });
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
  public openPromptSelector(): void {
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
		if (!this.controller?.inFlight && (required || this.store.getState().recoveryRequired)) {
			// 恢复评估不证明旧工具的执行结果；只结束旧活动展示，保留结果未知。
			this.streaming.flushStreamingDeltas();
			this.eventController.dispatchTimeline(this.streaming.project({ kind: "cleanup", reason: "recovery" }));
		}
		if (required !== this.store.getState().recoveryRequired) this.streaming.resetFromCanonicalMessages();
		this.store.dispatch({ type: "recovery.set", required });
		this.ui.requestRender();
	}

  /**
   * P4:注册表派发 —— handleSubmit 与 openSlashCommands 的共同出口。
   * 域逻辑(openXxxSelector / runDomainCommand / workflow)不动,只换入口形态;
   * 任务运行中禁用的命令(availableDuringTask=false)在此统一拦截。
   */
  private dispatchCommand(command: RegisteredSlashCommand, arg: string): void {
    this.inputController.hideSlashPopup();
    if (!command.availableDuringTask && this.inFlight()) {
      this.showNotice(command.unavailableDuringTaskMessage ?? `/${command.canonicalName} is available when the current turn is idle.`, "note");
      return;
    }
    if (!isCommandAvailable(command, this.authAdapter.supports)) {
      this.showNotice(unavailableCommandMessage(`/${command.canonicalName}`), "error");
      return;
    }
    switch (command.actionType) {
      case "session.mode":
        void this.sessionWorkflow.switchAgentMode(arg);
        return;
      case "session.mode.minimal":
        if (arg.trim() !== "") this.showNotice("Usage: /minimal", "error");
        else void this.sessionWorkflow.switchAgentMode("minimal");
        return;
      case "session.create":
		void this.sessionWorkflow.createNewSession(arg);
        return;
      case "session.resume":
        void this.sessionWorkflow.resumeSession(arg || undefined);
        return;
      case "session.fork":
        void this.sessionWorkflow.forkCurrentSession();
        return;
      case "session.rename":
        void this.sessionWorkflow.renameCurrentSession(arg);
        return;
      case "config.provider":
        void this.authWorkflow.openProviderSelector();
        return;
      case "auth.login":
        void this.authWorkflow.openLoginSelector(arg || undefined);
        return;
      case "auth.logout":
        void this.authWorkflow.handleLogout(arg || undefined);
        return;
      case "config.model":
        this.modelWorkflow.openModelSelector();
        return;
      case "config.thinking":
        this.modelWorkflow.openThinkingSelector();
        return;
      case "config.hide-thinking":
        void this.inputController.persistThinkingVisibility(this.toggleThinkingVisibility());
        return;
      case "config.theme":
        this.inputController.openSyntaxThemePicker();
        return;
      case "config.permissions":
        void this.permissionsWorkflow.open();
        return;
      case "recovery.open":
        void this.runRecoveryWorkflow(arg);
        return;
      case "process.list":
        this.processWorkflow.openProcessList();
        return;
      case "process.terminal":
        if (arg.length === 0) {
          this.showNotice("Use /terminal <executionId> to open a managed terminal.");
          return;
        }
        this.processWorkflow.openProcessTerminal(arg);
        return;
      case "extension.mcp":
        void this.extensionWorkflow.openMcpServerSelector();
        return;
      case "extension.plugins":
        void this.extensionWorkflow.openExtensionSelector("plugin.list", "plugins", "/plugins");
        return;
      case "extension.skills":
        void this.extensionWorkflow.openExtensionSelector("skill.list", "skills", "/skills");
        return;
      case "extension.skills.providers":
        void this.extensionWorkflow.openSkillProvidersModal();
        return;
      case "extension.hooks":
        void this.extensionWorkflow.openExtensionSelector("hook.list", "hooks", "/hooks");
        return;
      case "plan.inspect":
        void this.planWorkflow.openPlanWorkflow();
        return;
      case "compaction.list":
        void this.planWorkflow.runDomainCommand("compaction.list", {}, "/compact", true);
        return;
      case "memory.inspect":
        void this.planWorkflow.runDomainCommand("memory.inspect", {}, "/memory", true);
        return;
      case "memory.propose":
        if (arg.length === 0) {
          this.showNotice("/remember <text> 需要提供要记住的内容。", "error");
          return;
        }
        void this.planWorkflow.runDomainCommand("memory.propose", { scope: "workspace", title: arg.slice(0, 256), content: arg, sourceKind: "user" }, "/remember", false);
        return;
      case "prompt.select":
        this.openPromptSelector();
        return;
      case "ui.trajectory":
        this.openTrajectory(arg);
        return;
      case "ui.help":
        this.openSlashCommands();
        return;
      case "ui.clear":
        this.streaming.clearPendingBuffers();
        this.streaming.drainStreamingDeltas();
        this.streaming.resetRows();
        this.refs.chat.clear();
        this.ui.requestRender();
        return;
      case "ui.scrollbar.toggle":
        void this.inputController.toggleTranscriptScrollbar();
        return;
      case "ui.quit":
        void this.requestQuit();
        return;
    }
  }

  private inFlight(): boolean {
    return this.controller?.inFlight ?? this.agent?.inFlight ?? false;
  }

  private showNotice(text: string, kind: "note" | "error" = "note"): void {
    const severity = kind === "error" ? "error" : "info";
    this.eventController.dispatchTimeline([{
      type: "notice",
      generation: 0,
      correlationId: `notice-${this.store.getState().timeline.committedRows.length}-${this.store.getState().timeline.activeOrder.length}`,
      severity,
      message: { text, truncated: false, byteLength: new TextEncoder().encode(text).byteLength },
    }]);
    this.ui.requestRender();
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
  private waitForWorkflow(key: WorkflowKey, requestId: string): Promise<WorkflowResult> {
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

	private replayInitialHistory(syntaxThemeWarnings: readonly string[] = []): void {
		if (this.workspaceCapability?.endsWith("-unverified") === true) this.eventController.dispatchTimeline([{
			type: "notice",
			generation: 0,
			correlationId: `workspace-capability-${this.store.getState().timeline.committedRows.length}`,
			severity: "warning",
			message: { text: this.workspaceCapability, truncated: false, byteLength: new TextEncoder().encode(this.workspaceCapability).byteLength },
		}]);
		if (this.controller !== undefined) for (const warning of this.controller.warnings) this.eventController.dispatchTimeline([{
			type: "notice",
			generation: 0,
			correlationId: `warning-${this.store.getState().timeline.committedRows.length}`,
			severity: "warning",
			message: { text: warning, truncated: false, byteLength: new TextEncoder().encode(warning).byteLength },
		}]);
		for (const warning of syntaxThemeWarnings) this.eventController.dispatchTimeline([{
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
      this.eventController.dispatchTimeline(this.streaming.project({ kind: "replay-message", message, index }));
    }
    // 对齐 projector 计数，保证后续 live 行 id 不与 replay 冲突
    this.streaming.setMessageIndex(this.controller.messages.length);
    for (const run of this.controller.agentRuns ?? []) {
      this.eventController.dispatchTimeline([{
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
        this.eventController.dispatchTimeline([{
          type: "notice",
          generation: 0,
          correlationId: `audit-${this.store.getState().timeline.committedRows.length}`,
          severity: "info",
          message: { text: `${entry.type} ${name}${content}`, truncated: false, byteLength: new TextEncoder().encode(`${entry.type} ${name}${content}`).byteLength },
        }]);
      }
    }
  }

  private refreshStatusIndicator(): void {
    this.streaming.refreshStatusIndicator();
  }

  /** Clears the local-only recap slot and advances its client-side stale fence. */
  private clearIdleRecapStatus(): void {
    this.idleRecapRequestId = undefined;
    this.idleRecapActivityGeneration += 1;
    this.refs.status.setIdleRecap(undefined);
  }

  // ── FooterSnapshotProvider ──────────────────────────────────────────────

  /** FooterSnapshotProvider：一帧只组装一次不可变参数快照。 */
  getFooterSnapshot(): FooterSnapshot {
    const state = this.store.getState();
    const stopReason = this.getStopReason();
    const runTiming = this.getRunTiming();
    const workspaceDisplayAbsolutePath = this.getWorkspaceDisplayAbsolutePath();
    const gitBranchLabel = this.getGitBranchLabel();
    const planProgress = this.getPlanProgress();
    const contextUsage = this.getContextUsage();
    const threadLabel = this.getThreadLabel();
    const mode = this.harnessProfile === undefined ? undefined : agentModeIdentityPresentation(this.harnessProfile);
    return {
      nowMs: Date.now(),
      isStreaming: this.isStreaming(),
      ...(stopReason === undefined ? {} : { stopReason }),
      ...(runTiming === undefined ? {} : { runTiming }),
      providerId: this.getProviderId(),
      modelId: this.getModelId(),
      thinkingLevel: this.getThinkingLevel(),
      ...(this.harnessProfile === undefined ? {} : { agentMode: mode?.mode ?? "unavailable", toolsSummary: mode === undefined ? "unavailable" : agentModeToolsSummary(mode, this.harnessToolNames), permissionProfile: this.permissionProfile }),
      ...(workspaceDisplayAbsolutePath === undefined ? {} : { workspaceDisplayAbsolutePath }),
      ...(gitBranchLabel === undefined ? {} : { gitBranchLabel }),
      ...(planProgress === undefined ? {} : { planProgress }),
      ...(contextUsage === undefined ? {} : { contextUsage }),
      usage: this.getUsageSnapshot(),
      ...(threadLabel === undefined ? {} : { threadLabel }),
      queue: {
        steering: tuiCount(state.steeringCount),
        followUp: tuiCount(state.followUpCount),
      },
    };
  }

  /** FooterSnapshotProvider:thinking level 从 thinking workflow 读取（ready 时）。 */
  getThinkingLevel(): ModelThinkingLevel {
    return this.modelWorkflow.getThinkingLevel();
  }

  /** FooterSnapshotProvider:由 Footer.render 周期性 pull。 */
  isStreaming(): boolean {
    return this.streaming.isStreaming();
  }
  getStopReason(): string | undefined {
    return this.streaming.getStopReason();
  }
  getRunTiming(): { readonly state: "working" | "waiting" | "recovery_required"; readonly activeDurationMs: number; readonly lastResumedAtMs?: number } | undefined {
    return this.streaming.getRunTiming();
  }
  getModelId(): string {
    const st = this.controller?.currentSelection.model ?? this.agent?.state.model;
    if (!st) return "<no-model>";
    return typeof st === "string" ? st : (st as { id?: string }).id ?? "<unknown-model>";
  }
  getProviderId(): string {
    return this.controller?.currentSelection.provider ?? this.agent?.state.model.provider ?? "<no-provider>";
  }
  getHarnessToolNames(): readonly string[] | undefined {
    return this.harnessToolNames;
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

  /**
   * FooterSnapshotProvider legacy context getter：优先 runtime snapshot；仅为兼容旧 identity 行，
   * 缺失 used token 时才回退到最新 assistant 的 input + output 近似值。
   * Usage 行不消费这个近似 fallback。
   */
  getContextUsage(): { readonly totalTokens?: number; readonly contextWindow?: number } | undefined {
    return this.streaming.getContextUsage();
  }

  /** FooterSnapshotProvider：从 runtime reducer 读取唯一 usage 快照。 */
  getUsageSnapshot(): UsageSnapshot {
    return this.streaming.getUsageSnapshot();
  }

  /** 当前 Session 的可读标题；未命名时不把 durable session id 暴露到 status line。 */
  getThreadLabel(): string | undefined {
    const title = this.store.getState().bootstrap.session.title;
    return title === undefined || title.trim().length === 0 ? undefined : title;
  }

  /** 仅暴露给测试/上层 command router 的状态查询，不暴露 backend。 */
  isProcessOverlayOpen(): boolean {
    return this.processWorkflow.isProcessOverlayOpen();
  }

  private disposeFooterRegistry(): void {
    this.unsubscribeFooterRegistry?.();
    this.unsubscribeFooterRegistry = undefined;
    this.footerRegistry.dispose();
  }
}

function tuiCount(field: TuiState["steeringCount"]): number {
  return field.state === "known" && Number.isSafeInteger(field.value) && field.value >= 0 ? field.value : 0;
}
