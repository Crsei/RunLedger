/**
 * S4 拆分:阶段1 tool call prepare 与执行管线编排。
 *
 * prepare 串行(emit tool_execution_start + 校验 + beforeToolCall,失败合成
 * immediate error prepared),execute 按模式并发/串行,finalize 串行收口;
 * 每个 prepared call 至多 finalize 一次。schema 校验先于执行。
 */

import { newId } from "../ledger/types.ts";
import type { LedgerEntry } from "../ledger/types.ts";
import type { Tool } from "../../types.ts";
import { validateToolArguments } from "../../utils/validation.ts";
import { findToolByCallName } from "../tool-name-aliases.ts";
import { executePreparedToolCall } from "./tool-call-execution.ts";
import { finalizeExecutedToolCall } from "./tool-call-finalization.ts";
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  AgentToolCall,
  AssistantAgentMessage,
  BeforeToolCallResult,
  ToolResultContent,
} from "../types.ts";

export interface PreparedToolCall {
  toolCall: AgentToolCall;
  tool: AgentTool | undefined;
  args: unknown;
  /** beforeToolCall 已被调用且返回 block:true,直接合成 isError result */
  blocked?: { reason?: string; errorCode: string };
}

type ToolExecutionModeLike = "sequential" | "parallel";

/**
 * 工具调用执行入口:按 config.toolExecution 与每个 tool 自身 executionMode
 * 决定 sequential / parallel。返回的 ToolResultContent[] 与 toolCalls 同序。
 */
export async function executeToolCalls(
  toolCalls: AgentToolCall[],
  tools: AgentTool[],
  messages: AgentMessage[],
  assistantMessage: AssistantAgentMessage,
  context: AgentContext,
  config: AgentLoopConfig,
  signal: AbortSignal,
  fire: (ev: AgentEvent, entry?: Omit<LedgerEntry, "sessionId">) => Promise<void>,
  sessionId: string,
): Promise<ToolResultContent[]> {
  const mode = resolveExecutionMode(toolCalls, tools, config.toolExecution ?? "sequential");
  if (mode === "parallel") {
    // prepare 串行(emit tool_execution_start + 校验 + beforeToolCall),
    // execute 并发,finalize 按 await 实际完成顺序串行
    const prepared: PreparedToolCall[] = [];
    for (const tc of toolCalls) {
      const p = await prepareToolCall(tc, tools, messages, assistantMessage, context, config, signal, fire, sessionId);
      prepared.push(p);
    }
    const results = await Promise.all(
      prepared.map((p) => executePreparedToolCall(p, config, signal, fire, sessionId)),
    );
    const out: ToolResultContent[] = [];
    for (let i = 0; i < prepared.length; i++) {
      out.push(
        await finalizeExecutedToolCall(prepared[i]!, results[i]!, context, config, signal, fire, sessionId),
      );
    }
    return out;
  }
  // sequential
  const out: ToolResultContent[] = [];
  for (const tc of toolCalls) {
    const p = await prepareToolCall(tc, tools, messages, assistantMessage, context, config, signal, fire, sessionId);
    const r = await executePreparedToolCall(p, config, signal, fire, sessionId);
    out.push(await finalizeExecutedToolCall(p, r, context, config, signal, fire, sessionId));
  }
  return out;
}

/**
 * 解析批次执行模式:任一工具 executionMode === "sequential" 则降级 sequential。
 */
export function resolveExecutionMode(
  toolCalls: AgentToolCall[],
  tools: AgentTool[],
  fallback: ToolExecutionModeLike,
): "sequential" | "parallel" {
  // 显式 sequential 走 sequential
  if (fallback === "sequential") return "sequential";
  // 任一工具自身声明 executionMode="sequential" → 整批 sequential
  for (const tc of toolCalls) {
    const tool = findToolByCallName(tools, tc.name);
    if (tool?.executionMode === "sequential") return "sequential";
  }
  // 任一工具 isConcurrencySafe?.() 不返回 true → 整批 sequential
  // (对齐 claude-code-bun docs/tools/what-are-tools.mdx §"并行执行模式")
  for (const tc of toolCalls) {
    const tool = findToolByCallName(tools, tc.name);
    const safe = tool?.isConcurrencySafe?.();
    if (safe !== true) return "sequential";
  }
  return "parallel";
}

