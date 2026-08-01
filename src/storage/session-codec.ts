import type { ModelThinkingLevel } from "../types.ts";
import type { AgentMessage } from "../runtime/types.ts";
import type { LedgerEntry, LedgerSink } from "../runtime/ledger/types.ts";
import { newId } from "../runtime/ledger/types.ts";

export interface SessionRuntimeConfig {
  provider?: string;
  model?: string;
  thinkingLevel?: ModelThinkingLevel;
}

export interface SessionReplay {
  messages: AgentMessage[];
  config: SessionRuntimeConfig;
  auditEntries: LedgerEntry[];
  warnings: string[];
}

/** 从 ledger 重建可继续请求的上下文与 TUI 审计回放。 */
export async function replaySession(ledger: LedgerSink): Promise<SessionReplay> {
  const entries = await ledger.entries();
  const messages: AgentMessage[] = [];
  const config: SessionRuntimeConfig = {};
  const warnings: string[] = [];

  for (const entry of entries) {
    if (entry.type === "message") {
      const canonical = toAgentMessage(entry.payload.message);
      if (canonical) {
        messages.push(canonical);
      }
      continue;
    }
    if (entry.type === "custom" && entry.payload.kind === "runtime.config") {
      if (typeof entry.payload.provider === "string") config.provider = entry.payload.provider;
      if (typeof entry.payload.model === "string") config.model = entry.payload.model;
      if (isThinkingLevel(entry.payload.thinkingLevel)) {
        config.thinkingLevel = entry.payload.thinkingLevel;
      }
    }
  }

  return {
    messages,
    config,
    auditEntries: entries.filter((entry) => entry.type === "tool_call" || entry.type === "tool_result"),
    warnings,
  };
}

export async function appendRuntimeConfig(
  ledger: LedgerSink,
  config: SessionRuntimeConfig,
  source: "startup" | "provider" | "model" | "thinking" | "resume",
): Promise<void> {
  await ledger.append({
    id: newId(),
    sessionId: ledger.sessionId,
    parentId: ledger.header()?.id ?? ledger.sessionId,
    timestamp: Date.now(),
    type: "custom",
    payload: {
      kind: "runtime.config",
      source,
      ...config,
    },
  });
}

function toAgentMessage(value: unknown): AgentMessage | undefined {
  if (!isRecord(value) || typeof value.role !== "string") return undefined;
  if (value.role === "user" && Array.isArray(value.content)) {
    return value as unknown as AgentMessage;
  }
  if (value.role === "assistant" && Array.isArray(value.content) && typeof value.stopReason === "string") {
    return value as unknown as AgentMessage;
  }
  if (value.role === "toolResult" && Array.isArray(value.content)) {
    return value as unknown as AgentMessage;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThinkingLevel(value: unknown): value is ModelThinkingLevel {
  return value === "off" || value === "minimal" || value === "low" || value === "medium" ||
    value === "high" || value === "xhigh" || value === "max";
}
