/**
 * Agent 类 —— 包装 runAgentLoop 的 stateful surfaces,对齐参考 pi 的 `Agent`。
 *
 * 本期只暴露最小 API:
 *   Agent({ initialState, streamFn, ledger?, convertToLlm? })
 *   subscribe(listener)
 *   on(type, handler)
 *   prompt(text | prompts)
 *
 * `// TODO(pi): AgentHarness / compaction 封装`
 */

import { runAgentLoop, defaultConvertToLlm } from "./agent-loop.ts";
import type { LedgerSink } from "./ledger/types.ts";
import type {
  AgentContext,
  AgentEvent,
  AgentEventSink,
  AgentLoopConfig,
  AgentMessage,
  AgentState,
  AgentTool,
  QueueMode,
  StreamFn,
  UserAgentMessage,
} from "./types.ts";
import type { AssistantMessage, Message, ModelThinkingLevel } from "../types.ts";
import { clampThinkingLevel } from "../models.ts";
import type { TraceRecorderFactory } from "./trace/composition.ts";
import type { AgentTelemetryConfig } from "./telemetry/telemetry.ts";
import { newId } from "./ledger/types.ts";

export interface EphemeralTurnRequest {
  readonly promptText: string;
  readonly requestId?: string;
  readonly signal?: AbortSignal;
  readonly ownerGeneration?: number;
  readonly activityGeneration?: number;
  /** Bounded, non-secret failure observation for the owner-side side channel. */
  readonly onDiagnostic?: (diagnostic: EphemeralTurnDiagnostic) => void;
}

export const EPHEMERAL_TURN_DIAGNOSTIC_CODES = [
  "router_denied",
  "auth_missing",
  "provider_timeout",
  "provider_error",
  "malformed_response",
  "empty_response",
  "aborted",
] as const;

export type EphemeralTurnDiagnosticCode = (typeof EPHEMERAL_TURN_DIAGNOSTIC_CODES)[number];

export interface EphemeralTurnDiagnostic {
  readonly kind: "idle-recap";
  readonly requestId: string;
  readonly code: EphemeralTurnDiagnosticCode;
  readonly ownerGeneration?: number;
  readonly activityGeneration?: number;
}

export interface EphemeralTurnResult {
  readonly requestId: string;
  readonly replyText: string;
  readonly assistantMessage: AssistantMessage;
}

/** Idle recap is a bounded, non-retrying side request rather than a normal model turn. */
export const IDLE_RECAP_MAX_TOKENS = 128;
export const IDLE_RECAP_TIMEOUT_MS = 30_000;
export const IDLE_RECAP_MAX_RETRIES = 0;

export interface AgentOptions {
  initialState: {
    systemPrompt: string;
    model: AgentState["model"];
    tools?: AgentTool[];
    messages?: AgentMessage[];
    thinkingLevel?: ModelThinkingLevel;
  };
  /** 必填:LLM 调用入口;默认应该传 mockStreamFn */
  streamFn: StreamFn;
  /** 可选:ledger(缺省时不落盘) */
  ledger?: LedgerSink;
  /** 可选:自定义 convertToLlm,默认 = defaultConvertToLlm */
  convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  /** 可选:其他 loop config 字段,通过 spread 透传 */
  loopConfig?: Partial<
    Omit<AgentLoopConfig, "model" | "convertToLlm" | "toolExecution" | "tools">
  >;
  /** 可选:toolExecution 默认 sequential */
  toolExecution?: "sequential" | "parallel";
  /** 可选 AbortSignal */
  signal?: AbortSignal;
  steeringMode?: QueueMode;
  followUpMode?: QueueMode;
  /** 每个 prompt/run 创建独立 recorder；不得跨 run 复用有状态 recorder。 */
  traceRecorderFactory?: TraceRecorderFactory;
  /**
   * 可选:OpenTelemetry 插桩配置。prompt() 转发到 loop config(镜像
   * traceRecorderFactory 模式);不传时 agent loop 零 tracer 查找。
   */
  telemetry?: AgentTelemetryConfig;
}

class PendingMessageQueue {
  private messages: UserAgentMessage[] = [];
  mode: QueueMode;

  constructor(mode: QueueMode) {
    this.mode = mode;
  }

  enqueue(message: UserAgentMessage): void {
    this.messages.push(message);
  }

  snapshot(): UserAgentMessage[] {
    return this.messages.slice();
  }

