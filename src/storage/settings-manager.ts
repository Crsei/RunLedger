/**
 * 用户级 Settings 加载/落盘。
 *
 * 所有持久化路径都来自 composition root 注入的 RunledgerLayout。cwd、旧项目
 * settings 与任意 sessionDir 不再参与 canonical settings authority。
 */

import { existsSync, readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
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
import {
	normalizeDisplaySettings,
	normalizeGitSettings,
	normalizeCompactionSettings,
	normalizeMemorySettings,
	normalizePlanSettings,
	normalizeProviderSettings,
	normalizeRetrySettings,
	normalizeStartupSettings,
	normalizeTaskSettings,
	normalizeToolsSettings,
	normalizeWorkspaceSettings,
	normalizeSettingValue,
	type CompactionSettings,
	type DisplaySettings,
	type GitSettings,
	type MemorySettings,
	type PlanSettings,
	type ProviderSettings,
	type RetrySettings,
	type SettingScope,
	type StartupSettings,
	type TaskSettings,
	type ToolsSettings,
	type WorkspaceSettings,
} from "./settings-schema.ts";

const SETTINGS_WRITE_OPTS = { encoding: "utf8", mode: 0o600 } as const;
const SETTINGS_MKDIR_OPTS = { recursive: true, mode: 0o700 } as const;
const SETTINGS_LOCK_OPTS = {
	retries: { retries: 50, factor: 1.25, minTimeout: 10, maxTimeout: 100 },
	stale: 30_000,
	realpath: false,
} as const;
const WORKSPACE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u;
const COMPOSER_SHAPE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,63}$/u;
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

export interface LoadedProjectSettingsDocument {
	/** Safe canonical projection consumed by ordinary settings readers. */
	readonly settings: ProjectSettings;
	/** Parsed source retained only for schema diagnostics/effective resolution. */
	readonly source: Readonly<Record<string, unknown>>;
}

