/**
 * RunLedger 路径解析 —— 对应 pi 的 `coding-agent/config.ts` 中 `getAgentDir` 与项目层布局。
 *
 * 两层布局:
 *   - 用户层:`~/.runledger/agent/`(可用 `RUNLEDGER_DIR` 覆盖)
 *     含 `auth.json` / `bin/` / `sessions/` / 可选全局 `AGENTS.md`
 *     sessions 子目录按 cwd 编码(`session/--<encoded-cwd>--/`)
 *   - 项目层:`<cwd>/.runledger/`(默认)
 *     含 `settings.json` / `sessions/`(本期默认 sessionDir)
 *
 * 当用户在 `<cwd>/.runledger/settings.json` 设 `sessionDir` 时覆盖默认项目内路径,
 * env `RUNLEDGER_SESSION_DIR` 单独再覆盖,优先级最高(对照 pi `PI_CODING_AGENT_SESSION_DIR`)。
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { encodeCwd } from "./path-utils.ts";

const ENV_AGENT_DIR = "RUNLEDGER_DIR";
const ENV_SESSION_DIR = "RUNLEDGER_SESSION_DIR";
const CONFIG_DIR_NAME = ".runledger";
const PROJECT_DIR_NAME = ".runledger";
const PROJECT_SESSIONS_SUBDIR = "sessions";
const PROJECT_SETTINGS_FILE = "settings.json";
const EXTENSIONS_STATE_FILE = "extensions-state.json";
const TRUST_STORE_FILE = "trust.json";
const PLUGIN_DATA_SUBDIR = "plugin-data";
const EXTENSION_SPILL_SUBDIR = "extension-spill";
const AGENTS_MD = "AGENTS.md";

/** 展开 `~/...` 至用户 home 目录;其它路径原样返回。简单等价于 pi 的 normalizePath 子集。 */
export function normalizePath(input: string): string {
	if (input.startsWith("~")) {
		return join(homedir(), input.slice(1));
	}
	return input;
}

function expandTildePath(path: string): string {
	return path.startsWith("~") ? join(homedir(), path.slice(1)) : path;
}

export function getAgentDir(): string {
	const envDir = process.env[ENV_AGENT_DIR];
	if (envDir) {
		return expandTildePath(envDir);
	}
	return join(homedir(), CONFIG_DIR_NAME, "agent");
}

export function getBinDir(): string {
	return join(getAgentDir(), "bin");
}

/** 用户层 `~/.runledger/agent/settings.json`。 */
export function getUserSettingsPath(): string {
	return join(getAgentDir(), PROJECT_SETTINGS_FILE);
}

/** 用户层扩展资源 root；Skill/Hook/MCP/Plugin 均从该目录的显式子路径发现。 */
export function getUserExtensionRoot(): string {
	return getAgentDir();
}

/** 用户层扩展启停状态；不保存 secret 或 trust receipt。 */
export function getExtensionsStatePath(): string {
	return join(getAgentDir(), EXTENSIONS_STATE_FILE);
}

/** 用户层 exact-identity trust store。 */
export function getTrustStorePath(): string {
	return join(getAgentDir(), TRUST_STORE_FILE);
}

/** 用户层 Plugin 可写数据根；Plugin 安装目录本身保持只读。 */
export function getPluginDataRoot(): string {
	return join(getAgentDir(), PLUGIN_DATA_SUBDIR);
}

/**
 * 单 Plugin 数据目录。目录名使用 canonical string JSON 的 SHA-256 前 128 bit，
 * 与 Extension discovery 的 qualified-id 映射一致，且不会把路径分隔符带入文件系统。
 */
export function getPluginDataDir(qualifiedPluginId: string): string {
	const encoded = createHash("sha256")
		.update(JSON.stringify(qualifiedPluginId), "utf8")
		.digest("hex")
		.slice(0, 32);
	return join(getPluginDataRoot(), encoded);
}

