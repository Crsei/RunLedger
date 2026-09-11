/**
 * S4 拆分:outer turn / inner assistant stream 状态机。
 *
 * 本文件是 runAgentLoop 的唯一实现:事件顺序、steering/follow-up 消费边界、
 * budget 终止与 provider error/abort 的 stop reason 组合均保持拆分前语义。
 * 状态机超过 120 行 guardrail:outer/inner 双层循环与事件/ledger 联合写入
 * 共享同一 `fire` 闭包与循环变量,拆分会破坏原子性(计划 §3 例外记录)。
 */

import type { TraceModelHandle } from "../trace/recorder.ts";
import { newId } from "../ledger/types.ts";
import type { LedgerEntry } from "../ledger/types.ts";
import type { AssistantMessage, StopReason, ToolCall } from "../../types.ts";
import {
  activeDurationExhausted,
  appendBudgetTerminationSummary,
  isApprovalExpiration,
  repeatedToolFailure,
  validateRunBudget,
} from "./run-budget.ts";
import { defaultConvertToLlm, serializeAssistant } from "./context-conversion.ts";
import { executeToolCalls } from "./tool-call-preparation.ts";
import { failUnexecutedToolCalls } from "./assistant-recovery.ts";
import type {
  AgentContext,
  AgentEvent,
  AgentEventSink,
  AgentLoopConfig,
  AgentLoopTurnUpdate,
  AgentMessage,
  AgentRunTerminationReason,
  AgentToolCall,
  AssistantAgentMessage,
  LlmContext,
  StreamFn,
  ToolResultAgentMessage,
  ToolResultContent,
} from "../types.ts";

