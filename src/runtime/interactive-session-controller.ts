import type { AuthInteraction, AuthType, Credential } from "../auth/types.ts";
import { clampThinkingLevel, type Models, type Provider } from "../models.ts";
import type { Api, Model, ModelThinkingLevel } from "../types.ts";
import type { ProjectSettings } from "../storage/settings-manager.ts";
import { updateProjectSettings } from "../storage/settings-manager.ts";
import { SettingsResolver, type EffectiveRuntimeSettingsSnapshot } from "../storage/settings-resolver.ts";
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
	CompactionSummarizer,
} from "./types.ts";
import { DEFAULT_AGENT_RUN_BUDGET } from "./types.ts";
import type { ExtensionHookRuntime, ExtensionHookRuntimeResult } from "../extensions/turn-lifecycle.ts";
import type { ContextAssemblySink, ModelContextAssembler } from "./types.ts";
import type { LedgerSink } from "./ledger/types.ts";
import type { SessionDomainMutationContext, SessionDomainRequestContext, SessionDomainResult } from "./session-runtime/domain-router.ts";
import type { AgentRunSummary } from "./session-runtime/run-timing.ts";
import type { LedgerEntry } from "./ledger/types.ts";
import { createStdlibTools } from "./tools/index.ts";
import type { AgentTelemetryConfig } from "./telemetry/telemetry.ts";
import { flushTelemetryExport } from "./telemetry/otel-export.ts";
import {
  AllowAllToolAuthorizationPolicy,
  authorizationBeforeToolCall,
} from "./tool-authorization.ts";
import type { TraceRecorderFactory } from "./trace/composition.ts";
import type { ExecutionEnv } from "./execution-env.ts";
import {
	createChildModelRuntimeFactory,
	createProviderRequestGate,
	createSessionModelStreamFn,
	type ChildModelRequestRouter,
	type ChildModelRuntimeFactoryPort,
	type ProviderRequestGate,
} from "./agents/child-model-runtime.ts";
import type { RetryPolicy } from "./retry/policy.ts";
import { resolveProviderPolicy, type ProviderPolicyProjection, type ToolPolicyProjection } from "../storage/settings-policies.ts";

export interface ModelRequestRouter extends ChildModelRequestRouter {}