/** 用户级或 workspace 级 settings schema。sessionDir 不属于 canonical schema。 */
export interface ProjectSettings {
	/** 是否允许首个合格用户输入触发异步 Session 自动标题；缺省开启。 */
	autoTitle?: boolean;
	/** 空闲 recap 的用户级开关与延迟；运行时会解析为完整有效快照。 */
	recap?: RecapSettings;
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
	/** 启动时选择 TUI 状态符号族；运行中不热切换。 */
	symbolPreset?: "unicode" | "nerd" | "ascii";
	/** 启动时启用色盲友好语义色；不改变中性色或运行时语义。 */
	colorBlindMode?: boolean;
	statusLine?: DisplaySettings["statusLine"];
	display?: DisplaySettings["display"];
	tui?: DisplaySettings["tui"];
	/** 启动策略；CLI/session override 由 composition root 另行覆盖。 */
	autoResume?: boolean;
	startup?: StartupSettings["startup"];
	/** 用户级受治理 shell executable；路径不存在/不可执行时启动 fail closed。 */
	shellPath?: string;
	/** /model 选择器可见模型白名单;空数组或 undefined 表示无白名单 */
	enabledModels?: string[];
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
	/** 已有 provider stream seam 使用的统一 retry policy。 */
	retry?: RetrySettings;
	/** 已有 compaction cut planner 使用的基础 policy。 */
	compaction?: CompactionSettings;
	/** 已有 Host memory domain 使用的 backend 选择。 */
	memory?: MemorySettings;
	tools?: ToolsSettings;
	disabledProviders?: readonly string[];
	providers?: ProviderSettings;
	git?: GitSettings;
	task?: TaskSettings;
	workspace?: WorkspaceSettings;
	plan?: PlanSettings;
	/** 用户级本地 trace 记录策略；workspace settings 不拥有该 authority。 */
	recording?: RecordingSettings;
	/** M1 bounded root delegation policy；workspace 层只能进一步收窄。 */
	multiAgent?: MultiAgentSettingsSource;
	/** 版本化 skills provider policy（user/workspace 均可写，workspace 只能收窄）。 */
	skills?: SkillsSettings;
	/** composer shape 只允许出现在用户级 canonical settings。 */
	composer?: ComposerSettings;
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

/** 用户级 TUI composer presentation 设置；workspace 层不拥有该 authority。 */
export interface ComposerSettings {
	readonly shape: string;
}

export type EffectiveRecordingConfig = Readonly<RecordingSettings>;

export const DEFAULT_RECORDING_CONFIG: EffectiveRecordingConfig = Object.freeze({
	mode: "off",
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
	return (await loadProjectSettingsDocument(options)).settings;
}

/** Load both the safe projection and the parsed diagnostic source in one read. */
export async function loadProjectSettingsDocument(
	options: SettingsStoreOptions,
): Promise<LoadedProjectSettingsDocument> {
	const path = getSettingsPath(options);
	let text: string;
	try {
		text = await fs.readFile(path, "utf8");
	} catch {
		return { settings: {}, source: Object.freeze({}) };
	}
	return parseSettingsDocument(text, path, options.workspaceKey === undefined, options.workspaceKey === undefined ? "user" : "workspace");
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
	return parseSettingsDocument(
		text,
		path,
		options.workspaceKey === undefined,
		options.workspaceKey === undefined ? "user" : "workspace",
	).settings;
}

/** 写入 canonical settings；sessionDir 在触及目标前被结构化拒绝。 */
export async function saveProjectSettings(
	options: SettingsStoreOptions,
	settings: ProjectSettingsInput,
): Promise<void> {
	const path = getSettingsPath(options);
	assertSupportedSettings(options, path, settings);
	await fs.mkdir(dirname(path), SETTINGS_MKDIR_OPTS);
	const release = await acquireSettingsLock(path);
	try {
		await saveProjectSettingsUnlocked(options, settings);
	} finally {
		await release();
	}
}

/**
 * 在 canonical settings 锁内完成 read-modify-write，避免 TUI presentation
 * preference 与 model/theme/runtime settings 的并发保存互相覆盖。
 */
export async function updateProjectSettings(
	options: SettingsStoreOptions,
	update: (current: ProjectSettings) => ProjectSettingsInput | Promise<ProjectSettingsInput>,
): Promise<ProjectSettings> {
	const path = getSettingsPath(options);
	await fs.mkdir(dirname(path), SETTINGS_MKDIR_OPTS);
	const release = await acquireSettingsLock(path);
	try {
		const current = await loadProjectSettings(options);
		const next = await update(current);
		assertSupportedSettings(options, path, next);
		const sanitized = sanitizeProjectSettings(
			next as Record<string, unknown>,
			options.workspaceKey === undefined,
			options.workspaceKey === undefined ? "user" : "workspace",
		);
		await saveProjectSettingsUnlocked(options, sanitized);
		return sanitized;
	} finally {
		await release();
	}
}

async function acquireSettingsLock(path: string): Promise<() => Promise<void>> {
	return lockfile.lock(path, {
		...SETTINGS_LOCK_OPTS,
		lockfilePath: `${path}.lock`,
	});
}

async function saveProjectSettingsUnlocked(
	options: SettingsStoreOptions,
	settings: ProjectSettingsInput,
): Promise<void> {
	const path = getSettingsPath(options);
	const serialized = JSON.stringify(
		sanitizeProjectSettings(
			settings as Record<string, unknown>,
			options.workspaceKey === undefined,
			options.workspaceKey === undefined ? "user" : "workspace",
		),
		null,
		2,
	) + "\n";
	const temporaryPath = `${path}.tmp-${process.pid}-${process.hrtime.bigint().toString(36)}`;
	try {
		await fs.writeFile(temporaryPath, serialized, SETTINGS_WRITE_OPTS);
		await fs.rename(temporaryPath, path);
	} catch (error) {
		await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
		throw error;
	}
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

function parseSettingsDocument(text: string, path: string, allowRecording: boolean, source: SettingScope): LoadedProjectSettingsDocument {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		process.stderr.write(
			`[runledger] settings parse failed at ${path}: ${String(error)}\n` +
				"  回退空 settings,流程继续。\n",
		);
		return { settings: {}, source: Object.freeze({}) };
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { settings: {}, source: Object.freeze({}) };
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
	return {
		settings: sanitizeProjectSettings(raw, allowRecording, source),
		source: Object.freeze({ ...raw }),
	};
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
		settings: sanitizeProjectSettings(raw, allowRecording, source),
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
function sanitizeProjectSettings(
	raw: Record<string, unknown>,
	allowRecording = true,
	source: SettingScope = "user",
): ProjectSettings {
	const out: ProjectSettings = {};
	if (typeof raw.autoTitle === "boolean") out.autoTitle = raw.autoTitle;
	const recap = sanitizeRecapSettings(raw.recap);
	if (recap !== undefined) out.recap = recap;
	if (typeof raw.provider === "string" && raw.provider.length > 0) out.provider = raw.provider;
	if (typeof raw.model === "string" && raw.model.length > 0) out.model = raw.model;
	if (isThinkingLevel(raw.thinkingLevel)) out.thinkingLevel = raw.thinkingLevel;
	if (typeof raw.hideThinkingBlock === "boolean") out.hideThinkingBlock = raw.hideThinkingBlock;
	if (typeof raw.logo === "string") {
		const logo = raw.logo.trim();
		if (LOGO_LETTERS_PATTERN.test(logo)) out.logo = logo.toLowerCase();
	}
	const theme = normalizeSettingValue("theme", raw.theme, source);
	if (Object.hasOwn(raw, "theme") && theme.ok) out.theme = theme.value as string;
	const display = normalizeDisplaySettings(raw, source);
	if (display?.symbolPreset !== undefined) out.symbolPreset = display.symbolPreset;
	if (display?.colorBlindMode !== undefined) out.colorBlindMode = display.colorBlindMode;
	if (display?.statusLine !== undefined) out.statusLine = display.statusLine;
	if (display?.display !== undefined) out.display = display.display;
	if (display?.tui !== undefined) out.tui = display.tui;
	const startup = normalizeStartupSettings(raw, source);
	if (startup?.autoResume !== undefined) out.autoResume = startup.autoResume;
	if (startup?.startup !== undefined) out.startup = startup.startup;
	const shellPath = normalizeSettingValue("shellPath", raw.shellPath, source);
	if (Object.hasOwn(raw, "shellPath") && shellPath.ok) out.shellPath = shellPath.value as string;
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
	const retry = normalizeRetrySettings(raw.retry, source);
	if (retry !== undefined) out.retry = retry;
	const compaction = normalizeCompactionSettings(raw.compaction, source);
	if (compaction !== undefined) out.compaction = compaction;
	const memory = normalizeMemorySettings(raw.memory, source);
	if (memory !== undefined) out.memory = memory;
	const tools = normalizeToolsSettings(raw.tools, source);
	if (tools !== undefined) out.tools = tools;
	const disabledProviders = normalizeSettingValue("disabledProviders", raw.disabledProviders, source);
	if (Object.hasOwn(raw, "disabledProviders") && disabledProviders.ok) out.disabledProviders = disabledProviders.value as readonly string[];
	const providers = normalizeProviderSettings(raw.providers, source);
	if (providers !== undefined) out.providers = providers;
	const git = normalizeGitSettings(raw.git, source);
	if (git !== undefined) out.git = git;
	const task = normalizeTaskSettings(raw.task, source);
	if (task !== undefined) out.task = task;
	const workspace = normalizeWorkspaceSettings(raw.workspace, source);
	if (workspace !== undefined) out.workspace = workspace;
	const plan = normalizePlanSettings(raw.plan, source);
	if (plan !== undefined) out.plan = plan;
	if (allowRecording) {
		const recording = sanitizeRecordingSettings(raw.recording);
		if (recording) out.recording = recording;
	}
	const multiAgent = sanitizeMultiAgentSettings(raw.multiAgent);
	if (multiAgent !== undefined) out.multiAgent = multiAgent;
	const skills = sanitizeSkillsSettings(raw.skills);
	if (skills !== undefined) out.skills = skills;
	if (allowRecording) {
		const composer = sanitizeComposerSettings(raw.composer);
		if (composer !== undefined) out.composer = composer;
	}
	return out;
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

function sanitizeMultiAgentSettings(value: unknown): MultiAgentSettingsSource | undefined {
	const validation = validateMultiAgentSettingsSource(value, "multiAgent");
	return validation.diagnostics.length === 0 ? validation.value : undefined;
}

const SKILLS_PROVIDER_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;

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

function sanitizeComposerSettings(value: unknown): ComposerSettings | undefined {
	if (!isPlainRecord(value)) return undefined;
	const shape = value.shape;
	if (typeof shape !== "string" || !COMPOSER_SHAPE_ID_PATTERN.test(shape)) return undefined;
	return { shape };
}

/** 将缺失或非法配置解析为安全且不可变的启动快照。 */
export function resolveRecordingConfig(settings: { readonly recording?: unknown }): EffectiveRecordingConfig {
	return Object.freeze(sanitizeRecordingSettings(settings.recording) ?? { ...DEFAULT_RECORDING_CONFIG });
}

export function recordingConfigDigest(config: EffectiveRecordingConfig): string {
	return canonicalDigest({ mode: config.mode, failurePolicy: config.failurePolicy });
}

function sanitizeRecordingSettings(value: unknown): RecordingSettings | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	if (!isRecordingMode(raw.mode) || !isRecordingFailurePolicy(raw.failurePolicy)) return undefined;
	return { mode: raw.mode, failurePolicy: raw.failurePolicy };
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