export async function runAgentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal?: AbortSignal,
  streamFn?: StreamFn,
): Promise<AgentMessage[]> {
  validateRunBudget(config.runBudget);
  const ledger = config.ledger;
  const sessionStart = Date.now();
  const sessionId = ledger?.sessionId ?? newId();
  const runId = `run-${newId()}`;

  if (config.traceRecorder) {
    await config.traceRecorder.startRun({ agentId: sessionId, metadata: { runId } });
  }

  // emit + ledger 联合写入辅助
  const fire = async (
    ev: AgentEvent,
    ledgerEntry?: Omit<LedgerEntry, "sessionId">,
  ): Promise<void> => {
    const normalizedEvent = ev.runId === undefined ? { ...ev, runId } : ev;
    await emit(normalizedEvent);
    if (ledger && ledgerEntry) {
      const entry: LedgerEntry = {
        ...ledgerEntry,
        sessionId,
      };
      await ledger.append(entry);
    }
    if (config.traceRecorder) {
      await config.traceRecorder.recordAgentEvent(normalizedEvent);
    }
  };

  await fire(
    { type: "agent_start", timestamp: sessionStart, runId },
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
    await fire({ type: "message_start", timestamp: ts, role: "user", message: p });
    messages.push(p);
    const ts2 = Date.now();
    await fire(
      { type: "message_end", timestamp: ts2, role: "user", message: p },
      {
        id: newId(),
        parentId: sessionId,
        timestamp: ts2,
        type: "message",
        payload: {
          role: "user",
          content: p.content.map((c) => c.text).join(""),
          message: p,
        },
      },
    );
  }

  context.messages = messages.slice();
  let turn = 0;
  let toolTurns = 0;
  let lastStopReason: StopReason = "stop";
  let terminationReason: AgentRunTerminationReason | undefined;
  let failureFingerprints: ReadonlyMap<string, number> = new Map();
  let repeatedFailureCount = 0;
  let approvalExpirations = 0;
  let loopModel = config.model;
  let loopReasoning = config.reasoning;
  let pendingMessages: AgentMessage[] = signal?.aborted ? [] : await config.getSteeringMessages?.() ?? [];

  const appendPendingMessages = async (): Promise<void> => {

    if (pendingMessages.length > 0) {
      for (const pending of pendingMessages) {
        if (pending.role !== "user") continue;
        const pendingStart = Date.now();
        await fire({ type: "message_start", timestamp: pendingStart, role: "user", message: pending });
        messages.push(pending);
        const pendingEnd = Date.now();
        await fire(
          { type: "message_end", timestamp: pendingEnd, role: "user", message: pending },
          {
            id: newId(),
            parentId: sessionId,
            timestamp: pendingEnd,
            type: "message",
            payload: {
              role: "user",
              content: pending.content.map((c) => c.text).join(""),
              message: pending,
            },
          },
        );
      }
      context.messages = messages.slice();
      pendingMessages = [];
    }

  };

  // inner loop
  while (true) {
    if (signal?.aborted) {
      lastStopReason = "aborted";
      break;
    }
    if (activeDurationExhausted(config)) {
      terminationReason = "active_duration_limit";
      lastStopReason = "length";
      await appendBudgetTerminationSummary(messages, terminationReason, fire, sessionId);
      context.messages = messages.slice();
      break;
    }
    if (config.runBudget !== undefined && turn >= config.runBudget.maxModelTurns) {
      terminationReason = "model_turn_limit";
      lastStopReason = "length";
      await appendBudgetTerminationSummary(messages, terminationReason, fire, sessionId);
      context.messages = messages.slice();
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

    const finishUnrequestedTurn = async (stopReason: "error" | "aborted"): Promise<void> => {
      const timestamp = Date.now();
      await fire({ type: "turn_end", timestamp, turn, stopReason }, {
        id: newId(), parentId: sessionId, timestamp, type: "turn",
        payload: { turn, phase: "end", stopReason },
      });
    };
    let llmContext: LlmContext;
    let traceModel: TraceModelHandle | undefined;
    try {
      await appendPendingMessages();
      // 请求准备失败也要结算已开始的 turn；accepted 输入已保存在 context。
      const convertFn = config.convertToLlm ?? defaultConvertToLlm;
      llmContext = {
        systemPrompt: context.systemPrompt,
        messages: await convertFn(messages),
        tools: context.tools,
      };
      if (config.modelContextAssembler !== undefined) {
        const assembled = await config.modelContextAssembler({ model: loopModel, context: llmContext, sessionId, turn, thinkingLevel: loopReasoning ?? "off" });
        llmContext = assembled.context;
        await config.contextAssemblySink?.({ sessionId, turn, model: loopModel, receipt: assembled.receipt });
      }
      if (!signal?.aborted && config.traceRecorder) {
        traceModel = await config.traceRecorder.startModel({ turn, model: loopModel, context: llmContext });
      }
    } catch (error) {
      await finishUnrequestedTurn(signal?.aborted ? "aborted" : "error");
      throw error;
    }

    if (signal?.aborted) {
      lastStopReason = "aborted";
      const timestamp = Date.now();
      if (traceModel && config.traceRecorder) await config.traceRecorder.finishModel(traceModel, {
        role: "assistant", content: [], stopReason: "aborted", timestamp,
        api: loopModel.api, provider: loopModel.provider, model: loopModel.id,
        errorMessage: "Cancelled before provider dispatch.",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      });
      await finishUnrequestedTurn("aborted");
      break;
    }

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
        metadata: { requestKind: config.requestKind ?? "interactive" },
        ...(loopReasoning && loopReasoning !== "off" ? { reasoning: loopReasoning } : {}),
      }),
    );

    // 3. 消费 stream,边 emit message_* 事件,边累积 assistant content
    const assistantContent: AssistantAgentMessage["content"] = [];
    let assistantStopReason: StopReason = "error";
    let assistantUsage: AssistantAgentMessage["usage"] | undefined;
    let assistantErrorMessage: string | undefined = "Assistant stream ended without a terminal event; tool calls were not executed.";
    let providerMessage: AssistantMessage | undefined;
    let messageOpen = false;
    let streamStartedAt: number | undefined;
    for await (const ev of stream) {
      const ts = Date.now();
      if (ev.type === "start") {
        if (!messageOpen) {
          messageOpen = true;
          streamStartedAt = ts;
          await fire({
            type: "message_start",
            timestamp: ts,
            role: "assistant",
            message: { role: "assistant", content: [], stopReason: "stop", api: loopModel.api, provider: loopModel.provider, model: loopModel.id },
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
        // 直接 push pi-ai ToolCall 视图,保留完整字段
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
      } else if (ev.type === "done") {
        providerMessage = ev.message;
        assistantStopReason = ev.message.stopReason;
        assistantUsage = ev.message.usage;
        assistantErrorMessage = ev.message.errorMessage;
      } else if (ev.type === "error") {
        providerMessage = ev.error;
        assistantStopReason = ev.error.stopReason === "aborted" ? "aborted" : "error";
        assistantErrorMessage = ev.error.errorMessage;
      }
    }
    const measuredDurationMs = providerMessage !== undefined
      && providerMessage.durationMs === undefined
      && providerMessage.stopReason !== "error"
      && providerMessage.stopReason !== "aborted"
      && streamStartedAt !== undefined
      ? Math.max(0, Date.now() - streamStartedAt)
      : undefined;
    const retainedProviderMessage = providerMessage === undefined || measuredDurationMs === undefined
      ? providerMessage
      : { ...providerMessage, durationMs: measuredDurationMs, timingSource: "measured" as const };
    const retainedDurationMs = retainedProviderMessage?.durationMs;
    const retainedTimingSource = retainedProviderMessage?.timingSource
      ?? (retainedDurationMs === undefined ? undefined : "provider");
    const assistantMessage: AssistantAgentMessage = {
      role: "assistant",
      content: retainedProviderMessage?.content ?? assistantContent,
      stopReason: assistantStopReason,
      usage: assistantUsage,
      errorMessage: assistantErrorMessage,
      api: retainedProviderMessage?.api ?? loopModel.api,
      provider: retainedProviderMessage?.provider ?? loopModel.provider,
      model: retainedProviderMessage?.model ?? loopModel.id,
      timestamp: retainedProviderMessage?.timestamp,
      durationMs: retainedDurationMs,
      ttftMs: retainedProviderMessage?.ttftMs,
      timingSource: retainedTimingSource,
    };
    if (traceModel && config.traceRecorder) {
      await config.traceRecorder.finishModel(traceModel, retainedProviderMessage);
    }
    if (messageOpen || providerMessage) {
      const ts = Date.now();
      // provider 可在响应头到达前失败；终态仍须有成对的消息边界供实时消费者投影。
      if (!messageOpen) {
        await fire({ type: "message_start", timestamp: ts, role: "assistant" });
      }
      await fire(
        {
          type: "message_end",
          timestamp: ts,
          role: "assistant",
          stopReason: assistantStopReason,
          message: assistantMessage,
        },
        {
          id: newId(),
          parentId: sessionId,
          timestamp: ts,
          type: "message",
          payload: {
            role: "assistant",
            stopReason: assistantStopReason,
            content: serializeAssistant(assistantMessage.content),
            errorMessage: assistantErrorMessage,
            message: assistantMessage,
          },
        },
      );
    }
    messages.push(assistantMessage);
    context.messages = messages.slice();
    lastStopReason = assistantStopReason;

    // 4. 取出 toolCall 块(直接复用 pi-ai ToolCall 视图)
    const toolCalls: AgentToolCall[] = assistantMessage.content.filter(
      (c): c is ToolCall => c.type === "toolCall",
    );

    if (toolCalls.length > 0) {
      let toolResults: ToolResultContent[];
      if (assistantStopReason === "length" || assistantStopReason === "error" || assistantStopReason === "aborted") {
        // 先判模型终态，失败响应不能进入准入、审批或执行链。
        toolResults = await failUnexecutedToolCalls(toolCalls, fire, sessionId, assistantStopReason);
      } else {
        // 5. 执行
        toolResults = await executeToolCalls(
          toolCalls,
          context.tools ?? [],
          messages,
          assistantMessage,
          context,
          config,
          signal ?? new AbortController().signal,
          fire,
          sessionId,
        );
      }
      for (const r of toolResults) {
        const msg: ToolResultAgentMessage = {
          role: "toolResult",
          content: [r],
        };
        messages.push(msg);
        context.messages = messages.slice();
        if (ledger) {
          const ts = Date.now();
          await ledger.append({
            id: newId(),
            parentId: sessionId,
            sessionId,
            timestamp: ts,
            type: "message",
            payload: {
              role: "toolResult",
              message: msg,
            },
          });
        }
      }
	  const repeatedFailure = repeatedToolFailure(toolResults, toolCalls, failureFingerprints);
	  failureFingerprints = repeatedFailure.fingerprints;
	  repeatedFailureCount = repeatedFailure.count;
	  approvalExpirations += toolResults.filter(isApprovalExpiration).length;
	  toolTurns += 1;
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

    if (signal?.aborted) {
      lastStopReason = "aborted";
      break;
    }
    if (assistantStopReason === "error" || assistantStopReason === "aborted") break;

    // apply prepareNextTurn
    const update = await config.prepareNextTurn?.({ messages, turn });
    if (update) {
      applyTurnUpdate(update, context);
      if (update.model) {
        loopModel = update.model;
      }
      if (update.thinkingLevel !== undefined) {
        loopReasoning = update.thinkingLevel;
      }
    }

    // shouldStopAfterTurn hook
    const shouldStop = await config.shouldStopAfterTurn?.({ messages, turn });
    if (shouldStop) {
      break;
    }

	if (config.runBudget !== undefined && toolTurns >= config.runBudget.maxToolTurns && toolCalls.length > 0 && assistantStopReason === "toolUse") {
	  terminationReason = "tool_turn_limit";
	  lastStopReason = "length";
	  await appendBudgetTerminationSummary(messages, terminationReason, fire, sessionId);
	  context.messages = messages.slice();
	  break;
	}

	if (activeDurationExhausted(config)) {
	  terminationReason = "active_duration_limit";
	  lastStopReason = "length";
	  await appendBudgetTerminationSummary(messages, terminationReason, fire, sessionId);
	  context.messages = messages.slice();
	  break;
	}

	if (config.runBudget !== undefined && approvalExpirations >= config.runBudget.maxApprovalExpirations) {
	  terminationReason = "approval_expiration_limit";
	  lastStopReason = "length";
	  await appendBudgetTerminationSummary(messages, terminationReason, fire, sessionId);
	  context.messages = messages.slice();
	  break;
	}

	if (config.runBudget !== undefined && repeatedFailureCount >= config.runBudget.maxRepeatedFailureFingerprint) {
	  terminationReason = "repeated_tool_failure";
	  lastStopReason = "length";
	  await appendBudgetTerminationSummary(messages, terminationReason, fire, sessionId);
	  context.messages = messages.slice();
	  break;
	}

    // steering 优先于 follow-up,且只在当前工具批次完成后注入。
    pendingMessages = await config.getSteeringMessages?.() ?? [];
    const hasMoreToolCalls = toolCalls.length > 0 && assistantStopReason === "toolUse";
    if (hasMoreToolCalls || pendingMessages.length > 0) continue;

    pendingMessages = await config.getFollowUpMessages?.() ?? [];
    if (pendingMessages.length > 0) continue;
    break;
  }

  // dequeue 后取消时输入已转交 loop；写入历史供下一次继续，不能静默丢弃。
  await appendPendingMessages();
  const agentEnd = Date.now();
  await fire(
    {
      type: "agent_end",
      timestamp: agentEnd,
      runId,
      stopReason: lastStopReason,
      elapsedMs: Math.max(0, agentEnd - sessionStart),
      activeDurationMs: Math.max(0, agentEnd - sessionStart),
      messageCountAtEnd: messages.length,
      ...(terminationReason === undefined ? {} : { terminationReason }),
    },
    {
      id: newId(),
      parentId: sessionId,
      timestamp: agentEnd,
      type: "agent_event",
      payload: { event: "agent_end", stopReason: lastStopReason, turn, ...(terminationReason === undefined ? {} : { terminationReason }) },
    },
  );

  // 同步 context.messages
  context.messages = messages;
  return messages;
}

function applyTurnUpdate(update: AgentLoopTurnUpdate, context: AgentContext): void {
  if (update.systemPrompt !== undefined) {
    context.systemPrompt = update.systemPrompt;
  }
  if (update.tools !== undefined) {
    context.tools = update.tools;
  }
}
