/**
 * ExecutionEnv —— 运行时文件系统与 shell 的统一抽象层。
 *
 * 对齐 pi `coding-agent/src/types.ts` 中的 `Operations` 接口族
 * (BashOperations / ReadOperations / WriteOperations / EditOperations …),
 * 把"工具到底调用什么 fs / shell"上提一层,使得:
 *   - 真实工具集(via `localExecutionEnv()`)走 node:fs/promises 与 child_process
 *   - 测试 / 沙箱可注入 fake 实现
 *   - 远端运行(后续接 streamProxy + Browser ExecutionEnv)可重写 fs / shell
 */

import { readFile, writeFile, stat, readdir, mkdir, rm } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import { findGitBash } from "../utils/shell.ts";

/** 文件元信息:对齐 node:fs Stats 子集,只保留工具实际需要的字段。 */
export interface FileStats {
  size: number;
  /** epoch ms */
  mtimeMs: number;
  isFile: boolean;
  isDirectory: boolean;
}

/** FileSystem 操作面 —— 工具用到的 API 子集。 */
export interface FileSystem {
  readFile(p: string): Promise<Buffer>;
  writeFile(p: string, data: string | Buffer): Promise<void>;
  stat(p: string): Promise<FileStats>;
  readdir(p: string): Promise<string[]>;
  mkdir(p: string, opts?: { recursive?: boolean }): Promise<void>;
  rm(p: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void>;
}

/** Shell 执行结果。 */
export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** 命令在子进程中是否被信号杀掉(by SIGKILL 等) */
  signaled?: boolean;
}

/** Shell 操作面。 */
export interface Shell {
  exec(cmd: string, opts?: ShellExecOptions): Promise<ShellResult>;
}

/** Shell 执行参数;保留可扩展的占位字段。 */
export interface ShellExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** 毫秒;超时则 SIGKILL */
  timeoutMs?: number;
  /** 最大输出字符数;溢出截断 */
  maxOutputChars?: number;
  stdin?: string;
  signal?: AbortSignal;
  /** 子进程输出增量,供 TUI 实时渲染。 */
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

/** ExecutionEnv = fs + shell + cwd。 */
export interface ExecutionEnv {
  fs: FileSystem;
  shell: Shell;
  cwd: string;
}

/**
 * 默认本地 ExecutionEnv。基于 `node:fs/promises` + `node:child_process`。
 * Windows 下走 git-bash(由 utils/shell.ts 探测),其他平台走 `bash`/`sh`。
 */
export function localExecutionEnv(initialCwd: string = process.cwd()): ExecutionEnv {
  return {
    fs: localFs(),
    shell: localShell(),
    cwd: initialCwd,
  };
}

function localFs(): FileSystem {
  return {
    async readFile(p) {
      return readFile(p);
    },
    async writeFile(p, data) {
      await writeFile(p, data);
    },
    async stat(p) {
      const s = await stat(p);
      return {
        size: s.size,
        mtimeMs: s.mtimeMs,
        isFile: s.isFile(),
        isDirectory: s.isDirectory(),
      };
    },
    async readdir(p) {
      return readdir(p);
    },
    async mkdir(p, opts) {
      await mkdir(p, opts);
    },
    async rm(p, opts) {
      await rm(p, opts);
    },
  };
}

function localShell(): Shell {
  return {
    async exec(cmd, opts) {
      const cwd = opts?.cwd ?? process.cwd();
      const env = opts?.env ?? {};
      const timeoutMs = opts?.timeoutMs ?? 60_000;
      const maxChars = opts?.maxOutputChars ?? 1_000_000;
      const stdin = opts?.stdin;
      const signal = opts?.signal;

      // 平台 shell 选择:Windows 走 git-bash;Posix 走 sh 兜底(若 bash 不在 PATH)
      let shellCmd: string;
      let shellArgs: string[];
      if (process.platform === "win32") {
        try {
          shellCmd = findGitBash();
          shellArgs = ["-c", cmd];
        } catch {
          // git-bash 找不到 → cmd.exe 兜底
          shellCmd = process.env.COMSPEC ?? "cmd.exe";
          shellArgs = ["/d", "/s", "/c", cmd];
        }
      } else {
        shellCmd = "bash";
        shellArgs = ["-c", cmd];
      }

      return new Promise<ShellResult>((resolve) => {
        const child: ChildProcess = spawn(shellCmd, shellArgs, {
          cwd,
          env: { ...process.env, ...env },
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });

      let stdoutBuf = "";
      let stderrBuf = "";
      let settled = false;

      const finish = (r: ShellResult) => {
        if (settled) return;
        settled = true;
        resolve(r);
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stdoutBuf += text;
        opts?.onStdout?.(text);
        if (stdoutBuf.length > maxChars * 2) {
          stdoutBuf = stdoutBuf.slice(-maxChars * 2);
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stderrBuf += text;
        opts?.onStderr?.(text);
        if (stderrBuf.length > maxChars * 2) {
          stderrBuf = stderrBuf.slice(-maxChars * 2);
        }
      });

      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // 防御:进程已退出时 kill 抛错吞掉
        }
      }, timeoutMs);

      const onAbort = () => {
        try {
          child.kill("SIGKILL");
        } catch {
          // 防御
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      child.on("error", (err) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        finish({
          stdout: truncate(stdoutBuf, maxChars),
          stderr: `${stderrBuf}${err.message}`,
          exitCode: 127,
          signaled: false,
        });
      });

      child.on("close", (code, signalName) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        finish({
          stdout: truncate(stdoutBuf, maxChars),
          stderr: truncate(stderrBuf, maxChars),
          exitCode: code ?? 127,
          signaled: signalName != null,
        });
      });

      if (stdin !== undefined && child.stdin) {
        child.stdin.end(stdin);
      } else {
        child.stdin?.end();
      }
      });
    },
  };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n... [output truncated at ${max} chars]`;
}

// 防 unused
void path;
