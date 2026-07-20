/**
 * Agent 循环核心实现。
 *
 * 对照参考 pi 的 `packages/agent/src/agent-loop.ts`。
 * 本期只实现"无队列、无 thinking、无 transformContext"的最简形态,
 * 但保留 outer/inner 双层结构与 shouldStopAfterTurn / prepareNextTurn 钩子,
 * 以便后续按 pi 的方式逐步补全(`// TODO(pi):` 注释标出占位)。
 *
 * 核心流程(伪代码):
 *   emit agent_start
 *   把 prompts 作为 user 消息入 context
 *   loop:
 *     emit turn_start
 *     llm_messages = config.convertToLlm(context.messages)
 *     stream = streamFn(model, {systemPrompt, messages: llm_messages, tools}, { apiKey, env, signal })
 *     for ev of stream:
 *       首次 start → emit message_start("assistant")
 *       text_delta / toolcall_* → 累积 content + emit message_update(ev)
 *       done → 拿 message.stopReason / message.usage
 *       error → stopReason = "error"
 *     把助理消息 push 到 context
 *     取出 toolCall 块
 *     if stopReason === "length": 全部 toolCall 标 isError
 *     else: executeToolCalls (parallel | sequential),emit tool_execution_start/end,
 *          把 toolResult 消息 push 到 context
 *     emit turn_end
 *     if prepareNextTurn: apply update(model / tools / systemPrompt)
 *     if shouldStopAfterTurn: break
 *     if no toolCall: break
 *   emit agent_end
 *   返回 context.messages
 *
 * 事件协议直接消费 pi-ai AssistantMessageEvent(start / text_delta /
 * toolcall_end / done / error)。骨架原版假定的 text_delta.delta 累加、
 * toolcall_end.toolCall 取 ToolCall 字段、stop.stopReason/usage 字段,
 * 全部对齐 pi-ai 命名,减少译码层。
 */

import type {
  AgentContext,
  AgentEvent,
  AgentEventSink,
  AgentLoopConfig,
  AgentLoopTurnUpdate,
  AgentMessage,
  AgentTool,
  AgentToolCall,
  AfterToolCallResult,
  AssistantAgentMessage,
  BeforeToolCallResult,
  LlmContext,
  StreamFn,
  ToolResultAgentMessage,
  ToolResultContent,
} from "./types.ts";
import type { Message, StopReason, TextContent, ToolCall } from "../types.ts";
import { newId } from "./ledger/types.ts";
import type { LedgerSink, LedgerEntry } from "./ledger/types.ts";

/**
 * 与 pi 对齐的对外接口。本期只实现 runAgentLoop 与 runAgentLoopContinue,
 * agentLoop 与 agentLoopContinue(返回 EventStream 的 push-based 包装)以 `// TODO(pi):` 占位。
 */
