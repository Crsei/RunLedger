import { isAbsolute } from "node:path";

const SYNTAX_THEME_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/**
 * RunLedger settings 的单一 typed contract。
 *
 * 这里仅声明已有 Runtime/TUI 能消费的设置。未知键不会因为出现在 JSON
 * 中就获得 authority；新能力必须先有真实 consumer 和 focused test。
 */

export type SettingScope = "user" | "workspace" | "session" | "cli";
export type SettingApplyMode = "live" | "next-turn" | "startup";
export type SettingGroupName =
	| "display"
	| "startup"
	| "retry"
	| "compaction"
	| "memory"
	| "tools"
	| "providers"
	| "git"
	| "task"
	| "workspace"
	| "plan";

export type SettingPath =
	| "autoTitle"
	| "hideThinkingBlock"
	| "theme"
	| "symbolPreset"
	| "colorBlindMode"
	| "statusLine.preset"
	| "statusLine.separator"
	| "statusLine.sessionAccent"
	| "display.smoothStreaming"
	| "display.hideToolActivity"
	| "display.showTokenUsage"
	| "display.cacheMissMarker"
	| "tui.renderMermaid"
	| "autoResume"
	| "startup.quiet"
	| "startup.showSplash"
	| "shellPath"
	| "steeringMode"
	| "followUpMode"
	| "recap.enabled"
	| "recap.idleSeconds"
	| "retry.enabled"
	| "retry.maxRetries"
	| "retry.baseDelayMs"
	| "retry.maxDelayMs"
	| "compaction.enabled"
	| "compaction.midTurnEnabled"
	| "compaction.strategy"
	| "compaction.thresholdPercent"
	| "compaction.thresholdTokens"
	| "compaction.retainRecentTurns"
	| "compaction.minCompactedTurns"
	| "memory.backend"
	| "tools.approval"
	| "tools.approvalMode"
	| "tools.artifactSpillThreshold"
	| "tools.artifactTailBytes"
	| "tools.artifactHeadBytes"
	| "tools.artifactTailLines"
	| "tools.outputMaxColumns"
	| "tools.read.enabled"
	| "tools.read.defaultLimit"
	| "tools.read.renderMarkdown"
	| "tools.write.enabled"
	| "tools.edit.enabled"
	| "tools.bash.enabled"
	| "tools.bash.defaultTimeoutMs"
	| "tools.bash.maxOutputChars"
	| "tools.grep.enabled"
	| "tools.grep.defaultLimit"
	| "tools.grep.contextBefore"
	| "tools.grep.contextAfter"
	| "tools.find.enabled"
	| "tools.find.defaultLimit"
	| "tools.glob.enabled"
	| "tools.glob.defaultLimit"
	| "tools.ls.enabled"
	| "tools.ls.defaultLimit"
	| "tools.webFetch.enabled"
	| "tools.lsp.enabled"
	| "tools.lsp.timeoutMs"
	| "disabledProviders"
	| "git.enabled"
	| "providers.maxInFlightRequests"
	| "task.maxConcurrency"
	| "task.maxRecursionDepth"
	| "task.maxRuntimeMs"
	| "task.softRequestBudget"
	| "task.disabledAgents"
	| "workspace.additionalDirectories"
	| "plan.enabled"
	| "plan.defaultOnStartup";

export type SettingValue =
	| boolean
	| number
	| string
	| readonly string[]
	| Readonly<Record<string, number>>
	| undefined;

export interface SettingDiagnostic {
	readonly code: "unknown_path" | "invalid_value" | "out_of_range" | "scope_not_allowed";
	readonly path: string;
	readonly source?: SettingScope;
	readonly message: string;
}

export type SettingNormalizationResult =
	| { readonly ok: true; readonly value: SettingValue }
	| { readonly ok: false; readonly diagnostic: SettingDiagnostic };

export interface SettingDefinition {
	readonly path: SettingPath;
	readonly group: SettingGroupName;
	readonly scope: readonly SettingScope[];
	readonly apply: SettingApplyMode;
	readonly defaultValue: SettingValue;
	readonly secret: false;
}

export interface RetrySettings {
	readonly enabled?: boolean;
	readonly maxRetries?: number;
	readonly baseDelayMs?: number;
	readonly maxDelayMs?: number;
}

export interface CompactionSettings {
	readonly enabled?: boolean;
	readonly midTurnEnabled?: boolean;
	readonly strategy?: "off" | "summary";
	readonly thresholdPercent?: number;
	readonly thresholdTokens?: number;
	readonly retainRecentTurns?: number;
	readonly minCompactedTurns?: number;
}

export interface MemorySettings {
	readonly backend?: "off" | "local";
}

export interface StatusLineSettings {
	readonly preset?: "default" | "compact" | "minimal";
	readonly separator?: string;
	readonly sessionAccent?: boolean;
}

export interface DisplaySettings {
	readonly symbolPreset?: "unicode" | "nerd" | "ascii";
	readonly colorBlindMode?: boolean;
	readonly statusLine?: StatusLineSettings;
	readonly display?: {
		readonly smoothStreaming?: boolean;
		readonly hideToolActivity?: boolean;
		readonly showTokenUsage?: boolean;
		readonly cacheMissMarker?: boolean;
	};
	readonly tui?: { readonly renderMermaid?: boolean };
}

export interface StartupSettings {
	readonly autoResume?: boolean;
	readonly startup?: {
		readonly quiet?: boolean;
		readonly showSplash?: boolean;
	};
}

