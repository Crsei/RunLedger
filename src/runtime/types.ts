/**
 * Runtime 层类型定义 —— agent-loop / Agent / ledger / 工具的对外契约。
 *
 * 对照参考 pi 的 `packages/agent-core` 抽象(`agent/src/types.ts`)。
 * 类型尽量直接复用 pi-ai 移植层(`../types.ts`)的 `Message` / `Tool` /
 * `StopReason` / `AssistantMessage` / `AssistantMessageEvent` /
 * `AssistantMessageEventStream` / `Model` / `Api` / `StreamOptions` /
 * `ToolCall` / `TextContent` / `ImageContent`,不重新发明,以减少运行循环 ↔
 * LLM provider 之间的角色译码成本。
 *
 * AgentMessage / AgentEvent / AgentContext 等"运行循环视角"类型与 pi-ai
 * `Message` 系列的差异在 `convertToLlm` 边界统一翻译。
 *
 * 对照 pi 的差异(本期决策):
 *   - 不引入 `AgentToolDefinition`(schema-only 视图),由后续 ToolRegistry
 *     的 `schemaOnlyView()` 投影得到 pi-ai `Tool`。
 *   - 不引入 `ExtensionContext`/TUI 渲染字段;`AgentTool.execute` 接受的
 *     `ToolContext` 仅含 cwd / fs / shell / ledger / env / signal /
 *     sessionId / toolCallId,无 UI 操作面。
 *   - 错误契约 = throw(pi 同款),由 agent-loop 转 isError tool result。
 */

import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  ImageContent,
  Message,
  Model,
  ModelThinkingLevel,
  SimpleStreamOptions,
  StopReason,
  TextContent,
  Tool,
  ToolCall,
} from "../types.ts";
import type { Static, TSchema } from "typebox";
import type { LedgerSink } from "./ledger/types.ts";
import type { ToolContext } from "./tool-context.ts";

// ===== 工具 =====

/** 工具执行模式 —— 与 pi `ToolExecutionMode` 对齐。 */
export type ToolExecutionMode = "sequential" | "parallel";

/**
 * 工具执行过程中流式给到 agent-loop 的 partial 结果回调。
 *
 * 与 pi `AgentToolUpdateCallback<T>` 对齐:calls made after the tool promise
 * settles are ignored(由 agent-loop 控制)。
 */
export type AgentToolUpdateCallback<T = unknown> = (partialResult: AgentToolResult<T>) => void;

/**
 * Agent 工具抽象,对齐 pi `AgentTool<TParameters, TDetails>`。
 *
 * - `parameters` 是 TypeBox `TSchema`(同步是 JSON-Schema 对象,可直接 spread
 *   给 LLM provider 请求构造),`Static<typeof parameters>` 给出验证后的入参类型。
 * - `prepareArguments` 是 schema 校验前的兼容垫片,允许工具做向后兼容形态归整。
 * - `execute` 契约 = throw on failure:工具内部抛错由 agent-loop 兜底转
 *   `isError: true` 的 ToolResultMessage。pi 同款契约。
 * - `executionMode` 让每个工具声明自己能否与批次内其他工具并发(默认走 AgentLoopConfig.toolExecution)。
 * - `isReadOnly()` / `isConcurrencySafe()` / `isDestructive()`(可选):
 *   agent-loop 在 resolveExecutionMode 时优先看 isConcurrencySafe(任一非 concurrency-safe
 *   → 强制 sequential),toolResult 预算与 ledger 主动记账看 isReadOnly,isDestructive
 *   暂未消费,留给后续 trust gate hooks(对齐 claude-code-bun docs/tools/what-are-tools.mdx)。
 *
 * `execute` 签名本期采用**最小破坏**形态:`context?: ToolContext` 留在 5 位
 * 可选位置,`signal` / `onUpdate` 仍居 3/4 位。这样老调用点(包括 13 个 stdlib
 * 单测 + 8 个 stdlib 内工具)与 mock-stream 不用一次性改完,agent-loop 仅在
 * dispatch 时主动构造 ToolContext 并以 5 位传入。后期(M5+ TUI 渲染接入后)
 * 可继续把 context 收编到 3 位,届时破坏性变更集中在一个 PR。
 */