export async function runAgentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal?: AbortSignal,
  streamFn?: StreamFn,
): Promise<AgentMessage[]> {
  const ledger = configLedgerExtract(config);
  const sessionStart = Date.now();
  const sessionId = ledger?.sessionId ?? newId();

  // emit + ledger 联合写入辅助
  const fire = async (
    ev: AgentEvent,
    ledgerEntry?: Omit<LedgerEntry, "sessionId">,
  ): Promise<void> => {
    await emit(ev);
    if (ledger && ledgerEntry) {
      const entry: LedgerEntry = {
        ...ledgerEntry,
        sessionId,
      };
      await ledger.append(entry);
    }
  };

  await fire(
    { type: "agent_start", timestamp: sessionStart },
    {
      id: newId(),
      parentId: sessionId,
      timestamp: sessionStart,
      type: "agent_event",
      payload: { event: "agent_start" },
    },
  );

  // 把 prompts 作为 user 消息入 context
  const messages: AgentMessage[] = context.messages.slice();
  for (const p of prompts) {
    if (p.role !== "user") {
      throw new Error(`runAgentLoop 仅接受 user 角色的 prompt,实际为 ${p.role}`);
    }
    const ts = Date.now();
    await fire(
      { type: "message_start", timestamp: ts, role: "user" },
      {
        id: newId(),
        parentId: sessionId,
        timestamp: ts,
        type: "message",
        payload: {
          role: "user",
          content: (p.content as TextContent[]).map((c) => c.text).join(""),
        },
      },
    );
    messages.push(p);
    const ts2 = Date.now();
    await fire(
      { type: "message_end", timestamp: ts2, role: "user" },
      {
        id: newId(),
        parentId: sessionId,
        timestamp: ts2,
        type: "message",
        payload: { role: "user", phase: "end" },
      },
    );
  }

  let turn = 0;
  let lastStopReason: StopReason = "stop";
  let loopModel = config.model;

  // inner loop
  while (true) {
    if (signal?.aborted) {
      lastStopReason = "aborted";
      break;
    }
    turn++;
    const tStart = Date.now();
    await fire(
      { type: "turn_start", timestamp: tStart, turn },
      {
        id: newId(),
        parentId: sessionId,
        timestamp: tStart,
        type: "turn",
        payload: { turn, phase: "start" },
      },
    );

    // 1. AgentMessage → LLM Message[],在边界处做了角色译码
    const convertFn = config.convertToLlm ?? defaultConvertToLlm;
    const llmMessages = await convertFn(messages);

    const llmContext: LlmContext = {
      systemPrompt: context.systemPrompt,
      messages: llmMessages,
      tools: context.tools,
    };

    // 2. 取 streamFn
    const fn = streamFn;
    if (!fn) {
      throw new Error("streamFn is required (avoid passing undefined)");
    }
    const stream = await Promise.resolve(
      fn(loopModel, llmContext, {
        apiKey: config.apiKey,
        env: config.env,
        signal,
      }),
    );

    // 3. 消费 stream,边 emit message_* 事件,边累积 assistant content
    const assistantContent: AssistantAgentMessage["content"] = [];
    let assistantStopReason: StopReason = "stop";
    let assistantUsage: AssistantAgentMessage["usage"] | undefined;
    let assistantErrorMessage: string | undefined;
    let messageOpen = false;
    for await (const ev of stream) {
      const ts = Date.now();
      if (ev.type === "start") {
        if (!messageOpen) {
          messageOpen = true;
          await fire({
            type: "message_start",
            timestamp: ts,
            role: "assistant",
          });
        }
      } else if (ev.type === "text_start" || ev.type === "text_end" || ev.type === "thinking_start" || ev.type === "thinking_delta" || ev.type === "thinking_end" || ev.type === "toolcall_start" || ev.type === "toolcall_delta") {
        // 暂不消费,但 forward 给 observer
        await fire({
          type: "message_update",
          timestamp: ts,
          assistantMessageEvent: ev,
        });
      } else if (ev.type === "text_delta") {
        // 合并相邻 text 块,避免每个 delta 一个 TextContent
        const last = assistantContent[assistantContent.length - 1];
        if (last && last.type === "text") {
          // 不可变 update:用 spread 创建新对象以避免上层引用混乱
          assistantContent[assistantContent.length - 1] = {
            type: "text",
            text: (last as { type: "text"; text: string }).text + ev.delta,
          };
        } else {
          assistantContent.push({ type: "text", text: ev.delta });
        }
        await fire({
          type: "message_update",
          timestamp: ts,
          assistantMessageEvent: ev,
        });
      } else if (ev.type === "toolcall_end") {
        const toolCall = ev.toolCall;
        // 转 AgentToolCall 视图(input = arguments)
        const agentToolCall: AgentToolCall = {
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.arguments,
        };
        // 同时把 ToolCall block 存进 assistantContent(以保留 pi-ai 字段命名)
        assistantContent.push(toolCall);
        await fire({
          type: "message_update",
          timestamp: ts,
          assistantMessageEvent: {
            type: "toolcall_end",
            contentIndex: ev.contentIndex,
            toolCall,
            partial: ev.partial,
          },
        });
        // 防御性使用 agentToolCall 引用(便于断点调试,不被 verbatim 警告)
        void agentToolCall;
      } else if (ev.type === "done") {
        assistantStopReason = ev.message.stopReason;
        assistantUsage = ev.message.usage;
        assistantErrorMessage = ev.message.errorMessage;
      } else if (ev.type === "error") {
        assistantStopReason = ev.error.stopReason === "aborted" ? "aborted" : "error";
        assistantErrorMessage = ev.error.errorMessage;
      }
    }
    if (messageOpen) {
      const ts = Date.now();
      await fire(
        {
          type: "message_end",
          timestamp: ts,
          role: "assistant",
          stopReason: assistantStopReason,
        },
        {
          id: newId(),
          parentId: sessionId,
          timestamp: ts,
          type: "message",
          payload: {
            role: "assistant",
            stopReason: assistantStopReason,
            content: serializeAssistant(assistantContent),
            errorMessage: assistantErrorMessage,
          },
        },
      );
    }

    const assistantMessage: AssistantAgentMessage = {
      role: "assistant",
      content: assistantContent,
      stopReason: assistantStopReason,
      usage: assistantUsage,
      errorMessage: assistantErrorMessage,
    };
    messages.push(assistantMessage);
    lastStopReason = assistantStopReason;

    // 4. 取出 toolCall 块(从 pi-ai ToolCall 视图转 AgentToolCall 视图)
    const toolCalls: AgentToolCall[] = assistantContent
      .filter((c): c is ToolCall => c.type === "toolCall")
      .map((tc: ToolCall): AgentToolCall => ({
        id: tc.id,
        name: tc.name,
        input: tc.arguments,
      }));

    if (toolCalls.length > 0) {
      // 5. 执行
      const toolResults = await executeToolCalls(
        toolCalls,
        context.tools,
        messages,
        config,
        signal ?? new AbortController().signal,
        fire,
        sessionId,
      );
      for (const r of toolResults) {
        const msg: ToolResultAgentMessage = {
          role: "toolResult",
          content: [r],
        };
        messages.push(msg);
      }
    }

    const tEnd = Date.now();
    await fire(
      { type: "turn_end", timestamp: tEnd, turn, stopReason: lastStopReason },
      {
        id: newId(),
        parentId: sessionId,
        timestamp: tEnd,
        type: "turn",
        payload: { turn, phase: "end", stopReason: lastStopReason },
      },
    );

    // apply prepareNextTurn
    const update = await config.prepareNextTurn?.({ messages, turn });
    if (update) {
      applyTurnUpdate(update, context);
      if (update.model) {
        loopModel = update.model;
      }
    }

    // shouldStopAfterTurn hook
    const shouldStop = await config.shouldStopAfterTurn?.({ messages, turn });
    if (shouldStop) {
      break;
    }

    // 内层循环退出条件:无 toolCall 或非 toolUse 原因
    if (toolCalls.length === 0 || assistantStopReason !== "toolUse") {
      break;
    }

    // TODO(pi): getSteeringMessages / getFollowUpMessages 队列在此处排空
  }

  const agentEnd = Date.now();
  await fire(
    { type: "agent_end", timestamp: agentEnd },
    {
      id: newId(),
      parentId: sessionId,
      timestamp: agentEnd,
      type: "agent_event",
      payload: { event: "agent_end", stopReason: lastStopReason, turn },
    },
  );

  // 同步 context.messages
  context.messages = messages;
  return messages;
}

