/**
 * Mock LLM provider —— 把 LLM 调用完全模拟为本地字符串与单个 toolCall,
 * 以便在无任何 API key 的情况下走通 start → message → tool → end 全流程。
 *
 * 行为约定:
 *   - 当 context 中只有 user 消息(从未调用过工具):emit 一段文本 + 一个 echo toolCall,
 *     stopReason = "toolUse"
 *   - 当 context 中已经有 toolResult(说明上一轮调用过工具):输出总结文本,
 *     stopReason = "stop"
 *   - 当 signal 已取消:emit error 事件并以 stopReason = "aborted" settle
 *
 * 事件协议直接对齐 pi-ai AssistantMessageEvent(`start` / `text_delta` /
 * `toolcall_end` / `done` / `error`),不另起一套。
 *
 * `// TODO(pi):` 真实 provider 应参考 pi 的 `packages/ai/src/providers/*`,
 * 比如 anthropic-messages / openai-responses 等等,涉及 SSE 解析与本机协议,
 * 本期只为支撑 agent-loop 复活与单测。
 */

import { createAssistantMessageEventStream } from "../../utils/event-stream.ts";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Model,
  StreamOptions,
  TextContent,
  ToolCall,
} from "../../types.ts";
import type { LlmContext, StreamFn } from "../types.ts";

/** Mock model 的 provider 标识;用于 mockStreamFn 的防御性校验 */
const MOCK_PROVIDER = "mock";
const MOCK_API = "mock";
const MOCK_MODEL_ID = "mock-1";

/** 测试场景预设的 mock model */
export const mockModel: Model<"mock" & Api> = {
  id: MOCK_MODEL_ID,
  name: "Mock Model",
  api: MOCK_API as "mock" & Api,
  provider: MOCK_PROVIDER,
  baseUrl: "http://localhost:0",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 1024,
};

function isMockModel(m: Model<Api>): boolean {
  return m.provider === MOCK_PROVIDER;
}

/**
 * 默认 mock streamFn —— 同步返回 AssistantMessageEventStream,
 * 内部 queueMicrotask 异步推进事件流,模拟真实 LLM 流式延迟。
 */
export const mockStreamFn: StreamFn = (model, context, options) => {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    void runMockTurn(model, context, options, stream);
  });
  return stream;
};

