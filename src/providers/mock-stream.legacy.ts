/**
 * Mock LLM provider —— 把 LLM 调用完全模拟为本地字符串与单个 toolCall,
 * 以便在无任何 API key 的情况下走通 start → message → tool → end 全流程。
 *
 * 接收 LlmContext 与 StreamOptions,返回 AssistantMessageEventStream。
 *
 * 行为约定:
 *   - 当 context 中只有 user 消息(从未调用过工具):emit 一段文本 + 一个 echo toolCall
 *     stopReason = "tool_use"
 *   - 当 context 中已经有 toolResult(说明上一轮调用过工具):输出总结文本,
 *     stopReason = "stop"
 *   - 当 signal 已取消:emit error 事件并以 stopReason = "aborted" settle
 *
 * `// TODO(pi):` 真实 provider 应参考 pi 的 `packages/ai/src/providers/*`,
 * 比如 anthropic-messages / openai-responses 等等,涉及 SSE 解析与本机协议。
 * 本期不实现。
 */

import { EventStream } from "../event-stream.js";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  LlmContext,
  MessageContent,
  Model,
  StreamOptions,
  StreamFn,
} from "../types.js";

interface MockModel extends Model {
  provider: "mock";
}

function isMockModel(m: Model): m is MockModel {
  return m.provider === "mock";
}

/**
 * 默认 mock streamFn。延迟若干 ms 模拟流式延迟。
 */
export const mockStreamFn: StreamFn = (
  model,
  context,
  options,
): AssistantMessageEventStream => {
  const stream = new EventStream<AssistantMessageEvent, AssistantMessage>();
  void runMockTurn(model, context, options, stream);
  return stream;
};

async function runMockTurn(
  model: Model,
  context: LlmContext,
  options: StreamOptions | undefined,
  stream: EventStream<AssistantMessageEvent, AssistantMessage>,
): Promise<void> {
  // 防御性:即使 mock 也尊重 model.provider 字段
  if (!isMockModel(model)) {
    stream.emit({ type: "error", message: `mock provider 不可用于 model ${model.provider}/${model.modelId}` });
    stream.resolve(buildAssistant(context, [], "error"));
    return;
  }
  const signal = options?.signal;
  if (signal?.aborted) {
    stream.emit({ type: "error", message: "aborted" });
    stream.resolve(buildAssistant(context, [], "aborted"));
    return;
  }

  const hasToolResult = context.messages.some(
    (m) => m.role === "toolResult",
  );

  stream.emit({ type: "start" });

  if (!hasToolResult) {
    // 模拟一轮"思考 + 调用工具"
    await delay(20);
    if (signal?.aborted) {
      stream.resolve(buildAssistant(context, [], "aborted"));
      return;
    }
    stream.emit({ type: "text_start" });
    const intro = "我会调用 echo 工具来回应你。";
    for (const ch of intro) {
      stream.emit({ type: "text_delta", delta: ch });
      await delay(5);
      if (signal?.aborted) {
        stream.resolve(buildAssistant(context, [], "aborted"));
        return;
      }
    }
    stream.emit({ type: "text_end" });

    // 找到最后一条 user 消息,从中抽出 text
    const lastUser = [...context.messages]
      .reverse()
      .find((m) => m.role === "user");
    const userText = lastUser
      ? lastUser.content.find((c) => c.type === "text")
      : undefined;

    await delay(10);
    const toolCallId = "call_mock_" + Math.random().toString(36).slice(2, 10);
    stream.emit({
      type: "toolcall_start",
      id: toolCallId,
      name: "echo",
    });
    stream.emit({
      type: "toolcall_delta",
      id: toolCallId,
      partialJson: JSON.stringify({ text: userText?.text ?? "" }),
    });
    stream.emit({
      type: "toolcall_end",
      id: toolCallId,
      name: "echo",
      input: { text: userText?.text ?? "" },
    });
    stream.emit({ type: "stop", stopReason: "tool_use" });
    const final = buildAssistant(
      context,
      [
        { type: "text", text: intro },
        {
          type: "toolCall",
          id: toolCallId,
          name: "echo",
          input: { text: userText?.text ?? "" },
        },
      ],
      "tool_use",
    );
    stream.resolve(final);
    return;
  }

  // 已有 toolResult:输出总结并结束
  await delay(20);
  stream.emit({ type: "text_start" });
  const summary = "echo 已回显了你的输入,任务完成。";
  for (const ch of summary) {
    stream.emit({ type: "text_delta", delta: ch });
    await delay(5);
  }
  stream.emit({ type: "text_end" });
  stream.emit({ type: "stop", stopReason: "stop" });
  const final = buildAssistant(context, [{ type: "text", text: summary }], "stop");
  stream.resolve(final);
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function buildAssistant(
  _context: LlmContext,
  content: MessageContent[],
  stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
  // 把简化的 fake 内容拼装成一个最小 AssistantMessage。
  // 实际场景下 streamFn 应在 stream 结束时返回与 stop 一致的 final assistant 消息。
  return {
    role: "assistant",
    content,
    stopReason,
  };
}