export interface ToolsSettings {
	readonly approval?: "record" | "off";
	readonly approvalMode?: "always-ask" | "write" | "yolo";
	readonly artifactSpillThreshold?: number;
	readonly artifactTailBytes?: number;
	readonly artifactHeadBytes?: number;
	readonly artifactTailLines?: number;
	readonly outputMaxColumns?: number;
	readonly read?: {
		readonly enabled?: boolean;
		readonly defaultLimit?: number;
		readonly renderMarkdown?: boolean;
	};
	readonly write?: { readonly enabled?: boolean };
	readonly edit?: { readonly enabled?: boolean };
	readonly bash?: {
		readonly enabled?: boolean;
		readonly defaultTimeoutMs?: number;
		readonly maxOutputChars?: number;
	};
	readonly grep?: {
		readonly enabled?: boolean;
		readonly defaultLimit?: number;
		readonly contextBefore?: number;
		readonly contextAfter?: number;
	};
	readonly find?: { readonly enabled?: boolean; readonly defaultLimit?: number };
	readonly glob?: { readonly enabled?: boolean; readonly defaultLimit?: number };
	readonly ls?: { readonly enabled?: boolean; readonly defaultLimit?: number };
	readonly webFetch?: { readonly enabled?: boolean };
	readonly lsp?: { readonly enabled?: boolean; readonly timeoutMs?: number };
}

export interface ProviderSettings {
	readonly maxInFlightRequests?: Readonly<Record<string, number>>;
}

export interface GitSettings {
	readonly enabled?: boolean;
}

export interface TaskSettings {
	readonly maxConcurrency?: number;
	readonly maxRecursionDepth?: number;
	readonly maxRuntimeMs?: number;
	readonly softRequestBudget?: number;
	readonly disabledAgents?: readonly string[];
}

export interface WorkspaceSettings {
	readonly additionalDirectories?: readonly string[];
}

export interface PlanSettings {
	readonly enabled?: boolean;
	readonly defaultOnStartup?: boolean;
}

const USER_SCOPE: readonly SettingScope[] = Object.freeze(["user"]);
const USER_WORKSPACE_SCOPE: readonly SettingScope[] = Object.freeze(["user", "workspace"]);
const RUNTIME_SCOPE: readonly SettingScope[] = Object.freeze(["user", "workspace", "session", "cli"]);

function definition(
	path: SettingPath,
	group: SettingGroupName,
	scope: readonly SettingScope[],
	apply: SettingApplyMode,
	defaultValue: SettingValue,
): SettingDefinition {
	return Object.freeze({ path, group, scope, apply, defaultValue, secret: false as const });
}