export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = unknown> extends Tool<TParameters> {
  /** UI 显示用的 label;不参与 LLM 请求。Runtime 字段中性化。 */
  label: string;
  /**
   * 可选兼容垫片:在 schema 校验前把 LLM 传入的 raw args 规整为符合
   * `TParameters` 的形态。返回值将送入 `validateToolArguments`。
   */
  prepareArguments?: (args: unknown) => Static<TParameters>;
  /**
   * 执行工具。失败时 throw,由 agent-loop 转为 isError tool result。
   * `onUpdate` 给流式工具推送 partial 结果(如 bash 长输出),agent-loop
   * 在收到后透传为 `tool_execution_update` 事件。
   * `context` 由 agent-loop 在 dispatch 阶段构造,可选注入 cwd / env / ledger /
   * signal / sessionId / toolCallId;工具可选消费 context.cwd 与 context.env.shell
   * 以替代工厂闭包(本期两者并存,后期完全切换到 context)。
   */
  execute: (
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,
    context?: ToolContext,
  ) => Promise<AgentToolResult<TDetails>>;
  /** 工具级执行模式覆写;未指定时跟随 AgentLoopConfig.toolExecution。 */
  executionMode?: ToolExecutionMode;
  /**
   * 工具是否只读(无副作用)。read-only 工具可放心并发且不污染审计 ledger。
   * 缺省 = false。
   */
  isReadOnly?: () => boolean;
  /**
   * 工具是否可与其他工具并发执行。任一非 concurrency-safe 工具在 batch 内时,
   * agent-loop 把整批降级为 sequential(对齐 claude-code-bun
   * docs/tools/what-are-tools.mdx §"并行执行模式")。缺省 = false。
   */
  isConcurrencySafe?: () => boolean;
  /**
   * 工具是否破坏性(写文件 / 改 ledger / 删除资源)。本期仅作 metadata 显式
   * 标注不消费,留待后续 trust gate hooks(对齐 what-are-tools.mdx)。
   */
  isDestructive?: () => boolean;
  /**
   * 工具结果最大字符预算;超额部分由 agent-loop 落 `tmp/tool-output-<id>.txt`
   * 并在 content 末尾附路径提示(对齐 what-are-tools.mdx §"大结果落盘")。
   * 缺省 = DEFAULT_MAX_BYTES。
   */
  maxResultSizeChars?: number;
}

/**
 * 工具执行结果,对齐 pi `AgentToolResult<T>`。
 *
 * - `content` 回灌给 LLM 的文本/图像。
 * - `details` 给审计日志/UI 渲染用的结构化数据(自由 schema)。
 * - `addedToolNames` deferred tool loading:本条 result 之后请把列出的工具
 *   加入 AgentContext.tools;兼容支持该字段的 provider 会下发到下一轮 LLM。
 * - `terminate` 批次内所有 finalized 都置 true 时才会提前停止 agent 循环。
 */
export interface AgentToolResult<T = unknown> {
  content: (TextContent | ImageContent)[];
  details: T;
  /** 工具已完成但结果应作为错误回灌,例如 bash 非零退出。 */
  isError?: boolean;
  addedToolNames?: string[];
  terminate?: boolean;
}

// ===== AgentMessage =====

export interface UserAgentMessage {
  role: "user";
  content: TextContent[];
}

export interface AssistantAgentMessage {
  role: "assistant";
  /** 保留 provider 返回的完整 content,包括 thinking/signature 与 toolCall。 */
  content: AssistantMessage["content"];
  stopReason: StopReason;
  usage?: AssistantMessage["usage"];
  errorMessage?: string;
  api?: AssistantMessage["api"];
  provider?: AssistantMessage["provider"];
  model?: AssistantMessage["model"];
  timestamp?: AssistantMessage["timestamp"];
}

/**
 * ToolResult agent 视角消息。一条 ToolResultAgentMessage 内含多条
 * `AgentToolResult`(每条对应一次 toolCall),并补 toolCallId / toolName /
 * isError 字段以便 convertToLlm 摊平为 pi-ai 多条 ToolResultMessage。
 */
export interface ToolResultAgentMessage {
  role: "toolResult";
  content: ToolResultContent[];
}

