/**
 * Agent 循环核心实现。
 *
 * 对照参考 pi 的 `packages/agent/src/agent-loop.ts`。
 * 当前实现包含 reasoning、steering/follow-up 队列与工具调用;transformContext 仍未实现,
 * 但保留 outer/inner 双层结构与 shouldStopAfterTurn / prepareNextTurn 钩子,
 * 以便后续按 pi 的方式逐步补全(`// TODO(pi):` 注释标出占位)。
 *
 * 工具执行三段式(prepare → execute → finalize)对齐 pi:
 *   - prepare: 路由 tools.find + prepareArguments + schema 校验 + beforeToolCall hook
 *   - execute: tool.execute(...) with try/catch → 兜底 isError ToolResultContent
 *   - finalize: afterToolCall hook 字段级浅合并到 result
 *
 * 与 pi 的差异:
 *   - 没有 deferred tool loading 维护映射"addedToolNames → 实际新增工具到 Context",
 *     本期只把 addedToolNames 透传到 ToolResultContent,由调用方自行决定。
 *   - 没有 onUpdate 中间事件落盘;`tool_execution_update` 仅 emit 到订阅者。
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
 *     if stopReason === "length": 全部 toolCall 标 isError, 不真正执行
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
  AgentToolUpdateCallback,
  AfterToolCallResult,
  AssistantAgentMessage,
  BeforeToolCallResult,
  LlmContext,
  StreamFn,
  ToolResultAgentMessage,
  ToolResultContent,
  ToolResultOverflowStore,
  AgentRunTerminationReason,
} from "./types.ts";
import type { AssistantMessage, ImageContent, Message, SimpleStreamOptions, StopReason, TextContent, Tool, ToolCall } from "../types.ts";
import { validateToolArguments } from "../utils/validation.ts";
import { newId } from "./ledger/types.ts";
import type { LedgerSink, LedgerEntry } from "./ledger/types.ts";
import { localExecutionEnv } from "./execution-env.ts";
import { makeToolContext } from "./tool-context.ts";
import { DEFAULT_MAX_BYTES } from "./tools/tool-support.ts";
import { runtimeDigest } from "./protocol/foundation.ts";
import { compactMessages, type CompactionPolicy, type CompactionTriggerReason } from "./context/compaction/cut-planner.ts";
import { ContextAssemblyError } from "./context/context-engine.ts";
import { TokenEstimator } from "./context/token-estimator.ts";
import type { ToolPolicyProjection } from "../storage/settings-policies.ts";
import { redactRuntimeArtifactText } from "./trace/redaction.ts";

import type { AgentTelemetryConfig } from "./telemetry/telemetry.ts";
import {
  failChatSpan,
  finishChatSpan,
  finishExecuteToolSpan,
  finishInvokeAgentSpan,
  recordSkippedTool,
  resolveTelemetry,
  runInActiveSpan,
  startChatSpan,
  startExecuteToolSpan,
  startInvokeAgentSpan,
} from "./telemetry/telemetry.ts";
import type { AgentTelemetry } from "./telemetry/telemetry.ts";
import type { ToolStatus } from "./telemetry/run-collector.ts";
import type { Span } from "@opentelemetry/api";

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
  validateRunBudget(config.runBudget);
  const ledger = config.ledger;
  const sessionStart = Date.now();
  const sessionId = ledger?.sessionId ?? newId();
  const runId = `run-${newId()}`;

  // OTEL 插桩:整轮 run 包裹在 invoke_agent span 内(对齐 pi runLoop 结构)。
  // telemetry 未配置时 resolveTelemetry 返回 undefined,所有 helper 短路零开销。
  const telemetry = resolveTelemetry(config.telemetry, sessionId);
  const invokeAgentSpan = startInvokeAgentSpan(telemetry, config.model);
  const stepCounter = { count: 0 };
  let caughtError: unknown;
  try {
    return await runInActiveSpan(invokeAgentSpan, async () => {
  if (config.traceRecorder) {
    await config.traceRecorder.startRun({ agentId: sessionId });
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

  let turn = 0;
  let toolTurns = 0;
  let lastStopReason: StopReason = "stop";
  let terminationReason: AgentRunTerminationReason | undefined;
  let lastFailureFingerprint: string | undefined;
  let repeatedFailureCount = 0;
  let approvalExpirations = 0;
  let loopModel = config.model;
  let loopReasoning = config.reasoning;
  let pendingCompactionTrigger = config.compactionTrigger;
  let modelSwitchPending = false;
  let continuingAfterToolCall = false;
  let pendingMessages: AgentMessage[] = await config.getSteeringMessages?.() ?? [];

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
    const midTurn = continuingAfterToolCall;
    continuingAfterToolCall = false;
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

    // steering/follow-up 进入下一次 LLM 请求前才成为正式会话消息。
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
      pendingMessages = [];
    }

    // 1. AgentMessage → model-visible projection → LLM Message[]。raw messages
    // 永远留在本地 state/ledger；compaction 只替换本次 provider request 的视图。
    const convertFn = config.convertToLlm ?? defaultConvertToLlm;
    const compactionPolicy: CompactionPolicy | undefined = config.runtimeSettings?.compaction ?? config.compactionPolicy;
    const triggerReason: CompactionTriggerReason = pendingCompactionTrigger
      ?? (modelSwitchPending ? "model_switch" : "threshold");
    pendingCompactionTrigger = undefined;
    modelSwitchPending = false;
    let projectedMessages: readonly AgentMessage[] = messages;
    const summarize = config.compactionSummarizer;
    const projectForModelRequest = async (reason: CompactionTriggerReason) => {
      if (compactionPolicy === undefined || summarize === undefined) return undefined;
      return compactMessages({
        messages,
        policy: compactionPolicy,
        contextWindow: loopModel.contextWindow,
        estimatedInputTokens: estimateAgentMessages(messages),
        midTurn,
        reason,
        summarize: ({ compactedMessages, cut, reason: summaryReason }) => summarize({
          messages: compactedMessages,
          cut,
          reason: summaryReason,
          model: loopModel,
          sessionId,
          turn,
        }),
      });
    };
    const initialCompaction = await projectForModelRequest(triggerReason);
    if (initialCompaction?.status === "compacted") projectedMessages = initialCompaction.projectedMessages;
    let llmMessages = await convertFn(projectedMessages.slice());

    let llmContext: LlmContext = {
      systemPrompt: context.systemPrompt,
      messages: llmMessages,
      tools: context.tools,
    };

    if (config.modelContextAssembler !== undefined) {
      try {
        const assembled = await config.modelContextAssembler({
          model: loopModel,
          context: llmContext,
          sessionId,
          turn,
        });
        llmContext = assembled.context;
        await config.contextAssemblySink?.({ sessionId, turn, model: loopModel, receipt: assembled.receipt });
      } catch (error) {
        // A single bounded overflow retry may compact raw history. No provider
        // request has been sent yet, so retrying this request is side-effect free.
        if (!(error instanceof ContextAssemblyError)) throw error;
        const overflowCompaction = await projectForModelRequest("overflow");
        if (overflowCompaction?.status !== "compacted") throw error;
        projectedMessages = overflowCompaction.projectedMessages;
        llmMessages = await convertFn(projectedMessages.slice());
        llmContext = {
          systemPrompt: context.systemPrompt,
          messages: llmMessages,
          tools: context.tools,
        };
        const assembled = await config.modelContextAssembler({
          model: loopModel,
          context: llmContext,
          sessionId,
          turn,
        });
        llmContext = assembled.context;
        await config.contextAssemblySink?.({ sessionId, turn, model: loopModel, receipt: assembled.receipt });
      }
    }

    const traceModel = config.traceRecorder
      ? await config.traceRecorder.startModel({ turn, model: loopModel, context: llmContext })
      : undefined;

    // 2. 取 streamFn + OTEL chat span。chat span 包裹 streamFn 调用与
    // 消费循环,使 provider HTTP 调用(可能 lazy 到首次 next())落在 span 上下文内。
    const fn = streamFn;
    if (!fn) {
      throw new Error("streamFn is required (avoid passing undefined)");
    }
    const chatStepNumber = stepCounter.count;
    stepCounter.count += 1;
    const chatSpan = startChatSpan(telemetry, loopModel, {
      parent: invokeAgentSpan,
      stepNumber: chatStepNumber,
      request: {
        reasoningEffort: typeof loopReasoning === "string" ? loopReasoning : undefined,
        tools: llmContext.tools,
        systemPrompt: llmContext.systemPrompt,
        messages: llmContext.messages,
      },
    });
    let capturedHeaders: Readonly<Record<string, string>> | undefined;
    const captureOnResponse: NonNullable<SimpleStreamOptions["onResponse"]> = (response) => {
      capturedHeaders = response.headers;
    };

    // 3. 消费 stream,边 emit message_* 事件,边累积 assistant content
    const assistantContent: AssistantAgentMessage["content"] = [];
    let assistantStopReason: StopReason = "stop" as StopReason;
    let assistantUsage: AssistantAgentMessage["usage"] | undefined;
    let assistantErrorMessage: string | undefined;
    let providerMessage: AssistantMessage | undefined;
    let messageOpen = false;
    let streamStartedAt: number | undefined;
    try {
      await runInActiveSpan(chatSpan, async () => {
    const stream = await Promise.resolve(
      fn(loopModel, llmContext, {
        apiKey: config.apiKey,
        env: config.env,
        signal,
        metadata: { requestKind: config.requestKind ?? "interactive" },
        onResponse: captureOnResponse,
        ...(loopReasoning && loopReasoning !== "off" ? { reasoning: loopReasoning } : {}),
      }),
    );
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
      });
    } catch (chatError) {
      failChatSpan(telemetry, chatSpan, {
        errorObject: chatError,
        responseHeaders: capturedHeaders,
        baseUrl: loopModel.baseUrl,
      });
      throw chatError;
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
    // OTEL:用最终 provider message 收尾 chat span(usage/成本/gateway 属性 +
    // emitChatUsage);流结束无终端消息时按失败记。
    if (retainedProviderMessage !== undefined) {
      await finishChatSpan(telemetry, chatSpan, retainedProviderMessage, {
        stepNumber: chatStepNumber,
        responseHeaders: capturedHeaders,
        baseUrl: loopModel.baseUrl,
      });
    } else {
      failChatSpan(telemetry, chatSpan, {
        errorObject: new Error("provider stream ended without a terminal event"),
        responseHeaders: capturedHeaders,
        baseUrl: loopModel.baseUrl,
      });
    }
    const assistantMessage: AssistantAgentMessage = {
      role: "assistant",
      content: retainedProviderMessage?.content ?? assistantContent,
      stopReason: assistantStopReason,
      usage: assistantUsage,
      errorMessage: assistantErrorMessage,
      api: retainedProviderMessage?.api,
      provider: retainedProviderMessage?.provider,
      model: retainedProviderMessage?.model,
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
      if (assistantStopReason === "length") {
        // 截断降级路径:不真正执行,每工具合成 isError ToolResultContent
        toolResults = await failToolCallsFromTruncatedMessage(toolCalls, fire, sessionId, telemetry);
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
          telemetry,
          invokeAgentSpan,
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
	  const repeatedFailure = repeatedToolFailure(toolResults, lastFailureFingerprint, repeatedFailureCount);
	  lastFailureFingerprint = repeatedFailure.fingerprint;
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

    // apply prepareNextTurn
    const update = await config.prepareNextTurn?.({ messages, turn });
    if (update) {
      applyTurnUpdate(update, context);
      if (update.model) {
			if (!sameModel(loopModel, update.model)) modelSwitchPending = true;
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

    if (assistantStopReason === "error" || assistantStopReason === "aborted") break;

    // steering 优先于 follow-up,且只在当前工具批次完成后注入。
    pendingMessages = await config.getSteeringMessages?.() ?? [];
    const hasMoreToolCalls = toolCalls.length > 0 && assistantStopReason === "toolUse";
    if (hasMoreToolCalls || pendingMessages.length > 0) {
      continuingAfterToolCall = hasMoreToolCalls;
      continue;
    }

    pendingMessages = await config.getFollowUpMessages?.() ?? [];
    if (pendingMessages.length > 0) continue;
    break;
  }

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
    });
  } catch (err) {
    caughtError = err;
    throw err;
  } finally {
    finishInvokeAgentSpan(telemetry, invokeAgentSpan, {
      stepCount: stepCounter.count,
      errorObject: caughtError,
    });
  }
}

function isApprovalExpiration(result: ToolResultContent): boolean {
  if (result.isError !== true || typeof result.details !== "object" || result.details === null || Array.isArray(result.details)) return false;
  return (result.details as Readonly<Record<string, unknown>>).errorCode === "approval_expired";
}

function estimateAgentMessages(messages: readonly AgentMessage[]): number {
  const serialized = JSON.stringify(messages) ?? "";
  return new TokenEstimator().estimate(serialized);
}

function sameModel(left: AgentLoopConfig["model"], right: AgentLoopConfig["model"]): boolean {
  return left.api === right.api && left.provider === right.provider && left.id === right.id;
}

function validateRunBudget(budget: AgentLoopConfig["runBudget"]): void {
  if (budget === undefined) return;
  for (const [field, value] of Object.entries(budget)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`Agent run budget ${field} must be a positive safe integer`);
    }
  }
}

function activeDurationExhausted(config: AgentLoopConfig): boolean {
  if (config.runBudget === undefined || config.runBudgetUsage === undefined) return false;
  return config.runBudgetUsage.activeDurationMs() >= config.runBudget.maxActiveDurationMs;
}

function repeatedToolFailure(
  results: readonly ToolResultContent[],
  previousFingerprint: string | undefined,
  previousCount: number,
): { readonly fingerprint: string | undefined; readonly count: number } {
  if (results.length !== 1 || results[0]?.isError !== true) return { fingerprint: undefined, count: 0 };
  const result = results[0];
  const details = safeFailureDetails(result.details);
  if (details === undefined) return { fingerprint: undefined, count: 0 };
  const fingerprint = runtimeDigest({ toolName: result.toolName, ...details }).digest;
  return {
    fingerprint,
    count: fingerprint === previousFingerprint ? previousCount + 1 : 1,
  };
}

function safeFailureDetails(value: unknown): Readonly<Record<string, string | number>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Readonly<Record<string, unknown>>;
  const safe: Record<string, string | number> = {};
  for (const key of ["errorCode", "code", "exitCode", "signal", "policyDigest", "requestDigest"] as const) {
    const field = record[key];
    if (typeof field === "string" || (typeof field === "number" && Number.isFinite(field))) safe[key] = field;
  }
  return Object.keys(safe).length === 0 ? undefined : safe;
}

async function appendBudgetTerminationSummary(
  messages: AgentMessage[],
  reason: AgentRunTerminationReason,
  fire: (ev: AgentEvent, entry?: Omit<LedgerEntry, "sessionId">) => Promise<void>,
  sessionId: string,
): Promise<void> {
  const text = reason === "model_turn_limit"
    ? "Run stopped because the model turn limit was reached."
    : reason === "tool_turn_limit"
      ? "Run stopped because the tool turn limit was reached."
      : "Run stopped because its execution budget was exhausted.";
  const message: AssistantAgentMessage = {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "length",
  };
  const started = Date.now();
  await fire({ type: "message_start", timestamp: started, role: "assistant" });
  messages.push(message);
  const ended = Date.now();
  await fire(
    { type: "message_end", timestamp: ended, role: "assistant", stopReason: "length", message },
    {
      id: newId(),
      parentId: sessionId,
      timestamp: ended,
      type: "message",
      payload: { role: "assistant", stopReason: "length", content: text, message, terminationReason: reason },
    },
  );
}

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

// ===== 私有 helpers =====

function applyTurnUpdate(update: AgentLoopTurnUpdate, context: AgentContext): void {
  if (update.systemPrompt !== undefined) {
    context.systemPrompt = update.systemPrompt;
  }
  if (update.tools !== undefined) {
    context.tools = update.tools;
  }
}

/**
 * 工具调用执行入口:按 config.toolExecution 与每个 tool 自身 executionMode
 * 决定 sequential / parallel。返回的 ToolResultContent[] 与 toolCalls 同序。
 */