export const SETTINGS_SCHEMA: Readonly<Record<SettingPath, SettingDefinition>> = Object.freeze({
	autoTitle: definition("autoTitle", "startup", USER_WORKSPACE_SCOPE, "startup", true),
	hideThinkingBlock: definition("hideThinkingBlock", "display", USER_SCOPE, "live", false),
	theme: definition("theme", "display", USER_SCOPE, "live", undefined),
	symbolPreset: definition("symbolPreset", "display", USER_SCOPE, "startup", "unicode"),
	colorBlindMode: definition("colorBlindMode", "display", USER_SCOPE, "startup", false),
	"statusLine.preset": definition("statusLine.preset", "display", RUNTIME_SCOPE, "live", "default"),
	"statusLine.separator": definition("statusLine.separator", "display", RUNTIME_SCOPE, "live", " · "),
	"statusLine.sessionAccent": definition("statusLine.sessionAccent", "display", RUNTIME_SCOPE, "live", true),
	"display.smoothStreaming": definition("display.smoothStreaming", "display", RUNTIME_SCOPE, "live", true),
	"display.hideToolActivity": definition("display.hideToolActivity", "display", RUNTIME_SCOPE, "live", false),
	"display.showTokenUsage": definition("display.showTokenUsage", "display", RUNTIME_SCOPE, "live", true),
	"display.cacheMissMarker": definition("display.cacheMissMarker", "display", RUNTIME_SCOPE, "live", false),
	"tui.renderMermaid": definition("tui.renderMermaid", "display", RUNTIME_SCOPE, "live", true),
	autoResume: definition("autoResume", "startup", RUNTIME_SCOPE, "startup", false),
	"startup.quiet": definition("startup.quiet", "startup", RUNTIME_SCOPE, "startup", false),
	"startup.showSplash": definition("startup.showSplash", "startup", RUNTIME_SCOPE, "startup", true),
	shellPath: definition("shellPath", "startup", USER_SCOPE, "startup", undefined),
	steeringMode: definition("steeringMode", "startup", RUNTIME_SCOPE, "next-turn", "one-at-a-time"),
	followUpMode: definition("followUpMode", "startup", RUNTIME_SCOPE, "next-turn", "one-at-a-time"),
	"recap.enabled": definition("recap.enabled", "startup", USER_SCOPE, "next-turn", true),
	"recap.idleSeconds": definition("recap.idleSeconds", "startup", USER_SCOPE, "next-turn", 240),
	"retry.enabled": definition("retry.enabled", "retry", RUNTIME_SCOPE, "next-turn", true),
	"retry.maxRetries": definition("retry.maxRetries", "retry", RUNTIME_SCOPE, "next-turn", 0),
	"retry.baseDelayMs": definition("retry.baseDelayMs", "retry", RUNTIME_SCOPE, "next-turn", 250),
	"retry.maxDelayMs": definition("retry.maxDelayMs", "retry", RUNTIME_SCOPE, "next-turn", 10_000),
	"compaction.enabled": definition("compaction.enabled", "compaction", RUNTIME_SCOPE, "next-turn", true),
	"compaction.midTurnEnabled": definition("compaction.midTurnEnabled", "compaction", RUNTIME_SCOPE, "next-turn", false),
	"compaction.strategy": definition("compaction.strategy", "compaction", RUNTIME_SCOPE, "next-turn", "summary"),
	"compaction.thresholdPercent": definition("compaction.thresholdPercent", "compaction", RUNTIME_SCOPE, "next-turn", 80),
	"compaction.thresholdTokens": definition("compaction.thresholdTokens", "compaction", RUNTIME_SCOPE, "next-turn", 0),
	"compaction.retainRecentTurns": definition("compaction.retainRecentTurns", "compaction", RUNTIME_SCOPE, "next-turn", 1),
	"compaction.minCompactedTurns": definition("compaction.minCompactedTurns", "compaction", RUNTIME_SCOPE, "next-turn", 1),
	"memory.backend": definition("memory.backend", "memory", RUNTIME_SCOPE, "next-turn", "local"),
	"tools.approval": definition("tools.approval", "tools", USER_SCOPE, "next-turn", "record"),
	"tools.approvalMode": definition("tools.approvalMode", "tools", USER_SCOPE, "next-turn", "always-ask"),
	"tools.artifactSpillThreshold": definition("tools.artifactSpillThreshold", "tools", USER_WORKSPACE_SCOPE, "next-turn", 64_000),
	"tools.artifactTailBytes": definition("tools.artifactTailBytes", "tools", USER_WORKSPACE_SCOPE, "next-turn", 0),
	"tools.artifactHeadBytes": definition("tools.artifactHeadBytes", "tools", USER_WORKSPACE_SCOPE, "next-turn", 0),
	"tools.artifactTailLines": definition("tools.artifactTailLines", "tools", USER_WORKSPACE_SCOPE, "next-turn", 0),
	"tools.outputMaxColumns": definition("tools.outputMaxColumns", "tools", USER_WORKSPACE_SCOPE, "next-turn", 0),
	"tools.read.enabled": definition("tools.read.enabled", "tools", USER_WORKSPACE_SCOPE, "next-turn", true),
	"tools.read.defaultLimit": definition("tools.read.defaultLimit", "tools", USER_WORKSPACE_SCOPE, "next-turn", 2_000),
	"tools.read.renderMarkdown": definition("tools.read.renderMarkdown", "tools", USER_WORKSPACE_SCOPE, "next-turn", false),
	"tools.write.enabled": definition("tools.write.enabled", "tools", USER_WORKSPACE_SCOPE, "next-turn", true),
	"tools.edit.enabled": definition("tools.edit.enabled", "tools", USER_WORKSPACE_SCOPE, "next-turn", true),
	"tools.bash.enabled": definition("tools.bash.enabled", "tools", USER_WORKSPACE_SCOPE, "next-turn", true),
	"tools.bash.defaultTimeoutMs": definition("tools.bash.defaultTimeoutMs", "tools", USER_WORKSPACE_SCOPE, "next-turn", 60_000),
	"tools.bash.maxOutputChars": definition("tools.bash.maxOutputChars", "tools", USER_WORKSPACE_SCOPE, "next-turn", 300_000),
	"tools.grep.enabled": definition("tools.grep.enabled", "tools", USER_WORKSPACE_SCOPE, "next-turn", true),
	"tools.grep.defaultLimit": definition("tools.grep.defaultLimit", "tools", USER_WORKSPACE_SCOPE, "next-turn", 100),
	"tools.grep.contextBefore": definition("tools.grep.contextBefore", "tools", USER_WORKSPACE_SCOPE, "next-turn", 0),
	"tools.grep.contextAfter": definition("tools.grep.contextAfter", "tools", USER_WORKSPACE_SCOPE, "next-turn", 0),
	"tools.find.enabled": definition("tools.find.enabled", "tools", USER_WORKSPACE_SCOPE, "next-turn", true),
	"tools.find.defaultLimit": definition("tools.find.defaultLimit", "tools", USER_WORKSPACE_SCOPE, "next-turn", 1_000),
	"tools.glob.enabled": definition("tools.glob.enabled", "tools", USER_WORKSPACE_SCOPE, "next-turn", true),
	"tools.glob.defaultLimit": definition("tools.glob.defaultLimit", "tools", USER_WORKSPACE_SCOPE, "next-turn", 100),
	"tools.ls.enabled": definition("tools.ls.enabled", "tools", USER_WORKSPACE_SCOPE, "next-turn", true),
	"tools.ls.defaultLimit": definition("tools.ls.defaultLimit", "tools", USER_WORKSPACE_SCOPE, "next-turn", 500),
	"tools.webFetch.enabled": definition("tools.webFetch.enabled", "tools", USER_WORKSPACE_SCOPE, "next-turn", true),
	"tools.lsp.enabled": definition("tools.lsp.enabled", "tools", USER_WORKSPACE_SCOPE, "next-turn", true),
	"tools.lsp.timeoutMs": definition("tools.lsp.timeoutMs", "tools", USER_WORKSPACE_SCOPE, "next-turn", 20_000),
	disabledProviders: definition("disabledProviders", "providers", USER_WORKSPACE_SCOPE, "next-turn", []),
	"git.enabled": definition("git.enabled", "git", USER_WORKSPACE_SCOPE, "live", true),
	"providers.maxInFlightRequests": definition("providers.maxInFlightRequests", "providers", USER_WORKSPACE_SCOPE, "next-turn", {}),
	"task.maxConcurrency": definition("task.maxConcurrency", "task", USER_WORKSPACE_SCOPE, "next-turn", 1),
	"task.maxRecursionDepth": definition("task.maxRecursionDepth", "task", USER_WORKSPACE_SCOPE, "next-turn", 1),
	"task.maxRuntimeMs": definition("task.maxRuntimeMs", "task", USER_WORKSPACE_SCOPE, "next-turn", 0),
	"task.softRequestBudget": definition("task.softRequestBudget", "task", USER_WORKSPACE_SCOPE, "next-turn", 0),
	"task.disabledAgents": definition("task.disabledAgents", "task", USER_WORKSPACE_SCOPE, "next-turn", []),
	"workspace.additionalDirectories": definition("workspace.additionalDirectories", "workspace", ["workspace"], "startup", []),
	"plan.enabled": definition("plan.enabled", "plan", USER_WORKSPACE_SCOPE, "next-turn", true),
	"plan.defaultOnStartup": definition("plan.defaultOnStartup", "plan", USER_WORKSPACE_SCOPE, "startup", false),
});

