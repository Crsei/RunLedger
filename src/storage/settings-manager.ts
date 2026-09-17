import { parseUiThemeSettings, type UiThemeSettings } from "../contracts/ui-theme.ts";
import { isAgentMode, type AgentMode } from "../runtime/harness-profiles/agent-mode.ts";
/**
 * 用户级 Settings 加载/落盘。
 *
 * 所有持久化路径都来自 composition root 注入的 RunledgerLayout。cwd、旧项目
 * settings 与任意 sessionDir 不再参与 canonical settings authority。
 */

import { existsSync, readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import type { ModelThinkingLevel } from "../types.ts";
import type { QueueMode } from "../runtime/types.ts";
import type { RunledgerLayout } from "../runtime/contracts/public.ts";
import {
	validateMultiAgentSettingsSource,
	type MultiAgentDiagnostic,
	type MultiAgentSettingsSource,
} from "../runtime/agents/index.ts";
import { canonicalDigest } from "../runtime/protocol/canonical-json.ts";
import { runtimeDigest, type RuntimeDigest } from "../runtime/protocol/foundation.ts";
import { parseCompactionSettings, type CompactionSettings } from "../runtime/context/compaction/settings.ts";

const SETTINGS_WRITE_OPTS = { encoding: "utf8", mode: 0o600 } as const;
const SETTINGS_MKDIR_OPTS = { recursive: true, mode: 0o700 } as const;
const WORKSPACE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u;
const SYNTAX_THEME_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const LOGO_LETTERS_PATTERN = /^[A-Za-z]{1,32}$/u;

export interface SettingsStoreOptions {
	readonly layout: RunledgerLayout;
	/**
	 * Runtime workspace storage key. When omitted, settings are user-wide at
	 * `layout.settings`; when present, they are fixed at
	 * `layout.projects/<workspaceKey>/settings.json`.
	 */
	readonly workspaceKey?: string;
}

/** 用户级或 workspace 级 settings schema。sessionDir 不属于 canonical schema。 */
export interface ProjectSettings {
	/** 用户级压缩策略；工作区不能启用付费的自动摘要。 */
	compaction?: Partial<CompactionSettings>;
	/** 仅用户级新建默认；恢复与 TUI 新建继承 durable profile。 */
	agentMode?: AgentMode;
	/** 是否允许首个合格用户输入触发异步 Session 自动标题；缺省开启。 */
	autoTitle?: boolean;
	/** 空闲 recap 的用户级开关与延迟；运行时会解析为完整有效快照。 */
	recap?: RecapSettings;
	/** Goal Mode 的开关、自动续跑与迭代上限；workspace 只能进一步收窄。 */
	goal?: GoalSettings;
	/** Loop 的开关与无显式 limit 时的迭代上限；workspace 只能进一步收窄。 */
	loop?: LoopSettings;
	/** 默认 provider ID,与 model 共同组成稳定模型身份。 */
	provider?: string;
	/** 默认模型 ID;CLI `--model` 优先级高于此字段 */
	model?: string;
	/** 默认 thinking level;CLI `--thinking` 优先级高于此字段 */
	thinkingLevel?: ModelThinkingLevel;
	/** 是否仅在 TUI 展示层隐藏 thinking blocks；不改变模型请求或持久消息。 */
	hideThinkingBlock?: boolean;
	/** Welcome 页 Logo 字母；缺省由 TUI 使用 `runledger`。 */
	logo?: string;
	/** syntax theme 名；dark/light 是兼容输入，分别映射为自适应 pair。 */
	theme?: string;
	uiTheme?: UiThemeSettings;
	/** /model 选择器可见模型白名单;空数组或 undefined 表示无白名单 */
	enabledModels?: string[];
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
	/** 用户级本地 trace 记录策略；workspace settings 不拥有该 authority。 */
	recording?: Partial<RecordingSettings>;
	/** M1 bounded root delegation policy；workspace 层只能进一步收窄。 */
	multiAgent?: MultiAgentSettingsSource;
	/** 版本化 skills provider policy（user/workspace 均可写，workspace 只能收窄）。 */
	skills?: SkillsSettings;
	/** plugin settings 的**值层**：声明式 schema 在分发包的 `package.json#runledger` 里。 */
	plugins?: PluginSettingsValues;
	/** marketplace 自动更新模式；只有 user 层拥有该 authority（D10）。 */
	marketplace?: MarketplaceSettings;
	/**
	 * web 检索的 provider 顺序/排除、超时与 SearXNG 端点。user 层拥有 order 与
	 * timeout 的 authority；workspace 层只能追加 exclude（收窄）。
	 */
	webSearch?: WebSearchSettings;
}

/**
 * web 检索设置。
 *
 * `order` 里的 id 视为显式选择（走 `isExplicitlyAvailable`，因此 Exa/Parallel 这类
 * 无凭据兜底仍可用）；未识别的 id 在解析时丢弃。`exclude` 只做排除，不能反过来
 * 把未列出的 provider 关掉。
 */
export interface WebSearchSettings {
	/** 优先 provider 列表；空表示使用内建顺序。 */
	readonly order?: readonly string[];
	/** 永不使用的 provider。 */
	readonly exclude?: readonly string[];
	/** 单次 provider 传输的硬超时（秒），上限 300。 */
	readonly timeoutSeconds?: number;
	readonly searxng?: {
		readonly endpoint?: string;
		readonly token?: string;
		readonly basicUsername?: string;
		readonly basicPassword?: string;
		readonly engines?: readonly string[];
		readonly categories?: readonly string[];
		readonly language?: string;
		readonly safesearch?: number;
	};
}

/**
 * marketplace 行为设置。`autoUpdate` 缺省即 `off`；`notify` 需要真实可见出口
 * （CLI 可查询的 pending 列表或 TUI notice），`auto` 只刷新 catalog 与可见信号，
 * 绝不代替用户做安装/启用/信任决定（D7/D10）。
 */
export interface MarketplaceSettings {
	readonly autoUpdate?: "off" | "notify" | "auto";
}

/**
 * plugin settings 的值层。只在 user 层授权；workspace 层只能收窄（非 secret 键、
 * 且值本身仍合法），secret 键在 workspace 层一律拒绝——规则由
 * `extensions/plugins/settings-schema.ts` 的 `resolvePluginSettings` 执行。
 */
export interface PluginSettingsValues {
	/** `packageId` → setting 名 → 值。 */
	readonly values?: Readonly<Record<string, Readonly<Record<string, string | number | boolean>>>>;
	/**
	 * 可选文件 watcher：观察已安装/声明式 plugin root 的变更并在 **idle 边界**
	 * 请求交换 snapshot。默认关闭（D13：user 层授权，workspace 不拥有该 authority；
	 * in-session 变更需重开会话才生效）。
	 */
	readonly watch?: boolean;
}

export interface RecapSettings {
	readonly enabled?: boolean;
	readonly idleSeconds?: number;
}

export interface EffectiveRecapSettings {
	readonly enabled: boolean;
	readonly idleSeconds: number;
}

export const DEFAULT_RECAP_SETTINGS: EffectiveRecapSettings = Object.freeze({
	enabled: true,
	idleSeconds: 240,
});

export const RECAP_MIN_IDLE_SECONDS = 1;
export const RECAP_MAX_IDLE_SECONDS = 3600;

/** Goal Mode settings：总闸、自动续跑与两个上限；workspace 层只能收窄。 */
export interface GoalSettings {
	readonly enabled?: boolean;
	readonly autoContinuation?: boolean;
	readonly continuationDelaySeconds?: number;
	readonly maxContinuations?: number;
}

export interface EffectiveGoalSettings {
	readonly enabled: boolean;
	readonly autoContinuation: boolean;
	readonly continuationDelaySeconds: number;
	readonly maxContinuations: number;
}

export const DEFAULT_GOAL_SETTINGS: EffectiveGoalSettings = Object.freeze({
	enabled: true,
	autoContinuation: true,
	// omp 在 TUI 里固定 800ms 即时续跑；owner 侧用可配置 idle 窗口，避免无脑连跑。
	continuationDelaySeconds: 30,
	maxContinuations: 20,
});

export const GOAL_MIN_CONTINUATION_DELAY_SECONDS = 1;
export const GOAL_MAX_CONTINUATION_DELAY_SECONDS = 3600;
export const GOAL_MIN_CONTINUATIONS = 0;
export const GOAL_MAX_CONTINUATIONS = 1_000;

/** Loop settings：总闸、条件谓词开关与无显式 limit 时的硬上限。 */
export interface LoopSettings {
	readonly enabled?: boolean;
	readonly maxIterations?: number;
	readonly conditionEnabled?: boolean;
}

export interface EffectiveLoopSettings {
	readonly enabled: boolean;
	readonly maxIterations: number;
	readonly conditionEnabled: boolean;
}

export const DEFAULT_LOOP_SETTINGS: EffectiveLoopSettings = Object.freeze({
	enabled: true,
	// omp 无上限；RunLedger 必须给自主迭代一个硬边界。
	maxIterations: 50,
	conditionEnabled: false,
});

export const LOOP_MIN_ITERATIONS = 1;
export const LOOP_MAX_ITERATIONS = 1_000;

export type RecordingMode = "off" | "events" | "events_and_artifacts";

export type RecordingFailurePolicy = "best_effort" | "fail_closed";

export interface RecordingSettings {
	readonly mode: RecordingMode;
	readonly failurePolicy: RecordingFailurePolicy;
}

/**
 * 版本化 skills provider policy：user/workspace 均可写；workspace 只能收窄。
 * 外部路径不保存；provider exact ID 的已知性由 extensions/skills/policy.ts
 * 在消费时校验（storage 层只做结构清洗）。
 */
export interface SkillsSettings {
	/** 总闸：user false 后 workspace/session 只能进一步关闭。 */
	readonly enabled?: boolean;
	/** 已知 provider exact ID → boolean；未知 ID 保留 diagnostic，不自动运行。 */
	readonly providers?: Readonly<Record<string, boolean>>;
}

export type EffectiveRecordingConfig = Readonly<RecordingSettings>;

export const DEFAULT_RECORDING_CONFIG: EffectiveRecordingConfig = Object.freeze({
	mode: "events",
	failurePolicy: "best_effort",
});

/** 用于边界检查的输入类型；sessionDir 只能被识别为拒绝字段，不能被持久化。 */
export type ProjectSettingsInput = ProjectSettings & { readonly sessionDir?: unknown };

export type SettingsStorageErrorCode = "unsupported_setting" | "invalid_workspace_key" | "invalid_multi_agent_settings";

export interface LayeredMultiAgentSettings {
	readonly state: "absent" | "valid" | "invalid";
	readonly value?: MultiAgentSettingsSource;
	/** 保留 presence 与原始 JSON，供 policy resolver 产生 fail-closed diagnostic。 */
	readonly raw?: unknown;
	readonly sourceDigest: RuntimeDigest;
}

export interface LayeredSettingsLayer {
	readonly source: "user" | "workspace";
	readonly path: string;
	readonly settings: ProjectSettings;
	readonly multiAgent: LayeredMultiAgentSettings;
	readonly sourceDigest: RuntimeDigest;
}

export interface LayeredProjectSettings {
	readonly user: LayeredSettingsLayer;
	readonly workspace: LayeredSettingsLayer;
	readonly diagnostics: readonly MultiAgentDiagnostic[];
}

export interface LayeredProjectSettingsOptions {
	readonly layout: RunledgerLayout;
	readonly workspaceKey: string;
}

export class SettingsStorageError extends Error {
	readonly code: SettingsStorageErrorCode;
	readonly field?: string;
	readonly path: string;

	constructor(code: SettingsStorageErrorCode, path: string, field?: string) {
		super(
			code === "unsupported_setting"
				? `unsupported settings field${field ? `: ${field}` : ""}`
				: code === "invalid_workspace_key" ? "invalid workspace storage key" : "invalid multi-agent settings",
		);
		this.name = "SettingsStorageError";
		this.code = code;
		this.field = field;
		this.path = path;
	}
}

/** 空白 settings; canonical 文件缺失时返回此值。 */
export const EMPTY_PROJECT_SETTINGS: ProjectSettings = {};

/** 返回固定的 canonical settings locator。 */
export function getSettingsPath(options: SettingsStoreOptions): string {
	if (options.workspaceKey === undefined) return options.layout.settings;
	if (!WORKSPACE_KEY_PATTERN.test(options.workspaceKey)) {
		throw new SettingsStorageError("invalid_workspace_key", options.layout.projects);
	}
	return join(options.layout.projects, options.workspaceKey, "settings.json");
}

/** 加载 canonical settings；不会读取旧项目 settings。 */
export async function loadProjectSettings(
	options: SettingsStoreOptions,
): Promise<ProjectSettings> {
	const path = getSettingsPath(options);
	let text: string;
	try {
		text = await fs.readFile(path, "utf8");
	} catch {
		return {};
	}
	return parseSettings(text, path, options.workspaceKey === undefined);
}

/**
 * 读取 user/workspace 两层，而不是把它们先合并成一个 settings 对象。
 * multiAgent 的 invalid presence 会保留在 layer.raw，并以结构化诊断让上层
 * policy resolver fail closed；普通单 Agent settings 仍照常返回。
 */
export async function loadLayeredProjectSettings(
	options: LayeredProjectSettingsOptions,
): Promise<LayeredProjectSettings> {
	const user = await loadSettingsLayer(options.layout.settings, "user", true);
	const workspacePath = getSettingsPath({ layout: options.layout, workspaceKey: options.workspaceKey });
	const workspace = await loadSettingsLayer(workspacePath, "workspace", false);
	return Object.freeze({
		user: Object.freeze(user),
		workspace: Object.freeze(workspace),
		diagnostics: Object.freeze([
			...user.multiAgentDiagnostics,
			...workspace.multiAgentDiagnostics,
		].map((diagnostic) => Object.freeze(diagnostic))),
	});
}

/** 同步加载 canonical settings。 */
export function loadProjectSettingsSync(
	options: SettingsStoreOptions,
): ProjectSettings {
	const path = getSettingsPath(options);
	if (!existsSync(path)) return {};
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return {};
	}
	return parseSettings(text, path, options.workspaceKey === undefined);
}

