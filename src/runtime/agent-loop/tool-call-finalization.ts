/**
 * S4 拆分:阶段3 tool call finalize —— afterToolCall hook、事件/ledger 结算
 * 与工具结果字符预算。
 */

import { applyToolResultBudget, DEFAULT_TOOL_RESULT_MAX_CHARS } from "./tool-result-budget.ts";
export { applyToolResultBudget } from "./tool-result-budget.ts";
import { newId } from "../ledger/types.ts";
import type { LedgerEntry } from "../ledger/types.ts";
import type { ImageContent, TextContent } from "../../types.ts";
import { contextAssumedAssistant } from "./assistant-recovery.ts";
import type { AgentToolExecutedResult } from "./tool-call-execution.ts";
import type { PreparedToolCall } from "./tool-call-preparation.ts";
import type {
  AfterToolCallResult,
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  ToolResultContent,
} from "../types.ts";

/**
 * 阶段3: finalize —— afterToolCall hook 字段级浅合并 + emit tool_execution_end + ledger entry。
 */
export async function finalizeExecutedToolCall(
  p: PreparedToolCall,
  r: AgentToolExecutedResult,
  context: AgentContext,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  fire: (ev: AgentEvent, entry?: Omit<LedgerEntry, "sessionId">) => Promise<void>,
  sessionId: string,
): Promise<ToolResultContent> {
  let finalContent: (TextContent | ImageContent)[] = r.content;
  let finalDetails: unknown = r.details;
  let finalIsError: boolean = r.isError;
  let finalAddedToolNames: string[] | undefined = r.addedToolNames;

  if (p.tool && config.afterToolCall) {
    try {
      // 先组装 ToolResultContent 给 hook 看(便于读 result / isError)
      const finalizedSnapshot: ToolResultContent = {
        type: "toolResult",
        toolCallId: p.toolCall.id,
        toolName: p.toolCall.name,
        content: finalContent,
        isError: finalIsError,
        details: finalDetails,
        addedToolNames: finalAddedToolNames,
      };
      const after = await config.afterToolCall(
        {
          assistantMessage: contextAssumedAssistant(context, p.toolCall.id),
          toolCall: p.toolCall,
          args: p.args,
          context,
          tool: p.tool,
          result: finalizedSnapshot,
          isError: finalIsError,
        },
        signal,
      ) as AfterToolCallResult | void;
      if (after) {
        if (after.content !== undefined) finalContent = after.content;
        if (after.details !== undefined) finalDetails = after.details;
        if (after.isError !== undefined) finalIsError = after.isError;
      }
    } catch {
      // hook 抛错吞掉,沿用执行结果
    }
  }

  // hook 也可能改变正文；只在最终边界裁剪一次，避免重复落盘和绕过预算。
  finalContent = await applyToolResultBudget(
    finalContent, p.tool?.maxResultSizeChars ?? DEFAULT_TOOL_RESULT_MAX_CHARS,
    p.toolCall.id, config.toolResultOverflowStore,
  );
  const result: ToolResultContent = {
    type: "toolResult",
    toolCallId: p.toolCall.id,
    toolName: p.toolCall.name,
    content: finalContent,
    isError: finalIsError,
    details: finalDetails,
  };
  if (finalAddedToolNames !== undefined) result.addedToolNames = finalAddedToolNames;

  const tEnd = Date.now();
  await fire(
    {
      type: "tool_execution_end",
      timestamp: tEnd,
      toolCallId: p.toolCall.id,
      toolName: p.toolCall.name,
      isError: finalIsError,
      result,
    },
    {
      id: newId(),
      parentId: sessionId,
      timestamp: tEnd,
      type: "tool_result",
      payload: {
        toolCallId: p.toolCall.id,
        toolName: p.toolCall.name,
        isError: finalIsError,
        content: finalContent.map((c) => (c.type === "text" ? c.text : `[image]`)).join(""),
      },
    },
  );

  return result;
}
