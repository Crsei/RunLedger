/**
 * S4 拆分:阶段2 tool call execute —— 真正调用 tool.execute()。
 *
 * blocked / 不可达工具走 isError 兜底;onUpdate 回调把流式 partial 转发为
 * tool_execution_update 事件；最终结果在 hook 之后统一裁剪。
 */

import type { ImageContent, TextContent } from "../../types.ts";
import { localExecutionEnv } from "../execution-env.ts";
import { makeToolContext } from "../tool-context.ts";
import type { LedgerEntry } from "../ledger/types.ts";
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
      content: [{ type: "text", text: `${p.blocked.reason ?? "Tool admission denied"}${p.blocked.errorCode === "invalid_tool_arguments" ? ". Correct the arguments to match the tool schema before retrying." : ""}` }],
      isError: true,
      details: { errorCode: p.blocked.errorCode, executed: false },
    };
  }
  if (!p.tool) {
    return {
      content: [{ type: "text", text: `Tool not found: ${p.toolCall.name}. Use a tool listed in the current session.` }],
      isError: true,
      details: { errorCode: "tool_not_found", executed: false },
    };
  }

  if (signal.aborted) {
    return {
      content: [{ type: "text", text: "Tool call was not executed because the operation was aborted before execution." }],
      isError: true, details: { errorCode: "tool_aborted", executed: false },
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
    return {
      content: result.content,
      isError: result.isError === true,
      details: result.details,
      addedToolNames: result.addedToolNames,
    };
  } catch (e) {
    await updateChain;
	const errorCode = codedError(e);
    return {
      content: [{ type: "text", text: (e as Error).message ?? String(e) }],
      isError: true,
      details: { errorCode: errorCode ?? "tool_execution_error" },
    };
  }
}

function codedError(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("code" in value)) return undefined;
  const code = value.code;
  return typeof code === "string" && code.length > 0 && code.length <= 128 ? code : undefined;
}