function diagnostic(
	code: SettingDiagnostic["code"],
	path: string,
	message: string,
	source?: SettingScope,
): SettingNormalizationResult {
	return { ok: false, diagnostic: { code, path, ...(source === undefined ? {} : { source }), message } };
}

function normalizeBoolean(path: SettingPath, value: unknown, source?: SettingScope): SettingNormalizationResult {
	return typeof value === "boolean"
		? { ok: true, value }
		: diagnostic("invalid_value", path, "setting must be a boolean", source);
}

function normalizeString(path: SettingPath, value: unknown, source?: SettingScope): SettingNormalizationResult {
	return typeof value === "string" && value.trim().length > 0
		? { ok: true, value: value.trim() }
		: diagnostic("invalid_value", path, "setting must be a non-empty string", source);
}

function normalizeTheme(path: SettingPath, value: unknown, source?: SettingScope): SettingNormalizationResult {
	return typeof value === "string" && !value.includes("..") && SYNTAX_THEME_NAME_PATTERN.test(value)
		? { ok: true, value }
		: diagnostic("invalid_value", path, "setting must be a valid syntax theme name", source);
}

function normalizeEnum(
	path: SettingPath,
	value: unknown,
	allowed: readonly string[],
	source?: SettingScope,
): SettingNormalizationResult {
	return typeof value === "string" && allowed.includes(value)
		? { ok: true, value }
		: diagnostic("invalid_value", path, `setting must be one of ${allowed.join(", ")}`, source);
}

function normalizeInteger(
	path: SettingPath,
	value: unknown,
	minimum: number,
	maximum: number,
	source?: SettingScope,
): SettingNormalizationResult {
	if (typeof value !== "number" || !Number.isSafeInteger(value)) {
		return diagnostic("invalid_value", path, "setting must be a safe integer", source);
	}
	return value >= minimum && value <= maximum
		? { ok: true, value }
		: diagnostic("out_of_range", path, `setting must be between ${minimum} and ${maximum}`, source);
}

function normalizeSeparator(path: SettingPath, value: unknown, source?: SettingScope): SettingNormalizationResult {
	if (
		typeof value !== "string" ||
		value.trim().length === 0 ||
		value.length > 16 ||
		/[\u0000-\u001f\u007f]/u.test(value)
	) {
		return diagnostic("invalid_value", path, "setting must be a short printable separator", source);
	}
	return { ok: true, value };
}

function normalizeShellPath(path: SettingPath, value: unknown, source?: SettingScope): SettingNormalizationResult {
	if (
		typeof value !== "string" ||
		value.trim().length === 0 ||
		value.length > 4096 ||
		/[\u0000-\u001f\u007f]/u.test(value) ||
		!isAbsolute(value.trim())
	) {
		return diagnostic("invalid_value", path, "setting must be an absolute executable path", source);
	}
	return { ok: true, value: value.trim() };
}

function normalizeStringList(
	path: SettingPath,
	value: unknown,
	source: SettingScope | undefined,
	maximumEntries: number,
	maximumLength: number,
): SettingNormalizationResult {
	if (!Array.isArray(value) || value.length > maximumEntries) {
		return diagnostic("invalid_value", path, `setting must be an array of at most ${maximumEntries} strings`, source);
	}
	const result: string[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		if (typeof item !== "string") return diagnostic("invalid_value", path, "setting list items must be strings", source);
		const normalized = item.trim();
		if (normalized.length === 0 || normalized.length > maximumLength) {
			return diagnostic("invalid_value", path, "setting list contains an invalid string", source);
		}
		if (!seen.has(normalized)) {
			seen.add(normalized);
			result.push(normalized);
		}
	}
	return { ok: true, value: Object.freeze(result) };
}

function normalizeProviderLimits(
	path: SettingPath,
	value: unknown,
	source?: SettingScope,
): SettingNormalizationResult {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return diagnostic("invalid_value", path, "setting must be a provider limit object", source);
	}
	const result: Record<string, number> = {};
	for (const [provider, limit] of Object.entries(value as Record<string, unknown>)) {
		const normalizedProvider = provider.trim();
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(normalizedProvider)) {
			return diagnostic("invalid_value", path, "provider ID is invalid", source);
		}
		const normalizedLimit = normalizeInteger(path, limit, 1, 64, source);
		if (!normalizedLimit.ok) return normalizedLimit;
		result[normalizedProvider] = normalizedLimit.value as number;
	}
	return { ok: true, value: Object.freeze(result) };
}