async function executeToolCalls(
  toolCalls: AgentToolCall[],
  tools: AgentTool[],
  messages: AgentMessage[],
  assistantMessage: AssistantAgentMessage,
  context: AgentContext,
  config: AgentLoopConfig,
  signal: AbortSignal,
  fire: (ev: AgentEvent, entry?: Omit<LedgerEntry, "sessionId">) => Promise<void>,
  sessionId: string,
  telemetry: AgentTelemetry | undefined,
  invokeAgentSpan: Span | undefined,
): Promise<ToolResultContent[]> {
  const mode = resolveExecutionMode(toolCalls, tools, config.toolExecution ?? "sequential");
  if (mode === "parallel") {
    // prepare 串行(emit tool_execution_start + 校验 + beforeToolCall),
    // execute 并发,finalize 按 await 实际完成顺序串行
    const prepared: PreparedToolCall[] = [];
    for (const tc of toolCalls) {
      const p = await prepareToolCall(tc, tools, messages, assistantMessage, context, config, signal, fire, sessionId, telemetry, invokeAgentSpan);
      prepared.push(p);
    }
    const results = await Promise.all(
      prepared.map((p) => executePreparedToolCall(p, config, signal, fire, sessionId, telemetry)),
    );
    const out: ToolResultContent[] = [];
    for (let i = 0; i < prepared.length; i++) {
      out.push(
        await finalizeExecutedToolCall(prepared[i]!, results[i]!, context, config, signal, fire, sessionId, telemetry),
      );
    }
    return out;
  }
  // sequential
  const out: ToolResultContent[] = [];
  for (const tc of toolCalls) {
    const p = await prepareToolCall(tc, tools, messages, assistantMessage, context, config, signal, fire, sessionId, telemetry, invokeAgentSpan);
    const r = await executePreparedToolCall(p, config, signal, fire, sessionId, telemetry);
    out.push(await finalizeExecutedToolCall(p, r, context, config, signal, fire, sessionId, telemetry));
  }
  return out;
}