  drain(): UserAgentMessage[] {
    if (this.mode === "all") {
      const drained = this.messages.slice();
      this.messages = [];
      return drained;
    }
    const first = this.messages[0];
    if (!first) return [];
    this.messages = this.messages.slice(1);
    return [first];
  }

  clear(): UserAgentMessage[] {
    const cleared = this.messages.slice();
    this.messages = [];
    return cleared;
  }
}

export class Agent {
  private _state: AgentState;
  private _streamFn: StreamFn;
  private readonly _ledger: LedgerSink | undefined;
  private readonly _convertToLlm: (messages: AgentMessage[]) => Promise<Message[]> | Message[];
  private readonly subscribers: Set<AgentEventSink>;
  private _loopConfig: Partial<AgentLoopConfig>;
  private readonly _toolExecution: "sequential" | "parallel";
  private readonly _signal?: AbortSignal;
  private readonly _traceRecorderFactory: TraceRecorderFactory | undefined;
  private readonly _telemetryConfig: AgentTelemetryConfig | undefined;
  private readonly steeringQueue: PendingMessageQueue;
  private readonly followUpQueue: PendingMessageQueue;
  /** M8c:中断当前 turn 用的内部 controller;每次 prompt() 重建 */
  private _abortController: AbortController | undefined;
  /** true 当 prompt() 在 flight;用于 interrupt 区分 cold/warm 状态 */
  private _inFlight: boolean = false;
  private _activePromise: Promise<AgentMessage[]> | undefined;

  constructor(opts: AgentOptions) {
    this._state = {
      systemPrompt: opts.initialState.systemPrompt,
      messages: opts.initialState.messages?.slice() ?? [],
      tools: opts.initialState.tools ?? [],
      model: opts.initialState.model,
      thinkingLevel: clampThinkingLevel(
        opts.initialState.model,
        opts.initialState.thinkingLevel ?? "off",
      ),
    };
    this._streamFn = opts.streamFn;
    this._ledger = opts.ledger;
    this._convertToLlm = opts.convertToLlm ?? defaultConvertToLlm;
    this._loopConfig = opts.loopConfig ?? {};
    this._toolExecution = opts.toolExecution ?? "sequential";
    this._signal = opts.signal;
    this._traceRecorderFactory = opts.traceRecorderFactory;
    this._telemetryConfig = opts.telemetry;
    this.steeringQueue = new PendingMessageQueue(opts.steeringMode ?? "one-at-a-time");
    this.followUpQueue = new PendingMessageQueue(opts.followUpMode ?? "one-at-a-time");
    this.subscribers = new Set();
  }

  /** 当前快照(返回副本) */
  get state(): AgentState {
    return {
      systemPrompt: this._state.systemPrompt,
      messages: this._state.messages.slice(),
      tools: this._state.tools.slice(),
      model: this._state.model,
      thinkingLevel: this._state.thinkingLevel,
    };
  }

  setTools(tools: AgentTool[]): void {
    this._state.tools = tools.slice();
  }

  /** Prompt admission may replace the governed provider stream between runs. */
  setStreamFn(streamFn: StreamFn): void {
    if (this._inFlight) throw new Error("cannot replace streamFn during an active run");
    this._streamFn = streamFn;
  }

  /** Prompt admission may adopt a new immutable loop policy between runs. */
  setLoopConfig(config: Partial<AgentLoopConfig>): void {
    if (this._inFlight) throw new Error("cannot replace loop config during an active run");
    this._loopConfig = { ...this._loopConfig, ...config };
  }

  setSystemPrompt(prompt: string): void {
    this._state.systemPrompt = prompt;
  }

  setModel(model: AgentState["model"]): void {
    this._state.model = model;
    this._state.thinkingLevel = clampThinkingLevel(model, this._state.thinkingLevel);
  }

  setThinkingLevel(level: ModelThinkingLevel): ModelThinkingLevel {
    const effective = clampThinkingLevel(this._state.model, level);
    this._state.thinkingLevel = effective;
    return effective;
  }

  /**
   * M8c:中断当前正在跑的 turn。仅当 prompt() in flight 时生效;
   * 冷状态下调用为 no-op。abort 会让 runAgentLoop 在 turn 起点 / tool-execute 中途
   * 触发 stopReason="aborted" 终止;mock 与 anthropic stream 都已支持 signal.aborted 路径。
   */
  interrupt(): void {
    if (this._inFlight && this._abortController) {
      this._abortController.abort();
    }
  }

  /** 是否在 flight;供 TUI 状态指示器语义查询。 */
  get inFlight(): boolean {
    return this._inFlight;
  }

