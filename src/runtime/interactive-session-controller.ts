import type { ModelContextOverflowRecovery } from "./types.ts";
import type { TrajectoryClientPort } from "./contracts/trajectory.ts";
import type { AuthInteraction, AuthType, Credential } from "../auth/types.ts";
import { clampThinkingLevel, type Models, type Provider } from "../models.ts";
import type { Api, Model, ModelThinkingLevel } from "../types.ts";
import type { ProjectSettings } from "../storage/settings-manager.ts";
import { loadProjectSettings, saveProjectSettings } from "../storage/settings-manager.ts";
import type { RunledgerLayout } from "./contracts/public.ts";
import type { SessionReplay, SessionRuntimeConfig } from "../storage/session-codec.ts";
import { appendRuntimeConfig } from "../storage/session-codec.ts";
import { Agent, type EphemeralTurnDiagnostic, type EphemeralTurnRequest } from "./agent.ts";
import type {
  AgentEventSink,
  AgentMessage,
  AgentTool,
  AgentToolHookContext,
  AgentLoopConfig,
  AfterToolCallResult,
  QueueMode,
  StreamFn,
  ToolAuthorizationPolicy,
  ToolResultOverflowStore,
  UserAgentMessage,
  AgentRunBudget,
  AgentRunBudgetUsage,
} from "./types.ts";
import { DEFAULT_AGENT_RUN_BUDGET } from "./types.ts";
import { defaultConvertToLlm } from "./agent-loop/context-conversion.ts";
import type { ModelContextAssemblyInput } from "./types.ts";
import type { ExtensionHookRuntime, ExtensionHookRuntimeResult } from "../extensions/turn-lifecycle.ts";
import type { ContextAssemblySink, ModelContextAssembler, PromptInspection } from "./types.ts";
import { ModelRequestSnapshots, type RequestDumpView, type RequestDumpResult } from "./model-request-snapshots.ts";
import { runtimeDigest } from "./protocol/foundation.ts";
import type { LedgerSink } from "./ledger/types.ts";
import type { SessionDomainMutationContext, SessionDomainRequestContext, SessionDomainResult } from "./session-runtime/domain-router.ts";
import type { AgentRunSummary } from "./session-runtime/run-timing.ts";
import type { LedgerEntry } from "./ledger/types.ts";
import { createStdlibTools } from "./tools/index.ts";
import {
  AllowAllToolAuthorizationPolicy,
  authorizationBeforeToolCall,
} from "./tool-authorization.ts";
import type { TraceRecorderFactory } from "./trace/composition.ts";
import type { ExecutionEnv } from "./execution-env.ts";
import {
  createChildModelRuntimeFactory,
  createSessionModelStreamFn,
  type ChildModelRequestRouter,
  type ChildModelRuntimeFactoryPort,
} from "./agents/child-model-runtime.ts";

/** 打开模型列表时的 catalog 刷新节流:同一 provider 在 TTL 内不重复发起网络请求。 */
const MODEL_CATALOG_REFRESH_TTL_MS = 60_000;
/** 单次刷新总预算;超时按 AbortSignal 中止,列表回退 last-known-good。 */
const MODEL_CATALOG_REFRESH_TIMEOUT_MS = 10_000;

export interface ModelRequestRouter extends ChildModelRequestRouter {}

export interface RuntimeSelectionOverrides {
  provider?: string;
  model?: string;
  thinkingLevel?: ModelThinkingLevel;
}

export interface InteractiveSessionControllerOptions {
  cwd: string;
  layout: RunledgerLayout;
  systemPrompt: string;
  models: Models;
  settings: ProjectSettings;
  replay: SessionReplay;
  ledger: LedgerSink;
  overrides?: RuntimeSelectionOverrides;
  tools?: AgentTool[];
  authorizationPolicy?: ToolAuthorizationPolicy;
  traceRecorderFactory?: TraceRecorderFactory;
  executionEnv?: ExecutionEnv;
  toolResultOverflowStore?: ToolResultOverflowStore;
  /** Host-owned bounded model request assembly; local tests may omit it. */
  modelContextAssembler?: ModelContextAssembler;
  modelSelectionPreflight?: (model: Model<Api>) => Promise<void>;
  modelContextOverflowRecovery?: ModelContextOverflowRecovery;
  /** Host-owned canonical receipt sink; local tests may omit it. */
  contextAssemblySink?: ContextAssemblySink;
  /** Session-owned catalog/budget route receipt; provider dispatch is forbidden when it denies. */
  modelRequestRouter?: ModelRequestRouter;
	/** Optional model selection policy; standard CLI uses the current provider catalog. */
	isModelSelectable?: (model: Model<Api>) => boolean;
  /** Optional Host extension lifecycle facade; omitted in low-level controller tests. */
  extensionHookRuntime?: ExtensionHookRuntime;
  /** Current published extension snapshot identity used to bind hook invocations. */
  extensionHookSnapshotId?: () => string | undefined;
  /** Host admission barrier; called before Agent.prompt enters the turn. */
  extensionTurnAdmission?: () => Promise<void>;
  /** Releases a turn admitted by the Host when Agent startup fails. */
  extensionTurnAbort?: () => Promise<void>;
  /** 测试可缩小预算；production 默认不可省略。 */
  runBudget?: AgentRunBudget;
  /** Session Runtime active-time authority；production composition 必须注入。 */
  runBudgetUsage?: AgentRunBudgetUsage;
	/** Accepted prompt metadata hook; must not mutate the Agent transcript. */
	onAcceptedUserPrompt?: (text: string) => void;
	/** Cancels session-scoped background work that captured the previous model selection. */
	onModelSelectionChanged?: () => void;
}

