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
import type { Message, ModelThinkingLevel } from "../types.ts";
import { clampThinkingLevel } from "../models.ts";

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
  private readonly _streamFn: StreamFn;
  private readonly _ledger: LedgerSink | undefined;
  private readonly _convertToLlm: (messages: AgentMessage[]) => Promise<Message[]> | Message[];
  private readonly subscribers: Set<AgentEventSink>;
  private readonly _loopConfig: Partial<AgentLoopConfig>;
  private readonly _toolExecution: "sequential" | "parallel";
  private readonly _signal?: AbortSignal;
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
    const config: AgentLoopConfig = {
      ...this._loopConfig,
      model: this._state.model,
      reasoning: this._state.thinkingLevel,
      apiKey: this._loopConfig.apiKey,
      convertToLlm: this._convertToLlm as AgentLoopConfig["convertToLlm"],
      toolExecution: this._toolExecution,
      // ledger 已是 AgentLoopConfig 第一公民,直接挂入类型契约
      ledger: this._ledger,
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
    const run = runAgentLoop(
      prompts,
      context,
      config,
      (ev) => this.dispatch(ev),
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
    } finally {
      removeExternalAbort?.();
      this._inFlight = false;
      this._activePromise = undefined;
      this._abortController = undefined;
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

function normalizePrompts(input: string | UserAgentMessage | UserAgentMessage[]): UserAgentMessage[] {
  if (typeof input === "string") {
    return [{ role: "user", content: [{ type: "text", text: input }] }];
  }
  if (Array.isArray(input)) {
    return input;
  }
  return [input];
}
