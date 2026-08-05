import type { AuthInteraction, AuthType, Credential } from "../auth/types.ts";
import { clampThinkingLevel, type Models, type Provider } from "../models.ts";
import type { Api, Context, Model, ModelThinkingLevel } from "../types.ts";
import type { ProjectSettings } from "../storage/settings-manager.ts";
import { saveProjectSettings } from "../storage/settings-manager.ts";
import type { RunledgerLayout } from "./contracts/public.ts";
import type { SessionReplay, SessionRuntimeConfig } from "../storage/session-codec.ts";
import { appendRuntimeConfig } from "../storage/session-codec.ts";
import { Agent } from "./agent.ts";
import type {
  AgentEventSink,
  AgentMessage,
  AgentTool,
  QueueMode,
  StreamFn,
  ToolAuthorizationPolicy,
  ToolResultOverflowStore,
  UserAgentMessage,
} from "./types.ts";
import type { ContextAssemblySink, ModelContextAssembler } from "./types.ts";
import type { LedgerSink } from "./ledger/types.ts";
import type { LedgerEntry } from "./ledger/types.ts";
import { createStdlibTools } from "./tools/index.ts";
import {
  AllowAllToolAuthorizationPolicy,
  authorizationBeforeToolCall,
} from "./tool-authorization.ts";
import type { TraceRecorderFactory } from "./trace/composition.ts";
import type { ExecutionEnv } from "./execution-env.ts";

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
  /** Host-owned canonical receipt sink; local tests may omit it. */
  contextAssemblySink?: ContextAssemblySink;
}

export interface ProviderStatus {
  id: string;
  name: string;
  configured: boolean;
  source?: string;
  authTypes: AuthType[];
  interactiveAuthTypes: AuthType[];
}

/** Client-side contract shared by the Host-owned and local test controllers. */
export interface InteractiveSessionControllerPort {
  subscribe(listener: AgentEventSink): () => void;
  readonly sessionId: string;
  readonly inFlight: boolean;
  readonly currentSelection: RuntimeSelection;
  readonly messages: readonly AgentMessage[];
  readonly warnings: readonly string[];
  readonly auditEntries: readonly LedgerEntry[];
  readonly ledger?: LedgerSink;
  readonly toolCount: number;
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
  interrupt(): void;
  clearAllQueues(): { steering: UserAgentMessage[]; followUp: UserAgentMessage[] };
  waitForIdle(): Promise<void>;
  dispose(): void;
}

export interface RuntimeSelection {
  provider?: string;
  model?: Model<Api>;
  thinkingLevel: ModelThinkingLevel;
}

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
  private readonly contextAssemblySink: ContextAssemblySink | undefined;
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
    this.replay = opts.replay;
    this.ledgerSink = opts.ledger;
    this.tools = opts.tools ?? productionTools(opts.cwd, opts.executionEnv);
    this.policy = opts.authorizationPolicy ?? new AllowAllToolAuthorizationPolicy();
    this.traceRecorderFactory = opts.traceRecorderFactory;
    this.executionEnv = opts.executionEnv;
    this.toolResultOverflowStore = opts.toolResultOverflowStore;
    this.modelContextAssembler = opts.modelContextAssembler;
    this.contextAssemblySink = opts.contextAssemblySink;
    this.selection = selection;
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

  get ledger(): LedgerSink {
    return this.ledgerSink;
  }

  get toolCount(): number {
    return this.tools.length;
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
    const thinkingLevel = clampThinkingLevel(model, this.selection.thinkingLevel);
    this.selection = { provider: model.provider, model, thinkingLevel };
    this.ensureAgent();
    this.agent?.setModel(model);
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
    const auth = await this.models.getAuth(model);
    if (!auth) throw new Error(`Provider ${model.provider} is not configured. Use /login ${model.provider}.`);
    await agent.prompt(text);
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

  private ensureAgent(): void {
    const model = this.selection.model;
    if (!model) return;
    if (this.agent) return;
    const streamFn: StreamFn = (requestModel, context, options) =>
      this.models.streamSimple(requestModel, context as Context, options);
    const beforeToolCall = authorizationBeforeToolCall(this.policy);
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
        executionEnv: this.executionEnv,
        ...(this.toolResultOverflowStore === undefined ? {} : { toolResultOverflowStore: this.toolResultOverflowStore }),
        ...(this.modelContextAssembler === undefined ? {} : { modelContextAssembler: this.modelContextAssembler }),
        ...(this.contextAssemblySink === undefined ? {} : { contextAssemblySink: this.contextAssemblySink }),
      },
      toolExecution: "sequential",
      steeringMode: this.settings.steeringMode ?? "one-at-a-time",
      followUpMode: this.settings.followUpMode ?? "one-at-a-time",
      traceRecorderFactory: this.traceRecorderFactory,
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
    await saveProjectSettings({ layout: this.layout }, this.settings);
    await appendRuntimeConfig(this.ledgerSink, config, source);
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

function productionTools(cwd: string, executionEnv?: ExecutionEnv): AgentTool[] {
  const excluded = new Set(["Skill", "NotebookEdit", "echo"]);
  return createStdlibTools(cwd, executionEnv === undefined ? {} : { executionEnv }).toContext().filter((tool) => !excluded.has(tool.name));
}