export interface ProviderStatus {
  id: string;
  name: string;
  configured: boolean;
  source?: string;
  authTypes: AuthType[];
  interactiveAuthTypes: AuthType[];
}

/** Typed projection of the durable Session Store title event on a client subscription. */
export interface SessionTitleChangedEvent {
	readonly sessionId: string;
	readonly title: string;
	readonly source: "auto" | "user";
	readonly sequence?: number;
}

export type SessionTitleChangedSink = (event: SessionTitleChangedEvent) => void | Promise<void>;

export interface SessionIdleRecapEvent {
	readonly sessionId: string;
	readonly requestId: string;
	readonly ownerGeneration: number;
	readonly activityGeneration?: number;
	readonly driverRevision?: number;
	readonly text?: string;
	readonly diagnostic?: EphemeralTurnDiagnostic;
	readonly cleared?: boolean;
}

export type SessionIdleRecapSink = (event: SessionIdleRecapEvent) => void | Promise<void>;

/** Client-side contract shared by the Host-owned and local test controllers. */
export interface InteractiveSessionControllerPort {
  readonly trajectory?: TrajectoryClientPort;
  subscribe(listener: AgentEventSink): () => void;
	/** 客户端异步命令失败复用 warnings 投影，不进入 AgentEvent/replay。 */
	readonly subscribeWarnings?: (listener: (warning: string) => void) => () => void;
	/** Optional durable title-event subscription; absent on legacy/local controllers. */
	readonly subscribeSessionTitleChanged?: (listener: SessionTitleChangedSink) => () => void;
	readonly subscribePermissionProfile?: (listener: (profile: string) => void) => () => void;
	/** Optional transient idle recap subscription; never part of AgentEvent/replay. */
	readonly subscribeIdleRecap?: (listener: SessionIdleRecapSink) => () => void;
  /** Session Owner 客户端握手冻结的精确 operation 判断；legacy/local controller 缺省为不可协商。 */
  readonly supports?: (operation: string) => boolean;
  /** 握手冻结的 Session owner generation；本地 legacy/test controller 可省略。 */
  readonly authorityGeneration?: number;
  readonly sessionId: string;
  readonly inFlight: boolean;
  readonly currentSelection: RuntimeSelection;
  readonly messages: readonly AgentMessage[];
  readonly warnings: readonly string[];
  readonly auditEntries: readonly LedgerEntry[];
  readonly ledger?: LedgerSink;
	readonly toolCount: number;
	/** Composition-only tool extension point; callers must add already governed tools. */
	readonly addTools?: (tools: readonly AgentTool[]) => void;
  readonly agentRuns?: readonly AgentRunSummary[];
  getSteeringMessages(): readonly UserAgentMessage[];
  getFollowUpMessages(): readonly UserAgentMessage[];
  getProviderStatuses(): Promise<ProviderStatus[]>;
  getProvider(id: string): Provider | undefined;
  getAvailableModels(provider?: string): Promise<readonly Model<Api>[]>;
  /**
   * Best-effort 网络刷新动态 catalog(pi 在打开模型选择器时做同样的事)。
   * 仅配置 env key、从不 login 的用户因此也能看到 provider 端新增的模型。
   * 缺失表示该 controller 不提供刷新;实现必须在失败时保持 last-known-good。
   */
  refreshModels?(provider?: string): Promise<void>;
  login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<Credential>;
  logout(providerId: string): Promise<void>;
  selectModel(model: Model<Api>): Promise<void>;
  setThinkingLevel(level: ModelThinkingLevel): Promise<ModelThinkingLevel>;
  prompt(text: string, behavior?: "steer" | "followUp"): Promise<void>;
	/** Host/SessionRuntime-owned side-channel completion; never a normal turn. */
	readonly runEphemeralTurn?: (request: EphemeralSessionTurnRequest) => Promise<string | undefined>;
	/** Driver-only editor activity hint used to cancel/arm the owner-side timer. */
	readonly notifyEditorActivity?: (editorEmpty: boolean) => void;
  interrupt(): void;
  clearAllQueues(): { steering: UserAgentMessage[]; followUp: UserAgentMessage[] };
  waitForIdle(): Promise<void>;
  dispose(): void;
  /** Session-scoped typed domain query；缺失表示没有该 authority。 */
  readonly querySessionDomain?: (operation: string, payload: Record<string, unknown>, context: SessionDomainRequestContext) => Promise<SessionDomainResult>;
  /** Session-scoped typed domain mutation；driver 在 client/server 双端 fence。 */
  readonly commandSessionDomain?: (operation: string, payload: Record<string, unknown>, context: SessionDomainMutationContext) => Promise<SessionDomainResult>;
  /** Session Owner crash takeover 的 typed recovery facade；本地 legacy controller 可缺省。 */
  readonly recoveryStatus?: () => Promise<SessionRecoveryStatus>;
  readonly recoveryAssess?: () => Promise<SessionRecoveryAssessment>;
  readonly recoveryVerify?: (attemptId: string) => Promise<SessionRecoveryDecisionResult>;
  readonly recoveryResume?: (reasonCode: string) => Promise<SessionRecoveryDecisionResult>;
}