/**
 * 解析批次执行模式:任一工具 executionMode === "sequential" 则降级 sequential。
 */
function resolveExecutionMode(
  toolCalls: AgentToolCall[],
  tools: AgentTool[],
  fallback: ToolExecutionModeLike,
): "sequential" | "parallel" {
  // 显式 sequential 走 sequential
  if (fallback === "sequential") return "sequential";
  // 任一工具自身声明 executionMode="sequential" → 整批 sequential
  for (const tc of toolCalls) {
    const tool = tools.find((t) => t.name === tc.name);
    if (tool?.executionMode === "sequential") return "sequential";
  }
  // 任一工具 isConcurrencySafe?.() 不返回 true → 整批 sequential
  // (对齐 claude-code-bun docs/tools/what-are-tools.mdx §"并行执行模式")
  for (const tc of toolCalls) {
    const tool = tools.find((t) => t.name === tc.name);
    const safe = tool?.isConcurrencySafe?.();
    if (safe !== true) return "sequential";
  }
  return "parallel";
}

type ToolExecutionModeLike = "sequential" | "parallel";

interface PreparedToolCall {
  toolCall: AgentToolCall;
  tool: AgentTool | undefined;
  args: unknown;
  /** beforeToolCall 已被调用且返回 block:true,直接合成 isError result */
  blocked?: { reason?: string };
  /** OTEL execute_tool span,prepare 阶段 start,finalize 阶段 finish。 */
  telemetrySpan?: Span;
}

