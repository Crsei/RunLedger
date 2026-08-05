/** 纯 Shell/process capability descriptor（P3：不接生产 spawn，不读运行时平台分支）。 */

/**
 * 描述每个平台允许的 Shell、启动参数、进程树终止与 cleanup 重试策略。
 * `evidence: "verified"` 表示该语义有真实 runner 证据（当前仅 Linux）；
 * `"unverified"` 的平台语义在真实 runner 证据补齐前必须保持 typed unsupported。
 */

import type { WorkspacePlatform } from "./types.ts";

export interface ShellDescriptor {
	readonly id: string;
	/** 可执行解析顺序（windows 上配合 PATHEXT/shim 规则）。 */
	readonly executableCandidates: readonly string[];
	/** 启动参数数组（不把路径拼进命令字符串）。 */
	readonly launchArgs: readonly string[];
	/** Git Bash 等 MSYS shell 对 POSIX↔Windows 路径翻译的行为标记。 */
	readonly pathTranslation: "native" | "msys";
}

export interface ProcessTerminationPolicy {
	/** POSIX 用 process group（负 PID 信号）；Windows 需要 process-tree 终止。 */
	readonly strategy: "process_group" | "process_tree" | "unsupported";
	/** Windows tree 终止的受控参数数组（不拼接 shell 字符串）。 */
	readonly treeKillArgs?: readonly string[];
	readonly evidence: "verified" | "unverified";
}

export interface CleanupRetryPolicy {
	/** 占用句柄清理重试上限；Linux POSIX unlink 证据下为 1。 */
	readonly maxAttempts: number;
	readonly backoffMs: number;
	readonly evidence: "verified" | "unverified";
}

export interface WorkspaceProcessCapability {
	readonly platform: WorkspacePlatform;
	readonly shells: readonly ShellDescriptor[];
	readonly defaultShellId: string;
	readonly termination: ProcessTerminationPolicy;
	readonly cleanup: CleanupRetryPolicy;
	/** Windows PATHEXT（可执行扩展解析）；POSIX 平台为 undefined。 */
	readonly pathExt?: readonly string[];
}

export interface ProcessCapabilityEnv {
	readonly shell?: string;
	readonly comspec?: string;
	readonly pathext?: string;
	/** PATH 目录列表（解析 shell 可执行用；缺省回落到 process.env.PATH）。 */
	readonly path?: string;
}

/** 从用户环境选择默认 shell id（Windows 优先 pwsh，其次 PowerShell，再 cmd）。 */
function defaultShellIdFor(platform: WorkspacePlatform, env: ProcessCapabilityEnv): string {
	if (platform === "windows") {
		const comspec = (env.comspec ?? "").toLowerCase();
		if (comspec.includes("powershell") || comspec.includes("pwsh")) return "pwsh";
		return "cmd";
	}
	const shell = (env.shell ?? "").toLowerCase();
	if (shell.includes("zsh")) return "zsh";
	if (shell.includes("bash")) return "bash";
	if (platform === "macos") return "zsh";
	return "sh";
}

export function processCapabilityFor(platform: WorkspacePlatform, env: ProcessCapabilityEnv = {}): WorkspaceProcessCapability {
	if (platform === "linux") {
		return {
			platform,
			shells: [
				{ id: "bash", executableCandidates: ["bash"], launchArgs: ["-lc"], pathTranslation: "native" },
				{ id: "sh", executableCandidates: ["sh"], launchArgs: ["-c"], pathTranslation: "native" },
				{ id: "zsh", executableCandidates: ["zsh"], launchArgs: ["-lc"], pathTranslation: "native" },
			],
			defaultShellId: defaultShellIdFor(platform, env),
			termination: { strategy: "process_group", evidence: "verified" },
			cleanup: { maxAttempts: 1, backoffMs: 0, evidence: "verified" },
		};
	}
	if (platform === "macos") {
		return {
			platform,
			shells: [
				{ id: "zsh", executableCandidates: ["zsh", "/bin/zsh"], launchArgs: ["-lc"], pathTranslation: "native" },
				{ id: "bash", executableCandidates: ["bash", "/bin/bash"], launchArgs: ["-lc"], pathTranslation: "native" },
				{ id: "sh", executableCandidates: ["sh", "/bin/sh"], launchArgs: ["-c"], pathTranslation: "native" },
			],
			defaultShellId: defaultShellIdFor(platform, env),
			termination: { strategy: "process_group", evidence: "unverified" },
			cleanup: { maxAttempts: 1, backoffMs: 0, evidence: "unverified" },
		};
	}
	const pathExt = (env.pathext ?? ".EXE;.CMD;.BAT;.COM").split(";").filter((e) => e.length > 0);
	return {
		platform: "windows",
		shells: [
			{ id: "pwsh", executableCandidates: ["pwsh", "powershell"], launchArgs: ["-NoProfile", "-NonInteractive", "-Command"], pathTranslation: "native" },
			{ id: "cmd", executableCandidates: [env.comspec ?? "cmd"], launchArgs: ["/d", "/c"], pathTranslation: "native" },
			{ id: "git-bash", executableCandidates: ["git-bash", "bash"], launchArgs: ["-lc"], pathTranslation: "msys" },
		],
		defaultShellId: defaultShellIdFor(platform, env),
		termination: { strategy: "process_tree", treeKillArgs: ["taskkill", "/T", "/F", "/PID"], evidence: "unverified" },
		cleanup: { maxAttempts: 3, backoffMs: 200, evidence: "unverified" },
		...(pathExt.length > 0 ? { pathExt } : {}),
	};
}
