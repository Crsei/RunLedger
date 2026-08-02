/**
 * 用户级 Settings 加载/落盘。
 *
 * 所有持久化路径都来自 composition root 注入的 RunledgerLayout。cwd、旧项目
 * `.runledger/` 与任意 sessionDir 不再参与 canonical settings authority。
 */

import { existsSync, readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import type { ModelThinkingLevel } from "../types.ts";
import type { QueueMode } from "../runtime/types.ts";
import type { RunledgerLayout } from "../runtime/contracts/public.ts";

const SETTINGS_WRITE_OPTS = { encoding: "utf8", mode: 0o600 } as const;
const SETTINGS_MKDIR_OPTS = { recursive: true, mode: 0o700 } as const;
const WORKSPACE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u;

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
	/** 主题名,TUI 已用 dark/light 二选一 */
	theme?: "dark" | "light";
	/** /model 选择器可见模型白名单;空数组或 undefined 表示无白名单 */
	enabledModels?: string[];
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
}

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
	return parseSettings(text, path);
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
	return parseSettings(text, path);
}

/** 写入 canonical settings；sessionDir 在触及目标前被结构化拒绝。 */
export async function saveProjectSettings(
	options: SettingsStoreOptions,
	settings: ProjectSettingsInput,
): Promise<void> {
	const path = getSettingsPath(options);
	assertSupportedSettings(path, settings);
	await fs.mkdir(dirname(path), SETTINGS_MKDIR_OPTS);
	await fs.writeFile(
		path,
		JSON.stringify(sanitizeProjectSettings(settings as Record<string, unknown>), null, 2) + "\n",
		SETTINGS_WRITE_OPTS,
	);
}

function parseSettings(text: string, path: string): ProjectSettings {
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
	return sanitizeProjectSettings(parsed as Record<string, unknown>);
}

function assertSupportedSettings(path: string, settings: ProjectSettingsInput): void {
	if (Object.prototype.hasOwnProperty.call(settings, "sessionDir")) {
		throw new SettingsStorageError("unsupported_setting", path, "sessionDir");
	}
}

/** 把裸 JSON 对象清洗成 canonical ProjectSettings，丢弃 legacy/未知字段。 */
function sanitizeProjectSettings(raw: Record<string, unknown>): ProjectSettings {
	const out: ProjectSettings = {};
	if (typeof raw.provider === "string" && raw.provider.length > 0) out.provider = raw.provider;
	if (typeof raw.model === "string" && raw.model.length > 0) out.model = raw.model;
	if (isThinkingLevel(raw.thinkingLevel)) out.thinkingLevel = raw.thinkingLevel;
	if (raw.theme === "dark" || raw.theme === "light") out.theme = raw.theme;
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
	return out;
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