export interface SessionRecoveryStatus {
  readonly state: string;
  readonly barrierState: "open" | "closed";
  readonly unresolvedAttempts: number;
  readonly sideEffectSpawnCount: number;
}

export interface SessionRecoveryAssessment {
  readonly state: string;
  readonly unresolvedRemaining: number;
}

export interface SessionRecoveryDecisionResult {
  readonly state: string;
}

export interface RuntimeSelection {
  provider?: string;
  model?: Model<Api>;
  thinkingLevel: ModelThinkingLevel;
}

export type EphemeralSessionTurnRequest = EphemeralTurnRequest & {
	readonly kind: "idle-recap";
	readonly ownerGeneration: number;
	readonly activityGeneration: number;
};

/**
 * CLI/TUI 的统一运行时控制器。Models 负责 provider/auth,Agent 负责单次活跃 run,
 * controller 负责选择持久化、恢复与命令前置检查。
 */
export class InteractiveSessionController {
  private readonly cwd: string;
  private readonly layout: RunledgerLayout;
  private readonly systemPrompt: string;
  private readonly models: Models;
  private settings: ProjectSettings;
  private readonly replay: SessionReplay;
  private readonly ledgerSink: LedgerSink;
  private readonly tools: AgentTool[];
  private readonly policy: ToolAuthorizationPolicy;
  private readonly traceRecorderFactory: TraceRecorderFactory | undefined;
  private readonly executionEnv: ExecutionEnv | undefined;
  private readonly toolResultOverflowStore: ToolResultOverflowStore | undefined;
  private readonly modelContextAssembler: ModelContextAssembler | undefined;
  private readonly modelSelectionPreflight: ((model: Model<Api>) => Promise<void>) | undefined;
  private readonly modelContextOverflowRecovery: ModelContextOverflowRecovery | undefined;
  private readonly contextAssemblySink: ContextAssemblySink | undefined;
  private readonly modelRequestRouter: ModelRequestRouter | undefined;
	private readonly isModelSelectable: ((model: Model<Api>) => boolean) | undefined;
  private readonly extensionHookRuntime: ExtensionHookRuntime | undefined;
  private readonly extensionHookSnapshotId: (() => string | undefined) | undefined;
  private readonly extensionTurnAdmission: (() => Promise<void>) | undefined;
  private readonly extensionTurnAbort: (() => Promise<void>) | undefined;
  private readonly runBudget: AgentRunBudget;
  private readonly runBudgetUsage: AgentRunBudgetUsage | undefined;
	private readonly onAcceptedUserPrompt: ((text: string) => void) | undefined;
	private readonly onModelSelectionChanged: (() => void) | undefined;
  private readonly listeners = new Set<AgentEventSink>();
  private selection: RuntimeSelection;
  private readonly initialModelWarning: string | undefined;
  private readonly initialThinkingLevel: ModelThinkingLevel | undefined;
  private agent: Agent | undefined;
  private unsubscribeAgent: (() => void) | undefined;
  private readonly requestSnapshots = new ModelRequestSnapshots();
  private selectionChangePending = false;
  private promptPending = false;
  private selectionPersistenceWarning: string | undefined;
  /** 每 provider 的 catalog 刷新时间;TTL 内不重复发起网络请求。 */
  private readonly catalogRefreshedAt = new Map<string, number>();
  /** 串行化并发刷新,避免同时打开多个列表时重复请求同一 provider。 */
  private catalogRefreshInFlight: Promise<void> | undefined;