function normalizePathValue(path: SettingPath, value: unknown, source?: SettingScope): SettingNormalizationResult {
	switch (path) {
		case "autoTitle":
		case "hideThinkingBlock":
		case "colorBlindMode":
		case "statusLine.sessionAccent":
		case "display.smoothStreaming":
		case "display.hideToolActivity":
		case "display.showTokenUsage":
		case "display.cacheMissMarker":
		case "tui.renderMermaid":
		case "autoResume":
		case "startup.quiet":
		case "startup.showSplash":
		case "recap.enabled":
		case "retry.enabled":
		case "compaction.enabled":
		case "compaction.midTurnEnabled":
		case "tools.read.renderMarkdown":
		case "tools.read.enabled":
		case "tools.write.enabled":
		case "tools.edit.enabled":
		case "tools.bash.enabled":
		case "tools.grep.enabled":
		case "tools.find.enabled":
		case "tools.glob.enabled":
		case "tools.ls.enabled":
		case "tools.webFetch.enabled":
		case "tools.lsp.enabled":
		case "plan.enabled":
		case "plan.defaultOnStartup":
		case "git.enabled":
			return normalizeBoolean(path, value, source);
		case "theme":
			return normalizeTheme(path, value, source);
		case "symbolPreset":
			return normalizeEnum(path, value, ["unicode", "nerd", "ascii"], source);
		case "shellPath":
			return normalizeShellPath(path, value, source);
		case "statusLine.separator":
			return normalizeSeparator(path, value, source);
		case "statusLine.preset":
			return normalizeEnum(path, value, ["default", "compact", "minimal"], source);
		case "steeringMode":
		case "followUpMode":
			return normalizeEnum(path, value, ["one-at-a-time", "all"], source);
		case "compaction.strategy":
			return normalizeEnum(path, value, ["off", "summary"], source);
		case "memory.backend":
			return normalizeEnum(path, value, ["off", "local"], source);
		case "tools.approval":
			return normalizeEnum(path, value, ["record", "off"], source);
		case "tools.approvalMode":
			return normalizeEnum(path, value, ["always-ask", "write", "yolo"], source);
		case "recap.idleSeconds":
			return normalizeInteger(path, value, 1, 3_600, source);
		case "retry.maxRetries":
			return normalizeInteger(path, value, 0, 10, source);
		case "retry.baseDelayMs":
			return normalizeInteger(path, value, 0, 60_000, source);
		case "retry.maxDelayMs":
			return normalizeInteger(path, value, 0, 300_000, source);
		case "compaction.thresholdPercent":
			return normalizeInteger(path, value, 1, 100, source);
		case "compaction.thresholdTokens":
			return normalizeInteger(path, value, 0, 16_000_000, source);
		case "compaction.retainRecentTurns":
		case "compaction.minCompactedTurns":
			return normalizeInteger(path, value, 1, 10_000, source);
		case "tools.artifactSpillThreshold":
			return normalizeInteger(path, value, 0, 16_000_000, source);
		case "tools.artifactTailBytes":
		case "tools.artifactHeadBytes":
			return normalizeInteger(path, value, 0, 16_000_000, source);
		case "tools.artifactTailLines":
			return normalizeInteger(path, value, 0, 100_000, source);
		case "tools.outputMaxColumns":
			return normalizeInteger(path, value, 0, 10_000, source);
		case "tools.read.defaultLimit":
			return normalizeInteger(path, value, 1, 100_000, source);
		case "tools.bash.defaultTimeoutMs":
			return normalizeInteger(path, value, 1, 2_147_483_647, source);
		case "tools.bash.maxOutputChars":
			return normalizeInteger(path, value, 1, 16_000_000, source);
		case "tools.grep.defaultLimit":
		case "tools.find.defaultLimit":
		case "tools.glob.defaultLimit":
		case "tools.ls.defaultLimit":
			return normalizeInteger(path, value, 1, 100_000, source);
		case "tools.grep.contextBefore":
		case "tools.grep.contextAfter":
			return normalizeInteger(path, value, 0, 10_000, source);
		case "tools.lsp.timeoutMs":
			return normalizeInteger(path, value, 1, 300_000, source);
		case "task.maxConcurrency":
			return normalizeInteger(path, value, 1, 16, source);
		case "task.maxRecursionDepth":
			return normalizeInteger(path, value, 1, 8, source);
		case "task.maxRuntimeMs":
			return normalizeInteger(path, value, 0, 86_400_000, source);
		case "task.softRequestBudget":
			return normalizeInteger(path, value, 0, 1_000_000, source);
		case "disabledProviders":
			return normalizeStringList(path, value, source, 128, 128);
		case "providers.maxInFlightRequests":
			return normalizeProviderLimits(path, value, source);
		case "task.disabledAgents":
			return normalizeStringList(path, value, source, 128, 128);
		case "workspace.additionalDirectories":
			return normalizeStringList(path, value, source, 32, 512);
	}
}

export function getSettingDefinition(path: string): SettingDefinition | undefined {
	return Object.hasOwn(SETTINGS_SCHEMA, path)
		? SETTINGS_SCHEMA[path as SettingPath]
		: undefined;
}

export function normalizeSettingValue(
	path: string,
	value: unknown,
	source?: SettingScope,
): SettingNormalizationResult {
	const definition = getSettingDefinition(path);
	if (definition === undefined) return diagnostic("unknown_path", path, "setting path is not supported", source);
	if (source !== undefined && !definition.scope.includes(source)) {
		return diagnostic("scope_not_allowed", path, `${source} scope cannot own this setting`, source);
	}
	return normalizePathValue(definition.path, value, source);
}

export function normalizeRetrySettings(value: unknown, source: SettingScope = "user"): RetrySettings | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	const out: { enabled?: boolean; maxRetries?: number; baseDelayMs?: number; maxDelayMs?: number } = {};
	const enabled = normalizeSettingValue("retry.enabled", raw.enabled, source);
	if (Object.hasOwn(raw, "enabled") && enabled.ok) out.enabled = enabled.value as boolean;
	const maxRetries = normalizeSettingValue("retry.maxRetries", raw.maxRetries, source);
	if (Object.hasOwn(raw, "maxRetries") && maxRetries.ok) out.maxRetries = maxRetries.value as number;
	const baseDelayMs = normalizeSettingValue("retry.baseDelayMs", raw.baseDelayMs, source);
	if (Object.hasOwn(raw, "baseDelayMs") && baseDelayMs.ok) out.baseDelayMs = baseDelayMs.value as number;
	const maxDelayMs = normalizeSettingValue("retry.maxDelayMs", raw.maxDelayMs, source);
	if (Object.hasOwn(raw, "maxDelayMs") && maxDelayMs.ok) out.maxDelayMs = maxDelayMs.value as number;
	return Object.keys(out).length > 0 ? out : undefined;
}