/**
 * 阶段1: prepare —— 路由工具、调 prepareArguments、schema 校验、beforeToolCall hook。
 * 失败时合成 immediate error prepared(后续 execute 会跳过 execute() 直接落 isError)。
 */
async function prepareToolCall(
  tc: AgentToolCall,
  tools: AgentTool[],
  messages: AgentMessage[],
  assistantMessage: AssistantAgentMessage,
  context: AgentContext,
  config: AgentLoopConfig,
  signal: AbortSignal,
  fire: (ev: AgentEvent, entry?: Omit<LedgerEntry, "sessionId">) => Promise<void>,
  sessionId: string,
  telemetry: AgentTelemetry | undefined,
  invokeAgentSpan: Span | undefined,
): Promise<PreparedToolCall> {
  const tool = tools.find((t) => t.name === tc.name);
  // OTEL execute_tool span 于 prepare 前开始(携带工具元数据),finalize 收尾。
  const telemetrySpan = startExecuteToolSpan(telemetry, {
    tool,
    toolName: tc.name,
    toolCallId: tc.id,
    args: tc.arguments,
    parent: invokeAgentSpan,
  });
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

  if (!tool) {
    return { toolCall: tc, tool: undefined, args: tc.arguments, telemetrySpan };
  }

  // signal 已取消时 immediately 终止
  if (signal?.aborted) {
    return { toolCall: tc, tool, args: tc.arguments, blocked: { reason: "Operation aborted" }, telemetrySpan,
    };
  }

  // schema 校验:先把 raw args 走 prepareArguments,再 validate
  let preparedArgs: unknown;
  try {
    preparedArgs = prepareToolArguments(tool, tc, tc.arguments);
  } catch (e) {
    return { toolCall: tc, tool, args: tc.arguments, blocked: { reason: (e as Error).message ?? String(e) }, telemetrySpan,
    };
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
          blocked: { reason: (before as BeforeToolCallResult).reason },
        telemetrySpan,
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
						blocked: { reason: `updated tool input failed schema validation: ${(e as Error).message ?? String(e)}` },
					telemetrySpan,
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
						blocked: { reason: reauthorized.reason },
					telemetrySpan,
					};
				}
				if (reauthorized !== undefined && Object.hasOwn(reauthorized, "updatedInput")) {
					return {
						toolCall: tc,
						tool,
						args: preparedArgs,
						blocked: { reason: "tool input changed again during reauthorization" },
					telemetrySpan,
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
        blocked: { reason: (e as Error).message ?? String(e) },
      telemetrySpan,
      };
    }
  }

  return { toolCall: tc, tool, args: preparedArgs, telemetrySpan };
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