/** 写入 canonical settings；sessionDir 在触及目标前被结构化拒绝。 */
export async function saveProjectSettings(
	options: SettingsStoreOptions,
	settings: ProjectSettingsInput,
): Promise<void> {
	const path = getSettingsPath(options);
	assertSupportedSettings(options, path, settings);
	await fs.mkdir(dirname(path), SETTINGS_MKDIR_OPTS);
	await fs.writeFile(
		path,
		JSON.stringify(sanitizeProjectSettings(settings as Record<string, unknown>, options.workspaceKey === undefined), null, 2) + "\n",
		SETTINGS_WRITE_OPTS,
	);
}

/** 将缺失、非法或越界 recap 配置解析为安全的不可变运行时快照。 */
export function resolveRecapSettings(settings: { readonly recap?: unknown }): EffectiveRecapSettings {
	const recap = sanitizeRecapSettings(settings.recap);
	const idleSeconds = recap?.idleSeconds ?? DEFAULT_RECAP_SETTINGS.idleSeconds;
	return Object.freeze({
		enabled: recap?.enabled ?? DEFAULT_RECAP_SETTINGS.enabled,
		idleSeconds: Math.min(RECAP_MAX_IDLE_SECONDS, Math.max(RECAP_MIN_IDLE_SECONDS, Math.trunc(idleSeconds))),
	});
}

