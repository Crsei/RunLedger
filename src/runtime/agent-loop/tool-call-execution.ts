/**
 * S4 拆分:阶段2 tool call execute —— 真正调用 tool.execute()。
 *
 * blocked / 不可达工具走 isError 兜底;onUpdate 回调把流式 partial 转发为
 * tool_execution_update 事件 + ledger entry;超预算结果文本经
 * `applyToolResultBudget` 落盘/截断。
 */

import type { ImageContent, TextContent } from "../../types.ts";
import { localExecutionEnv } from "../execution-env.ts";
import { makeToolContext } from "../tool-context.ts";
import { DEFAULT_MAX_BYTES } from "../tools/tool-support.ts";
import type { LedgerEntry } from "../ledger/types.ts";
import { applyToolResultBudget } from "./tool-call-finalization.ts";
import type { PreparedToolCall } from "./tool-call-preparation.ts";
import type {
  AgentEvent,
  AgentLoopConfig,
  AgentToolUpdateCallback,
} from "../types.ts";

export interface AgentToolExecutedResult {
  content: (TextContent | ImageContent)[];
  isError: boolean;
  details?: unknown;
  addedToolNames?: string[];
  terminate?: boolean;
}

/**
 * 阶段2: execute —— 真正调用 tool.execute();blocked / 不可达工具走 isError 兜底。
 * onUpdate 回调把流式 partial 转发为 tool_execution_update 事件 + ledger entry。
 */
export async function executePreparedToolCall(
  p: PreparedToolCall,
  config: AgentLoopConfig,
  signal: AbortSignal,
  fire: (ev: AgentEvent, entry?: Omit<LedgerEntry, "sessionId">) => Promise<void>,
  sessionId: string,
): Promise<AgentToolExecutedResult> {
  // blocked / tool 未找到 → 立即合成 isError 内容,不调 execute
  if (p.blocked) {
    return {
      content: [{ type: "text", text: p.blocked.reason ?? "blocked by beforeToolCall" }],
      isError: true,
      details: undefined,
    };
  }
  if (!p.tool) {
    return {
      content: [{ type: "text", text: `Tool not found: ${p.toolCall.name}` }],
      isError: true,
      details: undefined,
    };
  }

  let updateChain: Promise<void> = Promise.resolve();
  const onUpdate: AgentToolUpdateCallback = (partialResult) => {
    const ts = Date.now();
    updateChain = updateChain.then(() => fire({
        type: "tool_execution_update",
        timestamp: ts,
        toolCallId: p.toolCall.id,
        toolName: p.toolCall.name,
        partialResult,
      })).catch(() => {
        // sink 失败吞掉
      });
  };

  // 构造 ToolContext:cwd / env 从 config 取回退到 process.cwd/localExecutionEnv。
  // 对齐 claude-code-bun docs/tools/what-are-tools.mdx §"ToolContext 的语义"。
  const cwd = config.cwd ?? process.cwd();
  const env = config.executionEnv ?? localExecutionEnv(cwd);
  const toolContext = makeToolContext({
    cwd,
    env,
    ledger: config.ledger,
    envVars: config.env ?? {},
    signal,
    sessionId,
    toolCallId: p.toolCall.id,
  });

  try {
    const result = await p.tool.execute(
      p.toolCall.id,
      p.args as never,
      signal,
      onUpdate,
      toolContext,
    );
    await updateChain;
    // 超 maxResultSizeChars 的 result content 文本溢出落盘 + 路径 hint
    const maxChars = p.tool.maxResultSizeChars ?? DEFAULT_MAX_BYTES;
    const content = await applyToolResultBudget(result.content, maxChars, p.toolCall.id, config.toolResultOverflowStore);
    return {
      content,
      isError: result.isError === true,
      details: result.details,
      addedToolNames: result.addedToolNames,
      terminate: result.terminate,
    };
  } catch (e) {
    await updateChain;
	const errorCode = codedError(e);
    return {
      content: [{ type: "text", text: (e as Error).message ?? String(e) }],
      isError: true,
      details: errorCode === undefined ? undefined : { errorCode },
    };
  }
}

function codedError(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("code" in value)) return undefined;
  const code = value.code;
  return typeof code === "string" && code.length > 0 && code.length <= 128 ? code : undefined;
}
