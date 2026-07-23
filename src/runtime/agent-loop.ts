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
  ToolExecutionAuthorizationGrant,
  ToolExecutionGatewayRequest,
} from "./types.ts";
import type { AssistantMessage, ImageContent, Message, StopReason, TextContent, Tool, ToolCall } from "../types.ts";
import { validateToolArguments } from "../utils/validation.ts";
import { newId } from "./ledger/types.ts";
import type { LedgerSink, LedgerEntry } from "./ledger/types.ts";
import { localExecutionEnv } from "./execution-env.ts";
import { makeToolContext } from "./tool-context.ts";
import { DEFAULT_MAX_BYTES } from "./tools/tool-support.ts";
import { writeFileSync, mkdirSync } from "node:fs";
import type {
  DurableModelHandle,
  DurableToolHandle,
  DurableTurnHandle,
} from "./session/agent-loop-events.ts";
import {
  zeroAgentOperationBudgetUsage,
  type AgentOperationBudgetReservation,
  type AgentOperationBudgetUsage,
  type AgentOperationOutcome,
} from "./operation-budget.ts";
import { canonicalDigest } from "./protocol/v3/canonical-json.ts";

const DEFAULT_PROVIDER_BUDGET_WALL_TIME_MS = 120_000;
const DEFAULT_TOOL_BUDGET_WALL_TIME_MS = 60_000;
const DEFAULT_TOOL_EXTERNAL_BYTES = 256 * 1024;

function safeBudgetInteger(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(value));
}

function serializedModelInput(context: LlmContext): string {
  return JSON.stringify({
    systemPrompt: context.systemPrompt ?? "",
    messages: context.messages,
    tools: (context.tools ?? []).map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
  });
}

function providerBudgetEstimate(
  model: AgentLoopConfig["model"],
  context: LlmContext,
): AgentOperationBudgetUsage {
  const inputBytes = Buffer.byteLength(serializedModelInput(context), "utf8");
  const inputTokens = Math.min(model.contextWindow, safeBudgetInteger(inputBytes / 3 + 8));
  const outputTokens = safeBudgetInteger(model.maxTokens);
  const rates = [model.cost, ...(model.cost.tiers ?? [])];
  const inputRate = Math.max(...rates.map((rate) => rate.input));
  const outputRate = Math.max(...rates.map((rate) => rate.output));
  return {
    ...zeroAgentOperationBudgetUsage(),
    inputTokens,
    outputTokens,
    usdMicros: safeBudgetInteger(inputTokens * inputRate + outputTokens * outputRate),
    wallTimeMs: DEFAULT_PROVIDER_BUDGET_WALL_TIME_MS,
  };
}

function providerBudgetActual(
  reservation: AgentOperationBudgetReservation,
  usage: AssistantAgentMessage["usage"],
  startedAtMs: number,
): AgentOperationBudgetUsage {
  if (!usage) return { ...reservation.estimatedUpperBound };
  return {
    ...zeroAgentOperationBudgetUsage(),
    inputTokens: safeBudgetInteger(usage.input),
    outputTokens: safeBudgetInteger(usage.output),
    usdMicros: safeBudgetInteger(usage.cost.total * 1_000_000),
    wallTimeMs: safeBudgetInteger(Date.now() - startedAtMs),
  };
}

function toolTimeoutMs(args: unknown): number {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return DEFAULT_TOOL_BUDGET_WALL_TIME_MS;
  const timeout = Reflect.get(args, "timeout");
  return typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0
    ? safeBudgetInteger(timeout)
    : DEFAULT_TOOL_BUDGET_WALL_TIME_MS;
}

function toolBudgetEstimate(
  args: unknown,
  capability: ToolExecutionAuthorizationGrant["capability"] | undefined,
  maxResultSizeChars: number,
  storesArtifact: boolean,
): AgentOperationBudgetUsage {
  const externalBytes = Math.max(DEFAULT_TOOL_EXTERNAL_BYTES, safeBudgetInteger(maxResultSizeChars));
  const usesNetwork = capability === "network" || capability === "browser" ||
    capability === "dependency_install" || capability === "deploy";
  const writesStorage = capability === "workspace_write" || capability === "dependency_install" ||
    capability === "process" || capability === "deploy" || capability === "cross_workspace";
  return {
    ...zeroAgentOperationBudgetUsage(),
    wallTimeMs: toolTimeoutMs(args),
    toolCalls: 1,
    networkBytes: usesNetwork ? externalBytes : 0,
    storageBytes: writesStorage ? externalBytes : 0,
    artifactCount: storesArtifact ? 1 : 0,
  };
}