/** 单条 tool 结果(agent 视角)。`AgentToolResult` + 路由元信息(toolCallId/toolName)。 */
export interface ToolResultContent {
  type: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  isError?: boolean;
  /** 自由形态 details,工具实现可填写,afterToolCall 也可改写 */
  details?: unknown;
  /** deferred tool loading 提示;convertToLlm 时透传到 pi-ai ToolResultMessage */
  addedToolNames?: string[];
  /** 与 pi 一致的早停 hint;agent-loop 按"批次内全部 finalized 都置 true"判定 */
  terminate?: boolean;
}

export type AgentMessage = UserAgentMessage | AssistantAgentMessage | ToolResultAgentMessage;

// ===== AgentToolCall =====

/**
 * 与 pi 一致:RunLedger 直接复用 pi-ai `ToolCall`(`AssistantMessage` content
 * 中 `type: "toolCall"` 的成员)。不再自定义 `input` 别名,工具调用走
 * `toolCall.arguments`。
 */
export type AgentToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

// ===== Hook Results =====

/**
 * `beforeToolCall` 返回值,对齐 pi `BeforeToolCallResult`。
 * `block: true` 阻断执行,reason 作为 error tool result 文本。
 */
export interface BeforeToolCallResult {
  block?: boolean;
  reason?: string;
}

/**
 * `afterToolCall` 返回值,对齐 pi `AfterToolCallResult`。
 * 字段级浅合并:不深合并 content/details,提供字段则整体替换。
 */
export interface AfterToolCallResult {
  content?: (TextContent | ImageContent)[];
  details?: unknown;
  isError?: boolean;
  terminate?: boolean;
}

// ===== AgentEvent =====

export type AgentEvent =
  | { type: "agent_start" | "agent_end"; timestamp: number }
  | {
      type: "turn_start" | "turn_end";
      timestamp: number;
      turn: number;
      stopReason?: StopReason;
    }
  | {
      type: "message_start" | "message_end";
      timestamp: number;
      role: "user" | "assistant";
      stopReason?: StopReason;
      message?: AgentMessage;
    }
  | { type: "message_update"; timestamp: number; assistantMessageEvent: AssistantMessageEvent }
  | {
      type: "tool_execution_start";
      timestamp: number;
      toolCallId: string;
      toolName: string;
      args: unknown;
    }
  | {
      type: "tool_execution_end";
      timestamp: number;
      toolCallId: string;
      toolName: string;
      isError: boolean;
      result: ToolResultContent;
    }
  | {
      type: "tool_execution_update";
      timestamp: number;
      toolCallId: string;
      toolName: string;
      partialResult: AgentToolResult;
    }
  | {
      type: "queue_update";
      timestamp: number;
      steering: AgentMessage[];
      followUp: AgentMessage[];
    };

export type AgentEventSink = (event: AgentEvent) => void | Promise<void>;

// ===== Context =====

/**
 * 与 pi 的 `AgentContext` 对齐:tools 可缺省(允许"无工具" turn)。
 */
export interface AgentContext {
  systemPrompt?: string;
  messages: AgentMessage[];
  tools: AgentTool[] | undefined;
}

/**
 * LLM 视角的 context。`messages` 已是 pi-ai `Message[]`,工具以 AgentTool[]
 * 形态保留(streamFn 内部转 pi-ai Tool[] 时再做一次最小包装丢 execute)。
 */
export interface LlmContext {
  systemPrompt?: string;
  messages: Message[];
  tools: AgentTool[] | undefined;
}

// ===== StreamFn =====

/**
 * 与 pi-ai `StreamFunction` 对齐:同步或异步返回 `AssistantMessageEventStream`。
 * AgentLoop 内部 `await Promise.resolve(fn(...))` 写法兼容两种实现形态。
 */
