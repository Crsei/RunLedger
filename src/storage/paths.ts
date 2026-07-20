/**
 * RunLedger 本地配置/凭据目录解析 —— 对应 pi 的 coding-agent/config.ts 中 `getAgentDir`。
 * 路径默认 `~/.runledger/agent`，可用环境变量 `RUNLEDGER_DIR` 覆盖（同 pi 的 `PI_CODING_AGENT_DIR`）。
 */

import { homedir } from "node:os";
import { join } from "node:path";

const ENV_AGENT_DIR = "RUNLEDGER_DIR";
const CONFIG_DIR_NAME = ".runledger";

/** 展开 `~/...` 至用户 home 目录；其它路径原样返回。简单等价于 pi 的 normalizePath 子集。 */
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