  get steeringMode(): QueueMode {
    return this.steeringQueue.mode;
  }

  set steeringMode(mode: QueueMode) {
    this.steeringQueue.mode = mode;
  }

  get followUpMode(): QueueMode {
    return this.followUpQueue.mode;
  }

  set followUpMode(mode: QueueMode) {
    this.followUpQueue.mode = mode;
  }

  steer(input: string | UserAgentMessage): void {
    this.steeringQueue.enqueue(normalizePrompts(input)[0]!);
    void this.emitQueueUpdate();
  }

  followUp(input: string | UserAgentMessage): void {
    this.followUpQueue.enqueue(normalizePrompts(input)[0]!);
    void this.emitQueueUpdate();
  }

  getSteeringMessages(): readonly UserAgentMessage[] {
    return this.steeringQueue.snapshot();
  }

  getFollowUpMessages(): readonly UserAgentMessage[] {
    return this.followUpQueue.snapshot();
  }

  clearAllQueues(): { steering: UserAgentMessage[]; followUp: UserAgentMessage[] } {
    const cleared = {
      steering: this.steeringQueue.clear(),
      followUp: this.followUpQueue.clear(),
    };
    void this.emitQueueUpdate();
    return cleared;
  }

  waitForIdle(): Promise<void> {
    return this._activePromise?.then(() => undefined, () => undefined) ?? Promise.resolve();
  }

  /**
   * 订阅所有事件。返回 unsubscribe 函数。
   */
  subscribe(listener: AgentEventSink): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  /**
   * 仅订阅某种事件类型。
   */
  on<T extends AgentEvent["type"]>(
    type: T,
    handler: (event: Extract<AgentEvent, { type: T }>) => void | Promise<void>,
  ): () => void {
    const sink: AgentEventSink = (event) => {
      if (event.type === type) {
        return handler(event as Extract<AgentEvent, { type: T }>);
      }
    };
    return this.subscribe(sink);
  }

  /**
   * 提交一段文本(或预组装的 user 消息),跑一轮 agent loop,await 到 messages 返回。
   */
  async prompt(input: string | UserAgentMessage | UserAgentMessage[]): Promise<AgentMessage[]> {
    if (this._inFlight) {
      throw new Error("Agent is already processing. Use steer() or followUp().");
    }
    const prompts: UserAgentMessage[] = normalizePrompts(input);
    const context: AgentContext = {
      systemPrompt: this._state.systemPrompt,
      messages: this._state.messages.slice(),
      tools: this._state.tools,
    };
    const traceRecorder = this._traceRecorderFactory
      ? await this._traceRecorderFactory.create({ sessionId: this._ledger?.sessionId ?? "<no-ledger>" })
      : this._loopConfig.traceRecorder;
    const config: AgentLoopConfig = {
      ...this._loopConfig,
      model: this._state.model,
      requestKind: "interactive",
      reasoning: this._state.thinkingLevel,
      apiKey: this._loopConfig.apiKey,
      convertToLlm: this._convertToLlm as AgentLoopConfig["convertToLlm"],
      toolExecution: this._toolExecution,
      // ledger 已是 AgentLoopConfig 第一公民,直接挂入类型契约
      ledger: this._ledger,
      traceRecorder,
      telemetry: this._telemetryConfig,
      getSteeringMessages: async () => {
        const drained = this.steeringQueue.drain();
        await this.emitQueueUpdate();
        return drained;
      },
      getFollowUpMessages: async () => {
        const drained = this.followUpQueue.drain();
        await this.emitQueueUpdate();
        return drained;
      },
    };
    // M8c:每次 prompt() 实例化新 AbortController,使 interrupt 在 inflight 期间可触发
    this._abortController = new AbortController();
    // 若外部 signal 已传入,绑一个转发,确保外部 abort 也能传到本 controller
    let removeExternalAbort: (() => void) | undefined;
    if (this._signal) {
      const externalSignal = this._signal;
      const onExternalAbort = () => this._abortController?.abort();
      if (externalSignal.aborted) {
        this._abortController.abort();
      } else {
        externalSignal.addEventListener("abort", onExternalAbort, { once: true });
        removeExternalAbort = () => externalSignal.removeEventListener("abort", onExternalAbort);
      }
    }
    this._inFlight = true;
    let startedRun: Extract<AgentEvent, { type: "agent_start" }> | undefined;
    let completionSeen = false;
    const dispatchRunEvent = async (event: AgentEvent): Promise<void> => {
      if (event.type === "agent_start") startedRun = event;
      if (event.type === "agent_end") completionSeen = true;
      const runId = startedRun?.runId;
      const enriched = event.runId === undefined && runId !== undefined
        ? { ...event, runId }
        : event;
      await this.dispatch(enriched);
    };
    const run = runAgentLoop(
      prompts,
      context,
      config,
      dispatchRunEvent,
      this._abortController.signal,
      this._streamFn,
    );
    this._activePromise = run;
    try {
      const finalMessages = await run;
      // 更新本地 state
      this._state.messages = finalMessages.slice();
      // 给 ledger 追加 sessionId 占位的最终 custom entry(可选)
      return finalMessages;
    } catch (error) {
      if (startedRun !== undefined && !completionSeen) {
        const timestamp = Date.now();
        const elapsedMs = Math.max(0, timestamp - startedRun.timestamp);
        await dispatchRunEvent({
          type: "agent_end",
          timestamp,
          runId: startedRun.runId,
          stopReason: this._abortController.signal.aborted ? "aborted" : "error",
          elapsedMs,
          activeDurationMs: elapsedMs,
          messageCountAtEnd: context.messages.length,
        });
      }
      throw error;
    } finally {
      removeExternalAbort?.();
      this._inFlight = false;
      this._activePromise = undefined;
      this._abortController = undefined;
    }
  }

