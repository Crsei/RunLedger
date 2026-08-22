/**
 * Settings 到现有 Runtime/TUI policy 的纯投影。
 *
 * 该模块不读取文件、不启动副作用，也不授予新的 capability。所有输入都
 * 经过有限范围归一化；缺少字段由上层 schema/effective resolver 提供默认值。
 */

import type { ApprovalPolicyName } from "../security/types.ts";

type UnknownRecord = Record<string, unknown>;

export interface DisplaySettingsProjection {
	readonly symbolPreset?: "unicode" | "nerd" | "ascii";
	readonly colorBlindMode?: boolean;
	readonly statusLine?: {
		readonly preset?: "default" | "compact" | "minimal";
		readonly separator?: string;
		readonly sessionAccent?: boolean;
	};
	readonly display?: {
		readonly smoothStreaming?: boolean;
		readonly hideToolActivity?: boolean;
		readonly showTokenUsage?: boolean;
		readonly cacheMissMarker?: boolean;
	};
	readonly tui?: {
		readonly renderMermaid?: boolean;
	};
}

export interface StartupSettingsProjection {
	readonly autoResume?: boolean;
	readonly startup?: {
		readonly quiet?: boolean;
		readonly showSplash?: boolean;
	};
}

export type ToolApprovalMode = "always-ask" | "write" | "yolo";
export interface ToolSearchPolicyProjection {
	readonly enabled?: boolean;
	readonly defaultLimit?: number;
	readonly contextBefore?: number;
	readonly contextAfter?: number;
}

export interface ToolPolicyProjection {
	readonly approval?: "record" | "off";
	readonly approvalMode?: ToolApprovalMode;
	readonly approvalPolicy?: ApprovalPolicyName;
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
	readonly grep?: ToolSearchPolicyProjection;
	readonly find?: ToolSearchPolicyProjection;
	readonly glob?: ToolSearchPolicyProjection;
	readonly ls?: ToolSearchPolicyProjection;
	readonly webFetch?: { readonly enabled?: boolean };
	readonly lsp?: { readonly enabled?: boolean; readonly timeoutMs?: number };
}

export interface ProviderPolicyProjection {
	readonly disabledProviders?: readonly string[];
	readonly maxInFlightRequests?: Readonly<Record<string, number>>;
}

export interface GitPolicyProjection {
	readonly enabled: boolean;
}

export interface PlanPolicyProjection {
	readonly enabled: boolean;
	readonly defaultOnStartup: boolean;
}

export interface TaskPolicyProjection {
	readonly maxConcurrency: number;
	readonly maxRecursionDepth: number;
	readonly maxRuntimeMs?: number;
	readonly softRequestBudget?: number;
	readonly disabledAgents?: readonly string[];
}

const DEFAULT_SEPARATOR = " · ";
const DEFAULT_ARTIFACT_SPILL_THRESHOLD = 64_000;
const DEFAULT_TASK_CONCURRENCY = 1;
const DEFAULT_TASK_RECURSION_DEPTH = 1;

/** Git 设置只控制只读 presentation metadata，不改变 workspace/Security authority。 */
export function resolveGitPolicy(value: unknown): GitPolicyProjection {
	const raw = recordValue(value);
	return Object.freeze({ enabled: raw.enabled !== false });
}

/** Plan 设置只控制既有 Plan domain 的可见性与启动默认，不授予新 capability。 */
export function resolvePlanPolicy(value: unknown): PlanPolicyProjection {
	const raw = recordValue(value);
	return Object.freeze({
		enabled: raw.enabled !== false,
		defaultOnStartup: raw.defaultOnStartup === true,
	});
}

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown): UnknownRecord {
	return isRecord(value) ? value : {};
}

function nestedGroupValue(raw: UnknownRecord, group: string, keys: readonly string[]): UnknownRecord {
	const nested = { ...recordValue(raw[group]) };
	for (const key of keys) {
		if (!Object.hasOwn(nested, key) && Object.hasOwn(raw, `${group}.${key}`)) nested[key] = raw[`${group}.${key}`];
	}
	return nested;
}

function booleanValue(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function safeString(value: unknown, maximumLength = 128): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 && trimmed.length <= maximumLength ? trimmed : undefined;
}