  private constructor(
    opts: InteractiveSessionControllerOptions,
    selection: RuntimeSelection,
  ) {
    this.cwd = opts.cwd;
    this.layout = opts.layout;
    this.systemPrompt = opts.systemPrompt;
    this.models = opts.models;
    this.settings = { ...opts.settings };
    this.replay = opts.replay;
    this.ledgerSink = opts.ledger;
    this.tools = opts.tools ?? productionTools(opts.cwd, opts.executionEnv);
    this.policy = opts.authorizationPolicy ?? new AllowAllToolAuthorizationPolicy();
    this.traceRecorderFactory = opts.traceRecorderFactory;
    this.executionEnv = opts.executionEnv;
    this.toolResultOverflowStore = opts.toolResultOverflowStore;
    this.modelContextAssembler = opts.modelContextAssembler;
    this.modelSelectionPreflight = opts.modelSelectionPreflight;
    this.modelContextOverflowRecovery = opts.modelContextOverflowRecovery;
    this.contextAssemblySink = opts.contextAssemblySink;
    this.modelRequestRouter = opts.modelRequestRouter;
	this.isModelSelectable = opts.isModelSelectable;
    this.extensionHookRuntime = opts.extensionHookRuntime;
    this.extensionHookSnapshotId = opts.extensionHookSnapshotId;
    this.extensionTurnAdmission = opts.extensionTurnAdmission;
    this.extensionTurnAbort = opts.extensionTurnAbort;
    this.runBudget = opts.runBudget ?? DEFAULT_AGENT_RUN_BUDGET;
    this.runBudgetUsage = opts.runBudgetUsage;
	this.onAcceptedUserPrompt = opts.onAcceptedUserPrompt;
	this.onModelSelectionChanged = opts.onModelSelectionChanged;
    this.selection = selection;
    this.initialThinkingLevel = opts.overrides?.thinkingLevel ?? opts.replay.config.thinkingLevel ?? opts.settings.thinkingLevel;
    const requestedModel = (opts.replay.config.provider === selection.provider ? opts.replay.config.model : undefined)
      ?? (opts.settings.provider === selection.provider ? opts.settings.model : undefined);
    this.initialModelWarning = selection.model === undefined && requestedModel !== undefined
      ? `Configured model ${selection.provider ?? "<provider>"}/${requestedModel} is unavailable. Use /login to refresh its catalog or /model to select an available model. No substitute model was selected.`
      : undefined;
    this.ensureAgent();
  }

  static async create(opts: InteractiveSessionControllerOptions): Promise<InteractiveSessionController> {
    const selection = await resolveInitialSelection(opts);
    const controller = new InteractiveSessionController(opts, selection);
    if (selection.model) {
      await appendRuntimeConfig(
        opts.ledger,
        controller.configSnapshot(),
        opts.replay.messages.length > 0 ? "resume" : "startup",
      );
    }
    return controller;
  }

  subscribe(listener: AgentEventSink): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get sessionId(): string {
    return this.ledgerSink.sessionId;
  }

  get inFlight(): boolean {
    return this.contextMutation !== undefined || (this.agent?.inFlight ?? false);
  }

  private contextMutation: AbortController | undefined;