/** 将缺失、非法或越界的 goal 配置解析为安全的不可变运行时快照。 */
export function resolveGoalSettings(settings: { readonly goal?: unknown }): EffectiveGoalSettings {
	const goal = sanitizeGoalSettings(settings.goal);
	const delay = goal?.continuationDelaySeconds ?? DEFAULT_GOAL_SETTINGS.continuationDelaySeconds;
	const maxContinuations = goal?.maxContinuations ?? DEFAULT_GOAL_SETTINGS.maxContinuations;
	return Object.freeze({
		enabled: goal?.enabled ?? DEFAULT_GOAL_SETTINGS.enabled,
		autoContinuation: goal?.autoContinuation ?? DEFAULT_GOAL_SETTINGS.autoContinuation,
		continuationDelaySeconds: Math.min(
			GOAL_MAX_CONTINUATION_DELAY_SECONDS,
			Math.max(GOAL_MIN_CONTINUATION_DELAY_SECONDS, Math.trunc(delay)),
		),
		maxContinuations: Math.min(GOAL_MAX_CONTINUATIONS, Math.max(GOAL_MIN_CONTINUATIONS, Math.trunc(maxContinuations))),
	});
}

/** 将缺失、非法或越界的 loop 配置解析为安全的不可变运行时快照。 */
export function resolveLoopSettings(settings: { readonly loop?: unknown }): EffectiveLoopSettings {
	const loop = sanitizeLoopSettings(settings.loop);
	const maxIterations = loop?.maxIterations ?? DEFAULT_LOOP_SETTINGS.maxIterations;
	return Object.freeze({
		enabled: loop?.enabled ?? DEFAULT_LOOP_SETTINGS.enabled,
		maxIterations: Math.min(LOOP_MAX_ITERATIONS, Math.max(LOOP_MIN_ITERATIONS, Math.trunc(maxIterations))),
		conditionEnabled: loop?.conditionEnabled ?? DEFAULT_LOOP_SETTINGS.conditionEnabled,
	});
}

