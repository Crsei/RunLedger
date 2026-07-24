/**
 * 项目层 Settings 加载/落盘 —— 对照 pi `core/settings-manager.ts` 极简版。
 *
 * 本期范围:
 *   - 用户层 `~/.runledger/agent/settings.json` 与项目层 `<cwd>/.runledger/settings.json`
 *   - 项目字段覆盖用户字段；runtimeFeatures 逐字段合并
 *   - 不做 trust-manager(`AGENTS.md §1.3` 显式不实现),
 *     settings.json 与 cwd 起点的 AGENTS.md 全部默认信任
 *   - schema 字段最小集:model / thinkingLevel / theme / sessionDir / enabledModels
 *
 * 写入采用 0o600 + mkdir 0o700(对照 auth-storage 同款),避免被同机组用户偷看。
 */

import { existsSync, readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import type { ModelThinkingLevel } from "../types.ts";
import type { QueueMode } from "../runtime/types.ts";
import {
  RUNTIME_FEATURE_NAMES,
  isSessionV3FeatureState,
  type RuntimeFeatureFlags,
  type SessionV3FeatureState,
} from "../runtime/runtime-features.ts";
import { getProjectSettingsPath, getUserSettingsPath } from "./paths.ts";

const SETTINGS_WRITE_OPTS = { encoding: "utf8", mode: 0o600 } as const;
const SETTINGS_MKDIR_OPTS = { recursive: true, mode: 0o700 } as const;

/**
 * 项目级 settings schema。所有字段可选,缺失字段在加载时保持 undefined。
 *
 * 对照 pi `Settings` 接口中本 RunLedger 会消费的字段。
 * 未实现的字段(如 compaction / retry / terminal / markdown / packages 等)
 * 一律不在此 schema 中,需在引入对应功能时一并通过补字段。
 */
export interface ProjectSettings {
  /** 默认 provider ID,与 model 共同组成稳定模型身份。 */
  provider?: string;
  /** 默认模型 ID;CLI `--model` 优先级高于此字段 */
  model?: string;
  /** 默认 thinking level;CLI `--thinking` 优先级高于此字段 */
  thinkingLevel?: ModelThinkingLevel;
  /** 主题名,TUI 已用 dark/light 二选一 */
  theme?: "dark" | "light";
  /**
   * Session 落盘目录。相对路径以 cwd 解析,绝对路径原样使用,`.` = cwd 本身。
   * 留空 / undefined = 默认项目内 `.runledger/sessions/`。
   */
  sessionDir?: string;
  /** /model 选择器可见模型白名单;空数组或 undefined 表示无白名单(显示全部 known) */
  enabledModels?: string[];
  steeringMode?: QueueMode;
  followUpMode?: QueueMode;
  /** Runtime rollout 请求值；composition root 仍必须校验依赖与可用性，不能据此绕过安全门。 */
  runtimeFeatures?: Partial<RuntimeFeatureFlags>;
  /** Session format rollout 的当前状态；存在时优先于旧 runtimeFeatures.sessionV3 boolean。 */
  sessionV3FeatureState?: SessionV3FeatureState;
  /** 曾经启用过的最高状态；CLI 只允许单调提高，用于紧急回滚的只读屏障。 */
  sessionV3HighestActivatedState?: SessionV3FeatureState;
  /** Extension 的用户上限与项目收窄项；资源声明仍位于独立配置文件。 */
  extensions?: ExtensionSettings;
}

export type CompatibilitySkillSource = "agents" | "claude" | "grok";

export interface ExtensionSettings {
  watch?: boolean;
  compatibilitySkillSources?: CompatibilitySkillSource[];
  activationProfile?: "metadata-only" | "execute-enabled";
}

/** 空白 settings;loadProjectSettings 缺文件时返回此值 */
export const EMPTY_PROJECT_SETTINGS: ProjectSettings = {};

/** 用户层与项目层使用相同的有界 schema；资源声明继续存放于独立扩展配置。 */
export type UserSettings = ProjectSettings;

async function loadSettingsPath(path: string): Promise<ProjectSettings> {
  let text: string;
  try {
    text = await fs.readFile(path, "utf8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    process.stderr.write(
      `[runledger] settings parse failed at ${path}: ${String(e)}\n` +
        `  回退空 settings,流程继续。\n`,
    );
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  return sanitizeProjectSettings(parsed as Record<string, unknown>);
}

function loadSettingsPathSync(path: string): ProjectSettings {
  if (!existsSync(path)) return {};
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return sanitizeProjectSettings(parsed as Record<string, unknown>);
  } catch {
    return {};
  }
}

async function saveSettingsPath(path: string, settings: ProjectSettings): Promise<void> {
  await fs.mkdir(dirname(path), SETTINGS_MKDIR_OPTS);
  await fs.writeFile(
    path,
    JSON.stringify(settings, null, 2) + "\n",
    SETTINGS_WRITE_OPTS,
  );
}

/**
 * 加载项目层 settings;文件不存在或解析失败时返回空对象。
 *
 * 解析失败不抛错,记到 stderr(`// TODO(pi): lastError 字段返回`),
 * 让运行时流程不因 settings 损坏而阻断。
 */
export async function loadProjectSettings(
  cwd: string = process.cwd(),
): Promise<ProjectSettings> {
  return loadSettingsPath(getProjectSettingsPath(cwd));
}

/**
 * 同步加载版,用于 CLI 启动早期需要 settings 但还不想 await 的场景。
 * 仅在 `existsSync` 命中时读文件,与 loadProjectSettings 在解析失败行为一致。
 */
export function loadProjectSettingsSync(
  cwd: string = process.cwd(),
): ProjectSettings {
  return loadSettingsPathSync(getProjectSettingsPath(cwd));
}

/** 加载用户层 settings；缺失或损坏时与项目层一样 fail-soft 为空对象。 */
export async function loadUserSettings(): Promise<UserSettings> {
  return loadSettingsPath(getUserSettingsPath());
}

/** 用户层 settings 的同步加载版。 */
export function loadUserSettingsSync(): UserSettings {
  return loadSettingsPathSync(getUserSettingsPath());
}

/**
 * 明确执行 user -> project 合并。primitive/array 由项目层覆盖，
 * runtimeFeatures 保留用户默认并只覆盖项目显式声明的 feature。
 */
export function mergeUserAndProjectSettings(
  userSettings: UserSettings,
  projectSettings: ProjectSettings,
): ProjectSettings {
  const merged: ProjectSettings = { ...userSettings, ...projectSettings };
  if (userSettings.runtimeFeatures || projectSettings.runtimeFeatures) {
    merged.runtimeFeatures = {
      ...userSettings.runtimeFeatures,
      ...projectSettings.runtimeFeatures,
    };
  }
  if (userSettings.extensions || projectSettings.extensions) {
    const user = userSettings.extensions ?? {};
    const project = projectSettings.extensions ?? {};
    const userSources = new Set(user.compatibilitySkillSources ?? []);
    const projectSources = project.compatibilitySkillSources;
    const compatibilitySkillSources = projectSources
      ? projectSources.filter((source) => userSources.has(source))
      : [...userSources];
    const userProfile = user.activationProfile ?? "metadata-only";
    const projectProfile = project.activationProfile ?? userProfile;
    const activationProfile =
      userProfile === "execute-enabled" && projectProfile === "execute-enabled"
        ? "execute-enabled"
        : "metadata-only";
    merged.extensions = {
      watch: (user.watch ?? false) && (project.watch ?? true),
      compatibilitySkillSources,
      activationProfile,
    };
  }
  return merged;
}

/** 一次加载并合并用户默认与项目覆盖。 */
export async function loadMergedSettings(
  cwd: string = process.cwd(),
): Promise<ProjectSettings> {
  const [userSettings, projectSettings] = await Promise.all([
    loadUserSettings(),
    loadProjectSettings(cwd),
  ]);
  return mergeUserAndProjectSettings(userSettings, projectSettings);
}

/** 同步加载并合并用户默认与项目覆盖。 */
export function loadMergedSettingsSync(
  cwd: string = process.cwd(),
): ProjectSettings {
  return mergeUserAndProjectSettings(
    loadUserSettingsSync(),
    loadProjectSettingsSync(cwd),
  );
}

/**
 * 写入项目层 settings;采用全文件覆盖,不深合并已有内容。
 * 调用方负责先 loadProjectSettings 再 spread 后传入。
 */
export async function saveProjectSettings(
  cwd: string,
  settings: ProjectSettings,
): Promise<void> {
  await saveSettingsPath(getProjectSettingsPath(cwd), settings);
}

/** 写入用户层 settings；文件与父目录权限分别固定为 0600/0700。 */
export async function saveUserSettings(settings: UserSettings): Promise<void> {
  await saveSettingsPath(getUserSettingsPath(), settings);
}

/**
 * 把裸 JSON 对象清洗成 ProjectSettings:
 * 仅保留已知键,丢弃未知键,字段类型不符直接忽略。
 */
function sanitizeProjectSettings(raw: Record<string, unknown>): ProjectSettings {
  const out: ProjectSettings = {};
  if (typeof raw.provider === "string" && raw.provider.length > 0) {
    out.provider = raw.provider;
  }
  if (typeof raw.model === "string" && raw.model.length > 0) {
    out.model = raw.model;
  }
  if (isThinkingLevel(raw.thinkingLevel)) {
    out.thinkingLevel = raw.thinkingLevel;
  }
  if (raw.theme === "dark" || raw.theme === "light") {
    out.theme = raw.theme;
  }
  if (typeof raw.sessionDir === "string" && raw.sessionDir.length > 0) {
    out.sessionDir = raw.sessionDir;
  }
  if (Array.isArray(raw.enabledModels)) {
    const filtered = raw.enabledModels.filter(
      (s): s is string => typeof s === "string" && s.length > 0,
    );
    if (filtered.length > 0) out.enabledModels = filtered;
  }
  if (raw.steeringMode === "one-at-a-time" || raw.steeringMode === "all") {
    out.steeringMode = raw.steeringMode;
  }
  if (raw.followUpMode === "one-at-a-time" || raw.followUpMode === "all") {
    out.followUpMode = raw.followUpMode;
  }
  if (raw.runtimeFeatures !== null && typeof raw.runtimeFeatures === "object" && !Array.isArray(raw.runtimeFeatures)) {
    const requested = raw.runtimeFeatures as Record<string, unknown>;
    const runtimeFeatures: Partial<RuntimeFeatureFlags> = {};
    for (const feature of RUNTIME_FEATURE_NAMES) {
      if (typeof requested[feature] === "boolean") runtimeFeatures[feature] = requested[feature];
    }
    if (Object.keys(runtimeFeatures).length > 0) out.runtimeFeatures = runtimeFeatures;
  }
  if (isSessionV3FeatureState(raw.sessionV3FeatureState)) {
    out.sessionV3FeatureState = raw.sessionV3FeatureState;
  }
  if (isSessionV3FeatureState(raw.sessionV3HighestActivatedState)) {
    out.sessionV3HighestActivatedState = raw.sessionV3HighestActivatedState;
  }
  if (raw.extensions !== null && typeof raw.extensions === "object" && !Array.isArray(raw.extensions)) {
    const requested = raw.extensions as Record<string, unknown>;
    const extensions: ExtensionSettings = {};
    if (typeof requested.watch === "boolean") extensions.watch = requested.watch;
    if (requested.activationProfile === "metadata-only" || requested.activationProfile === "execute-enabled") {
      extensions.activationProfile = requested.activationProfile;
    }
    if (Array.isArray(requested.compatibilitySkillSources)) {
      const sources = requested.compatibilitySkillSources.filter(
        (source): source is CompatibilitySkillSource =>
          source === "agents" || source === "claude" || source === "grok",
      );
      extensions.compatibilitySkillSources = [...new Set(sources)].sort();
    }
    if (Object.keys(extensions).length > 0) out.extensions = extensions;
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

function isThinkingLevel(v: unknown): v is ModelThinkingLevel {
  return typeof v === "string" && THINKING_LEVELS.has(v);
}