/**
 * 阶段1: prepare —— 路由工具、调 prepareArguments、schema 校验、beforeToolCall hook。
 * 失败时合成 immediate error prepared(后续 execute 会跳过 execute() 直接落 isError)。
 */
export async function prepareToolCall(
  tc: AgentToolCall,
  tools: AgentTool[],
  messages: AgentMessage[],
  assistantMessage: AssistantAgentMessage,
  context: AgentContext,
  config: AgentLoopConfig,
  signal: AbortSignal,
  fire: (ev: AgentEvent, entry?: Omit<LedgerEntry, "sessionId">) => Promise<void>,
  sessionId: string,
): Promise<PreparedToolCall> {
  const tStart = Date.now();
  await fire(
    {
      type: "tool_execution_start",
      timestamp: tStart,
      toolCallId: tc.id,
      toolName: tc.name,
      args: tc.arguments,
    },
    {
      id: newId(),
      parentId: sessionId,
      timestamp: tStart,
      type: "tool_call",
      payload: { toolCallId: tc.id, toolName: tc.name, input: tc.arguments },
    },
  );

  // 调用名先按别名表解析,再匹配规范名(如历史 `find` → `glob`)。
  const tool = findToolByCallName(tools, tc.name);
  if (!tool) {
    return { toolCall: tc, tool: undefined, args: tc.arguments };
  }

  // signal 已取消时 immediately 终止
  if (signal?.aborted) {
    return { toolCall: tc, tool, args: tc.arguments, blocked: { reason: "Operation aborted", errorCode: "tool_aborted" } };
  }

  // schema 校验:先把 raw args 走 prepareArguments,再 validate
  let preparedArgs: unknown;
  try {
    preparedArgs = prepareToolArguments(tool, tc, tc.arguments);
  } catch (e) {
    return { toolCall: tc, tool, args: tc.arguments, blocked: { reason: (e as Error).message ?? String(e), errorCode: "invalid_tool_arguments" } };
  }

  // beforeToolCall hook
  if (config.beforeToolCall) {
    try {
      const before = await config.beforeToolCall({
        assistantMessage,
        toolCall: tc,
        args: preparedArgs,
        context,
        tool,
      }, signal);
      if (before && (before as BeforeToolCallResult).block) {
        return {
          toolCall: tc,
          tool,
          args: preparedArgs,
          blocked: { reason: (before as BeforeToolCallResult).reason, errorCode: "tool_admission_denied" },
        };
      }
			if (before !== undefined && Object.hasOwn(before, "updatedInput")) {
				try {
					preparedArgs = prepareToolArguments(tool, tc, (before as BeforeToolCallResult).updatedInput);
				} catch (e) {
					return {
						toolCall: tc,
						tool,
						args: preparedArgs,
						blocked: { reason: `updated tool input failed schema validation: ${(e as Error).message ?? String(e)}`, errorCode: "invalid_tool_arguments" },
					};
				}
				const reauthorized = await config.beforeToolCall({
					assistantMessage,
					toolCall: tc,
					args: preparedArgs,
					context,
					tool,
				}, signal);
				if (reauthorized && reauthorized.block) {
					return {
						toolCall: tc,
						tool,
						args: preparedArgs,
						blocked: { reason: reauthorized.reason, errorCode: "tool_admission_denied" },
					};
				}
				if (reauthorized !== undefined && Object.hasOwn(reauthorized, "updatedInput")) {
					return {
						toolCall: tc,
						tool,
						args: preparedArgs,
						blocked: { reason: "tool input changed again during reauthorization", errorCode: "tool_input_changed" },
					};
				}
			}
    } catch (e) {
      // hook 抛错按 block 处理,不污染主循环
      void messages;
      return {
        toolCall: tc,
        tool,
        args: preparedArgs,
        blocked: { reason: (e as Error).message ?? String(e), errorCode: "tool_admission_error" },
      };
    }
  }

  return { toolCall: tc, tool, args: preparedArgs };
}

function prepareToolArguments(tool: AgentTool, toolCall: AgentToolCall, input: unknown): unknown {
	let prepared = input;
	if (tool.prepareArguments) prepared = tool.prepareArguments(input);
	return validateToolArguments(tool as unknown as Tool, {
		type: "toolCall",
		id: toolCall.id,
		name: toolCall.name,
		arguments: prepared as Record<string, unknown>,
	});
}