function parseSettings(text: string, path: string, allowRecording: boolean): ProjectSettings {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		process.stderr.write(allowRecording ? "[runledger] invalid_settings_json; using empty settings with recording disabled\n" : "[runledger] invalid_workspace_settings_json; using empty workspace settings\n");
		return allowRecording ? { recording: { mode: "off" } } : {};
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		if (allowRecording) process.stderr.write("[runledger] invalid_settings_document; recording disabled\n");
		return allowRecording ? { recording: { mode: "off" } } : {};
	}
	const raw = parsed as Record<string, unknown>;
	if (
		allowRecording &&
		Object.prototype.hasOwnProperty.call(raw, "recording") &&
		sanitizeRecordingSettings(raw.recording) === undefined
	) {
		process.stderr.write(`[runledger] invalid_recording_settings at ${path}; recording disabled\n`);
	}
	const multiAgentValidation = validateMultiAgentSettingsSource(raw.multiAgent, "multiAgent");
	if (Object.prototype.hasOwnProperty.call(raw, "multiAgent") && multiAgentValidation.diagnostics.length > 0) {
		process.stderr.write(`[runledger] invalid_multi_agent_settings at ${path}; multi-agent disabled\n`);
	}
	if (allowRecording) {
		const invalid = parseUiThemeSettings(raw.uiTheme).diagnostics;
		if (invalid.length > 0) process.stderr.write(`[runledger] invalid UI theme fields: ${invalid.join(", ")}\n`);
	}
	return sanitizeProjectSettings(raw, allowRecording);
}