/**
 * 阶段2: execute —— 真正调用 tool.execute();blocked / 不可达工具走 isError 兜底。
 * onUpdate 回调把流式 partial 转发为 tool_execution_update 事件 + ledger entry。
 */
async function executePreparedToolCall(
  p: PreparedToolCall,
  config: AgentLoopConfig,
  signal: AbortSignal,
  fire: (ev: AgentEvent, entry?: Omit<LedgerEntry, "sessionId">) => Promise<void>,
  sessionId: string,
  telemetry: AgentTelemetry | undefined,
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

  // 工具执行体跑在 execute_tool span 的 active 上下文内(pi 同款),
  // 使工具内部产生的 span 挂到 execute_tool 下。void 仅为满足 telemetry
  // 未启用时的短路;telemetry 变量在此保留以便语义对照。
  void telemetry;
  try {
    return await runInActiveSpan(p.telemetrySpan, async () => {
      const result = await p.tool!.execute(
        p.toolCall.id,
        p.args as never,
        signal,
        onUpdate,
        toolContext,
      );
      await updateChain;
      // 超 maxResultSizeChars 的 result content 文本溢出落盘 + 路径 hint
      const maxChars = p.tool!.maxResultSizeChars ?? DEFAULT_MAX_BYTES;
      const content = await applyToolResultBudget(
        result.content,
        maxChars,
        p.toolCall.id,
        config.toolResultOverflowStore,
        config.runtimeSettings?.toolPolicy,
      );
      return {
        content,
        isError: result.isError === true,
        details: result.details,
        addedToolNames: result.addedToolNames,
        terminate: result.terminate,
      };
    });
  } catch (e) {
    await updateChain;
    const errorCode = codedError(e);
    return {
      content: [{ type: "text", text: (e as Error).message ?? String(e) }],
      isError: true,
      details: errorCode === undefined ? undefined : { errorCode },
      errorObject: e,
    };
  }
}

