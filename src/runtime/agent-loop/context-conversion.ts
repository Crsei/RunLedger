/**
 * S4 拆分:AgentMessage → LLM Message 转换与 assistant 内容序列化。
 */

import type { Message, ToolCall } from "../../types.ts";
import type { AgentMessage, AssistantAgentMessage } from "../types.ts";

/**
 * 默认 convertToLlm 把 AgentMessage[] 摊平为 pi-ai Message[]:
 *   - user:直接传 content(补 timestamp,pi-ai UserMessage 必填)
 *   - assistant:直接传 content(转 typecast,pi-ai AssistantMessage 字段更多,
 *     但 streamFn 重新调用时不强制要求完整字段)
 *   - toolResult:把内嵌的 ToolResultContent 摊成多条 pi-ai ToolResultMessage,
 *     每条带 toolCallId / toolName / isError / addedToolNames / timestamp
 */
export function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
  const out: Message[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({
        role: "user",
        content: m.content,
        timestamp: Date.now(),
      });
    } else if (m.role === "assistant") {
      // 旧调用点仍可能只构造最小 assistant；新消息优先保留 provider 元数据。
      out.push({
        role: "assistant",
        content: m.content,
        api: m.api ?? "unknown",
        provider: m.provider ?? "unknown",
        model: m.model ?? "unknown",
        usage: m.usage ?? {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        ...(m.durationMs === undefined ? {} : { durationMs: m.durationMs }),
        ...(m.ttftMs === undefined ? {} : { ttftMs: m.ttftMs }),
        ...(m.timingSource === undefined ? {} : { timingSource: m.timingSource }),
        stopReason: m.stopReason,
        errorMessage: m.errorMessage,
        timestamp: m.timestamp ?? Date.now(),
      } as unknown as Message);
    } else if (m.role === "toolResult") {
      for (const c of m.content) {
        out.push({
          role: "toolResult",
          toolCallId: c.toolCallId,
          toolName: c.toolName,
          content: c.content,
          isError: c.isError === true,
          addedToolNames: c.addedToolNames,
          timestamp: Date.now(),
        });
      }
    }
  }
  return out;
}

export function serializeAssistant(content: AssistantAgentMessage["content"]): string {
  return content
    .map((c) => {
      if (c.type === "text") return c.text;
      if (c.type === "thinking") return `[thinking]`;
      return `[toolCall ${(c as ToolCall).name}]`;
    })
    .join("");
}