interface InternalSettingsLayer extends LayeredSettingsLayer {
	readonly multiAgentDiagnostics: readonly MultiAgentDiagnostic[];
}

async function loadSettingsLayer(
	path: string,
	source: "user" | "workspace",
	allowRecording: boolean,
): Promise<InternalSettingsLayer> {
	let text: string;
	try {
		text = await fs.readFile(path, "utf8");
	} catch {
		return makeSettingsLayer(path, source, {}, allowRecording, false, []);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		const diagnostics: MultiAgentDiagnostic[] = [{
			code: "invalid_policy",
			path: `${source}.settings`,
			message: "settings JSON is invalid; multi-agent capability is unavailable",
		}];
		return makeSettingsLayer(path, source, {}, allowRecording, true, diagnostics);
	}
	if (!isPlainRecord(parsed)) {
		const diagnostics: MultiAgentDiagnostic[] = [{
			code: "invalid_policy",
			path: `${source}.settings`,
			message: "settings root must be an object; multi-agent capability is unavailable",
		}];
		return makeSettingsLayer(path, source, {}, allowRecording, true, diagnostics);
	}

	const hasMultiAgent = Object.prototype.hasOwnProperty.call(parsed, "multiAgent");
	const validation = validateMultiAgentSettingsSource(parsed.multiAgent, `${source}.multiAgent`);
	return makeSettingsLayer(path, source, parsed, allowRecording, hasMultiAgent, validation.diagnostics);
}