export function normalizeCompactionSettings(value: unknown, source: SettingScope = "user"): CompactionSettings | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	const out: {
		enabled?: boolean;
		midTurnEnabled?: boolean;
		strategy?: "off" | "summary";
		thresholdPercent?: number;
		thresholdTokens?: number;
		retainRecentTurns?: number;
		minCompactedTurns?: number;
	} = {};
	const enabled = normalizeSettingValue("compaction.enabled", raw.enabled, source);
	if (Object.hasOwn(raw, "enabled") && enabled.ok) out.enabled = enabled.value as boolean;
	const midTurnEnabled = normalizeSettingValue("compaction.midTurnEnabled", raw.midTurnEnabled, source);
	if (Object.hasOwn(raw, "midTurnEnabled") && midTurnEnabled.ok) out.midTurnEnabled = midTurnEnabled.value as boolean;
	const strategy = normalizeSettingValue("compaction.strategy", raw.strategy, source);
	if (Object.hasOwn(raw, "strategy") && strategy.ok) out.strategy = strategy.value as "off" | "summary";
	const thresholdPercent = normalizeSettingValue("compaction.thresholdPercent", raw.thresholdPercent, source);
	if (Object.hasOwn(raw, "thresholdPercent") && thresholdPercent.ok) out.thresholdPercent = thresholdPercent.value as number;
	const thresholdTokens = normalizeSettingValue("compaction.thresholdTokens", raw.thresholdTokens, source);
	if (Object.hasOwn(raw, "thresholdTokens") && thresholdTokens.ok) out.thresholdTokens = thresholdTokens.value as number;
	const retainRecentTurns = normalizeSettingValue("compaction.retainRecentTurns", raw.retainRecentTurns, source);
	if (Object.hasOwn(raw, "retainRecentTurns") && retainRecentTurns.ok) out.retainRecentTurns = retainRecentTurns.value as number;
	const minCompactedTurns = normalizeSettingValue("compaction.minCompactedTurns", raw.minCompactedTurns, source);
	if (Object.hasOwn(raw, "minCompactedTurns") && minCompactedTurns.ok) out.minCompactedTurns = minCompactedTurns.value as number;
	return Object.keys(out).length > 0 ? out : undefined;
}

export function normalizeMemorySettings(value: unknown, source: SettingScope = "user"): MemorySettings | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	const backend = normalizeSettingValue("memory.backend", raw.backend, source);
	return Object.hasOwn(raw, "backend") && backend.ok
		? { backend: backend.value as "off" | "local" }
		: undefined;
}

function normalizedField(
	raw: Record<string, unknown>,
	key: string,
	path: SettingPath,
	source: SettingScope,
): SettingValue | undefined {
	if (!Object.hasOwn(raw, key)) return undefined;
	const result = normalizeSettingValue(path, raw[key], source);
	return result.ok ? result.value : undefined;
}

export function normalizeDisplaySettings(value: unknown, source: SettingScope = "user"): DisplaySettings | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	const statusLineRaw = typeof raw.statusLine === "object" && raw.statusLine !== null && !Array.isArray(raw.statusLine)
		? raw.statusLine as Record<string, unknown>
		: {};
	const displayRaw = typeof raw.display === "object" && raw.display !== null && !Array.isArray(raw.display)
		? raw.display as Record<string, unknown>
		: {};
	const tuiRaw = typeof raw.tui === "object" && raw.tui !== null && !Array.isArray(raw.tui)
		? raw.tui as Record<string, unknown>
		: {};
	const preset = normalizedField(statusLineRaw, "preset", "statusLine.preset", source);
	const separator = normalizedField(statusLineRaw, "separator", "statusLine.separator", source);
	const sessionAccent = normalizedField(statusLineRaw, "sessionAccent", "statusLine.sessionAccent", source);
	const statusLine: StatusLineSettings = {
		...(preset === undefined ? {} : { preset: preset as StatusLineSettings["preset"] }),
		...(separator === undefined ? {} : { separator: separator as string }),
		...(sessionAccent === undefined ? {} : { sessionAccent: sessionAccent as boolean }),
	};
	const display: Partial<Record<"smoothStreaming" | "hideToolActivity" | "showTokenUsage" | "cacheMissMarker", boolean>> = {};
	for (const [key, path] of [
		["smoothStreaming", "display.smoothStreaming"],
		["hideToolActivity", "display.hideToolActivity"],
		["showTokenUsage", "display.showTokenUsage"],
		["cacheMissMarker", "display.cacheMissMarker"],
	] as const) {
		const field = normalizedField(displayRaw, key, path, source);
		if (field !== undefined) display[key] = field as boolean;
	}
	const tuiValue = normalizedField(tuiRaw, "renderMermaid", "tui.renderMermaid", source);
	const symbolPreset = normalizedField(raw, "symbolPreset", "symbolPreset", source);
	const colorBlindMode = normalizedField(raw, "colorBlindMode", "colorBlindMode", source);
	const result: DisplaySettings = {
		...(symbolPreset === undefined ? {} : { symbolPreset: symbolPreset as DisplaySettings["symbolPreset"] }),
		...(colorBlindMode === undefined ? {} : { colorBlindMode: colorBlindMode as boolean }),
		...(Object.keys(statusLine).length === 0 ? {} : { statusLine }),
		...(Object.keys(display).length === 0 ? {} : { display }),
		...(tuiValue === undefined ? {} : { tui: { renderMermaid: tuiValue as boolean } }),
	};
	return Object.keys(result).length === 0 ? undefined : result;
}