function settingsRuntimeConfig(
	settings: EffectiveRuntimeSettingsSnapshot,
): Pick<SessionRuntimeConfig, "settingsDigest" | "settingsSourceLayers" | "settingsApplyModes" | "settingsDiagnostics"> {
	return {
		settingsDigest: settings.digest.digest,
		settingsSourceLayers: { ...settings.sourceLayers },
		settingsApplyModes: { ...settings.applyModes },
		settingsDiagnostics: settings.diagnostics.map(({ code, path, source }) => ({
			code,
			path,
			...(source === undefined ? {} : { source }),
		})),
	};
}

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
  /** Composition 注入的 immutable effective settings；每个 Session/turn 只消费这一份。 */
  runtimeSettings?: EffectiveRuntimeSettingsSnapshot;
  /** Host prompt admission supplies exactly one immutable snapshot per new run. */
  runtimeSettingsForTurn?: () => EffectiveRuntimeSettingsSnapshot | Promise<EffectiveRuntimeSettingsSnapshot>;
  replay: SessionReplay;
  ledger: LedgerSink;
  overrides?: RuntimeSelectionOverrides;
  tools?: AgentTool[];
  /** Rebuild governed tools when a next-turn policy snapshot is adopted. */
  toolsForRuntimeSettings?: (settings: EffectiveRuntimeSettingsSnapshot) => AgentTool[];
  authorizationPolicy?: ToolAuthorizationPolicy;
  traceRecorderFactory?: TraceRecorderFactory;
  /** OTEL 插桩配置;转发到 Agent(loop chat/tool span)与 oneshot 调用点。 */
  telemetry?: AgentTelemetryConfig;
  executionEnv?: ExecutionEnv;
  toolResultOverflowStore?: ToolResultOverflowStore;
  /** Host-owned bounded model request assembly; local tests may omit it. */
  modelContextAssembler?: ModelContextAssembler;
  /** Host-owned canonical receipt sink; local tests may omit it. */
  contextAssemblySink?: ContextAssemblySink;
  /** Host-owned compatibility gate; provider dispatch is forbidden when it denies. */
  modelRequestRouter?: ModelRequestRouter;
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
  /** 当前 Session turn 使用的 immutable retry policy。 */
  retryPolicy?: RetryPolicy;
	/** Host-owned provider gate shared by the Session side requests and child runtime. */
	providerGate?: ProviderRequestGate;
	/** Host-owned model path for automatic/manual/overflow compaction. */
	compactionSummarizer?: CompactionSummarizer;
	/** Rebuilds the Host summarizer when next-turn retry/provider policy changes. */
	compactionSummarizerForRuntimeSettings?: (settings: EffectiveRuntimeSettingsSnapshot) => CompactionSummarizer;
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
  subscribe(listener: AgentEventSink): () => void;
	/** Optional durable title-event subscription; absent on legacy/local controllers. */
	readonly subscribeSessionTitleChanged?: (listener: SessionTitleChangedSink) => () => void;
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
  private runtimeSettings: EffectiveRuntimeSettingsSnapshot;
	private readonly runtimeSettingsForTurn: InteractiveSessionControllerOptions["runtimeSettingsForTurn"];
  private readonly replay: SessionReplay;
  private readonly ledgerSink: LedgerSink;
  private tools: AgentTool[];
	private readonly toolsForRuntimeSettings: InteractiveSessionControllerOptions["toolsForRuntimeSettings"];
	private readonly additionalTools: AgentTool[] = [];
  private readonly policy: ToolAuthorizationPolicy;
  private readonly traceRecorderFactory: TraceRecorderFactory | undefined;
  private readonly telemetryConfig: AgentTelemetryConfig | undefined;
  private readonly executionEnv: ExecutionEnv | undefined;
  private readonly toolResultOverflowStore: ToolResultOverflowStore | undefined;
  private readonly modelContextAssembler: ModelContextAssembler | undefined;
  private readonly contextAssemblySink: ContextAssemblySink | undefined;
  private readonly modelRequestRouter: ModelRequestRouter | undefined;
  private readonly extensionHookRuntime: ExtensionHookRuntime | undefined;
  private readonly extensionHookSnapshotId: (() => string | undefined) | undefined;
  private readonly extensionTurnAdmission: (() => Promise<void>) | undefined;
  private readonly extensionTurnAbort: (() => Promise<void>) | undefined;
  private readonly runBudget: AgentRunBudget;
  private readonly runBudgetUsage: AgentRunBudgetUsage | undefined;
	private retryPolicy: RetryPolicy | undefined;
	private providerPolicy: ProviderPolicyProjection;
	private readonly providerGate: ProviderRequestGate;
	private compactionSummarizer: CompactionSummarizer | undefined;
	private readonly compactionSummarizerForRuntimeSettings: InteractiveSessionControllerOptions["compactionSummarizerForRuntimeSettings"];
	private readonly onAcceptedUserPrompt: ((text: string) => void) | undefined;
	private readonly onModelSelectionChanged: (() => void) | undefined;
  private readonly listeners = new Set<AgentEventSink>();
  private selection: RuntimeSelection;
  private agent: Agent | undefined;
  private unsubscribeAgent: (() => void) | undefined;

  private constructor(
    opts: InteractiveSessionControllerOptions,
    selection: RuntimeSelection,
  ) {
    this.cwd = opts.cwd;
    this.layout = opts.layout;
    this.systemPrompt = opts.systemPrompt;
    this.models = opts.models;
    this.settings = { ...opts.settings };
    this.runtimeSettings = opts.runtimeSettings ?? new SettingsResolver({ user: opts.settings }).effectiveRuntimeSnapshot();
	this.runtimeSettingsForTurn = opts.runtimeSettingsForTurn;
    this.replay = opts.replay;
    this.ledgerSink = opts.ledger;
    this.toolsForRuntimeSettings = opts.toolsForRuntimeSettings
		?? (opts.tools === undefined ? (settings) => productionTools(opts.cwd, opts.executionEnv, settings.toolPolicy) : undefined);
    this.tools = opts.tools ?? this.toolsForRuntimeSettings?.(this.runtimeSettings) ?? [];
    this.policy = opts.authorizationPolicy ?? new AllowAllToolAuthorizationPolicy();
    this.traceRecorderFactory = opts.traceRecorderFactory;
    this.telemetryConfig = opts.telemetry;
    this.executionEnv = opts.executionEnv;
    this.toolResultOverflowStore = opts.toolResultOverflowStore;
    this.modelContextAssembler = opts.modelContextAssembler;
    this.contextAssemblySink = opts.contextAssemblySink;
    this.modelRequestRouter = opts.modelRequestRouter;
    this.extensionHookRuntime = opts.extensionHookRuntime;
    this.extensionHookSnapshotId = opts.extensionHookSnapshotId;
    this.extensionTurnAdmission = opts.extensionTurnAdmission;
    this.extensionTurnAbort = opts.extensionTurnAbort;
    this.runBudget = opts.runBudget ?? DEFAULT_AGENT_RUN_BUDGET;
    this.runBudgetUsage = opts.runBudgetUsage;
    // composition root 注入 snapshot 时，legacy retryPolicy 仅保留兼容类型，
    // 不得覆盖当前 Session 已冻结的 effective policy。
    this.retryPolicy = opts.runtimeSettings === undefined
      ? (opts.retryPolicy ?? this.runtimeSettings.retry)
      : this.runtimeSettings.retry;
	this.providerPolicy = this.runtimeSettings.providerPolicy;
	this.providerGate = opts.providerGate ?? createProviderRequestGate(this.providerPolicy);
	this.compactionSummarizerForRuntimeSettings = opts.compactionSummarizerForRuntimeSettings;
	this.compactionSummarizer = opts.compactionSummarizer ?? opts.compactionSummarizerForRuntimeSettings?.(this.runtimeSettings);
	this.onAcceptedUserPrompt = opts.onAcceptedUserPrompt;
	this.onModelSelectionChanged = opts.onModelSelectionChanged;
    this.selection = selection;
    this.ensureAgent();
  }

  static async create(opts: InteractiveSessionControllerOptions): Promise<InteractiveSessionController> {
    const selection = await resolveInitialSelection(opts);
    const controller = new InteractiveSessionController(opts, selection);
    if (selection.model) {
		await appendRuntimeConfig(
			opts.ledger,
			{ ...controller.configSnapshot(), ...settingsRuntimeConfig(controller.runtimeSettings) },
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
    return this.agent?.inFlight ?? false;
  }

  get currentSelection(): RuntimeSelection {
    return { ...this.selection };
  }

  /** 当前 Session/turn 使用的不可变 settings snapshot；不暴露 raw JSON。 */
  runtimeSettingsSnapshot(): EffectiveRuntimeSettingsSnapshot {
    return this.runtimeSettings;
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

  get ledger(): LedgerSink {
    return this.ledgerSink;
  }

  get toolCount(): number {
    return this.tools.length;
  }

  /** 在 policy receipt/root registration 完成后加入 Session-owned tools。 */
  addTools(tools: readonly AgentTool[]): void {
    const existing = new Set(this.tools.map((tool) => tool.name));
    for (const tool of tools) {
      if (existing.has(tool.name)) throw new Error(`duplicate Session tool: ${tool.name}`);
      existing.add(tool.name);
	  this.additionalTools.push(tool);
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
	    const policyFiltered = applyProviderPolicy(available, this.providerPolicy);
	    const enabled = this.settings.enabledModels;
	    if (!enabled || enabled.length === 0) return policyFiltered;
	    return policyFiltered.filter((model) => enabled.some((entry) =>
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
	if (this.providerPolicy.disabledProviders?.includes(model.provider)) {
		throw new Error(`Provider ${model.provider} is disabled by settings`);
	}
    // 命令面只传 { provider, id } 等最小形状,按 catalog 解析完整 model
    // (baseUrl/api/reasoning/compat 等),避免流式调用时字段缺失。
    const resolved = this.models.getModel(model.provider, model.id) ?? model;
    const thinkingLevel = clampThinkingLevel(resolved, "high");
		this.selection = { provider: resolved.provider, model: resolved, thinkingLevel };
		this.onModelSelectionChanged?.();
		this.ensureAgent();
    this.agent?.setModel(resolved);
    this.agent?.setThinkingLevel(thinkingLevel);
    await this.persistSelection("model");
  }

  async setThinkingLevel(level: ModelThinkingLevel): Promise<ModelThinkingLevel> {
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
    if (agent.inFlight) {
      if (behavior === "followUp") agent.followUp(text);
      else agent.steer(text);
      return;
    }
	await this.admitRuntimeSettingsTurn();
	if (this.providerPolicy.disabledProviders?.includes(model.provider)) {
		throw new Error(`Provider ${model.provider} is disabled by settings`);
	}
    const auth = await this.models.getAuth(model);
    if (!auth) throw new Error(`Provider ${model.provider} is not configured. Use /login ${model.provider}.`);
    await this.extensionTurnAdmission?.();
    try {
      const submitted = await this.runExtensionHook("UserPromptSubmit", { text });
      if (submitted?.blocked || submitted?.decision === "deny" || submitted?.decision === "aborted") throw new Error("UserPromptSubmit hook denied the prompt");
	      const acceptedInput = promptText(submitted?.finalInput, text);
	      this.onAcceptedUserPrompt?.(acceptedInput);
	      await agent.prompt(acceptedInput);
	      // turn 边界 flush:长驻进程(Session Owner server)下让 span/metric/log
	      // 及时到达 collector,而不是等 batch 窗口。未启用时是廉价 no-op。
	      await flushTelemetryExport();
    } catch (error) {
      await this.extensionTurnAbort?.().catch(() => undefined);
      throw error;
    }
  }

	/** Run a transient completion through this Session's one Agent/model pipeline. */
	async runEphemeralTurn(request: EphemeralSessionTurnRequest): Promise<string | undefined> {
		const agent = this.agent;
		if (agent === undefined || this.selection.model === undefined || agent.state.messages.length === 0) return undefined;
		const result = await agent.runEphemeralTurn(request);
		return result?.replyText;
	}

  interrupt(): void {
    this.agent?.interrupt();
  }

  clearAllQueues(): { steering: UserAgentMessage[]; followUp: UserAgentMessage[] } {
    return this.agent?.clearAllQueues() ?? { steering: [], followUp: [] };
  }

  waitForIdle(): Promise<void> {
    return this.agent?.waitForIdle() ?? Promise.resolve();
  }

  dispose(): void {
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
	  getRetryPolicy: () => this.retryPolicy,
	  getProviderPolicy: () => this.providerPolicy,
	  providerGate: this.providerGate,
	  telemetry: this.telemetryConfig,
    });
	}

	/** Title/side-request composition must share this Session-wide gate. */
	get providerRequestGate(): ProviderRequestGate {
		return this.providerGate;
	}

	/** Exposes the immutable retry policy captured for this Session turn seam. */
	get retryPolicySnapshot(): RetryPolicy {
		return this.retryPolicy ?? this.runtimeSettings.retry;
	}

	private ensureAgent(): void {
    const model = this.selection.model;
    if (!model) return;
    if (this.agent) return;
    const streamFn: StreamFn = createSessionModelStreamFn({
      models: this.models,
      sessionId: this.sessionId,
      ...(this.modelRequestRouter === undefined ? {} : { modelRequestRouter: this.modelRequestRouter }),
      ...(this.retryPolicy === undefined ? {} : { retryPolicy: this.retryPolicy }),
	  providerPolicy: this.providerPolicy,
	  providerGate: this.providerGate,
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
        runtimeSettings: this.runtimeSettings,
		...(this.compactionSummarizer === undefined ? {} : { compactionSummarizer: this.compactionSummarizer }),
        beforeToolCall,
        afterToolCall,
        executionEnv: this.executionEnv,
        runBudget: this.runBudget,
        ...(this.runBudgetUsage === undefined ? {} : { runBudgetUsage: this.runBudgetUsage }),
        ...(this.toolResultOverflowStore === undefined ? {} : { toolResultOverflowStore: this.toolResultOverflowStore }),
        ...(this.modelContextAssembler === undefined ? {} : { modelContextAssembler: this.modelContextAssembler }),
        ...(this.contextAssemblySink === undefined ? {} : { contextAssemblySink: this.contextAssemblySink }),
      },
      toolExecution: "sequential",
      steeringMode: this.runtimeSettings.sessionPolicy.steeringMode,
      followUpMode: this.runtimeSettings.sessionPolicy.followUpMode,
      traceRecorderFactory: this.traceRecorderFactory,
      telemetry: this.telemetryConfig,
    });
    this.unsubscribeAgent = this.agent.subscribe((event) => this.dispatch(event));
  }

	private async admitRuntimeSettingsTurn(): Promise<void> {
		if (this.runtimeSettingsForTurn === undefined) return;
		const snapshot = await this.runtimeSettingsForTurn();
		const policyChanged = snapshot.digest.digest !== this.runtimeSettings.digest.digest;
		this.runtimeSettings = snapshot;
		this.retryPolicy = snapshot.retry;
		this.providerPolicy = snapshot.providerPolicy;
		this.providerGate.reconfigure?.(snapshot.providerPolicy);
		if (policyChanged && this.compactionSummarizerForRuntimeSettings !== undefined) {
			this.compactionSummarizer = this.compactionSummarizerForRuntimeSettings(snapshot);
		}
		if (this.toolsForRuntimeSettings !== undefined) {
			this.tools = [...this.toolsForRuntimeSettings(snapshot), ...this.additionalTools];
		}
		const agent = this.agent;
		if (agent === undefined) return;
		agent.setTools(this.tools);
		agent.steeringMode = snapshot.sessionPolicy.steeringMode;
		agent.followUpMode = snapshot.sessionPolicy.followUpMode;
		agent.setLoopConfig({
			runtimeSettings: snapshot,
			...(this.compactionSummarizer === undefined ? {} : { compactionSummarizer: this.compactionSummarizer }),
		});
		agent.setStreamFn(createSessionModelStreamFn({
			models: this.models,
			sessionId: this.sessionId,
			...(this.modelRequestRouter === undefined ? {} : { modelRequestRouter: this.modelRequestRouter }),
			retryPolicy: snapshot.retry,
			providerPolicy: snapshot.providerPolicy,
			providerGate: this.providerGate,
		}));
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

  private async persistSelection(source: "model" | "thinking"): Promise<void> {
    const config = this.configSnapshot();
	this.settings = await updateProjectSettings({ layout: this.layout }, (persisted) => ({
		...this.settings,
		...persisted,
		provider: config.provider,
		model: config.model,
		thinkingLevel: config.thinkingLevel,
	}));
		await appendRuntimeConfig(this.ledgerSink, { ...config, ...settingsRuntimeConfig(this.runtimeSettings) }, source);
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
	const providerPolicy = opts.runtimeSettings?.providerPolicy ?? resolveProviderPolicy(settings);
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
	if (!model && (opts.overrides?.provider || opts.overrides?.model)) {
    throw new Error(`Unknown model selection: ${provider ?? "<provider>"}/${modelId ?? "<model>"}`);
	}
	if (model !== undefined && providerPolicy.disabledProviders?.includes(model.provider)) {
		if (opts.overrides?.provider !== undefined || opts.overrides?.model !== undefined) {
			throw new Error(`Provider ${model.provider} is disabled by settings`);
		}
		model = undefined;
	}
	if (!model) model = applyProviderPolicy(await opts.models.getAvailable(), providerPolicy)[0];
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

function productionTools(cwd: string, executionEnv: ExecutionEnv | undefined, toolPolicy: ToolPolicyProjection): AgentTool[] {
  const excluded = new Set(["Skill", "NotebookEdit", "echo"]);
  return createStdlibTools(cwd, {
    requireExecutionEnv: true,
    ...(executionEnv === undefined ? {} : { executionEnv }),
    toolPolicy,
  }).toContext().filter((tool) => !excluded.has(tool.name));
}

function applyProviderPolicy(
	models: readonly Model<Api>[],
	policy: ProviderPolicyProjection,
): readonly Model<Api>[] {
	const disabled = new Set(policy.disabledProviders ?? []);
	return models.filter((model) => !disabled.has(model.provider));
}
