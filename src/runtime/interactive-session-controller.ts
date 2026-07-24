import type { AuthInteraction, AuthType, Credential } from "../auth/types.ts";
import { clampThinkingLevel, type Models, type Provider } from "../models.ts";
import type { Api, Context, Model, ModelThinkingLevel } from "../types.ts";
import type { ProjectSettings } from "../storage/settings-manager.ts";
import { saveProjectSettings } from "../storage/settings-manager.ts";
import type { SessionReplay, SessionRuntimeConfig } from "../storage/session-codec.ts";
import { appendRuntimeConfig } from "../storage/session-codec.ts";
import { Agent } from "./agent.ts";
import type {
  AgentEventSink,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  QueueMode,
  StreamFn,
  ToolAuthorizationPolicy,
  ToolResultArtifactSink,
  UserAgentMessage,
} from "./types.ts";
import type { LedgerSink } from "./ledger/types.ts";
import type { LedgerEntry } from "./ledger/types.ts";
import type {
  AgentLoopSessionEvents,
  DurableQueueReceipt,
} from "./session/agent-loop-events.ts";
import { canonicalDigest } from "./protocol/v3/canonical-json.ts";
import { createStdlibTools } from "./tools/index.ts";
import {
  DenyAllToolAuthorizationPolicy,
  authorizationBeforeToolCall,
} from "./tool-authorization.ts";

export interface RuntimeSelectionOverrides {
  provider?: string;
  model?: string;
  thinkingLevel?: ModelThinkingLevel;
}

export interface InteractiveSessionControllerOptions {
  cwd: string;
  systemPrompt: string;
  models: Models;
  settings: ProjectSettings;
  replay: SessionReplay;
  ledger?: LedgerSink;
  sessionId?: string;
  sessionEvents?: AgentLoopSessionEvents;
  toolResultArtifactSink?: ToolResultArtifactSink;
  overrides?: RuntimeSelectionOverrides;
  tools?: AgentTool[];
  authorizationPolicy?: ToolAuthorizationPolicy;
  /** Extension PreToolUse adapter；授权在该 hook 完成并重新校验入参后执行。 */
  beforeToolCall?: AgentLoopConfig["beforeToolCall"];
  /** Extension PostToolUse adapter。 */
  afterToolCall?: AgentLoopConfig["afterToolCall"];
  /** v3 model route + ContextEngine 的生产准备入口。 */
  prepareModelRequest?: AgentLoopConfig["prepareModelRequest"];
  /** v3 Workspace/Capability/Sandbox 工具执行唯一入口。 */
  toolExecutionGateway?: AgentLoopConfig["toolExecutionGateway"];
  /** production provider/tool operation 的 durable BudgetGuard seam。 */
  operationBudget?: AgentLoopConfig["operationBudget"];
  /** Extension snapshot 生命周期；reload 只在 active run 结束后的安全点生效。 */
  extensionLifecycle?: InteractiveExtensionLifecyclePort;
  /** 高风险 mutation 只能由 governed production composition 注入。 */
  extensionControl?: InteractiveExtensionControlPort;
  /** ToolRegistry 的当前只读投影；Extension generation 交换后用它刷新 Agent。 */
  toolProvider?: () => readonly AgentTool[];
}

export interface InteractiveExtensionCatalogResource {
  identity: { qualifiedId: string };
  kind: string;
  displayName: string;
  provenance?: { source: string };
  enabled: boolean;
  trust: string;
  activation: string;
  pluginId?: string;
  diagnostics?: readonly { message: string }[];
  manifest?: { combinedDigest: string };
  capabilities?: readonly { claim: unknown; required: boolean }[];
}

export interface InteractiveExtensionCatalog {
  snapshotId: string;
  generation: number;
  resources: readonly InteractiveExtensionCatalogResource[];
  diagnostics?: readonly { message: string }[];
  counts?: {
    ready: number;
    blocked: number;
    disabled: number;
    error: number;
  };
}