export function normalizeStartupSettings(value: unknown, source: SettingScope = "user"): StartupSettings | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	const startupRaw = typeof raw.startup === "object" && raw.startup !== null && !Array.isArray(raw.startup)
		? raw.startup as Record<string, unknown>
		: {};
	const autoResume = normalizedField(raw, "autoResume", "autoResume", source);
	const startup: Partial<Record<"quiet" | "showSplash", boolean>> = {};
	for (const [key, path] of [
		["quiet", "startup.quiet"],
		["showSplash", "startup.showSplash"],
	] as const) {
		const field = normalizedField(startupRaw, key, path, source);
		if (field !== undefined) startup[key] = field as boolean;
	}
	const result: StartupSettings = {
		...(autoResume === undefined ? {} : { autoResume: autoResume as boolean }),
		...(Object.keys(startup).length === 0 ? {} : { startup }),
	};
	return Object.keys(result).length === 0 ? undefined : result;
}

export function normalizeToolsSettings(value: unknown, source: SettingScope = "user"): ToolsSettings | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	const readRaw = typeof raw.read === "object" && raw.read !== null && !Array.isArray(raw.read) ? raw.read as Record<string, unknown> : {};
	const bashRaw = typeof raw.bash === "object" && raw.bash !== null && !Array.isArray(raw.bash) ? raw.bash as Record<string, unknown> : {};
	const read: { enabled?: boolean; defaultLimit?: number; renderMarkdown?: boolean } = {};
	const write: { enabled?: boolean } = {};
	const edit: { enabled?: boolean } = {};
	const bash: { enabled?: boolean; defaultTimeoutMs?: number; maxOutputChars?: number } = {};
	const grep: { enabled?: boolean; defaultLimit?: number; contextBefore?: number; contextAfter?: number } = {};
	const find: { enabled?: boolean; defaultLimit?: number } = {};
	const glob: { enabled?: boolean; defaultLimit?: number } = {};
	const ls: { enabled?: boolean; defaultLimit?: number } = {};
	const webFetch: { enabled?: boolean } = {};
	const lsp: { enabled?: boolean; timeoutMs?: number } = {};
	const readEnabled = normalizedField(readRaw, "enabled", "tools.read.enabled", source);
	if (readEnabled !== undefined) read.enabled = readEnabled as boolean;
	const approval = normalizedField(raw, "approval", "tools.approval", source);
	const approvalMode = normalizedField(raw, "approvalMode", "tools.approvalMode", source);
	for (const [key, path] of [["defaultLimit", "tools.read.defaultLimit"]] as const) {
		const field = normalizedField(readRaw, key, path, source);
		if (field !== undefined) read[key] = field as number;
	}
	const renderMarkdown = normalizedField(readRaw, "renderMarkdown", "tools.read.renderMarkdown", source);
	if (renderMarkdown !== undefined) read.renderMarkdown = renderMarkdown as boolean;
	const writeRaw = typeof raw.write === "object" && raw.write !== null && !Array.isArray(raw.write) ? raw.write as Record<string, unknown> : {};
	const writeEnabled = normalizedField(writeRaw, "enabled", "tools.write.enabled", source);
	if (writeEnabled !== undefined) write.enabled = writeEnabled as boolean;
	const editRaw = typeof raw.edit === "object" && raw.edit !== null && !Array.isArray(raw.edit) ? raw.edit as Record<string, unknown> : {};
	const editEnabled = normalizedField(editRaw, "enabled", "tools.edit.enabled", source);
	if (editEnabled !== undefined) edit.enabled = editEnabled as boolean;
	const bashEnabled = normalizedField(bashRaw, "enabled", "tools.bash.enabled", source);
	if (bashEnabled !== undefined) bash.enabled = bashEnabled as boolean;
	const defaultTimeoutMs = normalizedField(bashRaw, "defaultTimeoutMs", "tools.bash.defaultTimeoutMs", source);
	if (defaultTimeoutMs !== undefined) bash.defaultTimeoutMs = defaultTimeoutMs as number;
	const maxOutputChars = normalizedField(bashRaw, "maxOutputChars", "tools.bash.maxOutputChars", source);
	if (maxOutputChars !== undefined) bash.maxOutputChars = maxOutputChars as number;
	for (const [group, target, path] of [
		["grep", grep, "tools.grep.enabled"],
		["find", find, "tools.find.enabled"],
		["glob", glob, "tools.glob.enabled"],
		["ls", ls, "tools.ls.enabled"],
		["webFetch", webFetch, "tools.webFetch.enabled"],
	] as const) {
		const groupRaw = typeof raw[group] === "object" && raw[group] !== null && !Array.isArray(raw[group]) ? raw[group] as Record<string, unknown> : {};
		const enabled = normalizedField(groupRaw, "enabled", path, source);
		if (enabled !== undefined) target.enabled = enabled as boolean;
	}
	const grepRaw = typeof raw.grep === "object" && raw.grep !== null && !Array.isArray(raw.grep)
		? raw.grep as Record<string, unknown>
		: {};
	const grepDefaultLimit = normalizedField(grepRaw, "defaultLimit", "tools.grep.defaultLimit", source);
	const grepContextBefore = normalizedField(grepRaw, "contextBefore", "tools.grep.contextBefore", source);
	const grepContextAfter = normalizedField(grepRaw, "contextAfter", "tools.grep.contextAfter", source);
	if (grepDefaultLimit !== undefined) grep.defaultLimit = grepDefaultLimit as number;
	if (grepContextBefore !== undefined) grep.contextBefore = grepContextBefore as number;
	if (grepContextAfter !== undefined) grep.contextAfter = grepContextAfter as number;
	for (const [group, target, path] of [
		["find", find, "tools.find.defaultLimit"],
		["glob", glob, "tools.glob.defaultLimit"],
		["ls", ls, "tools.ls.defaultLimit"],
	] as const) {
		const groupRaw = typeof raw[group] === "object" && raw[group] !== null && !Array.isArray(raw[group])
			? raw[group] as Record<string, unknown>
			: {};
		const defaultLimit = normalizedField(groupRaw, "defaultLimit", path, source);
		if (defaultLimit !== undefined) target.defaultLimit = defaultLimit as number;
	}
	const lspRaw = typeof raw.lsp === "object" && raw.lsp !== null && !Array.isArray(raw.lsp) ? raw.lsp as Record<string, unknown> : {};
	const lspEnabled = normalizedField(lspRaw, "enabled", "tools.lsp.enabled", source);
	const lspTimeoutMs = normalizedField(lspRaw, "timeoutMs", "tools.lsp.timeoutMs", source);
	if (lspEnabled !== undefined) lsp.enabled = lspEnabled as boolean;
	if (lspTimeoutMs !== undefined) lsp.timeoutMs = lspTimeoutMs as number;
	const result: {
		approval?: ToolsSettings["approval"];
		approvalMode?: ToolsSettings["approvalMode"];
		read?: typeof read;
		write?: typeof write;
		edit?: typeof edit;
		bash?: typeof bash;
		grep?: typeof grep;
		find?: typeof find;
		glob?: typeof glob;
		ls?: typeof ls;
		webFetch?: typeof webFetch;
		lsp?: typeof lsp;
		artifactSpillThreshold?: number;
		artifactTailBytes?: number;
		artifactHeadBytes?: number;
		artifactTailLines?: number;
		outputMaxColumns?: number;
	} = {
		...(approval === undefined ? {} : { approval: approval as ToolsSettings["approval"] }),
		...(approvalMode === undefined ? {} : { approvalMode: approvalMode as ToolsSettings["approvalMode"] }),
		...(Object.keys(read).length === 0 ? {} : { read }),
		...(Object.keys(write).length === 0 ? {} : { write }),
		...(Object.keys(edit).length === 0 ? {} : { edit }),
		...(Object.keys(bash).length === 0 ? {} : { bash }),
		...(Object.keys(grep).length === 0 ? {} : { grep }),
		...(Object.keys(find).length === 0 ? {} : { find }),
		...(Object.keys(glob).length === 0 ? {} : { glob }),
		...(Object.keys(ls).length === 0 ? {} : { ls }),
		...(Object.keys(webFetch).length === 0 ? {} : { webFetch }),
		...(Object.keys(lsp).length === 0 ? {} : { lsp }),
	};
	const artifactSpillThreshold = normalizedField(raw, "artifactSpillThreshold", "tools.artifactSpillThreshold", source);
	const artifactTailBytes = normalizedField(raw, "artifactTailBytes", "tools.artifactTailBytes", source);
	const artifactHeadBytes = normalizedField(raw, "artifactHeadBytes", "tools.artifactHeadBytes", source);
	const artifactTailLines = normalizedField(raw, "artifactTailLines", "tools.artifactTailLines", source);
	const outputMaxColumns = normalizedField(raw, "outputMaxColumns", "tools.outputMaxColumns", source);
	if (artifactSpillThreshold !== undefined) result.artifactSpillThreshold = artifactSpillThreshold as number;
	if (artifactTailBytes !== undefined) result.artifactTailBytes = artifactTailBytes as number;
	if (artifactHeadBytes !== undefined) result.artifactHeadBytes = artifactHeadBytes as number;
	if (artifactTailLines !== undefined) result.artifactTailLines = artifactTailLines as number;
	if (outputMaxColumns !== undefined) result.outputMaxColumns = outputMaxColumns as number;
	return Object.keys(result).length === 0 ? undefined : result;
}