/**
 * 项目层 `<cwd>/.runledger/`,cwd 默认 process.cwd()。
 * 对照 pi `getProjectDir`,但 RunLedger 本期不分 configDir/customization,
 * 写死 `.runledger`(后续可由 package.json#runledgerConfig.configDir 覆盖,本期不做)。
 */
export function getProjectDir(cwd: string = process.cwd()): string {
	return join(cwd, PROJECT_DIR_NAME);
}

/** 当前项目扩展资源 root；项目资源只读发现，不承载用户 trust/state。 */
export function getProjectExtensionRoot(cwd: string = process.cwd()): string {
	return getProjectDir(cwd);
}

/** `<cwd>/.runledger/settings.json` */
export function getProjectSettingsPath(cwd: string = process.cwd()): string {
	return join(getProjectDir(cwd), PROJECT_SETTINGS_FILE);
}

/** `<cwd>/.runledger/sessions/`(默认项目内 session 目录) */
export function getProjectSessionsDir(cwd: string = process.cwd()): string {
	return join(getProjectDir(cwd), PROJECT_SESSIONS_SUBDIR);
}

/** 用户层 `~/.runledger/agent/sessions/` */
export function getUserSessionsDir(): string {
	return join(getAgentDir(), PROJECT_SESSIONS_SUBDIR);
}

/**
 * 用户层 cwd-encoded 子目录布局:`<agentDir>/sessions/--<encoded-cwd>--/`。
 *
 * 当项目层未指定 sessionDir 时,RunLedger 默认依然落项目内(见 `resolveSessionDir`),
 * 此函数仅供 settings.sessionDir 显式指到用户层、或多项目聚合在用户层时复用。
 * 与 pi 不同:pi 默认即此布局;RunLedger 默认走项目内。
 */
export function getDefaultUserSessionDirForCwd(cwd: string): string {
	return join(getUserSessionsDir(), encodeCwd(cwd));
}

/** Session 目录内的 Extension spill 根；原始超额正文不得写入 Plugin 安装目录。 */
export function getExtensionSpillRoot(sessionDir: string): string {
	return join(sessionDir, EXTENSION_SPILL_SUBDIR);
}

/** 单 Session 私有 Extension spill 目录，sessionId 被摘要为安全路径段。 */
export function getExtensionSpillDir(sessionDir: string, sessionId: string): string {
	const encodedSessionId = createHash("sha256")
		.update(JSON.stringify(sessionId), "utf8")
		.digest("hex")
		.slice(0, 32);
	return join(getExtensionSpillRoot(sessionDir), encodedSessionId);
}

/**
 * 全局 AGENTS.md:`<agentDir>/AGENTS.md`,可选,合入 systemPrompt 头部。
 */
export function getGlobalAgentsMd(): string {
	return join(getAgentDir(), AGENTS_MD);
}

/**
 * 解析实际生效的 session 目录(优先级:
 *   1. `RUNLEDGER_SESSION_DIR` env(进程级 override)
 *   2. settings.sessionDir(相对 cwd / 绝对 / "." = 项目根)
 *   3. 项目内 `<cwd>/.runledger/sessions/`(默认)
 *   当 settings.sessionDir 未提供时,即默认路径 = getProjectSessionsDir(cwd)。
 *   settings.sessionDir 相对路径按 cwd 解析(对照 pi 行为,不做 normalize 跨 cwd 兄弟)。
 */
export function resolveSessionDir(
	cwd: string = process.cwd(),
	settingsSessionDir?: string,
): string {
	const envOverride = process.env[ENV_SESSION_DIR];
	if (envOverride && envOverride.length > 0) {
		return normalizePath(envOverride);
	}
	if (!settingsSessionDir || settingsSessionDir.length === 0) {
		return getProjectSessionsDir(cwd);
	}
	if (settingsSessionDir === ".") {
		return cwd;
	}
	return isAbsolute(settingsSessionDir)
		? settingsSessionDir
		: resolve(cwd, settingsSessionDir);
}