function toolBudgetActual(
  reservation: AgentOperationBudgetReservation,
  startedAtMs: number,
): AgentOperationBudgetUsage {
  return {
    ...zeroAgentOperationBudgetUsage(),
    wallTimeMs: safeBudgetInteger(Date.now() - startedAtMs),
    toolCalls: 1,
    // Gateway 尚未提供 byte receipts；在可 reconciliation 前保守记入预留上界。
    networkBytes: reservation.estimatedUpperBound.networkBytes,
    storageBytes: reservation.estimatedUpperBound.storageBytes,
    artifactCount: reservation.estimatedUpperBound.artifactCount,
  };
}

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
  const ledger = config.ledger;
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
    await fire({ type: "message_start", timestamp: ts, role: "user", message: p });
    await config.sessionEvents?.recordMessage(p);
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
          schema: "agent-message/v1",
          role: "user",
          content: p.content.map((c) => c.text).join(""),
          message: p,
        },
      },
    );
  }

  let turn = 0;
  let lastStopReason: StopReason = "stop";
  let loopModel = config.model;
  let loopReasoning = config.reasoning;
  let pendingMessages: AgentMessage[] = await config.getSteeringMessages?.() ?? [];

  await config.sessionEvents?.ensureInitialized();

  // inner loop
  while (true) {
    if (signal?.aborted) {
      lastStopReason = "aborted";
      break;
    }
    turn++;
    // clear/cancel 可能在 turn tail 已 reserve 消息后赢得竞争。正文必须与
    // durable reference 一起被剔除，不能出现 event 已 cancelled 但仍发给模型。
    pendingMessages = [
      ...(config.sessionEvents?.activeQueueMessages(pendingMessages) ?? pendingMessages),
    ];
    // Control Plane 会在启动首轮前先 durable enqueue 初始 prompt。首轮只把
    // prompts 加入 queue-item 匹配集合，不重复写 conversation message。
    const durableQueueMessages = turn === 1
      ? [...prompts, ...pendingMessages]
      : pendingMessages;
    // Queue 归属由 Agent 在 enqueue receipt / replay 时绑定到精确对象；这里传递
    // queueItemId + kind reference，禁止用相同正文 digest 猜测 steer/follow-up。
    const durableQueueReferences = config.sessionEvents?.queueReferencesFor(durableQueueMessages) ?? [];
    const durableTurn = await config.sessionEvents?.beginTurn(durableQueueReferences);
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
        await config.sessionEvents?.recordMessage(pending);
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
              schema: "agent-message/v1",
              role: "user",
              content: pending.content.map((c) => c.text).join(""),
              message: pending,
            },
          },
        );
      }
      pendingMessages = [];
    }

    // 1. AgentMessage → LLM Message[],在边界处做了角色译码
    const convertFn = config.convertToLlm ?? defaultConvertToLlm;
    const llmMessages = await convertFn(messages);

    let llmContext: LlmContext = {
      systemPrompt: context.systemPrompt,
      messages: llmMessages,
      tools: context.tools,
    };
    let requestModel = loopModel;
    if (config.prepareModelRequest) {
      try {
        const prepared = await config.prepareModelRequest({
          turn,
          ...(durableTurn ? { turnId: durableTurn.turnId } : {}),
          ...(durableTurn?.modelRequestId ? { modelRequestId: durableTurn.modelRequestId } : {}),
          model: requestModel,
          context: llmContext,
          messages,
        }, signal);
        requestModel = prepared.model;
        llmContext = prepared.context;
      } catch (error) {
        if (durableTurn) await config.sessionEvents?.failTurn(durableTurn, error);
        throw error;
      }
    }
    const durableModel = durableTurn
      ? await config.sessionEvents?.beginModelRequest(
          durableTurn,
          `${requestModel.provider}/${requestModel.id}`,
          {
            // prepareModelRequest 可能切换 provider/model 并重组系统上下文；
            // durable model.requested 必须绑定真正送往 provider 的最终请求。
            systemPrompt: llmContext.systemPrompt ?? "",
            messages: JSON.stringify(llmContext.messages),
            tools: (llmContext.tools ?? []).map((tool) => tool.name),
          },
        )
      : undefined;

    // 2. 取 streamFn
    const fn = streamFn;
    if (!fn) {
      throw new Error("streamFn is required (avoid passing undefined)");
    }
    const providerEstimate = providerBudgetEstimate(requestModel, llmContext);
    let providerBudgetReservation: AgentOperationBudgetReservation | undefined;
    if (config.operationBudget) {
      try {
        providerBudgetReservation = await config.operationBudget.reserve({
          kind: "provider",
          operationKey: durableModel?.requestId ?? `provider-${sessionId}-${turn}`,
          estimatedUpperBound: providerEstimate,
        });
      } catch (error) {
        if (durableModel) await config.sessionEvents?.failModelRequest(durableModel, error);
        if (durableTurn) await config.sessionEvents?.failTurn(durableTurn, error);
        throw error;
      }
    }
    if (signal?.aborted && providerBudgetReservation && config.operationBudget) {
      try {
        await config.operationBudget.refund({ reservation: providerBudgetReservation, reason: "cancelled" });
      } catch (budgetError) {
        throw new AggregateError([budgetError], "provider budget refund failed before request start");
      }
      const error = new Error("provider request aborted before start");
      if (durableModel) await config.sessionEvents?.failModelRequest(durableModel, error);
      if (durableTurn) await config.sessionEvents?.failTurn(durableTurn, error);
      throw error;
    }
    const providerStartedAtMs = Date.now();
    let providerBudgetSettled = false;
    const settleProviderBudget = async (
      outcome: AgentOperationOutcome,
      usage: AssistantAgentMessage["usage"],
      result: unknown,
    ): Promise<void> => {
      if (!providerBudgetReservation || !config.operationBudget || providerBudgetSettled) return;
      await config.operationBudget.commit({
        reservation: providerBudgetReservation,
        outcome,
        actual: providerBudgetActual(providerBudgetReservation, usage, providerStartedAtMs),
        resultDigest: canonicalDigest(
          typeof result === "string" ? result : JSON.stringify(result ?? null),
        ),
      });
      providerBudgetSettled = true;
    };
    let stream: Awaited<ReturnType<StreamFn>>;
    try {
      stream = await Promise.resolve(
        fn(requestModel, llmContext, {
          apiKey: config.apiKey,
          env: config.env,
          signal,
          ...(loopReasoning && loopReasoning !== "off" ? { reasoning: loopReasoning } : {}),
        }),
      );
    } catch (error) {
      try {
        await settleProviderBudget(
          "uncertain",
          undefined,
          error instanceof Error ? `${error.name}:${error.message}` : String(error),
        );
      } catch (budgetError) {
        throw new AggregateError([error, budgetError], "provider request and budget settlement both failed");
      }
      if (durableModel) await config.sessionEvents?.failModelRequest(durableModel, error);
      if (durableTurn) await config.sessionEvents?.failTurn(durableTurn, error);
      throw error;
    }

    // 3. 消费 stream,边 emit message_* 事件,边累积 assistant content
    const assistantContent: AssistantAgentMessage["content"] = [];
    let assistantStopReason: StopReason = "stop";
    let assistantUsage: AssistantAgentMessage["usage"] | undefined;
    let assistantErrorMessage: string | undefined;
    let providerMessage: AssistantMessage | undefined;
    let messageOpen = false;
    try {
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
    } catch (error) {
      try {
        await settleProviderBudget(
          "uncertain",
          assistantUsage,
          error instanceof Error ? `${error.name}:${error.message}` : String(error),
        );
      } catch (budgetError) {
        throw new AggregateError([error, budgetError], "provider stream and budget settlement both failed");
      }
      if (durableModel) await config.sessionEvents?.failModelRequest(durableModel, error);
      if (durableTurn) await config.sessionEvents?.failTurn(durableTurn, error);
      throw error;
    }
    const providerOutcome: AgentOperationOutcome =
      assistantStopReason === "aborted"
        ? (assistantUsage ? "cancelled" : "uncertain")
        : assistantStopReason === "error"
          ? (assistantUsage ? "failed" : "uncertain")
          : "succeeded";
    await settleProviderBudget(providerOutcome, assistantUsage, {
      stopReason: assistantStopReason,
      usage: assistantUsage,
      errorMessage: assistantErrorMessage,
    });
    const assistantMessage: AssistantAgentMessage = {
      role: "assistant",
      content: providerMessage?.content ?? assistantContent,
      stopReason: assistantStopReason,
      usage: assistantUsage,
      errorMessage: assistantErrorMessage,
      api: providerMessage?.api,
      provider: providerMessage?.provider,
      model: providerMessage?.model,
      timestamp: providerMessage?.timestamp,
    };
    if (durableModel) {
      if (assistantStopReason === "error" || assistantStopReason === "aborted") {
        await config.sessionEvents?.failModelRequest(
          durableModel,
          assistantErrorMessage ?? assistantStopReason,
        );
      } else {
        await config.sessionEvents?.finishModelRequest(durableModel, assistantMessage, {
          inputTokens: assistantUsage?.input ?? 0,
          outputTokens: assistantUsage?.output ?? 0,
        });
      }
    }
    if (messageOpen || providerMessage) {
      await config.sessionEvents?.recordMessage(assistantMessage);
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
            schema: "agent-message/v1",
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
        toolResults = await failToolCallsFromTruncatedMessage(
          toolCalls,
          fire,
          sessionId,
          config,
          durableTurn,
        );
      } else {
        // 5. 执行
        const executedBatch = await executeToolCalls(
          toolCalls,
          context.tools ?? [],
          messages,
          assistantMessage,
          context,
          config,
          signal ?? new AbortController().signal,
          fire,
          sessionId,
          durableTurn,
        );
        toolResults = executedBatch.results;
        if (executedBatch.stopReason) lastStopReason = executedBatch.stopReason;
      }
      for (const r of toolResults) {
        const msg: ToolResultAgentMessage = {
          role: "toolResult",
          content: [r],
        };
        await config.sessionEvents?.recordMessage(msg);
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
              schema: "agent-message/v1",
              role: "toolResult",
              message: msg,
            },
          });
        }
      }
    }

    if (durableTurn) {
      if (lastStopReason === "aborted") {
        await config.sessionEvents?.interruptTurn(durableTurn, "model or tool execution aborted");
      } else if (lastStopReason === "error") {
        await config.sessionEvents?.failTurn(durableTurn, assistantErrorMessage ?? "model request failed");
      } else {
        await config.sessionEvents?.finishTurn(durableTurn, messages, lastStopReason);
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
      if (update.thinkingLevel !== undefined) {
        loopReasoning = update.thinkingLevel;
      }
    }

    // shouldStopAfterTurn hook
    const shouldStop = await config.shouldStopAfterTurn?.({ messages, turn });
    if (shouldStop) {
      break;
    }

    if (lastStopReason === "error" || lastStopReason === "aborted") break;

    // steering 优先于 follow-up,且只在当前工具批次完成后注入。
    pendingMessages = await config.getSteeringMessages?.() ?? [];
    const hasMoreToolCalls = toolCalls.length > 0 && assistantStopReason === "toolUse";
    if (hasMoreToolCalls || pendingMessages.length > 0) continue;

    pendingMessages = await config.getFollowUpMessages?.() ?? [];
    if (pendingMessages.length > 0) continue;
    break;
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
  durableTurn: DurableTurnHandle | undefined,
): Promise<{ results: ToolResultContent[]; stopReason?: StopReason }> {
  // v3 governed tool calls stay sequential until the Gateway can prove atomic
  // multi-call authorization and cancellation semantics for the whole batch.
  const mode = config.sessionEvents
    ? "sequential"
    : resolveExecutionMode(toolCalls, tools, config.toolExecution ?? "sequential");
  if (mode === "parallel") {
    // prepare 串行(emit tool_execution_start + 校验 + beforeToolCall),
    // execute 并发,finalize 按 await 实际完成顺序串行
    const prepared: PreparedToolCall[] = [];
    for (const tc of toolCalls) {
      const p = await prepareToolCall(
        tc,
        tools,
        messages,
        assistantMessage,
        context,
        config,
        signal,
        fire,
        sessionId,
        durableTurn,
      );
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
    return { results: out };
  }
  // sequential
  const out: ToolResultContent[] = [];
  let stopReason: StopReason | undefined;
  for (const tc of toolCalls) {
    const p = await prepareToolCall(
      tc,
      tools,
      messages,
      assistantMessage,
      context,
      config,
      signal,
      fire,
      sessionId,
      durableTurn,
    );
    const r = await executePreparedToolCall(p, config, signal, fire, sessionId);
    out.push(await finalizeExecutedToolCall(p, r, context, config, signal, fire, sessionId));
    if (r.gateClosed) {
      stopReason = r.terminalKind === "interrupted" ? "aborted" : "error";
      break;
    }
  }
  return { results: out, ...(stopReason ? { stopReason } : {}) };
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
  blocked?: {
    reason?: string;
    terminalKind?: "failed" | "interrupted";
    outcomeCertain?: boolean;
    gateClosed?: boolean;
  };
  durableTool?: DurableToolHandle;
  gatewayRequest?: ToolExecutionGatewayRequest;
  authorizationGrant?: ToolExecutionAuthorizationGrant;
  budgetReservation?: AgentOperationBudgetReservation;
  budgetStartedAtMs?: number;
}

async function reserveToolBudget(
  config: AgentLoopConfig,
  toolCall: AgentToolCall,
  tool: AgentTool,
  args: unknown,
  capability: ToolExecutionAuthorizationGrant["capability"] | undefined,
): Promise<AgentOperationBudgetReservation | undefined> {
  if (!config.operationBudget) return undefined;
  return config.operationBudget.reserve({
    kind: "tool",
    operationKey: `tool-${toolCall.id}`,
    estimatedUpperBound: toolBudgetEstimate(
      args,
      capability,
      tool.maxResultSizeChars ?? DEFAULT_MAX_BYTES,
      config.toolResultArtifactSink !== undefined,
    ),
  });
}

async function refundToolBudget(
  config: AgentLoopConfig,
  reservation: AgentOperationBudgetReservation | undefined,
  reason: "cancelled" | "not_started",
): Promise<void> {
  if (reservation && config.operationBudget) {
    await config.operationBudget.refund({ reservation, reason });
  }
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
  durableTurn: DurableTurnHandle | undefined,
): Promise<PreparedToolCall> {
  // `tool.requested.argumentsDigest` 必须绑定 PreToolUse 重写并重新校验后的
  // canonical 入参；否则 Gateway grant 会与 durable handle 永久失配。
  let durableTool: DurableToolHandle | undefined;
  const ensureDurableTool = async (args: unknown): Promise<DurableToolHandle | undefined> => {
    if (!durableTool && durableTurn) {
      durableTool = await config.sessionEvents?.requestTool(durableTurn, tc.id, tc.name, args);
    }
    return durableTool;
  };
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

  const tool = tools.find((t) => t.name === tc.name);
  if (!tool) {
    await ensureDurableTool(tc.arguments);
    return { toolCall: tc, tool: undefined, args: tc.arguments, durableTool };
  }

  // signal 已取消时 immediately 终止
  if (signal?.aborted) {
    await ensureDurableTool(tc.arguments);
    return { toolCall: tc, tool, args: tc.arguments, blocked: { reason: "Operation aborted" }, durableTool };
  }

  // schema 校验:先把 raw args 走 prepareArguments,再 validate
  let preparedArgs: unknown = tc.arguments;
  try {
    if (tool.prepareArguments) {
      preparedArgs = tool.prepareArguments(tc.arguments);
    }
    preparedArgs = validateToolArguments(tool as unknown as Tool, {
      type: "toolCall",
      id: tc.id,
      name: tc.name,
      arguments: preparedArgs as Record<string, unknown>,
    });
  } catch (e) {
    await ensureDurableTool(tc.arguments);
    return {
      toolCall: tc,
      tool,
      args: tc.arguments,
      blocked: { reason: (e as Error).message ?? String(e) },
      durableTool,
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
      const result = before as BeforeToolCallResult | undefined;
      if (result?.block) {
        await ensureDurableTool(preparedArgs);
        return {
          toolCall: tc,
          tool,
          args: preparedArgs,
          blocked: { reason: result.reason },
          durableTool,
        };
      }
      if (result?.updatedInput !== undefined) {
        try {
          const updated = tool.prepareArguments
            ? tool.prepareArguments(result.updatedInput)
            : result.updatedInput;
          preparedArgs = validateToolArguments(tool as unknown as Tool, {
            type: "toolCall",
            id: tc.id,
            name: tc.name,
            arguments: updated as Record<string, unknown>,
          });
        } catch (error) {
          await ensureDurableTool(preparedArgs);
          return {
            toolCall: tc,
            tool,
            args: preparedArgs,
            blocked: { reason: `PreToolUse updatedInput failed validation: ${(error as Error).message ?? String(error)}` },
            durableTool,
          };
        }
      }
    } catch (e) {
      // hook 抛错按 block 处理,不污染主循环
      void messages;
      await ensureDurableTool(preparedArgs);
      return {
        toolCall: tc,
        tool,
        args: preparedArgs,
        blocked: { reason: (e as Error).message ?? String(e) },
        durableTool,
      };
    }
  }

  await ensureDurableTool(preparedArgs);

  // 授权必须观察 hook 改写并重新校验后的最终入参。
  if (config.authorizeToolCall) {
    try {
      const authorization = await config.authorizeToolCall({
        assistantMessage,
        toolCall: tc,
        args: preparedArgs,
        context,
        tool,
      }, signal);
      if (authorization?.block) {
        return {
          toolCall: tc,
          tool,
          args: preparedArgs,
          blocked: { reason: authorization.reason },
          durableTool,
        };
      }
      if (authorization?.updatedInput !== undefined) {
        return {
          toolCall: tc,
          tool,
          args: preparedArgs,
          blocked: { reason: "authorization adapters cannot rewrite tool input" },
          durableTool,
        };
      }
    } catch (error) {
      return {
        toolCall: tc,
        tool,
        args: preparedArgs,
        blocked: { reason: (error as Error).message ?? String(error) },
        durableTool,
      };
    }
  }

  if (durableTool) {
    if (!config.toolExecutionGateway) {
      return {
        toolCall: tc,
        tool,
        args: preparedArgs,
        blocked: {
          reason: "governed tool execution gateway is not configured",
          terminalKind: "failed",
          outcomeCertain: true,
        },
        durableTool,
      };
    }
    if (tool.governedExecution !== "tool-context") {
      return {
        toolCall: tc,
        tool,
        args: preparedArgs,
        blocked: {
          reason: `tool ${tool.name} is not declared as ToolContext-bound and cannot run in a governed session`,
          terminalKind: "failed",
          outcomeCertain: true,
        },
        durableTool,
      };
    }
    const gatewayRequest: ToolExecutionGatewayRequest = {
	  turnId: durableTool.turnId,
      toolCallId: durableTool.toolCallId,
      providerToolCallId: tc.id,
      tool,
      arguments: preparedArgs,
      cwd: config.cwd ?? process.cwd(),
      envVars: config.env ?? {},
    };
    let authorization: Awaited<ReturnType<NonNullable<AgentLoopConfig["toolExecutionGateway"]>["authorize"]>>;
    try {
      authorization = await config.toolExecutionGateway.authorize(gatewayRequest, signal);
    } catch (error) {
      return {
        toolCall: tc,
        tool,
        args: preparedArgs,
        gatewayRequest,
        blocked: {
          reason: `governed authorization unavailable: ${(error as Error).message ?? String(error)}`,
          terminalKind: "failed",
          outcomeCertain: true,
        },
        durableTool,
      };
    }
    if (authorization.status !== "authorized") {
      const interrupted = authorization.status === "aborted";
      return {
        toolCall: tc,
        tool,
        args: preparedArgs,
        gatewayRequest,
        blocked: {
          reason: authorization.reason,
          terminalKind: interrupted ? "interrupted" : "failed",
          outcomeCertain: true,
          gateClosed: interrupted,
        },
        durableTool,
      };
    }
    let budgetReservation: AgentOperationBudgetReservation | undefined;
    try {
      budgetReservation = await reserveToolBudget(
        config,
        tc,
        tool,
        preparedArgs,
        authorization.grant.capability,
      );
    } catch (error) {
      return {
        toolCall: tc,
        tool,
        args: preparedArgs,
        gatewayRequest,
        blocked: {
          reason: `tool budget reservation failed: ${(error as Error).message ?? String(error)}`,
          terminalKind: "failed",
          outcomeCertain: true,
          gateClosed: true,
        },
        durableTool,
      };
    }
    if (signal.aborted) {
      try {
        await refundToolBudget(config, budgetReservation, "cancelled");
      } catch (error) {
        return {
          toolCall: tc,
          tool,
          args: preparedArgs,
          gatewayRequest,
          blocked: {
            reason: `tool budget refund failed after cancellation: ${(error as Error).message ?? String(error)}`,
            terminalKind: "interrupted",
            outcomeCertain: false,
            gateClosed: true,
          },
          durableTool,
        };
      }
      return {
        toolCall: tc,
        tool,
        args: preparedArgs,
        gatewayRequest,
        blocked: {
          reason: "Operation aborted",
          terminalKind: "interrupted",
          outcomeCertain: true,
          gateClosed: true,
        },
        durableTool,
      };
    }
    const sessionEvents = config.sessionEvents;
    if (!sessionEvents) {
      try {
        await refundToolBudget(config, budgetReservation, "not_started");
      } catch (error) {
        return {
          toolCall: tc,
          tool,
          args: preparedArgs,
          gatewayRequest,
          blocked: {
            reason: `governed session event bridge disappeared before start and budget refund failed: ${(error as Error).message ?? String(error)}`,
            terminalKind: "failed",
            outcomeCertain: false,
            gateClosed: true,
          },
          durableTool,
        };
      }
      return {
        toolCall: tc,
        tool,
        args: preparedArgs,
        gatewayRequest,
        blocked: {
          reason: "governed session event bridge disappeared before start",
          terminalKind: "failed",
          outcomeCertain: true,
        },
        durableTool,
      };
    }
    const authorizedTool = durableTool;
    const started: { handle?: DurableToolHandle } = {};
    let startResult: Awaited<ReturnType<NonNullable<AgentLoopConfig["toolExecutionGateway"]>["start"]>>;
    try {
      startResult = await config.toolExecutionGateway.start(
        { invocation: gatewayRequest, grant: authorization.grant },
        async () => {
          if (started.handle) throw new Error("governed durable start callback was invoked more than once");
          started.handle = await sessionEvents.authorizeAndStartTool(
            authorizedTool,
            authorization.grant,
            tool,
          );
        },
        signal,
      );
    } catch (error) {
      try {
        await refundToolBudget(config, budgetReservation, "not_started");
      } catch (budgetError) {
        return {
          toolCall: tc,
          tool,
          args: preparedArgs,
          gatewayRequest,
          blocked: {
            reason: `governed start barrier and budget refund both failed: ${(error as Error).message ?? String(error)}; ${(budgetError as Error).message ?? String(budgetError)}`,
            terminalKind: "failed",
            outcomeCertain: false,
            gateClosed: true,
          },
          durableTool,
        };
      }
      return {
        toolCall: tc,
        tool,
        args: preparedArgs,
        gatewayRequest,
        blocked: {
          reason: `governed start barrier unavailable: ${(error as Error).message ?? String(error)}`,
          terminalKind: "failed",
          outcomeCertain: true,
        },
        durableTool,
      };
    }
    if (startResult.grantDigest !== authorization.grant.grantDigest) {
      return {
        toolCall: tc,
        tool,
        args: preparedArgs,
        gatewayRequest,
        blocked: {
          reason: "governed start barrier returned an uncorrelated grant receipt",
          terminalKind: "failed",
          outcomeCertain: false,
          gateClosed: true,
        },
        durableTool,
      };
    }
    if (startResult.status !== "ready") {
      if (startResult.outcomeCertain) {
        try {
          await refundToolBudget(config, budgetReservation, "not_started");
        } catch (error) {
          return {
            toolCall: tc,
            tool,
            args: preparedArgs,
            gatewayRequest,
            blocked: {
              reason: `governed start rejected and budget refund failed: ${startResult.reason}; ${(error as Error).message ?? String(error)}`,
              terminalKind: "failed",
              outcomeCertain: false,
              gateClosed: true,
            },
            durableTool,
          };
        }
      }
      return {
        toolCall: tc,
        tool,
        args: preparedArgs,
        gatewayRequest,
        blocked: {
          reason: startResult.reason,
          terminalKind: "failed",
          outcomeCertain: startResult.outcomeCertain,
          gateClosed: !startResult.outcomeCertain,
        },
        durableTool,
      };
    }
    if (!started.handle?.started) {
      return {
        toolCall: tc,
        tool,
        args: preparedArgs,
        gatewayRequest,
        blocked: {
          reason: "governed start barrier did not durably start the tool",
          terminalKind: "failed",
          outcomeCertain: false,
          gateClosed: true,
        },
        durableTool,
      };
    }
    durableTool = started.handle;
    return {
      toolCall: tc,
      tool,
      args: preparedArgs,
      durableTool,
      gatewayRequest,
      authorizationGrant: authorization.grant,
      ...(budgetReservation ? { budgetReservation, budgetStartedAtMs: Date.now() } : {}),
    };
  }
  try {
    const budgetReservation = await reserveToolBudget(config, tc, tool, preparedArgs, undefined);
    return {
      toolCall: tc,
      tool,
      args: preparedArgs,
      durableTool,
      ...(budgetReservation ? { budgetReservation, budgetStartedAtMs: Date.now() } : {}),
    };
  } catch (error) {
    return {
      toolCall: tc,
      tool,
      args: preparedArgs,
      blocked: {
        reason: `tool budget reservation failed: ${(error as Error).message ?? String(error)}`,
        terminalKind: "failed",
        outcomeCertain: true,
        gateClosed: true,
      },
      durableTool,
    };
  }
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
): Promise<AgentToolExecutedResult> {
  // blocked / tool 未找到 → 立即合成 isError 内容,不调 execute
  if (p.blocked) {
    return {
      content: [{ type: "text", text: p.blocked.reason ?? "blocked by beforeToolCall" }],
      isError: true,
      details: undefined,
      executionError: p.blocked.reason ?? "blocked by beforeToolCall",
      outcomeCertain: p.blocked.outcomeCertain ?? true,
      terminalKind: p.blocked.terminalKind ?? "failed",
      gateClosed: p.blocked.gateClosed === true,
      maxResultSizeChars: p.tool?.maxResultSizeChars ?? DEFAULT_MAX_BYTES,
    };
  }
  if (!p.tool) {
    return {
      content: [{ type: "text", text: `Tool not found: ${p.toolCall.name}` }],
      isError: true,
      details: undefined,
      executionError: `Tool not found: ${p.toolCall.name}`,
      maxResultSizeChars: DEFAULT_MAX_BYTES,
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

  if (p.authorizationGrant && p.gatewayRequest) {
    const gateway = config.toolExecutionGateway;
    if (!gateway) {
      return {
        content: [{ type: "text", text: "governed execution gateway disappeared after authorization" }],
        isError: true,
        details: undefined,
        executionError: "governed execution gateway disappeared after authorization",
        outcomeCertain: false,
        terminalKind: "failed",
        gateClosed: true,
        maxResultSizeChars: p.tool.maxResultSizeChars ?? DEFAULT_MAX_BYTES,
      };
    }
    try {
      const executed = await gateway.execute({
        invocation: p.gatewayRequest,
        grant: p.authorizationGrant,
      }, onUpdate, signal);
      await updateChain;
      if (executed.grantDigest !== p.authorizationGrant.grantDigest) {
        return {
          content: [{ type: "text", text: "governed executor returned an uncorrelated grant receipt" }],
          isError: true,
          details: undefined,
          executionError: "governed executor returned an uncorrelated grant receipt",
          outcomeCertain: false,
          terminalKind: "failed",
          gateClosed: true,
          maxResultSizeChars: p.tool.maxResultSizeChars ?? DEFAULT_MAX_BYTES,
        };
      }
      if (executed.status === "completed") {
        if (p.authorizationGrant.capability === "process" && !executed.sandboxReceipt) {
          return {
            content: [{ type: "text", text: "process execution completed without a sandbox receipt" }],
            isError: true,
            details: undefined,
            executionError: "process execution completed without a sandbox receipt",
            outcomeCertain: false,
            terminalKind: "failed",
            gateClosed: true,
            maxResultSizeChars: p.tool.maxResultSizeChars ?? DEFAULT_MAX_BYTES,
          };
        }
        return {
          content: executed.result.content,
          isError: executed.result.isError === true,
          details: executed.result.details,
          addedToolNames: executed.result.addedToolNames,
          terminate: executed.result.terminate,
          sandboxReceipt: executed.sandboxReceipt,
          outcomeCertain: true,
          maxResultSizeChars: p.tool.maxResultSizeChars ?? DEFAULT_MAX_BYTES,
        };
      }
      return {
        content: [{ type: "text", text: executed.reason }],
        isError: true,
        details: undefined,
        executionError: executed.reason,
        outcomeCertain: executed.outcomeCertain,
        terminalKind: executed.status === "aborted" ? "interrupted" : "failed",
        // 任意 abort 都是本轮的明确终止信号；outcomeCertain 只描述副作用
        // 是否可判定，不能被解释为“仍可把 ToolResult 交给下一次模型调用”。
        gateClosed: executed.status === "uncertain" || executed.status === "aborted",
        maxResultSizeChars: p.tool.maxResultSizeChars ?? DEFAULT_MAX_BYTES,
      };
    } catch (error) {
      await updateChain;
      return {
        content: [{ type: "text", text: (error as Error).message ?? String(error) }],
        isError: true,
        details: undefined,
        executionError: error,
        outcomeCertain: false,
        terminalKind: signal.aborted ? "interrupted" : "failed",
        gateClosed: true,
        maxResultSizeChars: p.tool.maxResultSizeChars ?? DEFAULT_MAX_BYTES,
      };
    }
  }

  // Legacy-only path: no Session Kernel means direct tool.execute remains compatible.
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
      terminate: result.terminate,
      maxResultSizeChars: p.tool.maxResultSizeChars ?? DEFAULT_MAX_BYTES,
    };
  } catch (e) {
    await updateChain;
    return {
      content: [{ type: "text", text: (e as Error).message ?? String(e) }],
      isError: true,
      details: undefined,
      executionError: e,
      maxResultSizeChars: p.tool.maxResultSizeChars ?? DEFAULT_MAX_BYTES,
    };
  }
}

interface AgentToolExecutedResult {
  content: (TextContent | ImageContent)[];
  isError: boolean;
  details?: unknown;
  addedToolNames?: string[];
  terminate?: boolean;
  executionError?: unknown;
  outcomeCertain?: boolean;
  terminalKind?: "failed" | "interrupted";
  gateClosed?: boolean;
  sandboxReceipt?: import("./protocol/v3/capability.ts").SandboxExecutionReceiptRef;
  maxResultSizeChars: number;
}

/**
 * 工具结果字符预算:超出 maxChars 的 text content 落盘到
 * `tmp/tool-output-<toolCallId>.txt`,在 content 中以一个简短的
 * "exceeds maximum size ..." 提示 + 文件路径替换。
 *
 * 对齐 claude-code-bun docs/tools/what-are-tools.mdx §"大结果落盘":
 * 不抛错 / 不截断 inline,而是把超量结果导到磁盘并把路径回灌给 LLM,
 * 让后续 turn 自行决定是否 grep / read 重新读那段。
 *
 * 不可写的临时目录下退化为「inline 截断 + 提示」,仍不抛错。
 */
export function applyToolResultBudget(
  content: (TextContent | ImageContent)[],
  maxChars: number,
  toolCallId: string,
  overflowMode: "legacy_tmp" | "fail_closed" = "legacy_tmp",
): (TextContent | ImageContent)[] {
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
	  if (overflowMode === "fail_closed") {
		throw new Error(
		  "governed tool result exceeds the prompt budget but ArtifactToolResultSink is not configured",
		);
	  }
      // 落盘 best-effort,失败退化为 inline 截断
      let path = "";
      try {
        const dir = "tmp";
        path = `${dir}/tool-output-${toolCallId}.txt`;
        mkdirSync(dir, { recursive: true });
        writeFileSync(path, droppedTail, "utf-8");
      } catch {
        path = "";
      }
      const hint = path
        ? `\n\nOutput exceeds ${maxChars} chars; remaining content written to: ${path}`
        : `\n\nOutput exceeds ${maxChars} chars; remaining content truncated (tmp dir unavailable).`;
      out.push({ type: "text", text: `${inlineTail}${hint}` });
      totalChars = maxChars;
    }
    // 后续 text block 全部丢弃(只在第一次溢出时落盘一次);不丢图像
  }
  return out;
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
): Promise<ToolResultContent> {
  let finalContent: (TextContent | ImageContent)[] = r.content;
  let finalDetails: unknown = r.details;
  let finalIsError: boolean = r.isError;
  let finalAddedToolNames: string[] | undefined = r.addedToolNames;
  let finalTerminate: boolean | undefined = r.terminate;
  let artifactRef: ToolResultContent["artifactRef"];

  if (p.budgetReservation) {
    const operationBudget = config.operationBudget;
    if (!operationBudget) throw new Error("tool operation budget adapter disappeared after reservation");
    const outcome: AgentOperationOutcome = r.outcomeCertain === false
      ? "uncertain"
      : r.terminalKind === "interrupted"
        ? "cancelled"
        : r.executionError !== undefined
          ? "failed"
          : "succeeded";
    try {
      await operationBudget.commit({
        reservation: p.budgetReservation,
        outcome,
        actual: toolBudgetActual(p.budgetReservation, p.budgetStartedAtMs ?? p.budgetReservation.reservedAtMs),
        resultDigest: canonicalDigest({
          toolCallId: p.toolCall.id,
          outcome,
          isError: r.isError,
          outcomeCertain: r.outcomeCertain ?? true,
          content: r.content,
        }),
      });
    } catch (error) {
      if (p.durableTool) await config.sessionEvents?.failTool(p.durableTool, error, false);
      throw error;
    }
  }

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

  if (config.toolResultArtifactSink) {
    try {
      const projected = await config.toolResultArtifactSink.storeToolResult({
        toolCallId: p.toolCall.id,
        toolName: p.toolCall.name,
        content: finalContent,
        isError: finalIsError,
        maxPromptChars: r.maxResultSizeChars,
      });
      finalContent = projected.content;
      artifactRef = projected.artifactRef;
    } catch (error) {
      if (p.durableTool) await config.sessionEvents?.failTool(p.durableTool, error, false);
      throw error;
    }
  } else {
	try {
	  finalContent = applyToolResultBudget(
		finalContent,
		r.maxResultSizeChars,
		p.toolCall.id,
		config.sessionEvents ? "fail_closed" : "legacy_tmp",
	  );
	} catch (error) {
	  if (p.durableTool) await config.sessionEvents?.failTool(p.durableTool, error, false);
	  throw error;
	}
  }

  const result: ToolResultContent = {
    type: "toolResult",
    toolCallId: p.toolCall.id,
    toolName: p.toolCall.name,
    content: finalContent,
    isError: finalIsError,
    details: finalDetails,
    ...(artifactRef ? { artifactRef } : {}),
  };
  if (finalAddedToolNames !== undefined) result.addedToolNames = finalAddedToolNames;
  if (finalTerminate !== undefined) result.terminate = finalTerminate;

  if (p.durableTool) {
    if (r.sandboxReceipt && p.authorizationGrant) {
      await config.sessionEvents?.recordToolSandboxExecution(
        p.durableTool,
        p.authorizationGrant,
        r.sandboxReceipt,
      );
    }
    if (r.executionError !== undefined) {
      const outcomeCertain = r.outcomeCertain ?? (!p.durableTool.started || p.durableTool.readOnly);
      if (r.terminalKind === "interrupted" || signal?.aborted) {
        await config.sessionEvents?.interruptTool(
          p.durableTool,
          r.executionError instanceof Error ? r.executionError.message : String(r.executionError),
          outcomeCertain,
        );
      } else {
        await config.sessionEvents?.failTool(
          p.durableTool,
          r.executionError,
          outcomeCertain,
        );
      }
    } else {
      await config.sessionEvents?.finishTool(p.durableTool, result);
    }
  }

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

/** length 截断降级:每工具合成 isError ToolResultContent,不真正执行。 */
async function failToolCallsFromTruncatedMessage(
  toolCalls: AgentToolCall[],
  fire: (ev: AgentEvent, entry?: Omit<LedgerEntry, "sessionId">) => Promise<void>,
  sessionId: string,
  config: AgentLoopConfig,
  durableTurn: DurableTurnHandle | undefined,
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
    if (durableTurn) {
      const durableTool = await config.sessionEvents?.requestTool(
        durableTurn,
        tc.id,
        tc.name,
        tc.arguments,
      );
      if (durableTool) {
        await config.sessionEvents?.failTool(durableTool, errorText, true);
      }
    }
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

export async function runAgentLoopContinue(
  context: AgentContext,
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal?: AbortSignal,
  streamFn?: StreamFn,
): Promise<AgentMessage[]> {
  return runAgentLoop([], context, config, emit, signal, streamFn);
}