export interface InteractiveExtensionLifecyclePort {
  catalog(): InteractiveExtensionCatalog | undefined;
  beginTurn(): { status: "ready" | "failed"; reason?: string };
  endTurn(): Promise<
    | { status: "applied" | "pending" | "failed"; reason?: string }
    | undefined
  >;
  userPromptSubmit(
    prompt: string,
    signal?: AbortSignal,
  ): Promise<{ status: "allowed" | "blocked"; reason?: string }>;
  reload(signal?: AbortSignal): Promise<{
    status: "applied" | "pending" | "failed";
    reason?: string;
  }>;
}

export interface InteractiveExtensionResourceView {
  id: string;
  kind: string;
  displayName: string;
  enabled: boolean;
  trust: string;
  activation: string;
  source: string;
  componentCount: number;
  diagnostic?: string;
  digest: string;
  capabilities: readonly string[];
}

export interface InteractiveExtensionSnapshotView {
  snapshotId: string;
  generation: number;
  resources: readonly InteractiveExtensionResourceView[];
  diagnostics: readonly string[];
  counts: {
    ready: number;
    blocked: number;
    disabled: number;
    error: number;
  };
}

export type InteractiveExtensionMutationAction =
  | "trust"
  | "untrust"
  | "enable"
  | "disable"
  | "login"
  | "logout";

export interface InteractiveExtensionMutationInput {
  action: InteractiveExtensionMutationAction;
  kind: string;
  resourceId: string;
  digest: string;
}

export interface InteractiveExtensionControlPort {
  mutate(input: InteractiveExtensionMutationInput): Promise<{
    ok: boolean;
    status: "pending" | "applied" | "failed";
    message: string;
  }>;
}

export interface ProviderStatus {
  id: string;
  name: string;
  configured: boolean;
  source?: string;
  authTypes: AuthType[];
  interactiveAuthTypes: AuthType[];
}

export interface RuntimeSelection {
  provider?: string;
  model?: Model<Api>;
  thinkingLevel: ModelThinkingLevel;
}

/** 仅供 CLI composition adapter 使用，不属于 InteractiveSessionControllerPort。 */
export interface GovernedPromptRuntimeAcceptance {
  /** 首个 turn_start 发出前，v3 turn.started 已越过 durable barrier。 */
  started: Promise<void>;
  /** 整个 active run 的完成状态；command accepted 不等待此 Promise。 */
  completion: Promise<void>;
}

/** TUI 只依赖此 facade；生产模式可把 mutation 路由到 Control Plane。 */
export interface InteractiveSessionControllerPort {
  readonly sessionId: string;
  readonly inFlight: boolean;
  readonly currentSelection: RuntimeSelection;
  readonly messages: readonly AgentMessage[];
  readonly warnings: readonly string[];
  readonly auditEntries: readonly LedgerEntry[];
  readonly toolCount: number;
  getExtensionSnapshot?(): InteractiveExtensionSnapshotView | undefined;
  reloadExtensions?(): Promise<{ status: "applied" | "pending" | "failed"; reason?: string }>;
  mutateExtension?(input: InteractiveExtensionMutationInput): Promise<{
    ok: boolean;
    status: "pending" | "applied" | "failed";
    message: string;
  }>;
  subscribe(listener: AgentEventSink): () => void;
  getProviderStatuses(): Promise<ProviderStatus[]>;
  getProvider(id: string): Provider | undefined;
  getAvailableModels(provider?: string): Promise<readonly Model<Api>[]>;
  login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<Credential>;
  logout(providerId: string): Promise<void>;
  selectModel(model: Model<Api>): Promise<void>;
  setThinkingLevel(level: ModelThinkingLevel): Promise<ModelThinkingLevel>;
  prompt(text: string, behavior?: "steer" | "followUp"): Promise<void>;
  interrupt(): void;
  cancelAllQueues(reason?: string): Promise<{ steering: UserAgentMessage[]; followUp: UserAgentMessage[] }>;
  waitForIdle(): Promise<void>;
  dispose(): void;
}

/**
 * CLI/TUI 的统一运行时控制器。Models 负责 provider/auth,Agent 负责单次活跃 run,
 * controller 负责选择持久化、恢复与命令前置检查。
 */
