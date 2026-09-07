/**
 * S4 拆分:run budget 校验、耗尽检测与终止摘要。
 */

import { runtimeDigest } from "../protocol/foundation.ts";
import { newId } from "../ledger/types.ts";
import type { LedgerEntry } from "../ledger/types.ts";
import type {
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentRunTerminationReason,
  AgentToolCall,
  AssistantAgentMessage,
  ToolResultContent,
} from "../types.ts";

export function isApprovalExpiration(result: ToolResultContent): boolean {
  if (result.isError !== true || typeof result.details !== "object" || result.details === null || Array.isArray(result.details)) return false;
  return (result.details as Readonly<Record<string, unknown>>).errorCode === "approval_expired";
}

export function validateRunBudget(budget: AgentLoopConfig["runBudget"]): void {
  if (budget === undefined) return;
  for (const [field, value] of Object.entries(budget)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`Agent run budget ${field} must be a positive safe integer`);
    }
  }
}

export function activeDurationExhausted(config: AgentLoopConfig): boolean {
  if (config.runBudget === undefined || config.runBudgetUsage === undefined) return false;
  return config.runBudgetUsage.activeDurationMs() >= config.runBudget.maxActiveDurationMs;
}

/** 仅保存上一批的摘要；成功重置同请求，重复失败跨批累计，批内也逐调用计数。 */
export function repeatedToolFailure(
  results: readonly ToolResultContent[],
  calls: readonly AgentToolCall[],
  previous: ReadonlyMap<string, number>,
): { readonly fingerprints: ReadonlyMap<string, number>; readonly count: number } {
  const fingerprints = new Map<string, number>();
  const reset = new Set<string>();
  const requests = new Map(calls.map((call) => [call.id, runtimeDigest({ toolName: call.name, arguments: call.arguments }).digest]));
  for (const result of results) {
    const request = requests.get(result.toolCallId);
    if (request === undefined) continue;
    if (result.isError !== true || isApprovalExpiration(result)) {
      reset.add(request);
      for (const key of fingerprints.keys()) if (key.startsWith(`${request}:`)) fingerprints.delete(key);
      continue;
    }
    const output = result.content.map((block) => block.type === "text"
      ? (result.toolCallId.length === 0 ? block.text : block.text.replaceAll(result.toolCallId, "<tool-call>"))
      : runtimeDigest(block).digest);
    const fingerprint = `${request}:${runtimeDigest({ details: safeFailureDetails(result.details), output }).digest}`;
    const count = (fingerprints.get(fingerprint) ?? (reset.has(request) ? 0 : previous.get(fingerprint)) ?? 0) + 1;
    fingerprints.set(fingerprint, count);
    // 异常大批次不让状态无界增长；保留最近请求，总轮次预算继续兜底。
    if (fingerprints.size > 256) fingerprints.delete(fingerprints.keys().next().value!);
  }
  return { fingerprints, count: Math.max(0, ...fingerprints.values()) };
}

function safeFailureDetails(value: unknown): Readonly<Record<string, string | number>> {
  const safe: Record<string, string | number> = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return safe;
  const record = value as Readonly<Record<string, unknown>>;
  for (const key of ["errorCode", "code", "exitCode", "signal", "policyDigest"] as const) {
    const field = record[key];
    if (typeof field === "string" || (typeof field === "number" && Number.isFinite(field))) safe[key] = field;
  }
  return safe;
}

export async function appendBudgetTerminationSummary(
  messages: AgentMessage[],
  reason: AgentRunTerminationReason,
  fire: (ev: AgentEvent, entry?: Omit<LedgerEntry, "sessionId">) => Promise<void>,
  sessionId: string,
): Promise<void> {
  const summaries: Record<AgentRunTerminationReason, string> = {
    model_turn_limit: "Run stopped because the model turn limit was reached.",
    tool_turn_limit: "Run stopped because the tool turn limit was reached.",
    active_duration_limit: "Run stopped because the active execution time limit was reached.",
    repeated_tool_failure: "Run stopped after repeated tool failures. Review the failed tool results before retrying; the task is incomplete.",
    approval_expiration_limit: "Run stopped after repeated approval expirations. Review the pending operation before requesting fresh approval; the task is incomplete.",
  };
  const text = summaries[reason];
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