function safeSeparator(value: unknown): string {
	if (typeof value !== "string") return DEFAULT_SEPARATOR;
	const separator = value;
	if (
		separator.trim().length === 0 ||
		separator.length > 16 ||
		/[\u0000-\u001f\u007f]/u.test(separator)
	) return DEFAULT_SEPARATOR;
	return separator;
}

function integerInRange(value: unknown, minimum: number, maximum: number): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum
		? value
		: undefined;
}

function integerOrDefault(value: unknown, fallback: number, minimum: number, maximum: number): number {
	return integerInRange(value, minimum, maximum) ?? fallback;
}

function uniqueStrings(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const result: string[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		const normalized = safeString(item);
		if (normalized === undefined || seen.has(normalized)) continue;
		seen.add(normalized);
		result.push(normalized);
	}
	return result;
}

function approvalPolicy(value: unknown): ApprovalPolicyName | undefined {
	switch (value) {
		case "always-ask":
			return "granular";
		case "write":
			return "on-request";
		case "yolo":
			return "never";
		default:
			return undefined;
	}
}

/** 只投影已有 presentation 字段；不改变消息、ledger 或 provider request。 */
export function resolveDisplaySettings(value: unknown): DisplaySettingsProjection {
	const raw = recordValue(value);
	const statusLine = recordValue(raw.statusLine);
	const display = recordValue(raw.display);
	const tui = recordValue(raw.tui);
	const result: {
		symbolPreset?: DisplaySettingsProjection["symbolPreset"];
		colorBlindMode?: boolean;
		statusLine?: DisplaySettingsProjection["statusLine"];
		display?: DisplaySettingsProjection["display"];
		tui?: DisplaySettingsProjection["tui"];
	} = {};
	if (raw.symbolPreset === "unicode" || raw.symbolPreset === "nerd" || raw.symbolPreset === "ascii") {
		result.symbolPreset = raw.symbolPreset;
	}
	const colorBlindMode = booleanValue(raw.colorBlindMode);
	if (colorBlindMode !== undefined) result.colorBlindMode = colorBlindMode;

	if (Object.keys(statusLine).length > 0) {
		const projected: {
			preset?: "default" | "compact" | "minimal";
			separator?: string;
			sessionAccent?: boolean;
		} = {};
		if (statusLine.preset === "default" || statusLine.preset === "compact" || statusLine.preset === "minimal") {
			projected.preset = statusLine.preset;
		}
		if (Object.hasOwn(statusLine, "separator")) projected.separator = safeSeparator(statusLine.separator);
		const sessionAccent = booleanValue(statusLine.sessionAccent);
		if (sessionAccent !== undefined) projected.sessionAccent = sessionAccent;
		if (Object.keys(projected).length > 0) result.statusLine = projected;
	}
	if (Object.keys(display).length > 0) {
		const projected: Partial<Record<"smoothStreaming" | "hideToolActivity" | "showTokenUsage" | "cacheMissMarker", boolean>> = {};
		for (const key of ["smoothStreaming", "hideToolActivity", "showTokenUsage", "cacheMissMarker"] as const) {
			const boolean = booleanValue(display[key]);
			if (boolean !== undefined) projected[key] = boolean;
		}
		if (Object.keys(projected).length > 0) result.display = projected;
	}
	if (Object.keys(tui).length > 0) {
		const renderMermaid = booleanValue(tui.renderMermaid);
		if (renderMermaid !== undefined) result.tui = { renderMermaid };
	}

	return Object.freeze(result);
}

/** 启动设置只影响启动 policy，不改变已有 CLI/session override 优先级。 */
export function resolveStartupSettings(value: unknown): StartupSettingsProjection {
	const raw = recordValue(value);
	const result: {
		autoResume?: boolean;
		startup?: StartupSettingsProjection["startup"];
	} = {};
	const autoResume = booleanValue(raw.autoResume);
	if (autoResume !== undefined) result.autoResume = autoResume;
	const startup = recordValue(raw.startup);
	if (Object.keys(startup).length > 0) {
		const projected: Partial<Record<"quiet" | "showSplash", boolean>> = {};
		for (const key of ["quiet", "showSplash"] as const) {
			const boolean = booleanValue(startup[key]);
			if (boolean !== undefined) projected[key] = boolean;
		}
		if (Object.keys(projected).length > 0) result.startup = projected;
	}
	return Object.freeze(result);
}