export class InteractiveSessionController implements InteractiveSessionControllerPort {
  private readonly cwd: string;
  private readonly systemPrompt: string;
  private readonly models: Models;
  private settings: ProjectSettings;
  private readonly replay: SessionReplay;
  private readonly ledger: LedgerSink | undefined;
  private readonly runtimeSessionId: string;
  private readonly sessionEvents: AgentLoopSessionEvents | undefined;
  private readonly toolResultArtifactSink: ToolResultArtifactSink | undefined;
  private tools: AgentTool[];
  private readonly policy: ToolAuthorizationPolicy;
  private readonly authorizationPolicyConfigured: boolean;
  private readonly beforeToolCall: AgentLoopConfig["beforeToolCall"] | undefined;
  private readonly afterToolCall: AgentLoopConfig["afterToolCall"] | undefined;
  private readonly prepareModelRequest: AgentLoopConfig["prepareModelRequest"] | undefined;
  private readonly toolExecutionGateway: AgentLoopConfig["toolExecutionGateway"] | undefined;
  private readonly operationBudget: AgentLoopConfig["operationBudget"] | undefined;
  private readonly extensionLifecycle: InteractiveExtensionLifecyclePort | undefined;
  private readonly extensionControl: InteractiveExtensionControlPort | undefined;
  private readonly toolProvider: (() => readonly AgentTool[]) | undefined;
  private readonly governedPromptPreflights = new Map<string, string>();
  private readonly listeners = new Set<AgentEventSink>();
  private selection: RuntimeSelection;
  private agent: Agent | undefined;
  private unsubscribeAgent: (() => void) | undefined;

  private constructor(
    opts: InteractiveSessionControllerOptions,
    selection: RuntimeSelection,
  ) {
    this.cwd = opts.cwd;
    this.systemPrompt = opts.systemPrompt;
    this.models = opts.models;
    this.settings = { ...opts.settings };
    this.replay = opts.replay;
    this.ledger = opts.ledger;
    this.runtimeSessionId = opts.sessionId ?? opts.ledger?.sessionId ?? "<no-session>";
    this.sessionEvents = opts.sessionEvents;
    this.toolResultArtifactSink = opts.toolResultArtifactSink;
    this.tools = opts.tools ?? productionTools(opts.cwd);
    this.policy = opts.authorizationPolicy ?? new DenyAllToolAuthorizationPolicy();
    this.authorizationPolicyConfigured = opts.authorizationPolicy !== undefined;
    this.beforeToolCall = opts.beforeToolCall;
    this.afterToolCall = opts.afterToolCall;
    this.prepareModelRequest = opts.prepareModelRequest;
    this.toolExecutionGateway = opts.toolExecutionGateway;
    this.operationBudget = opts.operationBudget;
    this.extensionLifecycle = opts.extensionLifecycle;
    this.extensionControl = opts.extensionControl;
    this.toolProvider = opts.toolProvider;
    this.selection = selection;
    this.ensureAgent();
  }