export function normalizeProviderSettings(value: unknown, source: SettingScope = "user"): ProviderSettings | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	const limits = normalizedField(raw, "maxInFlightRequests", "providers.maxInFlightRequests", source);
	const result: ProviderSettings = {
		...(limits === undefined ? {} : { maxInFlightRequests: limits as Readonly<Record<string, number>> }),
	};
	return Object.keys(result).length === 0 ? undefined : result;
}

export function normalizeGitSettings(value: unknown, source: SettingScope = "user"): GitSettings | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const enabled = normalizedField(value as Record<string, unknown>, "enabled", "git.enabled", source);
	return enabled === undefined ? undefined : { enabled: enabled as boolean };
}

export function normalizeTaskSettings(value: unknown, source: SettingScope = "user"): TaskSettings | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	const result: Record<string, unknown> = {};
	for (const key of ["maxConcurrency", "maxRecursionDepth", "maxRuntimeMs", "softRequestBudget", "disabledAgents"] as const) {
		const field = normalizedField(raw, key, `task.${key}` as SettingPath, source);
		if (field !== undefined) result[key] = field;
	}
	return Object.keys(result).length === 0 ? undefined : result as TaskSettings;
}

export function normalizeWorkspaceSettings(value: unknown, source: SettingScope = "workspace"): WorkspaceSettings | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	const directories = normalizedField(raw, "additionalDirectories", "workspace.additionalDirectories", source);
	return directories === undefined ? undefined : { additionalDirectories: directories as readonly string[] };
}

export function normalizePlanSettings(value: unknown, source: SettingScope = "user"): PlanSettings | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	const enabled = normalizedField(raw, "enabled", "plan.enabled", source);
	const defaultOnStartup = normalizedField(raw, "defaultOnStartup", "plan.defaultOnStartup", source);
	const result: PlanSettings = {
		...(enabled === undefined ? {} : { enabled: enabled as boolean }),
		...(defaultOnStartup === undefined ? {} : { defaultOnStartup: defaultOnStartup as boolean }),
	};
	return Object.keys(result).length === 0 ? undefined : result;
}