export interface StreamFn {
  (
    model: Model<Api>,
    context: LlmContext,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream | Promise<AssistantMessageEventStream>;
}

// ===== Loop 配置 =====

/**
 * Agent loop 配置。对齐 pi 的字段集,补 RunLedger 自有的 `ledger`(替代旧
 * `WithLedger` 反射 trick),让审计 sink 成类型契约第一公民。
 */
export interface AgentLoopConfig {
  model: Model<Api>;
  /** 当前有效 thinking level;off 时请求不发送 reasoning。 */
  reasoning?: ModelThinkingLevel;
  apiKey?: string;
  /** 透传给 streamFn 的 env overrides,激活 ANTHROPIC_BASE_URL 等 */
  env?: Record<string, string>;
  /**
   * 工具执行基目录;缺省 = process.cwd()。dispatch 阶段把 cwd 写进每个
   * toolCall 的 ToolContext(对齐 claude-code-bun docs/tools 中的 cwd 概念)。
   */
  cwd?: string;
  /**
   * 工具执行环境(fs + shell);缺省 = `localExecutionEnv(cwd)`。注入自定义
   * env 是测试 / 沙箱 / 远端 streamProxy 的入口。注意与 `env` 字段(环境变量字典)
   * 区分:本字段是 ExecutionEnv runtime 接口。
   */
  executionEnv?: import("./execution-env.ts").ExecutionEnv;
  /** 默认 = defaultConvertToLlm */
  convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  /** 工具执行模式;缺省 sequential */
  toolExecution?: ToolExecutionMode;
  shouldStopAfterTurn?: (ctx: {
    messages: AgentMessage[];
    turn: number;
  }) => boolean | Promise<boolean>;
  prepareNextTurn?: (ctx: {
    messages: AgentMessage[];
    turn: number;
  }) => AgentLoopTurnUpdate | Promise<AgentLoopTurnUpdate>;
  /** 每个 assistant/tool 批次后拉取 steering 消息。 */
  getSteeringMessages?: () => AgentMessage[] | Promise<AgentMessage[]>;
  /** agent 原本将结束时拉取 follow-up 消息。 */
  getFollowUpMessages?: () => AgentMessage[] | Promise<AgentMessage[]>;
  /**
   * 工具调用前置 hook。返回 `{ block: true, reason }` 阻断执行并生成
   * isError tool result;返回 void/undefined 放行。
   */
  beforeToolCall?: (
    ctx: AgentToolHookContext,
    signal?: AbortSignal,
  ) => Promise<BeforeToolCallResult | void> | BeforeToolCallResult | void;
  /**
   * 工具执行后置 hook。返回的字段以浅合并语义覆盖到 `AgentToolResult`。
   */
  afterToolCall?: (
    ctx: AgentToolHookContext & { result: ToolResultContent; isError: boolean },
    signal?: AbortSignal,
  ) => Promise<AfterToolCallResult | void> | AfterToolCallResult | void;
  /** 可选:LedgerSink,直接挂入类型契约;agent-loop 把事件与 entry 联合写入。 */
  ledger?: LedgerSink;
}

/** beforeToolCall / afterToolCall 共享的上下文,对齐 pi Before/AfterToolCallContext。 */
export interface AgentToolHookContext {
  /** 触发本次调用的 assistant 消息 */
  assistantMessage: AssistantAgentMessage;
  /** pi-ai 原始 ToolCall 块(取自 assistantMessage.content) */
  toolCall: AgentToolCall;
  /** schema 校验后的工具入参 */
  args: unknown;
  /** 当前 AgentContext 快照(消息已 copy) */
  context: AgentContext;
  /** 被调用的工具实例(若找到) */
  tool: AgentTool | undefined;
}

export interface AgentState {
  systemPrompt?: string;
  messages: AgentMessage[];
  tools: AgentTool[];
  model: Model<Api>;
  thinkingLevel: ModelThinkingLevel;
}

export interface AgentLoopTurnUpdate {
  systemPrompt?: string;
  tools?: AgentTool[];
  model?: Model<Api>;
  thinkingLevel?: ModelThinkingLevel;
}

/** steering/follow-up 每次 drain 一条或全部。 */
export type QueueMode = "one-at-a-time" | "all";

export interface ToolAuthorizationRequest {
  assistantMessage: AssistantAgentMessage;
  toolCall: AgentToolCall;
  args: unknown;
  tool: AgentTool | undefined;
  context: AgentContext;
}

export type ToolAuthorizationDecision =
  | { decision: "allow" }
  | { decision: "deny"; reason: string };

/** 可替换的工具权限策略;TUI 审批以后只需替换此接口实现。 */
export interface ToolAuthorizationPolicy {
  authorize(
    request: ToolAuthorizationRequest,
    signal?: AbortSignal,
  ): ToolAuthorizationDecision | Promise<ToolAuthorizationDecision>;
}
