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

export function repeatedToolFailure(
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

export async function appendBudgetTerminationSummary(
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
