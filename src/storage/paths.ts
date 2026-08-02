/**
 * Legacy path metadata helpers。
 *
 * 这些 helper 只描述待迁移的历史 source，不是 canonical Storage/CLI 写入 authority。
 * canonical 根由 `resolveRunledgerHome()` 一次解析后通过 `RunledgerLayout` 注入。
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { encodeCwd } from "./path-utils.ts";

const ENV_AGENT_DIR = "RUNLEDGER_DIR";
const CONFIG_DIR_NAME = ".runledger";
const PROJECT_DIR_NAME = ".runledger";
const PROJECT_SESSIONS_SUBDIR = "sessions";
const PROJECT_SETTINGS_FILE = "settings.json";
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

/**
 * 历史项目层 `<cwd>/.runledger/` source locator。
 */
export function getProjectDir(cwd: string = process.cwd()): string {
	return join(cwd, PROJECT_DIR_NAME);
}

/** 历史 `<cwd>/.runledger/settings.json` source locator。 */
export function getProjectSettingsPath(cwd: string = process.cwd()): string {
	return join(getProjectDir(cwd), PROJECT_SETTINGS_FILE);
}

/** 历史 `<cwd>/.runledger/sessions/` source locator。 */
export function getProjectSessionsDir(cwd: string = process.cwd()): string {
	return join(getProjectDir(cwd), PROJECT_SESSIONS_SUBDIR);
}

/** 历史用户层 `~/.runledger/agent/sessions/` source locator。 */
export function getUserSessionsDir(): string {
	return join(getAgentDir(), PROJECT_SESSIONS_SUBDIR);
}

/**
 * 历史用户层 cwd-encoded session locator，仅供显式迁移 source metadata。
 */
export function getDefaultUserSessionDirForCwd(cwd: string): string {
	return join(getUserSessionsDir(), encodeCwd(cwd));
}

/**
 * 历史全局 AGENTS.md source locator；canonical 运行时使用 layout.agents。
 */
export function getGlobalAgentsMd(): string {
	return join(getAgentDir(), AGENTS_MD);
}
