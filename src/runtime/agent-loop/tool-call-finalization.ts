/**
 * S4 拆分:阶段3 tool call finalize —— afterToolCall hook、事件/ledger 结算
 * 与工具结果字符预算。
 */

import { runtimeDigest } from "../protocol/foundation.ts";
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
  ToolResultOverflowStore,
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
  let finalTerminate: boolean | undefined = r.terminate;

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
        terminate: finalTerminate,
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
        if (after.terminate !== undefined) finalTerminate = after.terminate;
      }
    } catch {
      // hook 抛错吞掉,沿用执行结果
    }
  }

  const result: ToolResultContent = {
    type: "toolResult",
    toolCallId: p.toolCall.id,
    toolName: p.toolCall.name,
    content: finalContent,
    isError: finalIsError,
    details: finalDetails,
  };
  if (finalAddedToolNames !== undefined) result.addedToolNames = finalAddedToolNames;
  if (finalTerminate !== undefined) result.terminate = finalTerminate;

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

/**
 * 工具结果字符预算:超出 maxChars 的 text content 通过 Host 注入的
 * overflow store 保存,在 content 中只回灌 bounded artifact ref 摘要。
 *
 * 没有 Host overflow store 时只做 inline 截断。agent-loop 不直接持有
 * filesystem、ArtifactStore 路径或 process-local 临时目录。
 *
 * Host store 不可用时退化为「inline 截断 + 提示」,仍不抛错。
 */
export async function applyToolResultBudget(
  content: (TextContent | ImageContent)[],
  maxChars: number,
  toolCallId: string,
  overflowStore?: ToolResultOverflowStore,
): Promise<(TextContent | ImageContent)[]> {
  const out: (TextContent | ImageContent)[] = [];
  let totalChars = 0;
  let overflowStarted = false;
  for (const block of content) {
    if (block.type !== "text") {
      out.push(block);
      continue;
    }
    const len = block.text.length;
    if (totalChars + len <= maxChars) {
      out.push(block);
      totalChars += len;
      continue;
    }
    // 第一次超预算:把"剩余配额"那一截留下用,剩余部分落盘
    if (!overflowStarted) {
      overflowStarted = true;
      const remain = Math.max(0, maxChars - totalChars);
      const inlineTail = remain > 0 ? block.text.slice(0, remain) : "";
      const droppedTail = remain > 0 ? block.text.slice(remain) : block.text;
      let hint = `\n\nOutput exceeds ${maxChars} chars; remaining content truncated by the Host boundary.`;
      if (overflowStore !== undefined && droppedTail.length > 0) {
        try {
          const sourceDigest = runtimeDigest(droppedTail);
          const stored = await overflowStore.put({
            toolCallId,
            bytes: new TextEncoder().encode(droppedTail),
            mediaType: "text/plain; charset=utf-8",
            sourceDigest,
          });
          hint = `\n\nOutput exceeds ${maxChars} chars; remaining content is available through governed artifact ${stored.ref.digest.digest} (${stored.ref.size ?? droppedTail.length} bytes).`;
        } catch {
          // Best effort only: the inline result remains usable and no local
          // path is exposed when the Host store is unavailable.
        }
      }
      out.push({ type: "text", text: `${inlineTail}${hint}` });
      totalChars = maxChars;
    }
    // 后续 text block 全部丢弃(只在第一次溢出时落盘一次);不丢图像
  }
  return out;
}
