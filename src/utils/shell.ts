/**
 * Shell 探测 —— Windows 上找到 git-bash 可执行文件的常用路径与 PATH 搜索。
 *
 * 对齐 pi `packages/coding-agent/src/utils/shell.ts`(本期只移植最小子集,
 * 不引入 PowerShell / WSL / Cygwin 多层 fallback)。
 *
 * 设计:
 *   - Windows(平台 `win32`)下:
 *     1. 优先 `process.env.RUNLEDGER_GIT_BASH` 显式覆盖
 *     2. PATH 搜索 `bash.exe` / `git-bash.exe`
 *     3. 兜底常用安装位置硬编码
 *     4. 仍找不到 → 抛错(由调用方降级到 `cmd.exe`,但 bash 工具会立即 isError)
 *   - 非 Windows:返回 `bash`(若 PATH 内存在),否则 `sh`
 *
 * 不缓存进程检测结果以便测试时切 env 注入路径。
 */

import { accessSync, constants, existsSync, statSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const GIT_BASH_HINTS_WIN = [
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  `${process.env.LOCALAPPDATA ?? ""}\\Programs\\Git\\bin\\bash.exe`,
].filter(Boolean) as string[];

export interface ShellPathResolution {
	readonly ok: true;
	readonly path: string;
}

export interface ShellPathFailure {
	readonly ok: false;
	readonly code: "shell_path_invalid" | "shell_path_unavailable";
	readonly message: string;
}

export interface ShellInvocation {
	readonly executable: string;
	readonly args: readonly string[];
}

/** Convert one command string into the selected shell's native invocation. */
export function buildShellInvocation(
	executable: string,
	command: string,
	options: { readonly login?: boolean } = {},
): ShellInvocation {
	const binary = executable.split(/[\\/]/u).at(-1)?.toLowerCase();
	if (binary === "cmd" || binary === "cmd.exe") {
		return { executable, args: ["/d", "/s", "/c", command] };
	}
	if (binary === "powershell" || binary === "powershell.exe" || binary === "pwsh" || binary === "pwsh.exe") {
		return { executable, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command] };
	}
	return { executable, args: [options.login === true ? "-lc" : "-c", command] };
}

/**
 * 校验 settings.shellPath。配置的是宿主进程的明确 executable，不接受 PATH
 * 片段或目录；这样失败时可以在 composition root fail closed，而不是静默换
 * 到另一个 shell。
 */
export function resolveConfiguredShellPath(value: unknown): ShellPathResolution | ShellPathFailure {
	if (typeof value !== "string" || value.trim().length === 0 || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) {
		return { ok: false, code: "shell_path_invalid", message: "configured shellPath must be a non-empty absolute executable path" };
	}
	const candidate = value.trim();
	if (!path.isAbsolute(candidate)) {
		return { ok: false, code: "shell_path_invalid", message: "configured shellPath must be absolute" };
	}
	try {
		if (!existsSync(candidate) || !statSync(candidate).isFile()) {
			return { ok: false, code: "shell_path_unavailable", message: "configured shellPath does not point to a file" };
		}
		if (process.platform !== "win32") accessSync(candidate, constants.X_OK);
		return { ok: true, path: candidate };
	} catch {
		return { ok: false, code: "shell_path_unavailable", message: "configured shellPath is not executable" };
	}
}

/** 把 shell 配置失败转成稳定、不会泄露完整路径的 Error。 */
export function shellPathError(failure: ShellPathFailure): Error & { readonly code: ShellPathFailure["code"] } {
	return Object.assign(new Error(failure.message), { code: failure.code });
}

/** 找 git-bash 路径;失败抛错。 */
export function findGitBash(): string {
  // 1. 显式覆盖
  const override = process.env.RUNLEDGER_GIT_BASH;
  if (override && existsSync(override)) {
    return override;
  }

  // 2. PATH 内搜索 bash.exe(Windows)
  if (process.platform === "win32") {
    const fromPath = searchPathFor("bash.exe") ?? searchPathFor("git-bash.exe");
    if (fromPath) return fromPath;

    // 3. 常用安装位置硬编码
    for (const hint of GIT_BASH_HINTS_WIN) {
      if (existsSync(hint)) return hint;
    }

    throw new Error(
      "git-bash 未找到:请安装 Git for Windows,或设置 RUNLEDGER_GIT_BASH 环境变量指向 bash.exe",
    );
  }

  // 4. 非 Windows:PATH 内有 bash 用 bash,否则 sh
  const bashFromPath = searchPathFor("bash");
  if (bashFromPath) return bashFromPath;
  return "sh";
}

/** 在 PATH 中按目录搜索可执行文件名,返回首个命中的绝对路径。 */
function searchPathFor(binary: string): string | undefined {
  const envPath = process.env.PATH ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE").split(";") : [""];
  for (const dir of envPath.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, binary + ext);
      if (existsSync(full)) return full;
    }
  }
  return undefined;
}

/** 当前平台默认 shell 程序(供测试断言形态用);耦合 process.platform 不耦合环境 env。 */
export function defaultShell(configuredPath?: string): string {
	if (configuredPath !== undefined) {
		const resolved = resolveConfiguredShellPath(configuredPath);
		if (!resolved.ok) throw shellPathError(resolved);
		return resolved.path;
	}
	if (process.platform === "win32") {
    try {
      return findGitBash();
    } catch {
      return "cmd.exe";
    }
  }
  return os.platform() === "darwin" ? "/bin/bash" : "bash";
}