/** 把用户侧 approvalMode 映射为 Security 已有的 fail-closed enum。 */
export function resolveToolPolicy(value: unknown): ToolPolicyProjection {
	const raw = recordValue(value);
	const result: {
		approval?: "record" | "off";
		approvalMode?: ToolApprovalMode;
		approvalPolicy?: ApprovalPolicyName;
		artifactSpillThreshold?: number;
		artifactTailBytes?: number;
		artifactHeadBytes?: number;
		artifactTailLines?: number;
		outputMaxColumns?: number;
		read?: ToolPolicyProjection["read"];
		write?: ToolPolicyProjection["write"];
		edit?: ToolPolicyProjection["edit"];
		bash?: ToolPolicyProjection["bash"];
		grep?: ToolPolicyProjection["grep"];
		find?: ToolPolicyProjection["find"];
		glob?: ToolPolicyProjection["glob"];
		ls?: ToolPolicyProjection["ls"];
		webFetch?: ToolPolicyProjection["webFetch"];
		lsp?: ToolPolicyProjection["lsp"];
	} = {};
	if (raw.approval === "record" || raw.approval === "off") result.approval = raw.approval;
	if (raw.approvalMode === "always-ask" || raw.approvalMode === "write" || raw.approvalMode === "yolo") {
		result.approvalMode = raw.approvalMode;
		result.approvalPolicy = approvalPolicy(raw.approvalMode);
	}
	if (Object.hasOwn(raw, "artifactSpillThreshold")) {
		result.artifactSpillThreshold = integerOrDefault(raw.artifactSpillThreshold, DEFAULT_ARTIFACT_SPILL_THRESHOLD, 0, 16_000_000);
	}
	for (const key of ["artifactTailBytes", "artifactHeadBytes"] as const) {
		if (Object.hasOwn(raw, key)) result[key] = integerOrDefault(raw[key], 0, 0, 16_000_000);
	}
	if (Object.hasOwn(raw, "artifactTailLines")) {
		result.artifactTailLines = integerOrDefault(raw.artifactTailLines, 0, 0, 100_000);
	}
	if (Object.hasOwn(raw, "outputMaxColumns")) {
		result.outputMaxColumns = integerOrDefault(raw.outputMaxColumns, 0, 0, 10_000);
	}

	const read = nestedGroupValue(raw, "read", ["enabled", "defaultLimit", "renderMarkdown"]);
	if (Object.keys(read).length > 0) {
		const projected: { enabled?: boolean; defaultLimit?: number; renderMarkdown?: boolean } = {};
		const enabled = booleanValue(read.enabled);
		if (enabled !== undefined) projected.enabled = enabled;
		if (Object.hasOwn(read, "defaultLimit")) projected.defaultLimit = integerOrDefault(read.defaultLimit, 2_000, 1, 100_000);
		const renderMarkdown = booleanValue(read.renderMarkdown);
		if (renderMarkdown !== undefined) projected.renderMarkdown = renderMarkdown;
		if (Object.keys(projected).length > 0) result.read = projected;
	}
	for (const [group, target] of [
		["write", "write"],
		["edit", "edit"],
		["webFetch", "webFetch"],
	] as const) {
		const enabled = booleanValue(nestedGroupValue(raw, group, ["enabled"]).enabled);
		if (enabled !== undefined) result[target] = Object.freeze({ enabled });
	}
	for (const [group, target, fallback] of [
		["grep", "grep", 100],
		["find", "find", 1_000],
		["glob", "glob", 100],
		["ls", "ls", 500],
	] as const) {
		const value = nestedGroupValue(raw, group, ["enabled", "defaultLimit", "contextBefore", "contextAfter"]);
		const enabled = booleanValue(value.enabled);
		const projected: { enabled?: boolean; defaultLimit?: number; contextBefore?: number; contextAfter?: number } = {};
		if (enabled !== undefined) projected.enabled = enabled;
		if (Object.hasOwn(value, "defaultLimit")) projected.defaultLimit = integerOrDefault(value.defaultLimit, fallback, 1, 100_000);
		if (group === "grep") {
			if (Object.hasOwn(value, "contextBefore")) projected.contextBefore = integerOrDefault(value.contextBefore, 0, 0, 10_000);
			if (Object.hasOwn(value, "contextAfter")) projected.contextAfter = integerOrDefault(value.contextAfter, 0, 0, 10_000);
		}
		if (Object.keys(projected).length > 0) result[target] = Object.freeze(projected);
	}
	const lsp = nestedGroupValue(raw, "lsp", ["enabled", "timeoutMs"]);
	if (Object.keys(lsp).length > 0) {
		const projected: { enabled?: boolean; timeoutMs?: number } = {};
		const enabled = booleanValue(lsp.enabled);
		if (enabled !== undefined) projected.enabled = enabled;
		if (Object.hasOwn(lsp, "timeoutMs")) projected.timeoutMs = integerOrDefault(lsp.timeoutMs, 20_000, 1, 300_000);
		if (Object.keys(projected).length > 0) result.lsp = projected;
	}
	const bash = nestedGroupValue(raw, "bash", ["enabled", "defaultTimeoutMs", "maxOutputChars"]);
	if (Object.keys(bash).length > 0) {
		const projected: { enabled?: boolean; defaultTimeoutMs?: number; maxOutputChars?: number } = {};
		const enabled = booleanValue(bash.enabled);
		if (enabled !== undefined) projected.enabled = enabled;
		if (Object.hasOwn(bash, "defaultTimeoutMs")) projected.defaultTimeoutMs = integerOrDefault(bash.defaultTimeoutMs, 60_000, 1, 2_147_483_647);
		if (Object.hasOwn(bash, "maxOutputChars")) projected.maxOutputChars = integerOrDefault(bash.maxOutputChars, 300_000, 1, 16_000_000);
		if (Object.keys(projected).length > 0) result.bash = projected;
	}
	return Object.freeze(result);
}

