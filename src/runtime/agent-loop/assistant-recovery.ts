/**
 * S4 拆分:truncated/assumed assistant 收口。
 *
 * length 截断降级不真正执行工具;afterToolCall 的 assistantMessage
 * 从 context 倒序查找对应 toolCallId,兜底返回空 assistant。
 */

import { newId } from "../ledger/types.ts";
import type { LedgerEntry } from "../ledger/types.ts";
import type { ToolCall } from "../../types.ts";
import type {
  AgentContext,
  AgentEvent,
  AgentEventSink,
  AgentToolCall,
  AssistantAgentMessage,
  ToolResultContent,
} from "../types.ts";

/** length 截断降级:每工具合成 isError ToolResultContent,不真正执行。 */
export async function failToolCallsFromTruncatedMessage(
  toolCalls: AgentToolCall[],
  fire: (ev: AgentEvent, entry?: Omit<LedgerEntry, "sessionId">) => Promise<void>,
  sessionId: string,
): Promise<ToolResultContent[]> {
  const results: ToolResultContent[] = [];
  for (const tc of toolCalls) {
    const errorText = "Tool call was not executed because the assistant response reached the output limit and its arguments may be incomplete.";
    const started = Date.now();
    await fire(
      {
        type: "tool_execution_start",
        timestamp: started,
        toolCallId: tc.id,
        toolName: tc.name,
        args: tc.arguments,
      },
      {
        id: newId(),
        parentId: sessionId,
        timestamp: started,
        type: "tool_call",
        payload: { toolCallId: tc.id, toolName: tc.name, input: tc.arguments },
      },
    );
    const result: ToolResultContent = {
      type: "toolResult",
      toolCallId: tc.id,
      toolName: tc.name,
      content: [{
        type: "text",
        text: errorText,
      }],
      isError: true,
    };
    const ended = Date.now();
    await fire(
      {
        type: "tool_execution_end",
        timestamp: ended,
        toolCallId: tc.id,
        toolName: tc.name,
        isError: true,
        result,
      },
      {
        id: newId(),
        parentId: sessionId,
        timestamp: ended,
        type: "tool_result",
        payload: {
          toolCallId: tc.id,
          toolName: tc.name,
          isError: true,
          content: errorText,
        },
      },
    );
    results.push(result);
  }
  return results;
}

/**
 * findAfterTool:从 context 中找到对应 toolCallId 的 assistant message。
 * 辅助 afterToolCall 取 assistantMessage,本期维护成本低。
 */
export function contextAssumedAssistant(context: AgentContext, toolCallId: string): AssistantAgentMessage {
  // 倒序找最后一条包含此 toolCall.id 的 assistant message
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const m = context.messages[i]!;
    if (m.role !== "assistant") continue;
    if (m.content.some((c) => c.type === "toolCall" && (c as ToolCall).id === toolCallId)) {
      return m;
    }
  }
  // 兜底:返回空 assistant(理论上不会走到,因为 finalize 是在 prepare 之后立即调的)
  return { role: "assistant", content: [], stopReason: "stop" } as AssistantAgentMessage;
}