async function runMockTurn(
  model: Model<Api>,
  context: LlmContext,
  options: StreamOptions | undefined,
  stream: AssistantMessageEventStream,
): Promise<void> {
  const signal = options?.signal;

  if (!isMockModel(model)) {
    const err = buildErrorAssistant(`mock provider 不可用于 model ${model.provider}/${model.id}`);
    stream.push({ type: "error", reason: "error", error: err });
    stream.end(err);
    return;
  }
  if (signal?.aborted) {
    const err = buildErrorAssistant("aborted", "aborted");
    stream.push({ type: "error", reason: "aborted", error: err });
    stream.end(err);
    return;
  }

  const hasToolResult = context.messages.some((m) => m.role === "toolResult");
  const partialBase = buildPartialAssistant([]);

  stream.push({ type: "start", partial: partialBase });

  if (!hasToolResult) {
    // 模拟一轮"说话 + 调用工具":先文本,再一个 echo toolCall
    await delay(20);
    if (signal?.aborted) {
      const err = buildErrorAssistant("aborted", "aborted");
      stream.push({ type: "error", reason: "aborted", error: err });
      stream.end(err);
      return;
    }
    const intro = "我会调用 echo 工具来回应你。";
    const introBlocks: TextContent[] = [];
    stream.push({
      type: "text_start",
      contentIndex: 0,
      partial: withContent(partialBase, []),
    });
    for (const ch of intro) {
      await delay(5);
      if (signal?.aborted) {
        const err = buildErrorAssistant("aborted", "aborted");
        stream.push({ type: "error", reason: "aborted", error: err });
        stream.end(err);
        return;
      }
      introBlocks.push({ type: "text", text: ch });
      stream.push({
        type: "text_delta",
        contentIndex: 0,
        delta: ch,
        partial: withContent(partialBase, [...introBlocks]),
      });
    }
    stream.push({
      type: "text_end",
      contentIndex: 0,
      content: intro,
      partial: withContent(partialBase, [...introBlocks]),
    });

    // 抽取最后一条 user 文本作为 echo 输入
    const lastUser = [...context.messages].reverse().find((m) => m.role === "user");
    const userText = lastUser && typeof lastUser.content !== "string"
      ? lastUser.content.find((c): c is TextContent => c.type === "text")
      : undefined;
    const echoInput = { text: userText?.text ?? "" };

    await delay(10);
    const toolCallId = "call_mock_" + Math.random().toString(36).slice(2, 10);
    const toolCall: ToolCall = {
      type: "toolCall",
      id: toolCallId,
      name: "echo",
      arguments: echoInput,
    };
    stream.push({
      type: "toolcall_start",
      contentIndex: 1,
      partial: withContent(partialBase, [...introBlocks, { ...toolCall, arguments: {} }]),
    });
    stream.push({
      type: "toolcall_delta",
      contentIndex: 1,
      delta: JSON.stringify(echoInput),
      partial: withContent(partialBase, [...introBlocks, { ...toolCall, arguments: {} }]),
    });
    stream.push({
      type: "toolcall_end",
      contentIndex: 1,
      toolCall,
      partial: withContent(partialBase, [...introBlocks, toolCall]),
    });

    const finalAssistant = buildFinalAssistant([...introBlocks, toolCall], "toolUse");
    stream.push({ type: "done", reason: "toolUse", message: finalAssistant });
    stream.end(finalAssistant);
    return;
  }

  // 已有 toolResult:输出总结并结束
  await delay(20);
  const summary = "echo 已回显了你的输入,任务完成。";
  const summaryBlocks: TextContent[] = [];
  stream.push({
    type: "text_start",
    contentIndex: 0,
    partial: withContent(partialBase, []),
  });
  for (const ch of summary) {
    await delay(5);
    if (signal?.aborted) {
      const err = buildErrorAssistant("aborted", "aborted");
      stream.push({ type: "error", reason: "aborted", error: err });
      stream.end(err);
      return;
    }
    summaryBlocks.push({ type: "text", text: ch });
    stream.push({
      type: "text_delta",
      contentIndex: 0,
      delta: ch,
      partial: withContent(partialBase, [...summaryBlocks]),
    });
  }
  stream.push({
    type: "text_end",
    contentIndex: 0,
    content: summary,
    partial: withContent(partialBase, [...summaryBlocks]),
  });
  const finalAssistant = buildFinalAssistant([...summaryBlocks], "stop");
  stream.push({ type: "done", reason: "stop", message: finalAssistant });
  stream.end(finalAssistant);
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function buildPartialAssistant(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: MOCK_API,
    provider: MOCK_PROVIDER,
    model: MOCK_MODEL_ID,
    usage: ZERO_USAGE,
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function withContent(
  base: AssistantMessage,
  content: AssistantMessage["content"],
): AssistantMessage {
  return { ...base, content, timestamp: Date.now() };
}

function buildFinalAssistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: MOCK_API,
    provider: MOCK_PROVIDER,
    model: MOCK_MODEL_ID,
    usage: { ...ZERO_USAGE },
    stopReason,
    timestamp: Date.now(),
  };
}

function buildErrorAssistant(
  message: string,
  stopReason: "error" | "aborted" = "error",
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: MOCK_API,
    provider: MOCK_PROVIDER,
    model: MOCK_MODEL_ID,
    usage: { ...ZERO_USAGE },
    stopReason,
    errorMessage: message,
    timestamp: Date.now(),
  };
}

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

// 防御:确保 AssistantMessageEvent 被引用到本文件的 type scope 中
// (避免 verbatimModuleSyntax 下未使用 type import 触发 info)
export type { AssistantMessageEvent };
