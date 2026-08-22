import type { ModelThinkingLevel } from "../types.ts";
import type { AgentMessage } from "../runtime/types.ts";
import type { LedgerEntry, LedgerSink } from "../runtime/ledger/types.ts";
import { newId } from "../runtime/ledger/types.ts";

export type SessionSettingsSource = "default" | "user" | "workspace" | "session" | "cli";
export type SessionSettingsApplyMode = "live" | "next-turn" | "startup";
export type SessionSettingsDiagnosticCode = "unknown_path" | "invalid_value" | "out_of_range" | "scope_not_allowed";

export interface SessionSettingsDiagnostic {
	readonly code: SessionSettingsDiagnosticCode;
	readonly path: string;
	readonly source?: "user" | "workspace" | "session" | "cli";
}

export interface SessionRuntimeConfig {
  provider?: string;
  model?: string;
  thinkingLevel?: ModelThinkingLevel;
  /** Effective settings snapshot identity; never contains raw settings or credentials. */
  settingsDigest?: string;
	/** Sanitized source metadata for replay diagnostics; values are never persisted here. */
	settingsSourceLayers?: Readonly<Record<string, SessionSettingsSource>>;
	/** Schema application boundary captured with the runtime config event. */
	settingsApplyModes?: Readonly<Record<string, SessionSettingsApplyMode>>;
	/** Only stable diagnostic code/path/source are replayed; messages are intentionally omitted. */
	settingsDiagnostics?: readonly SessionSettingsDiagnostic[];
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
  return projectSessionReplay(entries);
}

/**
 * 从 checkpoint projection 继续应用 ledger tail。seed 缺省时等价 genesis
 * replay；调用方不得把 checkpoint 之外的状态当作 authority。
 */
export function projectSessionReplay(
  entries: readonly LedgerEntry[],
  seed?: SessionReplay,
): SessionReplay {
  const messages: AgentMessage[] = [...(seed?.messages ?? [])];
  const config: SessionRuntimeConfig = { ...(seed?.config ?? {}) };
  const warnings: string[] = [...(seed?.warnings ?? [])];
  const auditEntries: LedgerEntry[] = [...(seed?.auditEntries ?? [])];

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
      if (isSettingsDigest(entry.payload.settingsDigest)) {
        config.settingsDigest = entry.payload.settingsDigest;
      }
			const sourceLayers = parseSettingsSourceLayers(entry.payload.settingsSourceLayers);
			if (sourceLayers !== undefined) config.settingsSourceLayers = sourceLayers;
			const applyModes = parseSettingsApplyModes(entry.payload.settingsApplyModes);
			if (applyModes !== undefined) config.settingsApplyModes = applyModes;
			const diagnostics = parseSettingsDiagnostics(entry.payload.settingsDiagnostics);
			if (diagnostics !== undefined) config.settingsDiagnostics = diagnostics;
    }
    if (entry.type === "tool_call" || entry.type === "tool_result") auditEntries.push(entry);
  }

  return {
    messages,
    config,
    auditEntries,
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

function isSettingsDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isSettingsSource(value: unknown): value is SessionSettingsSource {
	return value === "default" || value === "user" || value === "workspace" || value === "session" || value === "cli";
}

function parseSettingsSourceLayers(value: unknown): Readonly<Record<string, SessionSettingsSource>> | undefined {
	if (!isRecord(value)) return undefined;
	const result: Record<string, SessionSettingsSource> = {};
	for (const [path, source] of Object.entries(value)) {
		if (!isSettingsSource(source)) return undefined;
		result[path] = source;
	}
	return Object.freeze(result);
}

function isSettingsApplyMode(value: unknown): value is SessionSettingsApplyMode {
	return value === "live" || value === "next-turn" || value === "startup";
}

function parseSettingsApplyModes(value: unknown): Readonly<Record<string, SessionSettingsApplyMode>> | undefined {
	if (!isRecord(value)) return undefined;
	const result: Record<string, SessionSettingsApplyMode> = {};
	for (const [path, mode] of Object.entries(value)) {
		if (!isSettingsApplyMode(mode)) return undefined;
		result[path] = mode;
	}
	return Object.freeze(result);
}

function isSettingsDiagnosticCode(value: unknown): value is SessionSettingsDiagnosticCode {
	return value === "unknown_path" || value === "invalid_value" || value === "out_of_range" || value === "scope_not_allowed";
}

function isSettingsDiagnosticSource(value: unknown): SessionSettingsDiagnostic["source"] {
	return value === "user" || value === "workspace" || value === "session" || value === "cli" ? value : undefined;
}

function parseSettingsDiagnostics(value: unknown): readonly SessionSettingsDiagnostic[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const result: SessionSettingsDiagnostic[] = [];
	for (const item of value) {
		if (!isRecord(item) || !isSettingsDiagnosticCode(item.code) || typeof item.path !== "string") return undefined;
		if (Object.hasOwn(item, "source") && item.source !== undefined && isSettingsDiagnosticSource(item.source) === undefined) return undefined;
		const source = isSettingsDiagnosticSource(item.source);
		result.push({
			code: item.code,
			path: item.path,
			...(source === undefined ? {} : { source }),
		});
	}
	return Object.freeze(result.map((diagnostic) => Object.freeze(diagnostic)));
}
