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
 *     stream = streamFn(model, {systemPrompt, messages: llm_messages, tools})
 *     for ev in stream.iterate():
 *       首次 start → emit message_start("assistant")
 *       text_delta/toolcall_* → emit message_update(ev)
 *       stop → emit message_end("assistant")
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
  Message,
  StopReason,
  StreamFn,
  ToolResultAgentMessage,
  ToolResultContent,
  TextContent,
} from "./types.js";
import { newId } from "./ledger/types.js";
import type { LedgerSink, LedgerEntry } from "./ledger/types.js";

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
  let sessionId = ledger?.sessionId ?? newId();

  // emit + ledger 联合写入辅助
  const fire = async (ev: AgentEvent, ledgerEntry?: Omit<LedgerEntry, "sessionId">): Promise<void> => {
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
        payload: { role: "user", content: (p.content as TextContent[]).map((c) => c.text).join("") },
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
    const llmMessages = await config.convertToLlm(messages);

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
      fn(loopModel, llmContext, { apiKey: config.apiKey, signal }),
    );

    // 3. 消费 stream,边 emit message_* 事件,边累积 assistant content
    const assistantContent: AssistantAgentMessage["content"] = [];
    let assistantStopReason: StopReason = "stop";
    let assistantUsage: AssistantAgentMessage["usage"] | undefined;
    let messageOpen = false;
    for await (const ev of stream.iterate()) {
      const ts = Date.now();
      if (ev.type === "start") {
        if (!messageOpen) {
          messageOpen = true;
          await fire(
            { type: "message_start", timestamp: ts, role: "assistant" },
          );
        }
      } else if (ev.type === "text_start") {
        // 忽略
      } else if (ev.type === "text_delta") {
        // 合并相邻 text 块,避免每个 delta 一个 TextContent
        const last = assistantContent[assistantContent.length - 1];
        if (last && last.type === "text") {
          // 不可变 update:用 concat 创建新对象以避免上层引用混乱
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
      } else if (ev.type === "text_end") {
        // 忽略
      } else if (ev.type === "toolcall_start") {
        // 占位 push 一个 toolCall,等 end 时填 input
        // 但本期为了简单,input 在 toolcall_end 时统一补全
        // 这里先 gap-fill
      } else if (ev.type === "toolcall_delta") {
        // 忽略(partial JSON)
      } else if (ev.type === "toolcall_end") {
        assistantContent.push({
          type: "toolCall",
          id: ev.id,
          name: ev.name,
          input: ev.input,
        });
        await fire({
          type: "message_update",
          timestamp: ts,
          assistantMessageEvent: {
            type: "toolcall_end",
            id: ev.id,
            name: ev.name,
            input: ev.input,
          },
        });
      } else if (ev.type === "stop") {
        assistantStopReason = ev.stopReason;
        assistantUsage = ev.usage;
      } else if (ev.type === "error") {
        assistantStopReason = "error";
      }
    }
    if (messageOpen) {
      const ts = Date.now();
      await fire(
        { type: "message_end", timestamp: ts, role: "assistant" },
        {
          id: newId(),
          parentId: sessionId,
          timestamp: ts,
          type: "message",
          payload: {
            role: "assistant",
            stopReason: assistantStopReason,
            content: serializeAssistant(assistantContent),
          },
        },
      );
    }

    const assistantMessage: AssistantAgentMessage = {
      role: "assistant",
      content: assistantContent,
      stopReason: assistantStopReason,
      usage: assistantUsage,
    };
    messages.push(assistantMessage);
    lastStopReason = assistantStopReason;

    // 4. 取出 toolCall 块
    const toolCalls = assistantContent.filter(
      (c): c is AgentToolCall => c.type === "toolCall",
    );

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

    // 内层循环退出条件:无 toolCall 或非 tool_use 原因
    if (toolCalls.length === 0 || assistantStopReason !== "tool_use") {
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
 * 临时占位,后续引入 OpenAI / Anthropic provider 时,这里就是 `convertToLlm` 的默认实现处。
 * `// TODO(pi): 默认 convertToLlm`
 */
export function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
  const out: Message[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      out.push({
        role: "assistant",
        content: m.content,
      } as Message);
    } else if (m.role === "toolResult") {
      for (const c of m.content) {
        out.push({
          role: "toolResult",
          content: [c],
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
    return Promise.all(toolCalls.map((tc) => runOneTool(tc, tools, messages, config, signal, fire, sessionId)));
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
    .map((c) => (c.type === "text" ? c.text : `[toolCall ${c.name}]`))
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