function makeSettingsLayer(
	path: string,
	source: "user" | "workspace",
	raw: Record<string, unknown>,
	allowRecording: boolean,
	present: boolean,
	diagnostics: readonly MultiAgentDiagnostic[],
): InternalSettingsLayer {
	const validation = validateMultiAgentSettingsSource(raw.multiAgent, `${source}.multiAgent`);
	const state = !present ? "absent" : diagnostics.length === 0 && validation.value !== undefined ? "valid" : "invalid";
	const multiAgent: LayeredMultiAgentSettings = Object.freeze({
		state,
		...(present ? { raw: raw.multiAgent } : {}),
		...(state === "valid" && validation.value !== undefined ? { value: validation.value } : {}),
		sourceDigest: runtimeDigest(present ? raw.multiAgent : null),
	});
	return {
		source,
		path,
		settings: sanitizeProjectSettings(raw, allowRecording),
		multiAgent,
		sourceDigest: runtimeDigest(raw),
		multiAgentDiagnostics: Object.freeze([...diagnostics]),
	};
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertSupportedSettings(
	options: SettingsStoreOptions,
	path: string,
	settings: ProjectSettingsInput,
): void {
	if (Object.prototype.hasOwnProperty.call(settings, "sessionDir")) {
		throw new SettingsStorageError("unsupported_setting", path, "sessionDir");
	}
	if (options.workspaceKey !== undefined && Object.prototype.hasOwnProperty.call(settings, "recording")) {
		throw new SettingsStorageError("unsupported_setting", path, "recording");
	}
	if (
		options.workspaceKey === undefined &&
		Object.prototype.hasOwnProperty.call(settings, "recording") &&
		sanitizeRecordingSettings(settings.recording) === undefined
	) {
		throw new SettingsStorageError("unsupported_setting", path, "recording");
	}
	if (Object.prototype.hasOwnProperty.call(settings, "multiAgent")) {
		const validation = validateMultiAgentSettingsSource(settings.multiAgent, "multiAgent");
		if (validation.diagnostics.length > 0 || validation.value === undefined) {
			throw new SettingsStorageError("invalid_multi_agent_settings", path, "multiAgent");
		}
	}
}

/** 把裸 JSON 对象清洗成 canonical ProjectSettings，丢弃 legacy/未知字段。 */
function sanitizeProjectSettings(raw: Record<string, unknown>, allowRecording = true): ProjectSettings {
	if (Object.hasOwn(raw, "agentMode") && (!allowRecording || !isAgentMode(raw.agentMode))) {
		throw new Error("agentMode must be default|minimal|plan in user settings");
	}
	const out: ProjectSettings = {};
	if (Object.hasOwn(raw, "compaction")) {
		if (!allowRecording) throw new Error("compaction is only allowed in user settings");
		out.compaction = parseCompactionSettings(raw.compaction);
	}
	if (isAgentMode(raw.agentMode)) out.agentMode = raw.agentMode;
	if (typeof raw.autoTitle === "boolean") out.autoTitle = raw.autoTitle;
	const recap = sanitizeRecapSettings(raw.recap);
	if (recap !== undefined) out.recap = recap;
	const goal = sanitizeGoalSettings(raw.goal);
	if (goal !== undefined) out.goal = goal;
	const loop = sanitizeLoopSettings(raw.loop);
	if (loop !== undefined) out.loop = loop;
	if (typeof raw.provider === "string" && raw.provider.length > 0) out.provider = raw.provider;
	if (typeof raw.model === "string" && raw.model.length > 0) out.model = raw.model;
	if (isThinkingLevel(raw.thinkingLevel)) out.thinkingLevel = raw.thinkingLevel;
	if (typeof raw.hideThinkingBlock === "boolean") out.hideThinkingBlock = raw.hideThinkingBlock;
	if (typeof raw.logo === "string") {
		const logo = raw.logo.trim();
		if (LOGO_LETTERS_PATTERN.test(logo)) out.logo = logo.toLowerCase();
	}
	if (isSyntaxThemeName(raw.theme)) out.theme = raw.theme;
	if (allowRecording) {
		const parsed = parseUiThemeSettings(raw.uiTheme);
		if (parsed.value !== undefined) out.uiTheme = parsed.value;
	}
	if (Array.isArray(raw.enabledModels)) {
		const filtered = raw.enabledModels.filter(
			(value): value is string => typeof value === "string" && value.length > 0,
		);
		if (filtered.length > 0) out.enabledModels = filtered;
	}
	if (raw.steeringMode === "one-at-a-time" || raw.steeringMode === "all") {
		out.steeringMode = raw.steeringMode;
	}
	if (raw.followUpMode === "one-at-a-time" || raw.followUpMode === "all") {
		out.followUpMode = raw.followUpMode;
	}
	if (allowRecording) {
		const recording = sanitizeRecordingSettings(raw.recording);
		if (recording) out.recording = recording;
		else if (Object.prototype.hasOwnProperty.call(raw, "recording")) out.recording = { mode: "off", failurePolicy: "best_effort" };
	}
	const multiAgent = sanitizeMultiAgentSettings(raw.multiAgent);
	if (multiAgent !== undefined) out.multiAgent = multiAgent;
	const skills = sanitizeSkillsSettings(raw.skills);
	if (skills !== undefined) out.skills = skills;
	const plugins = sanitizePluginSettings(raw.plugins);
	if (plugins !== undefined) out.plugins = plugins;
	// marketplace 自动更新模式：`auto` 会刷新 catalog，属 user 层 authority
	// （与 recording/compaction 同一处理），workspace settings 不得改写。
	if (allowRecording) {
		const marketplace = sanitizeMarketplaceSettings(raw.marketplace);
		if (marketplace !== undefined) out.marketplace = marketplace;
	}
	return out;
}

function sanitizeMarketplaceSettings(value: unknown): MarketplaceSettings | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	if (!Object.hasOwn(value, "autoUpdate")) return undefined;
	const mode = (value as Record<string, unknown>).autoUpdate;
	if (mode !== "off" && mode !== "notify" && mode !== "auto") {
		throw new Error("marketplace.autoUpdate must be off|notify|auto");
	}
	return Object.freeze({ autoUpdate: mode });
}

