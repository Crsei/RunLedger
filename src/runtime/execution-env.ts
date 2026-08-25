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

import { readFile, writeFile, stat, readdir, mkdir, rm, rename } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import { buildShellInvocation, defaultShell, resolveConfiguredShellPath } from "../utils/shell.ts";

/** 文件元信息:对齐 node:fs Stats 子集,只保留工具实际需要的字段。 */
export interface FileStats {
  size: number;
  /** epoch ms */
  mtimeMs: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink?: boolean;
}

/** FileSystem 操作面 —— 工具用到的 API 子集。 */
export interface FileSystem {
  readFile(p: string): Promise<Buffer>;
  writeFile(p: string, data: string | Buffer): Promise<void>;
  stat(p: string): Promise<FileStats>;
  readdir(p: string): Promise<string[]>;
  mkdir(p: string, opts?: { recursive?: boolean }): Promise<void>;
  rm(p: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

/** Host-gated network request; the implementation owns transport and redirects. */
export interface NetworkRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | Buffer;
  maxBytes: number;
}

/** Bounded network response returned by the Host policy broker. */
export interface NetworkResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  finalUrl: string;
}

export interface Network {
  request(request: NetworkRequest, signal?: AbortSignal): Promise<NetworkResponse>;
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
  /** Absent in low-level/test environments; production WebFetch receives this port. */
  network?: Network;
}

export interface LocalExecutionEnvOptions {
  /** settings.shellPath 的已解析输入；配置失败时 fail closed。 */
  shellPath?: string;
}

/**
 * 默认本地 ExecutionEnv。基于 `node:fs/promises` + `node:child_process`。
 * Windows 下走 git-bash(由 utils/shell.ts 探测),其他平台走 `bash`/`sh`。
 */
export function localExecutionEnv(
  initialCwd: string = process.cwd(),
  options?: LocalExecutionEnvOptions,
): ExecutionEnv {
  const configuredShell = options?.shellPath === undefined
    ? undefined
    : resolveConfiguredShellPath(options.shellPath);
  if (configuredShell !== undefined && !configuredShell.ok) {
    const error = Object.assign(new Error(configuredShell.message), { code: configuredShell.code });
    throw error;
  }
  return {
    fs: localFs(),
    shell: localShell(configuredShell?.path),
    cwd: initialCwd,
    network: localNetwork(),
  };
}

function localNetwork(): Network {
  return {
    async request(request) {
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body === undefined ? undefined : typeof request.body === "string" ? request.body : Uint8Array.from(request.body),
        redirect: "manual",
      });
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => { headers[key] = value; });
      return {
        status: response.status,
        headers,
        body: Buffer.from(await response.arrayBuffer()),
        finalUrl: request.url,
      };
    },
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
    async rename(from, to) {
      await rename(from, to);
    },
  };
}

function localShell(configuredShellPath?: string): Shell {
  return {
    async exec(cmd, opts) {
      const cwd = opts?.cwd ?? process.cwd();
      const env = opts?.env ?? {};
      const timeoutMs = opts?.timeoutMs ?? 60_000;
      const maxChars = opts?.maxOutputChars ?? 1_000_000;
      const stdin = opts?.stdin;
      const signal = opts?.signal;

      // 显式 shellPath 由 composition root 校验后直接使用；未配置时保留平台默认。
      const shellCmd = defaultShell(configuredShellPath);
      const shellInvocation = buildShellInvocation(shellCmd, cmd);

      return new Promise<ShellResult>((resolve) => {
        const child: ChildProcess = spawn(shellInvocation.executable, shellInvocation.args, {
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
