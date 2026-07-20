/**
 * Agent 类 —— 包装 runAgentLoop 的 stateful surfaces,对齐参考 pi 的 `Agent`。
 *
 * 本期只暴露最小 API:
 *   Agent({ initialState, streamFn, ledger?, convertToLlm? })
 *   subscribe(listener)
 *   on(type, handler)
 *   prompt(text | prompts)
 *
 * `// TODO(pi): steer / nextTurn / followUp / abort / state setters / harness 封装`
 */

import { runAgentLoop } from "./agent-loop.js";
import { newId } from "./ledger/types.js";
import type { LedgerSink } from "./ledger/types.js";
import { defaultConvertToLlm } from "./agent-loop.js";
import type {
  AgentContext,
  AgentEvent,
  AgentEventSink,
  AgentLoopConfig,
  AgentMessage,
  AgentState,
  AgentTool,
  Message,
  StreamFn,
  TextContent,
  UserAgentMessage,
} from "./types.js";

export interface AgentOptions {
  initialState: {
    systemPrompt: string;
    model: AgentState["model"];
    tools?: AgentTool[];
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

  constructor(opts: AgentOptions) {
    this._state = {
      systemPrompt: opts.initialState.systemPrompt,
      messages: [],
      tools: opts.initialState.tools ?? [],
      model: opts.initialState.model,
    };
    this._streamFn = opts.streamFn;
    this._ledger = opts.ledger;
    this._convertToLlm = opts.convertToLlm ?? defaultConvertToLlm;
    this._loopConfig = opts.loopConfig ?? {};
    this._toolExecution = opts.toolExecution ?? "sequential";
    this._signal = opts.signal;
    this.subscribers = new Set();
  }

  /** 当前快照(返回副本) */
  get state(): AgentState {
    return {
      systemPrompt: this._state.systemPrompt,
      messages: this._state.messages.slice(),
      tools: this._state.tools.slice(),
      model: this._state.model,
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
    const prompts: UserAgentMessage[] = normalizePrompts(input);
    const context: AgentContext = {
      systemPrompt: this._state.systemPrompt,
      messages: this._state.messages.slice(),
      tools: this._state.tools,
    };
    const config: AgentLoopConfig = {
      ...this._loopConfig,
      model: this._state.model,
      apiKey: this._loopConfig.apiKey,
      convertToLlm: this._convertToLlm as AgentLoopConfig["convertToLlm"],
      tools: this._state.tools,
      toolExecution: this._toolExecution,
      // 通过闭包把 ledger 透传到 agent-loop(避开类型污染)
      ...({ ledger: this._ledger } as Record<string, unknown>),
    };
    const finalMessages = await runAgentLoop(
      prompts,
      context,
      config,
      (ev) => this.dispatch(ev),
      this._signal,
      this._streamFn,
    );
    // 更新本地 state
    this._state.messages = finalMessages.slice();
    // 给 ledger 追加 sessionId 占位的最终 custom entry(可选)
    return finalMessages;
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

void newId; // 左移保留 import 不被 tsc 在 verbatim 模式下警告(防御性)
void ({} as TextContent); // 同上