  /**
   * Run a provider completion against a snapshot of the current Agent context.
   *
   * This is deliberately not implemented in terms of prompt()/runAgentLoop():
   * idle recap is a transient side channel and must not append messages, emit
   * AgentEvents, execute tools, or write the ledger.  The returned assistant
   * message is restricted to text content so a provider tool call can never
   * cross this seam into tool execution.
   */
  async runEphemeralTurn(input: EphemeralTurnRequest): Promise<EphemeralTurnResult | undefined> {
    const requestId = input.requestId ?? `idle-recap-${newId()}`;
    let diagnosticReported = false;
    const reportDiagnostic = (code: EphemeralTurnDiagnosticCode): void => {
      if (diagnosticReported) return;
      diagnosticReported = true;
      try {
        input.onDiagnostic?.({
          kind: "idle-recap",
          requestId,
          code,
          ...(input.ownerGeneration === undefined ? {} : { ownerGeneration: input.ownerGeneration }),
          ...(input.activityGeneration === undefined ? {} : { activityGeneration: input.activityGeneration }),
        });
      } catch {
        // Diagnostics are observational and must not change side-channel failure semantics.
      }
    };
    const externalSignal = input.signal ?? this._signal;
    if (externalSignal?.aborted) {
      reportDiagnostic("aborted");
      return undefined;
    }
    const deadline = new AbortController();
    const forwardAbort = (): void => deadline.abort(externalSignal?.reason);
    externalSignal?.addEventListener("abort", forwardAbort, { once: true });
    let timeoutExpired = false;
    const timeout = setTimeout(() => {
      timeoutExpired = true;
      deadline.abort();
    }, IDLE_RECAP_TIMEOUT_MS);
    timeout.unref?.();
    const signal = deadline.signal;

    const model = this._state.model;
    const snapshotSystemPrompt = this._state.systemPrompt;
    const snapshotThinkingLevel = this._state.thinkingLevel;
    const snapshotMessages = this._state.messages.slice();
    const snapshotTools = this._state.tools.slice();
    const contextMessages: AgentMessage[] = [
      ...snapshotMessages,
      {
        role: "user",
        content: [{
          type: "text",
          text: "This is an idle recap side request. Do not call tools or propose tool calls; reply with plain text only.",
        }],
      },
      {
        role: "user",
        content: [{ type: "text", text: input.promptText }],
      },
    ];

    try {
      const messages = await this._convertToLlm(contextMessages);
      const ownerLineage = input.ownerGeneration === undefined ? "" : `:owner-${input.ownerGeneration}`;
      const activityLineage = input.activityGeneration === undefined ? "" : `:activity-${input.activityGeneration}`;
      const sideSessionId = `${this.sessionId}:idle-recap:${requestId}${ownerLineage}${activityLineage}`;
      const stream = await Promise.resolve(this._streamFn(model, {
        systemPrompt: snapshotSystemPrompt,
        messages,
        tools: snapshotTools,
      }, {
        apiKey: this._loopConfig.apiKey,
        env: this._loopConfig.env,
        signal,
        sessionId: sideSessionId,
        metadata: {
          requestKind: "idle-recap",
          requestId,
          ...(input.ownerGeneration === undefined ? {} : { ownerGeneration: input.ownerGeneration }),
          ...(input.activityGeneration === undefined ? {} : { activityGeneration: input.activityGeneration }),
        },
        maxTokens: IDLE_RECAP_MAX_TOKENS,
        timeoutMs: IDLE_RECAP_TIMEOUT_MS,
        maxRetries: IDLE_RECAP_MAX_RETRIES,
        ...(snapshotThinkingLevel !== "off" ? { reasoning: snapshotThinkingLevel } : {}),
      }));

      let providerMessage: AssistantMessage | undefined;
      const streamedText: string[] = [];
      for await (const event of stream) {
        if (signal?.aborted) {
          reportDiagnostic(timeoutExpired ? "provider_timeout" : "aborted");
          return undefined;
        }
        if (event.type === "text_delta") streamedText.push(event.delta);
        if (event.type === "done" || event.type === "error") providerMessage = event.type === "done" ? event.message : event.error;
      }
      if (signal?.aborted) {
        reportDiagnostic(timeoutExpired ? "provider_timeout" : "aborted");
        return undefined;
      }
      if (providerMessage === undefined) {
        reportDiagnostic("malformed_response");
        return undefined;
      }
      if (providerMessage.stopReason === "error" || providerMessage.stopReason === "aborted") {
        reportDiagnostic(providerMessage.stopReason === "aborted" ? (timeoutExpired ? "provider_timeout" : "aborted") : classifyEphemeralProviderError(providerMessage.errorMessage));
        return undefined;
      }
      if (!Array.isArray(providerMessage.content)) {
        reportDiagnostic("malformed_response");
        return undefined;
      }

      const textContent = providerMessage.content.filter(
        (part): part is Extract<AssistantMessage["content"][number], { type: "text" }> => part.type === "text",
      );
      const effectiveText = textContent.length > 0 ? textContent : streamedText.length > 0
        ? [{ type: "text" as const, text: streamedText.join("") }]
        : [];
      const replyText = effectiveText.map((part) => part.text).join("");
      if (replyText.trim().length === 0) {
        reportDiagnostic("empty_response");
        return undefined;
      }

      return {
        requestId,
        replyText,
        assistantMessage: {
          ...providerMessage,
          content: effectiveText,
        },
      };
    } catch (error) {
      reportDiagnostic(timeoutExpired ? "provider_timeout" : classifyEphemeralProviderError(error instanceof Error ? error.message : undefined));
      // A transient recap failure must not affect the ordinary prompt lifecycle.
      return undefined;
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", forwardAbort);
    }
  }