function sanitizeRecapSettings(value: unknown): RecapSettings | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	const out: { enabled?: boolean; idleSeconds?: number } = {};
	if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
	if (typeof raw.idleSeconds === "number" && Number.isFinite(raw.idleSeconds)) {
		out.idleSeconds = raw.idleSeconds;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/** 未知字段即整段丢弃：goal settings 不接受未声明键，避免拼错键静默生效。 */
function sanitizeGoalSettings(value: unknown): GoalSettings | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	const allowed = ["enabled", "autoContinuation", "continuationDelaySeconds", "maxContinuations"];
	if (Object.keys(raw).some((key) => !allowed.includes(key))) return undefined;
	const out: { enabled?: boolean; autoContinuation?: boolean; continuationDelaySeconds?: number; maxContinuations?: number } = {};
	if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
	if (typeof raw.autoContinuation === "boolean") out.autoContinuation = raw.autoContinuation;
	if (typeof raw.continuationDelaySeconds === "number" && Number.isFinite(raw.continuationDelaySeconds)) {
		out.continuationDelaySeconds = raw.continuationDelaySeconds;
	}
	if (typeof raw.maxContinuations === "number" && Number.isFinite(raw.maxContinuations)) {
		out.maxContinuations = raw.maxContinuations;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeLoopSettings(value: unknown): LoopSettings | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	const allowed = ["enabled", "maxIterations", "conditionEnabled"];
	if (Object.keys(raw).some((key) => !allowed.includes(key))) return undefined;
	const out: { enabled?: boolean; maxIterations?: number; conditionEnabled?: boolean } = {};
	if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
	if (typeof raw.maxIterations === "number" && Number.isFinite(raw.maxIterations)) out.maxIterations = raw.maxIterations;
	if (typeof raw.conditionEnabled === "boolean") out.conditionEnabled = raw.conditionEnabled;
	return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeMultiAgentSettings(value: unknown): MultiAgentSettingsSource | undefined {
	const validation = validateMultiAgentSettingsSource(value, "multiAgent");
	return validation.diagnostics.length === 0 ? validation.value : undefined;
}

const SKILLS_PROVIDER_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;

/**
 * 结构清洗 plugin settings 值层：非法条目**逐条丢弃**（不是整体丢弃），
 * 因为一个插件的坏值不应该让其它插件的合法值一起失效。
 */
function sanitizePluginSettings(value: unknown): PluginSettingsValues | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const rawValues = (value as Record<string, unknown>).values;
	const watch = typeof (value as Record<string, unknown>).watch === "boolean" ? (value as Record<string, unknown>).watch as boolean : undefined;
	if (typeof rawValues !== "object" || rawValues === null || Array.isArray(rawValues)) {
		// 只声明 watch 也是合法的 settings；此时没有值层。
		return watch === undefined ? undefined : { watch };
	}
	const values: Record<string, Record<string, string | number | boolean>> = {};
	for (const [packageId, entry] of Object.entries(rawValues as Record<string, unknown>)) {
		if (packageId.length === 0 || packageId.length > 128) continue;
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
		const settings: Record<string, string | number | boolean> = {};
		for (const [key, item] of Object.entries(entry as Record<string, unknown>)) {
			if (key.length === 0 || key.length > 64) continue;
			if (typeof item === "string" || typeof item === "boolean") settings[key] = item;
			else if (typeof item === "number" && Number.isFinite(item)) settings[key] = item;
		}
		if (Object.keys(settings).length > 0) values[packageId] = Object.freeze(settings);
	}
	if (Object.keys(values).length === 0) return watch === undefined ? undefined : { watch };
	return { values: Object.freeze(values), ...(watch === undefined ? {} : { watch }) };
}

/** 结构清洗 skills policy；非法结构整体丢弃（不拒绝整个 settings 文件）。 */
function sanitizeSkillsSettings(value: unknown): SkillsSettings | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	const out: { enabled?: boolean; providers?: Record<string, boolean> } = {};
	if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
	if (raw.providers !== undefined) {
		if (typeof raw.providers !== "object" || raw.providers === null || Array.isArray(raw.providers)) return undefined;
		const entries = Object.entries(raw.providers as Record<string, unknown>);
		if (entries.length > 32) return undefined;
		const providers: Record<string, boolean> = {};
		for (const [id, enabled] of entries) {
			if (!SKILLS_PROVIDER_KEY_PATTERN.test(id) || typeof enabled !== "boolean") return undefined;
			providers[id] = enabled;
		}
		out.providers = providers;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function isSyntaxThemeName(value: unknown): value is string {
	return typeof value === "string" && !value.includes("..") && SYNTAX_THEME_NAME_PATTERN.test(value);
}

/** 将缺失或非法配置解析为安全且不可变的启动快照。 */
export function resolveRecordingConfig(settings: { readonly recording?: unknown }): EffectiveRecordingConfig {
	if (!Object.prototype.hasOwnProperty.call(settings, "recording")) return DEFAULT_RECORDING_CONFIG;
	return Object.freeze(sanitizeRecordingSettings(settings.recording) ?? { mode: "off", failurePolicy: "best_effort" });
}

export function recordingConfigDigest(config: EffectiveRecordingConfig): string {
	return canonicalDigest({ mode: config.mode, failurePolicy: config.failurePolicy });
}

function sanitizeRecordingSettings(value: unknown): RecordingSettings | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	if (Object.keys(raw).some((key) => key !== "mode" && key !== "failurePolicy")) return undefined;
	const mode = raw.mode === undefined ? DEFAULT_RECORDING_CONFIG.mode : raw.mode;
	const failurePolicy = raw.failurePolicy === undefined ? DEFAULT_RECORDING_CONFIG.failurePolicy : raw.failurePolicy;
	if (!isRecordingMode(mode) || !isRecordingFailurePolicy(failurePolicy)) return undefined;
	return { mode, failurePolicy };
}

function isRecordingMode(value: unknown): value is RecordingMode {
	return value === "off" || value === "events" || value === "events_and_artifacts";
}

function isRecordingFailurePolicy(value: unknown): value is RecordingFailurePolicy {
	return value === "best_effort" || value === "fail_closed";
}

const THINKING_LEVELS: ReadonlySet<string> = new Set<ModelThinkingLevel>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

function isThinkingLevel(value: unknown): value is ModelThinkingLevel {
	return typeof value === "string" && THINKING_LEVELS.has(value);
}