  static async create(opts: InteractiveSessionControllerOptions): Promise<InteractiveSessionController> {
    const selection = await resolveInitialSelection(opts);
    const controller = new InteractiveSessionController(opts, selection);
    if (selection.model && opts.ledger) {
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
    return this.runtimeSessionId;
  }

  get inFlight(): boolean {
    return this.agent?.inFlight ?? false;
  }

  get currentSelection(): RuntimeSelection {
    return { ...this.selection };
  }

  get messages(): readonly AgentMessage[] {
    return this.agent?.state.messages ?? this.replay.messages;
  }

  get warnings(): readonly string[] {
    return this.replay.warnings;
  }

  get auditEntries() {
    return this.replay.auditEntries;
  }

  get toolCount(): number {
    return this.tools.length;
  }

  getExtensionSnapshot(): InteractiveExtensionSnapshotView | undefined {
    const catalog = this.extensionLifecycle?.catalog();
    if (!catalog) return undefined;
    return {
      snapshotId: catalog.snapshotId,
      generation: catalog.generation,
      resources: catalog.resources.map((resource) => ({
        id: resource.identity.qualifiedId,
        kind: resource.kind,
        displayName: resource.displayName,
        enabled: resource.enabled,
        trust: resource.trust,
        activation: resource.activation,
        source: resource.provenance?.source ?? "unknown",
        componentCount: resource.kind === "plugin"
          ? catalog.resources.filter((candidate) => candidate.pluginId === resource.identity.qualifiedId).length
          : 0,
        ...(resource.diagnostics?.[0]?.message
          ? { diagnostic: resource.diagnostics[0].message }
          : {}),
        digest: resource.manifest?.combinedDigest ?? resource.identity.qualifiedId,
        capabilities: (resource.capabilities ?? []).map((capability) =>
          `${capability.required ? "required" : "optional"}:${JSON.stringify(capability.claim)}`
        ),
      })),
      diagnostics: (catalog.diagnostics ?? []).map((diagnostic) => diagnostic.message),
      counts: catalog.counts ?? {
        ready: catalog.resources.filter((resource) => resource.activation === "ready").length,
        blocked: catalog.resources.filter((resource) => resource.activation === "blocked").length,
        disabled: catalog.resources.filter((resource) => resource.activation === "disabled").length,
        error: catalog.resources.filter((resource) => resource.activation === "failed").length,
      },
    };
  }

  async reloadExtensions(): Promise<{ status: "applied" | "pending" | "failed"; reason?: string }> {
    if (!this.extensionLifecycle) {
      return { status: "failed", reason: "production Extension runtime is not configured" };
    }
    if (this.inFlight) return { status: "pending", reason: "reload is deferred until the active run settles" };
    const result = await this.extensionLifecycle.reload();
    if (result.status === "applied") this.refreshTools();
    return result;
  }

  async mutateExtension(input: InteractiveExtensionMutationInput): Promise<{
    ok: boolean;
    status: "pending" | "applied" | "failed";
    message: string;
  }> {
    if (!this.extensionControl) {
      return {
        ok: false,
        status: "failed",
        message: "governed Extension mutation ports are not configured",
      };
    }
    if (this.inFlight) {
      return {
        ok: false,
        status: "failed",
        message: "Extension mutation is unavailable while a turn is active",
      };
    }
    return this.extensionControl.mutate(input);
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
    if (!enabled || enabled.length === 0) return available;
    return available.filter((model) => enabled.some((entry) =>
      entry === model.id || entry === `${model.provider}/${model.id}`
    ));
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
    await this.waitForIdle();
    const thinkingLevel = clampThinkingLevel(model, this.selection.thinkingLevel);
    this.selection = { provider: model.provider, model, thinkingLevel };
    this.ensureAgent();
    this.agent?.setModel(model);
    this.agent?.setThinkingLevel(thinkingLevel);
    await this.persistSelection("model");
  }

  async setThinkingLevel(level: ModelThinkingLevel): Promise<ModelThinkingLevel> {
    await this.waitForIdle();
    const model = this.selection.model;
    if (!model) throw new Error("Select a model before configuring thinking.");
    const effective = clampThinkingLevel(model, level);
    this.selection = { ...this.selection, thinkingLevel: effective };
    this.agent?.setThinkingLevel(effective);
    await this.persistSelection("thinking");
    return effective;
  }

  async prompt(text: string, behavior?: "steer" | "followUp"): Promise<void> {
    const agent = this.agent;
    const model = this.selection.model;
    if (!agent || !model) throw new Error("No model selected. Use /provider or /model.");
    const auth = await this.models.getAuth(model);
    if (!auth) throw new Error(`Provider ${model.provider} is not configured. Use /login ${model.provider}.`);
    if (agent.inFlight) {
      await this.authorizeExtensionPrompt(text);
      if (behavior === "followUp") agent.followUp(text);
      else agent.steer(text);
      return;
    }
    await this.runInitialPrompt(agent, text);
  }

  /** Control Plane preflight：任何 durable enqueue 之前完成 model/auth 与状态校验。 */
  async preflightGovernedPrompt(
    expectsActiveTurn: boolean,
    prompt?: { commandId: string; text: string },
  ): Promise<void> {
    const agent = this.agent;
    const model = this.selection.model;
    if (!agent || !model) throw new Error("No model selected. Use /provider or /model.");
    if (agent.inFlight !== expectsActiveTurn) {
      throw new Error(expectsActiveTurn
        ? "The durable session has an active turn but the local runtime is idle."
        : "The durable session is idle but the local runtime is already processing.");
    }
    const auth = await this.models.getAuth(model);
    if (!auth) throw new Error(`Provider ${model.provider} is not configured. Use /login ${model.provider}.`);
    if (this.extensionLifecycle) {
      if (!prompt) throw new Error("governed Extension preflight requires exact command and prompt correlation");
      await this.authorizeExtensionPrompt(prompt.text);
      this.rememberGovernedPromptPreflight(prompt.commandId, prompt.text);
    }
  }

  /**
   * Control Plane 专用内部入口。调用方必须先持有 queue.enqueued receipt；本方法
   * 不再写 queue event，从而保证 append 失败时内存队列完全不变。
   */
  acceptDurablyEnqueuedPrompt(
    text: string,
    behavior: "start" | "steer" | "followUp",
    commandId?: string,
    receipt?: DurableQueueReceipt,
  ): GovernedPromptRuntimeAcceptance {
    const agent = this.agent;
    if (!agent) throw new Error("No model selected. Use /provider or /model.");
    if (this.extensionLifecycle && !this.consumeGovernedPromptPreflight(commandId, text)) {
      throw new Error("durable prompt has no matching Extension preflight receipt");
    }
    if (behavior !== "start") {
      if (!agent.inFlight) throw new Error("Cannot enqueue into an inactive turn.");
      agent.acceptDurablyEnqueued(
        behavior === "followUp" ? "follow_up" : "steer",
        text,
        receipt,
      );
      return { started: Promise.resolve(), completion: agent.waitForIdle() };
    }
    if (agent.inFlight) throw new Error("Cannot start a second active run.");

    let resolveStarted: (() => void) | undefined;
    let rejectStarted: ((reason?: unknown) => void) | undefined;
    const started = new Promise<void>((resolve, reject) => {
      resolveStarted = resolve;
      rejectStarted = reject;
    });
    let unsubscribe = (): void => undefined;
    unsubscribe = agent.on("turn_start", () => {
      unsubscribe();
      resolveStarted?.();
    });
    const completion = this.runInitialPrompt(agent, text, true, receipt);
    void completion.catch((error: unknown) => {
      unsubscribe();
      rejectStarted?.(error);
    });
    return { started, completion };
  }

  interrupt(): void {
    this.agent?.interrupt();
  }

  cancelAllQueues(
    reason: string = "operator cleared queued messages",
  ): Promise<{ steering: UserAgentMessage[]; followUp: UserAgentMessage[] }> {
    return this.agent?.cancelAllQueues(reason) ?? Promise.resolve({ steering: [], followUp: [] });
  }

  waitForIdle(): Promise<void> {
    return this.agent?.waitForIdle() ?? Promise.resolve();
  }

  dispose(): void {
    this.unsubscribeAgent?.();
    this.unsubscribeAgent = undefined;
    this.governedPromptPreflights.clear();
    this.listeners.clear();
  }

  private async authorizeExtensionPrompt(text: string): Promise<void> {
    const result = await this.extensionLifecycle?.userPromptSubmit(text);
    if (result?.status === "blocked") {
      throw new Error(`Extension UserPromptSubmit blocked the prompt: ${result.reason ?? "no reason supplied"}`);
    }
  }

  private rememberGovernedPromptPreflight(commandId: string, text: string): void {
    if (!commandId || commandId.length > 128) throw new Error("governed prompt command id is invalid");
    if (this.governedPromptPreflights.size >= 256) {
      const oldest = this.governedPromptPreflights.keys().next().value;
      if (oldest !== undefined) this.governedPromptPreflights.delete(oldest);
    }
    this.governedPromptPreflights.set(commandId, canonicalDigest(text));
  }

  private consumeGovernedPromptPreflight(commandId: string | undefined, text: string): boolean {
    if (!commandId) return false;
    const expected = this.governedPromptPreflights.get(commandId);
    this.governedPromptPreflights.delete(commandId);
    return expected === canonicalDigest(text);
  }

  private refreshTools(): void {
    if (!this.toolProvider) return;
    const next = [...this.toolProvider()];
    const names = new Set<string>();
    for (const tool of next) {
      if (names.has(tool.name)) throw new Error(`Extension tool refresh produced duplicate name: ${tool.name}`);
      names.add(tool.name);
    }
    this.tools = next;
    this.agent?.setTools(next);
  }

  private async runInitialPrompt(
    agent: Agent,
    text: string,
    extensionPreflighted = false,
    receipt?: DurableQueueReceipt,
  ): Promise<void> {
    if (this.extensionLifecycle && !extensionPreflighted) await this.authorizeExtensionPrompt(text);
    const begun = this.extensionLifecycle?.beginTurn();
    if (begun?.status === "failed") {
      throw new Error(`Extension generation could not be pinned: ${begun.reason ?? "unknown failure"}`);
    }
    if (begun) this.refreshTools();

    let promptError: unknown;
    try {
      await agent.prompt(text, receipt ? [receipt] : undefined);
    } catch (error) {
      promptError = error;
    }

    let extensionError: unknown;
    if (begun) {
      try {
        const ended = await this.extensionLifecycle?.endTurn();
        if (ended?.status === "failed") {
          throw new Error(`Extension generation failed to settle: ${ended.reason ?? "unknown failure"}`);
        }
        this.refreshTools();
      } catch (error) {
        extensionError = error;
      }
    }
    if (promptError && extensionError) {
      throw new AggregateError([promptError, extensionError], "agent prompt and Extension settlement both failed");
    }
    if (promptError) throw promptError;
    if (extensionError) throw extensionError;
  }

  private ensureAgent(): void {
    const model = this.selection.model;
    if (!model) return;
    if (this.agent) return;
    const streamFn: StreamFn = (requestModel, context, options) =>
      this.models.streamSimple(requestModel, context as Context, options);
    // Gateway 已执行完整 capability/approval/sandbox 判定时，不再叠加默认
    // DenyAll legacy policy；显式传入的 policy 仍可作为额外收窄门。
    const authorizeToolCall = this.toolExecutionGateway && !this.authorizationPolicyConfigured
      ? undefined
      : authorizationBeforeToolCall(this.policy);
    this.agent = new Agent({
      initialState: {
        systemPrompt: this.systemPrompt,
        model,
        messages: this.replay.messages,
        tools: this.tools,
        thinkingLevel: this.selection.thinkingLevel,
      },
      streamFn,
      ledger: this.ledger,
      loopConfig: {
        cwd: this.cwd,
        beforeToolCall: this.beforeToolCall,
        ...(authorizeToolCall ? { authorizeToolCall } : {}),
        afterToolCall: this.afterToolCall,
        prepareModelRequest: this.prepareModelRequest,
        sessionEvents: this.sessionEvents,
        toolExecutionGateway: this.toolExecutionGateway,
        toolResultArtifactSink: this.toolResultArtifactSink,
        operationBudget: this.operationBudget,
      },
      toolExecution: "sequential",
      steeringMode: this.settings.steeringMode ?? "one-at-a-time",
      followUpMode: this.settings.followUpMode ?? "one-at-a-time",
    });
    this.unsubscribeAgent = this.agent.subscribe((event) => this.dispatch(event));
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

  private async persistSelection(source: "model" | "thinking"): Promise<void> {
    const config = this.configSnapshot();
    this.settings = {
      ...this.settings,
      provider: config.provider,
      model: config.model,
      thinkingLevel: config.thinkingLevel,
    };
    await saveProjectSettings(this.cwd, this.settings);
    if (this.ledger) await appendRuntimeConfig(this.ledger, config, source);
  }
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
  const thinkingLevel = cli.thinkingLevel ?? session.thinkingLevel ?? settings.thinkingLevel ?? "off";

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
  if (!model && (opts.overrides?.provider || opts.overrides?.model)) {
    throw new Error(`Unknown model selection: ${provider ?? "<provider>"}/${modelId ?? "<model>"}`);
  }
  if (!model) model = (await opts.models.getAvailable())[0];
  return {
    provider: model?.provider ?? provider,
    model,
    thinkingLevel: model ? clampThinkingLevel(model, thinkingLevel) : thinkingLevel,
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

function productionTools(cwd: string): AgentTool[] {
  const excluded = new Set(["Skill", "NotebookEdit", "echo"]);
  return createStdlibTools(cwd).toContext().filter((tool) => !excluded.has(tool.name));
}