  /** 手动 compact 独占请求投影；等待模型期间也阻止新的 prompt/model mutation。 */
  async withContextMutation<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.inFlight || this.promptPending || this.selectionChangePending || this.getSteeringMessages().length > 0 || this.getFollowUpMessages().length > 0) throw new Error("session_busy");
    const controller = new AbortController();
    this.contextMutation = controller;
    try { return await work(controller.signal); }
    finally { if (this.contextMutation === controller) this.contextMutation = undefined; }
  }

  get currentSelection(): RuntimeSelection {
	const { provider, model, thinkingLevel } = this.selection;
	return {
		...(provider === undefined ? {} : { provider }),
		...(model === undefined ? {} : { model }),
		thinkingLevel,
	};
  }

  get messages(): readonly AgentMessage[] {
    return this.agent?.state.messages ?? this.replay.messages;
  }

  /** compact 捕获生产请求所用的完整输入，避免从 TUI/dump 反向拼接。 */
  compactionInput(model = this.selection.model): ModelContextAssemblyInput {
    if (model === undefined) throw new Error("model_unavailable");
    return {
      sessionId: this.sessionId, turn: 0, model,
      thinkingLevel: this.selection.thinkingLevel,
      context: { systemPrompt: this.systemPrompt, tools: this.tools, messages: defaultConvertToLlm([...this.messages]) },
    };
  }

  get warnings(): readonly string[] {
    const warnings = this.selection.model === undefined && this.initialModelWarning !== undefined
      ? [...this.replay.warnings, this.initialModelWarning]
      : this.replay.warnings;
    return this.selectionPersistenceWarning === undefined ? warnings : [...warnings, this.selectionPersistenceWarning];
  }

  get auditEntries() {
    return this.replay.auditEntries;
  }

  get ledger(): LedgerSink {
    return this.ledgerSink;
  }

  get toolCount(): number {
    return this.tools.length;
  }

  /** 无真实 turn 时回退 harness 基座提示词；调用方据 `source` 字段区分。 */
  get promptInspection(): PromptInspection {
    return this.requestSnapshots.promptInspection ?? this.basePromptInspection;
  }

  requestDump(view: RequestDumpView): RequestDumpResult {
    return this.requestSnapshots.dump(view, this.basePromptInspection);
  }

  private get basePromptInspection(): PromptInspection {
    return {
      systemPrompt: this.systemPrompt,
      tools: this.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
      source: "base",
      selection: {
        ...(this.selection.provider === undefined ? {} : { provider: this.selection.provider }),
        ...(this.selection.model === undefined ? {} : { model: this.selection.model.id }),
        thinkingLevel: this.selection.thinkingLevel,
      },
      assembledPromptDigest: runtimeDigest(this.systemPrompt),
    };
  }

  /** 在 policy receipt/root registration 完成后加入 Session-owned tools。 */
  addTools(tools: readonly AgentTool[]): void {
    const existing = new Set(this.tools.map((tool) => tool.name));
    for (const tool of tools) {
      if (existing.has(tool.name)) throw new Error(`duplicate Session tool: ${tool.name}`);
      existing.add(tool.name);
      this.tools.push(tool);
    }
    this.agent?.setTools(this.tools);
  }

  getSteeringMessages(): readonly UserAgentMessage[] {
    return this.agent?.getSteeringMessages() ?? [];
  }

  getFollowUpMessages(): readonly UserAgentMessage[] {
    return this.agent?.getFollowUpMessages() ?? [];
  }

  async getProviderStatuses(): Promise<ProviderStatus[]> {
    return Promise.all(this.models.getProviders().map(async (provider) => {
      const auth = await this.models.checkAuth(provider.id).catch(() => undefined);
      const authTypes = providerAuthTypes(provider);
      return {
        id: provider.id,
        name: provider.name,
        configured: auth !== undefined,
        source: auth?.source,
        authTypes,
        interactiveAuthTypes: interactiveProviderAuthTypes(provider),
      };
    }));
  }

  getProvider(id: string): Provider | undefined {
    return this.models.getProvider(id);
  }

  async getAvailableModels(provider?: string): Promise<readonly Model<Api>[]> {
    const available = await this.models.getAvailable(provider);
    const enabled = this.settings.enabledModels;
	const enabledModels = !enabled || enabled.length === 0
		? available
		: available.filter((model) => enabled.some((entry) =>
			entry === model.id || entry === `${model.provider}/${model.id}`
		));
	const isModelSelectable = this.isModelSelectable;
	return isModelSelectable === undefined
		? enabledModels
		: enabledModels.filter((model) => isModelSelectable(model));
  }

  /**
   * Best-effort 刷新动态 catalog(标准 CLI 只在 login 时做网络刷新,仅用 env key
   * 的用户于是永远看不到 provider 侧新增的模型;pi 在打开模型选择器时刷新)。
   * 失败只进入 refresh 结果的 errors,不影响调用方返回的 last-known-good 列表。
   */
  async refreshModels(provider?: string): Promise<void> {
    const inFlight = this.catalogRefreshInFlight;
    if (inFlight !== undefined) {
      await inFlight.catch(() => undefined);
      return;
    }
    const now = Date.now();
    const targets = (provider === undefined ? this.models.getProviders().map((entry) => entry.id) : [provider])
      .filter((id) => this.models.getProvider(id)?.refreshModels !== undefined)
      .filter((id) => now - (this.catalogRefreshedAt.get(id) ?? 0) >= MODEL_CATALOG_REFRESH_TTL_MS);
    if (targets.length === 0) return;
    const operation = (async () => {
      try {
        await this.models.refresh({
          allowNetwork: true,
          providers: targets,
          signal: AbortSignal.timeout(MODEL_CATALOG_REFRESH_TIMEOUT_MS),
        });
      } catch {
        // 超时/中止:保留 last-known-good,下一次调用在 TTL 后重试。
      } finally {
        // 失败也要记时间:否则每次打开列表都会立刻重试同一个故障 provider。
        for (const id of targets) this.catalogRefreshedAt.set(id, Date.now());
        this.catalogRefreshInFlight = undefined;
      }
    })();
    this.catalogRefreshInFlight = operation;
    await operation;
  }

  async login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<Credential> {
    const credential = await this.models.login(providerId, type, interaction);
    await this.models.refresh({ allowNetwork: true, signal: interaction.signal });
    return credential;
  }

  async logout(providerId: string): Promise<void> {
    await this.models.logout(providerId);
  }

  async selectModel(model: Model<Api>): Promise<void> {
    this.beginSelectionChange();
    try {
      // 命令面仅携带身份；不接受调用方伪造的 endpoint、能力或目录外模型。
      const resolved = this.models.getModel(model.provider, model.id);
      if (resolved === undefined) throw new Error(`Unknown model selection: ${model.provider}/${model.id}`);
      if (this.isModelSelectable?.(resolved) === false) {
        throw new Error(`Model selection is unavailable: ${resolved.provider}/${resolved.id}`);
      }
      const available = await this.getAvailableModels(resolved.provider);
      if (!available.some((candidate) => candidate.provider === resolved.provider && candidate.id === resolved.id)) {
        throw new Error(`Model ${resolved.provider}/${resolved.id} is not available. Check provider login and enabled models.`);
      }
      await this.modelSelectionPreflight?.(resolved);
      const thinkingLevel = clampThinkingLevel(resolved, this.selection.model ? this.selection.thinkingLevel : this.initialThinkingLevel ?? "high");
      await this.persistSelection({ provider: resolved.provider, model: resolved, thinkingLevel }, "model");
    } finally {
      this.selectionChangePending = false;
    }
  }

  async setThinkingLevel(level: ModelThinkingLevel): Promise<ModelThinkingLevel> {
    this.beginSelectionChange();
    try {
      const model = this.selection.model;
      if (!model) throw new Error("Select a model before configuring thinking.");
      if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(level)) throw new Error("Invalid thinking level");
      const effective = clampThinkingLevel(model, level);
      await this.persistSelection({ ...this.selection, thinkingLevel: effective }, "thinking");
      return effective;
    } finally {
      this.selectionChangePending = false;
    }
  }

  private beginSelectionChange(): void {
    if (this.inFlight || this.promptPending || this.selectionChangePending) {
      throw new Error("Wait for the active request or model change to finish before changing model or thinking level.");
    }
    this.selectionChangePending = true;
  }

  async prompt(text: string, behavior?: "steer" | "followUp"): Promise<void> {
    const agent = this.agent;
    const model = this.selection.model;
    if (!agent || !model) throw new Error("No model selected. Use /provider or /model.");
    if (agent.inFlight) {
      if (behavior === "followUp") agent.followUp(text);
      else agent.steer(text);
      return;
    }
    if (this.contextMutation !== undefined || this.selectionChangePending || this.promptPending) throw new Error("Wait for the pending request or model change to finish.");
    this.promptPending = true;
    let admitted = false;
    try {
      const auth = await this.models.getAuth(model);
      if (!auth) throw new Error(`Provider ${model.provider} is not configured. Use /login ${model.provider}.`);
      await this.extensionTurnAdmission?.();
      admitted = true;
      const submitted = await this.runExtensionHook("UserPromptSubmit", { text });
      if (submitted?.blocked || submitted?.decision === "deny" || submitted?.decision === "aborted") throw new Error("UserPromptSubmit hook denied the prompt");
	      const acceptedInput = promptText(submitted?.finalInput, text);
	      this.onAcceptedUserPrompt?.(acceptedInput);
	      await agent.prompt(acceptedInput);
    } catch (error) {
      if (admitted) await this.extensionTurnAbort?.().catch(() => undefined);
      throw error;
    } finally {
      this.promptPending = false;
    }
  }

	/** Run a transient completion through this Session's one Agent/model pipeline. */
	async runEphemeralTurn(request: EphemeralSessionTurnRequest): Promise<string | undefined> {
		if (this.contextMutation !== undefined) return undefined;
		const agent = this.agent;
		if (agent === undefined || this.selection.model === undefined || agent.state.messages.length === 0) return undefined;
		const result = await agent.runEphemeralTurn(request);
		return result?.replyText;
	}

  interrupt(): void {
    this.contextMutation?.abort();
    this.agent?.interrupt();
  }

  clearAllQueues(): { steering: UserAgentMessage[]; followUp: UserAgentMessage[] } {
    return this.agent?.clearAllQueues() ?? { steering: [], followUp: [] };
  }

  waitForIdle(): Promise<void> {
    return this.agent?.waitForIdle() ?? Promise.resolve();
  }

  dispose(): void {
    this.contextMutation?.abort();
    this.unsubscribeAgent?.();
    this.unsubscribeAgent = undefined;
    this.listeners.clear();
  }

  /** 为 Session-owned child runtime 提供当前 selection 与同一 model router。 */
  createChildModelRuntimeFactory(): ChildModelRuntimeFactoryPort {
    return createChildModelRuntimeFactory({
      models: this.models,
      sessionId: this.sessionId,
      getSelection: () => ({
        model: this.selection.model,
        thinkingLevel: this.selection.thinkingLevel,
      }),
      ...(this.modelRequestRouter === undefined ? {} : { modelRequestRouter: this.modelRequestRouter }),
    });
  }

  private ensureAgent(): void {
    const model = this.selection.model;
    if (!model) return;
    if (this.agent) return;
    const streamFn: StreamFn = createSessionModelStreamFn({
      models: this.models,
      sessionId: this.sessionId,
      ...(this.modelRequestRouter === undefined ? {} : { modelRequestRouter: this.modelRequestRouter }),
    });
    const authorization = authorizationBeforeToolCall(this.policy);
    const beforeToolCall = async (request: Parameters<NonNullable<AgentLoopConfig["beforeToolCall"]>>[0], signal?: AbortSignal) => {
      const hook = await this.runExtensionHook("PreToolUse", request.args, request.toolCall.name, signal);
      if (hook?.blocked || hook?.decision === "deny" || hook?.decision === "aborted") return { block: true, reason: "PreToolUse hook denied the tool call" };
      const args = hook?.requiresRevalidation ? hook.finalInput : request.args;
      const decision = await authorization({ ...request, args }, signal);
      if (decision?.block) return decision;
      return hook?.requiresRevalidation ? { updatedInput: args } : undefined;
    };
    const afterToolCall = async (request: AgentToolHookContext & { result: import("./types.ts").ToolResultContent; isError: boolean }, signal?: AbortSignal): Promise<AfterToolCallResult | undefined> => {
      const hook = await this.runExtensionHook("PostToolUse", { args: request.args, result: request.result, isError: request.isError }, request.toolCall.name, signal);
      if (hook?.blocked || hook?.decision === "deny" || hook?.decision === "aborted") return { isError: true, content: [{ type: "text", text: "PostToolUse hook denied the tool result" }] };
      return undefined;
    };
    this.agent = new Agent({
      initialState: {
        systemPrompt: this.systemPrompt,
        model,
        messages: this.replay.messages,
        tools: this.tools,
        thinkingLevel: this.selection.thinkingLevel,
      },
      streamFn,
      ledger: this.ledgerSink,
      loopConfig: {
        cwd: this.cwd,
        beforeToolCall,
        afterToolCall,
        executionEnv: this.executionEnv,
        runBudget: this.runBudget,
        ...(this.runBudgetUsage === undefined ? {} : { runBudgetUsage: this.runBudgetUsage }),
        ...(this.toolResultOverflowStore === undefined ? {} : { toolResultOverflowStore: this.toolResultOverflowStore }),
        ...(this.modelContextAssembler === undefined ? {} : { modelContextAssembler: this.modelContextAssembler }),
        ...(this.modelContextOverflowRecovery === undefined ? {} : { modelContextOverflowRecovery: this.modelContextOverflowRecovery }),
        modelRequestObserver: this.requestSnapshots.observe,
        ...(this.contextAssemblySink === undefined ? {} : { contextAssemblySink: this.contextAssemblySink }),
      },
      toolExecution: "sequential",
      steeringMode: this.settings.steeringMode ?? "one-at-a-time",
      followUpMode: this.settings.followUpMode ?? "one-at-a-time",
      traceRecorderFactory: this.traceRecorderFactory,
    });
    this.unsubscribeAgent = this.agent.subscribe((event) => this.dispatch(event));
  }

  private async runExtensionHook(
    event: import("../extensions/hooks/types.ts").HookEventName,
    input: unknown,
    matcherValue?: string,
    signal?: AbortSignal,
  ): Promise<ExtensionHookRuntimeResult | undefined> {
    if (this.extensionHookRuntime === undefined) return undefined;
    const snapshotId = this.extensionHookSnapshotId?.();
    if (snapshotId === undefined) return { decision: "deny", blocked: true, finalInput: input, requiresRevalidation: false, requiresAuthorization: true, additionalContext: [] };
    return this.extensionHookRuntime.run({ event, sessionId: this.sessionId, snapshotId, input, ...(matcherValue === undefined ? {} : { matcherValue }), ...(signal === undefined ? {} : { signal }) });
  }

  private async dispatch(event: Parameters<AgentEventSink>[0]): Promise<void> {
    await Promise.all(Array.from(this.listeners).map(async (listener) => {
      try {
        await listener(event);
      } catch {
        // UI listener 不得破坏 runtime。
      }
    }));
  }

  private configSnapshot(): SessionRuntimeConfig {
    return {
      provider: this.selection.provider,
      model: this.selection.model?.id,
      thinkingLevel: this.selection.thinkingLevel,
    };
  }

  private async persistSelection(selection: RuntimeSelection, source: "model" | "thinking"): Promise<void> {
    const config = { provider: selection.provider, model: selection.model?.id, thinkingLevel: selection.thinkingLevel };
    // Session ledger 是选择的 authority；写入失败时保留原模型和思考程度。
    await appendRuntimeConfig(this.ledgerSink, config, source);
    this.selection = selection;
    this.ensureAgent();
    if (selection.model) this.agent?.setModel(selection.model);
    this.agent?.setThinkingLevel(selection.thinkingLevel);
    this.onModelSelectionChanged?.();
    try {
      const persisted = await loadProjectSettings({ layout: this.layout });
      this.settings = { ...this.settings, ...persisted, ...config };
      await saveProjectSettings({ layout: this.layout }, this.settings);
      this.selectionPersistenceWarning = undefined;
    } catch {
      // 默认值保存失败不撤销已持久化的 session 选择，也不伪报切换失败。
      this.selectionPersistenceWarning = "Session model selection was saved, but user defaults could not be updated.";
    }
  }
}

