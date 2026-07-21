import type { ModelThinkingLevel, StopReason } from "../types.ts";
import type { AgentMessage, AssistantAgentMessage } from "../runtime/types.ts";
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
  const isLegacy = ledger.header()?.version === 1;

  for (const entry of entries) {
    if (entry.type === "message") {
      const canonical = entry.payload.schema === "agent-message/v1"
        ? toAgentMessage(entry.payload.message)
        : undefined;
      if (canonical) {
        messages.push(canonical);
        continue;
      }
      if (isLegacy) {
        const recovered = recoverLegacyMessage(entry);
        if (recovered) messages.push(recovered);
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

  if (isLegacy) {
    warnings.push(
      "Legacy session v1: tool arguments and thinking signatures were not persisted; only safe text history was restored.",
    );
  }
  return {
    messages: sanitizeConversation(messages),
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

function recoverLegacyMessage(entry: LedgerEntry): AgentMessage | undefined {
  const role = entry.payload.role;
  const content = entry.payload.content;
  if (role === "user" && typeof content === "string") {
    return { role: "user", content: [{ type: "text", text: content }] };
  }
  if (role === "assistant" && typeof content === "string") {
    const stopReason = isStopReason(entry.payload.stopReason) ? entry.payload.stopReason : "stop";
    const message: AssistantAgentMessage = {
      role: "assistant",
      content: content.length > 0 ? [{ type: "text", text: content }] : [],
      stopReason,
    };
    if (typeof entry.payload.errorMessage === "string") {
      message.errorMessage = entry.payload.errorMessage;
    }
    return message;
  }
  return undefined;
}

/** 移除 legacy 中无法匹配 toolCall 的孤立 toolResult,避免 provider 拒绝上下文。 */
function sanitizeConversation(messages: AgentMessage[]): AgentMessage[] {
  const knownToolCalls = new Set<string>();
  const out: AgentMessage[] = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const content of message.content) {
        if (content.type === "toolCall") knownToolCalls.add(content.id);
      }
      out.push(message);
      continue;
    }
    if (message.role === "toolResult") {
      const content = message.content.filter((result) => knownToolCalls.has(result.toolCallId));
      if (content.length > 0) out.push({ ...message, content });
      continue;
    }
    out.push(message);
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThinkingLevel(value: unknown): value is ModelThinkingLevel {
  return value === "off" || value === "minimal" || value === "low" || value === "medium" ||
    value === "high" || value === "xhigh" || value === "max";
}

function isStopReason(value: unknown): value is StopReason {
  return value === "stop" || value === "length" || value === "toolUse" || value === "error" ||
    value === "aborted";
}