/**
 * 默认 convertToLlm 把 AgentMessage[] 摊平为 pi-ai Message[]:
 *   - user:直接传 content(补 timestamp,pi-ai UserMessage 必填)
 *   - assistant:直接传 content(转 typecast,pi-ai AssistantMessage 字段更多,
 *     但 streamFn 重新调用时不强制要求完整字段)
 *   - toolResult:把内嵌的 ToolResultContent 摊成多条 pi-ai ToolResultMessage,
 *     每条带 toolCallId / toolName / isError / timestamp
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
      // why any:pi-ai AssistantMessage 必填 api/provider/model/usage/timestamp 等字段,
      // 我们在 runtime 层只保留 content / stopReason / errorMessage。
      // streamFn 重新发起 LLM 请求时 provider 实现会重新生成 AssistantMessage,
      // mock provider 也不依赖这些历史字段,所以这里直接拼最小合法形态再断言。
      out.push({
        role: "assistant",
        content: m.content,
        api: "mock",
        provider: "mock",
        model: "",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: m.stopReason,
        errorMessage: m.errorMessage,
        timestamp: Date.now(),
      } as unknown as Message);
    } else if (m.role === "toolResult") {
      for (const c of m.content) {
        out.push({
          role: "toolResult",
          toolCallId: c.toolCallId,
          toolName: "",
          content: c.content,
          isError: c.isError === true,
          timestamp: Date.now(),
        });
      }
    }
  }
  return out;
}

// ===== 私有 helpers =====

function applyTurnUpdate(update: AgentLoopTurnUpdate, context: AgentContext): void {
  if (update.systemPrompt !== undefined) {
    context.systemPrompt = update.systemPrompt;
  }
  if (update.tools !== undefined) {
    context.tools = update.tools;
  }
}

async function executeToolCalls(
  toolCalls: AgentToolCall[],
  tools: AgentTool[],
  messages: AgentMessage[],
  config: AgentLoopConfig,
  signal: AbortSignal,
  fire: (ev: AgentEvent, entry?: Omit<LedgerEntry, "sessionId">) => Promise<void>,
  sessionId: string,
): Promise<ToolResultContent[]> {
  const mode = config.toolExecution ?? "sequential";
  if (mode === "parallel") {
    return Promise.all(
      toolCalls.map((tc) => runOneTool(tc, tools, messages, config, signal, fire, sessionId)),
    );
  }
  // sequential
  const out: ToolResultContent[] = [];
  for (const tc of toolCalls) {
    out.push(await runOneTool(tc, tools, messages, config, signal, fire, sessionId));
  }
  return out;
}

async function runOneTool(
  tc: AgentToolCall,
  tools: AgentTool[],
  messages: AgentMessage[],
  config: AgentLoopConfig,
  signal: AbortSignal,
  fire: (ev: AgentEvent, entry?: Omit<LedgerEntry, "sessionId">) => Promise<void>,
  sessionId: string,
): Promise<ToolResultContent> {
  const tool = tools.find((t) => t.name === tc.name);
  const tStart = Date.now();

  // beforeToolCall hook
  if (tool) {
    const before = await config.beforeToolCall?.({ tool, toolCall: tc, messages }, signal);
    if (before?.block) {
      return blockedResult(tc, before.reason);
    }
  }

  await fire(
    { type: "tool_execution_start", timestamp: tStart, toolCallId: tc.id, toolName: tc.name },
    {
      id: newId(),
      parentId: sessionId,
      timestamp: tStart,
      type: "tool_call",
      payload: { toolCallId: tc.id, toolName: tc.name, input: tc.input },
    },
  );

  let result: ToolResultContent;
  if (!tool) {
    result = {
      type: "toolResult",
      toolCallId: tc.id,
      content: [{ type: "text", text: `Tool not found: ${tc.name}` }],
      isError: true,
    };
  } else {
    try {
      result = await tool.execute(tc.id, tc.input, signal);
    } catch (e) {
      result = {
        type: "toolResult",
        toolCallId: tc.id,
        content: [{ type: "text", text: (e as Error).message ?? String(e) }],
        isError: true,
      };
    }
  }

  // afterToolCall hook
  if (tool) {
    const after = await config.afterToolCall?.(
      { tool, toolCall: tc, messages, result },
      signal,
    );
    if (after) {
      applyAfterToolCallResult(result, after);
    }
  }

  const tEnd = Date.now();
  await fire(
    {
      type: "tool_execution_end",
      timestamp: tEnd,
      toolCallId: tc.id,
      toolName: tc.name,
      isError: result.isError === true,
    },
    {
      id: newId(),
      parentId: sessionId,
      timestamp: tEnd,
      type: "tool_result",
      payload: {
        toolCallId: tc.id,
        toolName: tc.name,
        isError: result.isError === true,
        content: result.content.map((c) => c.text).join(""),
      },
    },
  );

  return result;
}

function applyAfterToolCallResult(
  target: ToolResultContent,
  after: AfterToolCallResult,
): void {
  if (after.content !== undefined) {
    target.content = after.content;
  }
  if (after.details !== undefined) {
    // 直接挂在 result 上(扩展字段)。
    (target as ToolResultContent & { details?: unknown }).details = after.details;
  }
  if (after.isError !== undefined) {
    target.isError = after.isError;
  }
}

function blockedResult(tc: AgentToolCall, reason?: string): ToolResultContent {
  return {
    type: "toolResult",
    toolCallId: tc.id,
    content: [{ type: "text", text: reason ?? "blocked by beforeToolCall" }],
    isError: true,
  };
}

function serializeAssistant(content: AssistantAgentMessage["content"]): string {
  return content
    .map((c) => (c.type === "text" ? c.text : `[toolCall ${(c as ToolCall).name}]`))
    .join("");
}

// 兼容既存配置中可能携带 ledger 字段(本期类型未在 AgentLoopConfig 暴露 ledger,
// 通过自定义扩展传入,以保持类型契约干净)。
interface WithLedger {
  ledger?: LedgerSink;
}
function configLedgerExtract(config: AgentLoopConfig): LedgerSink | undefined {
  const wl = config as AgentLoopConfig & WithLedger & Record<string, unknown>;
  return wl.ledger;
}

// 占位:runAgentLoopContinue 暂未实现(本期 demo 不使用)
// `// TODO(pi): resume without new prompt`
export async function runAgentLoopContinue(
  _context: AgentContext,
  _config: AgentLoopConfig,
  _emit: AgentEventSink,
  _signal?: AbortSignal,
  _streamFn?: StreamFn,
): Promise<AgentMessage[]> {
  throw new Error("runAgentLoopContinue not implemented yet"); // TODO(pi)
}

// 占位:BeforeToolCallResult 推断辅助
export type { BeforeToolCallResult };
