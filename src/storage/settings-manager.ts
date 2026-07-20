/**
 * 项目层 Settings 加载/落盘 —— 对照 pi `core/settings-manager.ts` 极简版。
 *
 * 本期范围:
 *   - 仅项目层 `<cwd>/.runledger/settings.json`
 *   - 不做用户层 settings 合并(对照 pi,pi 把 ~/.pi/agent/settings.json 与项目合并;
 *     RunLedger 本期暂只项目级,作 `// TODO(pi): 用户层合并` 留位)
 *   - 不做 trust-manager(`AGENTS.md §1.3` 显式不实现),
 *     settings.json 与 cwd 起点的 AGENTS.md 全部默认信任
 *   - schema 字段最小集:model / thinkingLevel / theme / sessionDir / enabledModels
 *
 * 写入采用 0o600 + mkdir 0o700(对照 auth-storage 同款),避免被同机组用户偷看。
 */

import { existsSync, readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import type { ThinkingLevel } from "../types.ts";
import { getProjectSettingsPath } from "./paths.ts";

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
  /** 默认模型 ID;CLI `--model` 优先级高于此字段 */
  model?: string;
  /** 默认 thinking level;CLI `--thinking` 优先级高于此字段 */
  thinkingLevel?: ThinkingLevel;
  /** 主题名,TUI 已用 dark/light 二选一 */
  theme?: "dark" | "light";
  /**
   * Session 落盘目录。相对路径以 cwd 解析,绝对路径原样使用,`.` = cwd 本身。
   * 留空 / undefined = 默认项目内 `.runledger/sessions/`。
   */
  sessionDir?: string;
  /** /model 选择器可见模型白名单;空数组或 undefined 表示无白名单(显示全部 known) */
  enabledModels?: string[];
}

/** 空白 settings;loadProjectSettings 缺文件时返回此值 */
export const EMPTY_PROJECT_SETTINGS: ProjectSettings = {};

/**
 * 加载项目层 settings;文件不存在或解析失败时返回空对象。
 *
 * 解析失败不抛错,记到 stderr(`// TODO(pi): lastError 字段返回`),
 * 让运行时流程不因 settings 损坏而阻断。
 */
export async function loadProjectSettings(
  cwd: string = process.cwd(),
): Promise<ProjectSettings> {
  const path = getProjectSettingsPath(cwd);
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

/**
 * 同步加载版,用于 CLI 启动早期需要 settings 但还不想 await 的场景。
 * 仅在 `existsSync` 命中时读文件,与 loadProjectSettings 在解析失败行为一致。
 */
export function loadProjectSettingsSync(
  cwd: string = process.cwd(),
): ProjectSettings {
  const path = getProjectSettingsPath(cwd);
  if (!existsSync(path)) return {};
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return sanitizeProjectSettings(parsed as Record<string, unknown>);
  } catch {
    return {};
  }
}

/**
 * 写入项目层 settings;采用全文件覆盖,不深合并已有内容。
 * 调用方负责先 loadProjectSettings 再 spread 后传入。
 */
export async function saveProjectSettings(
  cwd: string,
  settings: ProjectSettings,
): Promise<void> {
  const path = getProjectSettingsPath(cwd);
  await fs.mkdir(dirname(path), SETTINGS_MKDIR_OPTS);
  await fs.writeFile(
    path,
    JSON.stringify(settings, null, 2) + "\n",
    SETTINGS_WRITE_OPTS,
  );
}

/**
 * 把裸 JSON 对象清洗成 ProjectSettings:
 * 仅保留已知键,丢弃未知键,字段类型不符直接忽略。
 */
function sanitizeProjectSettings(raw: Record<string, unknown>): ProjectSettings {
  const out: ProjectSettings = {};
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
  return out;
}

const THINKING_LEVELS: ReadonlySet<string> = new Set<ThinkingLevel>([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

function isThinkingLevel(v: unknown): v is ThinkingLevel {
  return typeof v === "string" && THINKING_LEVELS.has(v);
}