  /** ledger 句柄(便于外部读取) */
  get ledger(): LedgerSink | undefined {
    return this._ledger;
  }

  /** session id (取自 ledger / 否则随机) */
  get sessionId(): string {
    return this._ledger?.sessionId ?? "<no-ledger>";
  }

  /** 内部:把事件 fan-out 给所有订阅者 */
  private async dispatch(ev: AgentEvent): Promise<void> {
    await Promise.all(
      Array.from(this.subscribers).map(async (sub) => {
        try {
          await sub(ev);
        } catch {
          // sink 抛错吞掉,避免影响 agent 循环
        }
      }),
    );
  }

  private async emitQueueUpdate(): Promise<void> {
    await this.dispatch({
      type: "queue_update",
      timestamp: Date.now(),
      steering: this.steeringQueue.snapshot(),
      followUp: this.followUpQueue.snapshot(),
    });
  }
}

function classifyEphemeralProviderError(errorMessage: string | undefined): EphemeralTurnDiagnosticCode {
  const message = errorMessage ?? "";
  if (/model route denied\s*\(/iu.test(message)) return "router_denied";
  if (/provider is not configured|missing\s+(?:an?\s+)?(?:api\s+)?key|authentication required|auth(?:entication)?\s+(?:is\s+)?missing/iu.test(message)) return "auth_missing";
  if (/tim(?:e|ed)\s*out|timeout|deadline exceeded/iu.test(message)) return "provider_timeout";
  return "provider_error";
}

function normalizePrompts(input: string | UserAgentMessage | UserAgentMessage[]): UserAgentMessage[] {
  if (typeof input === "string") {
    return [{ role: "user", content: [{ type: "text", text: input }] }];
  }
  if (Array.isArray(input)) {
    return input;
  }
  return [input];
}