function promptText(value: unknown, fallback: string): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as Record<string, unknown>).text === "string") return (value as Record<string, unknown>).text as string;
  return fallback;
}

async function resolveInitialSelection(
  opts: InteractiveSessionControllerOptions,
): Promise<RuntimeSelection> {
  const cli = normalizeModelOverride(opts.overrides ?? {});
  const session = opts.replay.config;
  const settings = opts.settings;
  const provider = cli.provider ?? session.provider ?? settings.provider;
  const modelId = cli.model ??
    (provider === session.provider ? session.model : undefined) ??
    (provider === settings.provider ? settings.model : undefined);
  const configuredThinkingLevel = cli.thinkingLevel ?? session.thinkingLevel ?? settings.thinkingLevel;

  let model: Model<Api> | undefined;
  if (provider && modelId) model = opts.models.getModel(provider, modelId);
  if (!model && modelId && !provider) {
    const matches = opts.models.getModels().filter((candidate) => candidate.id === modelId);
    if (matches.length === 1) model = matches[0];
    if (matches.length > 1 && opts.overrides?.model) {
      throw new Error(
        `Ambiguous model ${modelId}; use --provider or provider/model. Candidates: ${matches.map((m) => m.provider).join(", ")}`,
      );
    }
  }
	if (model !== undefined && opts.isModelSelectable?.(model) === false) {
		throw new Error(`Model selection is unavailable: ${model.provider}/${model.id}. No substitute model was selected.`);
	}
  if (!model && (opts.overrides?.provider || opts.overrides?.model)) {
    throw new Error(`Unknown model selection: ${provider ?? "<provider>"}/${modelId ?? "<model>"}`);
  }
	if (!model && !modelId) {
		const available = await opts.models.getAvailable();
		model = available.find((candidate) => opts.isModelSelectable?.(candidate) !== false);
	}
  return {
    provider: model?.provider ?? provider,
    model,
    thinkingLevel: model
      ? clampThinkingLevel(model, configuredThinkingLevel ?? "high")
      : configuredThinkingLevel ?? "off",
  };
}

function normalizeModelOverride(overrides: RuntimeSelectionOverrides): RuntimeSelectionOverrides {
  const model = overrides.model;
  if (!model || overrides.provider || !model.includes("/")) return overrides;
  const slash = model.indexOf("/");
  return {
    ...overrides,
    provider: model.slice(0, slash),
    model: model.slice(slash + 1),
  };
}

function providerAuthTypes(provider: Provider): AuthType[] {
  const types: AuthType[] = [];
  if (provider.auth.apiKey) types.push("api_key");
  if (provider.auth.oauth) types.push("oauth");
  return types;
}

function interactiveProviderAuthTypes(provider: Provider): AuthType[] {
  const types: AuthType[] = [];
  if (provider.auth.apiKey?.login) types.push("api_key");
  if (provider.auth.oauth) types.push("oauth");
  return types;
}

function productionTools(cwd: string, executionEnv?: ExecutionEnv): AgentTool[] {
  const excluded = new Set(["Skill", "NotebookEdit", "echo"]);
  return createStdlibTools(cwd, {
    requireExecutionEnv: true,
    ...(executionEnv === undefined ? {} : { executionEnv }),
  }).toContext().filter((tool) => !excluded.has(tool.name));
}