function codedError(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("code" in value)) return undefined;
  const code = value.code;
  return typeof code === "string" && code.length > 0 && code.length <= 128 ? code : undefined;
}

interface AgentToolExecutedResult {
  content: (TextContent | ImageContent)[];
  isError: boolean;
  details?: unknown;
  addedToolNames?: string[];
  terminate?: boolean;
  /** 工具 execute() 抛出的原始错误;finalize 用它在 execute_tool span 上 recordException。 */
  errorObject?: unknown;
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
async function applyToolResultBudget(
  content: (TextContent | ImageContent)[],
  maxChars: number,
  toolCallId: string,
  overflowStore?: ToolResultOverflowStore,
  policy?: ToolPolicyProjection,
): Promise<(TextContent | ImageContent)[]> {
  const out: (TextContent | ImageContent)[] = [];
  let totalChars = 0;
  let totalBytes = 0;
  let overflowStarted = false;
  const charBudget = Math.max(0, maxChars);
  const byteBudget = positiveInteger(policy?.artifactSpillThreshold);
  for (const block of content) {
    if (block.type !== "text") {
      out.push(block);
      continue;
    }
    if (overflowStarted) continue;
    const shaped = shapeToolText(
      block.text,
      Math.max(0, charBudget - totalChars),
      byteBudget === 0 ? Number.POSITIVE_INFINITY : Math.max(0, byteBudget - totalBytes),
      policy,
    );
    if (!shaped.truncated) {
      out.push({ type: "text", text: redactRuntimeArtifactText(block.text) });
      totalChars += block.text.length;
      totalBytes += byteLength(block.text);
      continue;
    }
    if (!shaped.budgetTruncated && shaped.columnTruncated) {
      const hint = await persistToolOverflow({
        toolCallId,
        omitted: shaped.omitted,
        visible: shaped.visible,
        charBudget,
        byteBudget,
        budgetTruncated: false,
        columnTruncated: true,
        columnLimit: policy?.outputMaxColumns,
        overflowStore,
      });
      out.push({ type: "text", text: `${redactRuntimeArtifactText(shaped.visible)}${hint}` });
      totalChars += shaped.visible.length;
      totalBytes += byteLength(shaped.visible);
      continue;
    }
    overflowStarted = true;
    const hint = await persistToolOverflow({
      toolCallId,
      omitted: shaped.omitted,
      visible: shaped.visible,
      charBudget,
      byteBudget,
      budgetTruncated: shaped.budgetTruncated,
      columnTruncated: shaped.columnTruncated,
      columnLimit: policy?.outputMaxColumns,
      overflowStore,
    });
    out.push({ type: "text", text: `${redactRuntimeArtifactText(shaped.visible)}${hint}` });
    totalChars = charBudget;
    totalBytes = byteBudget === 0 ? totalBytes : byteBudget;
  }
  return out;
}

interface ShapedToolText {
  readonly visible: string;
  readonly omitted: string;
  readonly truncated: boolean;
  readonly budgetTruncated: boolean;
  readonly columnTruncated: boolean;
}

function shapeToolText(text: string, charBudget: number, byteBudget: number, policy?: ToolPolicyProjection): ShapedToolText {
  const column = applyColumnCap(text, policy?.outputMaxColumns);
  const charBudgetExceeded = column.visible.length > charBudget;
  const byteBudgetExceeded = byteLength(column.visible) > byteBudget;
  if (!charBudgetExceeded && !byteBudgetExceeded && column.omitted.length === 0) {
    return { visible: text, omitted: "", truncated: false, budgetTruncated: false, columnTruncated: false };
  }

  if (!charBudgetExceeded && !byteBudgetExceeded) {
    return {
      visible: column.visible,
      omitted: column.omitted,
      truncated: true,
      budgetTruncated: false,
      columnTruncated: column.omitted.length > 0,
    };
  }

  if (!byteBudgetExceeded) {
    const windowed = splitHeadCharacters(column.visible, charBudget);
    return {
      visible: windowed.text,
      omitted: joinOmitted(column.omitted, windowed.rest),
      truncated: true,
      budgetTruncated: true,
      columnTruncated: column.omitted.length > 0,
    };
  }

  const windowed = shapeBudgetWindow(column.visible, byteBudget, policy);
  return {
    visible: windowed.visible,
    omitted: joinOmitted(column.omitted, windowed.omitted),
    truncated: true,
    budgetTruncated: true,
    columnTruncated: column.omitted.length > 0,
  };
}

function shapeBudgetWindow(
  text: string,
  budget: number,
  policy?: ToolPolicyProjection,
): { readonly visible: string; readonly omitted: string } {
  const headBytes = positiveInteger(policy?.artifactHeadBytes);
  const tailBytes = positiveInteger(policy?.artifactTailBytes);
  const tailLines = positiveInteger(policy?.artifactTailLines);

  if (headBytes > 0) {
    const head = splitHeadBytes(text, Math.min(headBytes, Math.floor(budget / 2)));
    const tailLimit = tailBytes > 0 ? Math.min(tailBytes, Math.max(0, budget - byteLength(head.text))) : Math.max(0, budget - byteLength(head.text));
    const tail = splitTailBytes(head.rest, tailLimit);
    const middleMarker = head.rest.length > tail.text.length ? "\n\n[… middle output elided …]\n\n" : "";
    return {
      visible: `${head.text}${middleMarker}${tail.text}`,
      omitted: tail.omitted,
    };
  }

  if (tailLines > 0) {
    const lineWindow = splitTailLines(text, tailLines);
    const tail = tailBytes > 0
      ? splitTailBytes(lineWindow.text, Math.min(tailBytes, budget))
      : splitTailBytes(lineWindow.text, budget);
    return {
      visible: tail.text,
      omitted: joinOmitted(lineWindow.omitted, tail.omitted),
    };
  }

  if (tailBytes > 0) {
    const tail = splitTailBytes(text, Math.min(tailBytes, budget));
    return { visible: tail.text, omitted: tail.omitted };
  }

  // Preserve the pre-settings prefix behavior when no window is requested.
  const head = splitHeadBytes(text, budget);
  return { visible: head.text, omitted: head.rest };
}

function positiveInteger(value: number | undefined): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function splitHeadBytes(value: string, maxBytes: number): { readonly text: string; readonly rest: string } {
  const bytes = Buffer.from(value, "utf8");
  if (maxBytes >= bytes.byteLength) return { text: value, rest: "" };
  const cut = utf8HeadBoundary(bytes, Math.max(0, maxBytes));
  return {
    text: bytes.subarray(0, cut).toString("utf8"),
    rest: bytes.subarray(cut).toString("utf8"),
  };
}

function splitHeadCharacters(value: string, maxCharacters: number): { readonly text: string; readonly rest: string } {
  if (maxCharacters >= value.length) return { text: value, rest: "" };
  const cut = Math.max(0, maxCharacters);
  return { text: value.slice(0, cut), rest: value.slice(cut) };
}

function splitTailBytes(value: string, maxBytes: number): { readonly omitted: string; readonly text: string } {
  const bytes = Buffer.from(value, "utf8");
  if (maxBytes >= bytes.byteLength) return { omitted: "", text: value };
  const start = utf8TailBoundary(bytes, Math.max(0, maxBytes));
  return {
    omitted: bytes.subarray(0, start).toString("utf8"),
    text: bytes.subarray(start).toString("utf8"),
  };
}

function utf8HeadBoundary(bytes: Buffer, maxBytes: number): number {
  let cut = Math.min(bytes.byteLength, maxBytes);
  while (cut > 0 && cut < bytes.byteLength && (bytes[cut]! & 0xc0) === 0x80) cut -= 1;
  return cut;
}

function utf8TailBoundary(bytes: Buffer, maxBytes: number): number {
  let start = Math.max(0, bytes.byteLength - maxBytes);
  while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return start;
}

function splitTailLines(value: string, count: number): { readonly omitted: string; readonly text: string } {
  const lines = value.split("\n");
  if (lines.length <= count) return { omitted: "", text: value };
  const splitAt = lines.length - count;
  return {
    omitted: `${lines.slice(0, splitAt).join("\n")}\n`,
    text: lines.slice(splitAt).join("\n"),
  };
}

function applyColumnCap(value: string, maxColumns: number | undefined): { readonly visible: string; readonly omitted: string } {
  const limit = positiveInteger(maxColumns);
  if (limit === 0) return { visible: value, omitted: "" };
  const omitted: string[] = [];
  const visible = value.split("\n").map((line) => {
    if (line.length <= limit) return line;
    omitted.push(line.slice(limit));
    return `${line.slice(0, limit)}…`;
  }).join("\n");
  return { visible, omitted: omitted.join("\n") };
}

function joinOmitted(first: string, second: string): string {
  if (first.length === 0) return second;
  if (second.length === 0) return first;
  return `${first}${second}`;
}

async function persistToolOverflow(input: {
  readonly toolCallId: string;
  readonly omitted: string;
  readonly visible: string;
  readonly charBudget: number;
  readonly byteBudget: number;
  readonly budgetTruncated: boolean;
  readonly columnTruncated: boolean;
  readonly columnLimit?: number;
  readonly overflowStore?: ToolResultOverflowStore;
}): Promise<string> {
  const budgetLabel = input.byteBudget > 0
    ? `${input.byteBudget} bytes`
    : `${input.charBudget} chars`;
  const columnLabel = input.columnLimit !== undefined && input.columnLimit > 0
    ? `Output lines were truncated to ${input.columnLimit} columns by the Host boundary.`
    : "Output was truncated by the Host boundary.";
  let hint = input.budgetTruncated
    ? `\n\nOutput exceeds ${budgetLabel}; remaining content truncated by the Host boundary.`
    : `\n\n${columnLabel}`;
  if (input.overflowStore === undefined || input.omitted.length === 0) return hint;
  try {
    const bytes = new TextEncoder().encode(redactRuntimeArtifactText(input.omitted));
    const stored = await input.overflowStore.put({
      toolCallId: input.toolCallId,
      bytes,
      mediaType: "text/plain; charset=utf-8",
      sourceDigest: runtimeDigest(input.omitted),
    });
    hint = input.budgetTruncated
      ? `\n\nOutput exceeds ${budgetLabel}; remaining content is available through governed artifact ${stored.ref.digest.digest} (${stored.ref.size ?? bytes.byteLength} bytes).`
      : `\n\n${columnLabel} Omitted content is available through governed artifact ${stored.ref.digest.digest} (${stored.ref.size ?? bytes.byteLength} bytes).`;
  } catch {
    // Best effort only: keep the bounded text and never expose a local path.
  }
  return hint;
}

/**
 * 阶段3: finalize —— afterToolCall hook 字段级浅合并 + emit tool_execution_end + ledger entry。
 */
async function finalizeExecutedToolCall(
  p: PreparedToolCall,
  r: AgentToolExecutedResult,
  context: AgentContext,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  fire: (ev: AgentEvent, entry?: Omit<LedgerEntry, "sessionId">) => Promise<void>,
  sessionId: string,
  telemetry: AgentTelemetry | undefined,
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

  // OTEL:收尾 execute_tool span。status 六态推导:blocked → beforeToolCall
  // 阻断;aborted → 执行期 run signal 已取消;error → isError;否则 ok。
  const status: ToolStatus = p.blocked
    ? "blocked"
    : finalIsError
      ? (signal?.aborted === true ? "aborted" : "error")
      : "ok";
  finishExecuteToolSpan(telemetry, p.telemetrySpan, {
    result: finalContent,
    isError: finalIsError,
    status,
    errorMessage: p.blocked?.reason,
    errorObject: r.errorObject,
    toolCallId: p.toolCall.id,
    toolName: p.toolCall.name,
  });

  return result;
}

/** length 截断降级:每工具合成 isError ToolResultContent,不真正执行。 */
async function failToolCallsFromTruncatedMessage(
  toolCalls: AgentToolCall[],
  fire: (ev: AgentEvent, entry?: Omit<LedgerEntry, "sessionId">) => Promise<void>,
  sessionId: string,
  telemetry: AgentTelemetry | undefined,
): Promise<ToolResultContent[]> {
  const results: ToolResultContent[] = [];
  for (const tc of toolCalls) {
    // OTEL:截断路径不产生 execute_tool span,按 skipped 记入 run summary。
    recordSkippedTool(telemetry, {
      toolCallId: tc.id,
      toolName: tc.name,
      status: "skipped",
    });
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

function serializeAssistant(content: AssistantAgentMessage["content"]): string {
  return content
    .map((c) => {
      if (c.type === "text") return c.text;
      if (c.type === "thinking") return `[thinking]`;
      return `[toolCall ${(c as ToolCall).name}]`;
    })
    .join("");
}

/**
 * findAfterTool:从 context 中找到对应 toolCallId 的 assistant message。
 * 辅助 afterToolCall 取 assistantMessage,本期维护成本低。
 */
function contextAssumedAssistant(context: AgentContext, toolCallId: string): AssistantAgentMessage {
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

// ===== 兼容旧调用点(已无反射 trick,ledger 走 AgentLoopConfig.ledger 第一公民) =====

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