/** Provider policy 只收窄可用 provider，不从 settings 推导 credential 或 transport。 */
export function resolveProviderPolicy(value: unknown): ProviderPolicyProjection {
	const raw = recordValue(value);
	const result: {
		disabledProviders?: readonly string[];
		maxInFlightRequests?: Readonly<Record<string, number>>;
	} = {};
	const disabledProviders = uniqueStrings(raw.disabledProviders);
	if (disabledProviders !== undefined) result.disabledProviders = Object.freeze(disabledProviders);
	if (isRecord(raw.maxInFlightRequests)) {
		const limits: Record<string, number> = {};
		for (const [provider, limit] of Object.entries(raw.maxInFlightRequests)) {
			const normalizedProvider = safeString(provider);
			if (normalizedProvider === undefined) continue;
			limits[normalizedProvider] = integerOrDefault(limit, 1, 1, 64);
		}
		result.maxInFlightRequests = Object.freeze(limits);
	}
	return Object.freeze(result);
}

/** Task policy 的越界值回退到最小安全并发/递归，而不是扩大 authority。 */
export function resolveTaskPolicy(value: unknown): TaskPolicyProjection {
	const raw = recordValue(value);
	const result: {
		maxConcurrency: number;
		maxRecursionDepth: number;
		maxRuntimeMs?: number;
		softRequestBudget?: number;
		disabledAgents?: readonly string[];
	} = {
		maxConcurrency: integerOrDefault(raw.maxConcurrency, DEFAULT_TASK_CONCURRENCY, 1, 16),
		maxRecursionDepth: integerOrDefault(raw.maxRecursionDepth, DEFAULT_TASK_RECURSION_DEPTH, 1, 8),
	};
	if (Object.hasOwn(raw, "maxRuntimeMs")) result.maxRuntimeMs = integerOrDefault(raw.maxRuntimeMs, 0, 1, 86_400_000);
	if (Object.hasOwn(raw, "softRequestBudget")) result.softRequestBudget = integerOrDefault(raw.softRequestBudget, 0, 1, 1_000_000);
	const disabledAgents = uniqueStrings(raw.disabledAgents);
	if (disabledAgents !== undefined) result.disabledAgents = Object.freeze(disabledAgents);
	return Object.freeze(result);
}
