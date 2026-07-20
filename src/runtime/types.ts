/**
 * Runtime 层类型定义 —— agent-loop / Agent / ledger / 工具的对外契约。
 *
 * 对照参考 pi 的 `packages/agent-core` 抽象,但本期只移植最小可运行子集,
 * 类型直接复用 pi-ai 移植层(`../types.ts`)的 `Message` / `Tool` / `StopReason`
 * / `AssistantMessage` / `AssistantMessageEvent` / `AssistantMessageEventStream`
 * / `Model` / `Api` / `StreamOptions` / `ToolCall` / `TextContent`,
 * 不重新发明,以减少运行循环 ↔ LLM provider 之间的角色译码成本。
 *
 * AgentMessage / AgentEvent / AgentContext 等"运行循环视角"类型与 pi-ai
 * `Message` 系列的差异在 `convertToLlm` 边界统一翻译。
 */

import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Message,
  Model,
  StreamOptions,
  StopReason,
  TextContent,
  Tool,
  ToolCall,
} from "../types.ts";

// ===== 工具 =====

/**
 * Agent 工具抽象:parameters 复用 pi-ai `Tool["parameters"]`(typebox TSchema),
 * execute 把 LLM 传入的 input 转成 ToolResultContent。
 */
export interface AgentTool {
  name: string;
  description: string;
  parameters: Tool["parameters"];
  execute(
    toolCallId: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResultContent>;
}

/**
 * 单条 ToolResult content。骨架自研类型,与 pi-ai `ToolResultMessage`
 * 在 `convertToLlm` 边界摊平:把内嵌的 ToolResultContent 摊成 pi-ai 视角的多条
 * `ToolResultMessage`(每条带 toolCallId / toolName / isError)。
 */
export interface ToolResultContent {
  type: "toolResult";
  toolCallId: string;
  content: TextContent[];
  isError?: boolean;
  /** 可选附加 details,外层 tool 实现可填写,afterToolCall 也可改写 */
  details?: unknown;
}

// ===== AgentMessage =====

export interface UserAgentMessage {
  role: "user";
  content: TextContent[];
}

export interface AssistantAgentMessage {
  role: "assistant";
  /** 直接复用 pi-ai ToolCall,避免译码 */
  content: (TextContent | ToolCall)[];
  stopReason: StopReason;
  usage?: AssistantMessage["usage"];
  errorMessage?: string;
}

export interface ToolResultAgentMessage {
  role: "toolResult";
  content: ToolResultContent[];
}

export type AgentMessage = UserAgentMessage | AssistantAgentMessage | ToolResultAgentMessage;

// ===== AgentToolCall(运行循环视角的 toolCall,字段命名与 pi-ai ToolCall 对齐) =====

export interface AgentToolCall {
  id: string;
  name: string;
  /** LLM 实际传入的 input;pi-ai ToolCall.arguments 的别名 */
  input: Record<string, unknown>;
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
    }
  | { type: "message_update"; timestamp: number; assistantMessageEvent: AssistantMessageEvent }
  | {
      type: "tool_execution_start" | "tool_execution_end";
      timestamp: number;
      toolCallId: string;
      toolName: string;
      isError?: boolean;
    };

export type AgentEventSink = (event: AgentEvent) => void | Promise<void>;

// ===== Context =====

export interface AgentContext {
  systemPrompt?: string;
  messages: AgentMessage[];
  tools: AgentTool[];
}

/**
 * LLM 视角的 context。`messages` 已是 pi-ai `Message[]`,工具以 AgentTool[]
 * 形态保留(streamFn 内部转 pi-ai Tool[] 时再做一次最小包装)。
 */
export interface LlmContext {
  systemPrompt?: string;
  messages: Message[];
  tools: AgentTool[];
}

// ===== StreamFn =====

/**
 * 与 pi-ai StreamFunction 对齐:同步返回 AssistantMessageEventStream。
 * AgentLoop 内部 `await Promise.resolve(fn(...))` 写法兼容同步/异步两种实现形态。
 */
export interface StreamFn {
  (
    model: Model<Api>,
    context: LlmContext,
    options?: StreamOptions,
  ): AssistantMessageEventStream;
}

// ===== Loop 配置 =====

export interface AgentLoopConfig {
  model: Model<Api>;
  apiKey?: string;
  /** 透传给 streamFn 的 env overrides,激活 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN 等 */
  env?: Record<string, string>;
  /** 默认 = defaultConvertToLlm */
  convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  toolExecution?: "sequential" | "parallel";
  shouldStopAfterTurn?: (ctx: {
    messages: AgentMessage[];
    turn: number;
  }) => boolean | Promise<boolean>;
  prepareNextTurn?: (ctx: {
    messages: AgentMessage[];
    turn: number;
  }) => AgentLoopTurnUpdate | Promise<AgentLoopTurnUpdate>;
  beforeToolCall?: (
    input: { tool: AgentTool; toolCall: AgentToolCall; messages: AgentMessage[] },
    signal?: AbortSignal,
  ) => Promise<{ block?: true; reason?: string } | void>;
  afterToolCall?: (
    input: {
      tool: AgentTool;
      toolCall: AgentToolCall;
      messages: AgentMessage[];
      result: ToolResultContent;
    },
    signal?: AbortSignal,
  ) => Promise<Partial<ToolResultContent> | void>;
}

export interface AgentState {
  systemPrompt?: string;
  messages: AgentMessage[];
  tools: AgentTool[];
  model: Model<Api>;
}

export interface AgentLoopTurnUpdate {
  systemPrompt?: string;
  tools?: AgentTool[];
  model?: Model<Api>;
}

// ===== 兼容骨架原 API 的别名(切到 pi-ai 命名) =====

/**
 * 旧骨架用 `BeforeToolCallResult` / `AfterToolCallResult` 命名;
 * 这里在类型层提供别名,使 agent-loop.ts 的引用无需重命名。
 */
export type BeforeToolCallResult = { block?: true; reason?: string } | void;
export type AfterToolCallResult = Partial<ToolResultContent>;
