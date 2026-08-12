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
import { canonicalDigest } from "../runtime/protocol/canonical-json.ts";

const SETTINGS_WRITE_OPTS = { encoding: "utf8", mode: 0o600 } as const;
const SETTINGS_MKDIR_OPTS = { recursive: true, mode: 0o700 } as const;
const WORKSPACE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u;
const SYNTAX_THEME_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

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
	/** 默认 provider ID,与 model 共同组成稳定模型身份。 */
	provider?: string;
	/** 默认模型 ID;CLI `--model` 优先级高于此字段 */
	model?: string;
	/** 默认 thinking level;CLI `--thinking` 优先级高于此字段 */
	thinkingLevel?: ModelThinkingLevel;
	/** syntax theme 名；dark/light 是兼容输入，分别映射为自适应 pair。 */
	theme?: string;
	/** /model 选择器可见模型白名单;空数组或 undefined 表示无白名单 */
	enabledModels?: string[];
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
	/** 用户级本地 trace 记录策略；workspace settings 不拥有该 authority。 */
	recording?: RecordingSettings;
}

export type RecordingMode = "off" | "events" | "events_and_artifacts";

export type RecordingFailurePolicy = "best_effort" | "fail_closed";

export interface RecordingSettings {
	readonly mode: RecordingMode;
	readonly failurePolicy: RecordingFailurePolicy;
}

export type EffectiveRecordingConfig = Readonly<RecordingSettings>;

export const DEFAULT_RECORDING_CONFIG: EffectiveRecordingConfig = Object.freeze({
	mode: "off",
	failurePolicy: "best_effort",
});

/** 用于边界检查的输入类型；sessionDir 只能被识别为拒绝字段，不能被持久化。 */
export type ProjectSettingsInput = ProjectSettings & { readonly sessionDir?: unknown };

export type SettingsStorageErrorCode = "unsupported_setting" | "invalid_workspace_key";

export class SettingsStorageError extends Error {
	readonly code: SettingsStorageErrorCode;
	readonly field?: string;
	readonly path: string;

	constructor(code: SettingsStorageErrorCode, path: string, field?: string) {
		super(
			code === "unsupported_setting"
				? `unsupported settings field${field ? `: ${field}` : ""}`
				: "invalid workspace storage key",
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

function parseSettings(text: string, path: string, allowRecording: boolean): ProjectSettings {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		process.stderr.write(
			`[runledger] settings parse failed at ${path}: ${String(error)}\n` +
				"  回退空 settings,流程继续。\n",
		);
		return {};
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
	const raw = parsed as Record<string, unknown>;
	if (
		allowRecording &&
		Object.prototype.hasOwnProperty.call(raw, "recording") &&
		sanitizeRecordingSettings(raw.recording) === undefined
	) {
		process.stderr.write(`[runledger] invalid_recording_settings at ${path}; recording disabled\n`);
	}
	return sanitizeProjectSettings(raw, allowRecording);
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
}

/** 把裸 JSON 对象清洗成 canonical ProjectSettings，丢弃 legacy/未知字段。 */
function sanitizeProjectSettings(raw: Record<string, unknown>, allowRecording = true): ProjectSettings {
	const out: ProjectSettings = {};
	if (typeof raw.provider === "string" && raw.provider.length > 0) out.provider = raw.provider;
	if (typeof raw.model === "string" && raw.model.length > 0) out.model = raw.model;
	if (isThinkingLevel(raw.thinkingLevel)) out.thinkingLevel = raw.thinkingLevel;
	if (isSyntaxThemeName(raw.theme)) out.theme = raw.theme;
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
	}
	return out;
}

function isSyntaxThemeName(value: unknown): value is string {
	return typeof value === "string" && !value.includes("..") && SYNTAX_THEME_NAME_PATTERN.test(value);
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
