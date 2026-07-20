/**
 * RunLedger 公共出口 barrel。
 *
 * 对照参考 pi 的 `packages/agent/src/index.ts`,只导出当前已实现的最小集合。
 * 后续 provider / tool / harness 补齐时,在这里集中 re-export。
 */

// 类型
export type {
  Api,
  Model,
  MessageRole,
  Message,
  AssistantMessage,
  UserMessage,
  ToolResultMessage,
  TextContent,
  ImageContent,
  ToolCallContent,
  ToolResultContent,
  MessageContent,
  UserAgentMessage,
  AssistantAgentMessage,
  ToolResultAgentMessage,
  AgentMessage,
  StopReason,
  TokenUsage,
  Tool,
  AgentTool,
  AgentToolCall,
  BeforeToolCallContext,
  BeforeToolCallResult,
  AfterToolCallContext,
  AfterToolCallResult,
  AssistantMessageEvent,
  AgentEvent,
  AgentContext,
  LlmContext,
  StreamOptions,
  AssistantMessageEventStream,
  StreamFn,
  AgentLoopTurnUpdate,
  AgentLoopConfig,
  AgentEventSink,
  AgentState,
} from "./types.js";

// 工具实现
export { EventStream, fromAsyncIterable } from "./event-stream.js";

// agent loop
export { runAgentLoop, runAgentLoopContinue, defaultConvertToLlm } from "./agent-loop.js";

// agent
export { Agent } from "./agent.js";
export type { AgentOptions } from "./agent.js";

// ledger
export { MemoryLedger } from "./ledger/memory-ledger.js";
export { JsonlLedger } from "./ledger/jsonl-ledger.js";
export type { JsonlLedgerOptions } from "./ledger/jsonl-ledger.js";
export type {
  LedgerHeader,
  LedgerEntry,
  LedgerEntryType,
  LedgerSink,
} from "./ledger/types.js";
export { newId } from "./ledger/types.js";

// tools
export { echoTool } from "./tools/echo.js";
export type { EchoArgs } from "./tools/echo.js";

// providers
export { mockStreamFn } from "./providers/mock-stream.js";
