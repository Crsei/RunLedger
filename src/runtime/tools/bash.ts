/**
 * bash 工具 —— 在 git-bash / sh 下执行一条命令,流式回传 stdout/stderr。
 *
 * 对齐 pi `core/tools/bash.ts`,但用 RunLedger 的 ExecutionEnv.shell 抽象层:
 *   - 默认 ops 走 localExecutionEnv().shell.exec(...)
 *   - ops 可注入,便于切到沙箱 / 远端 / fake 测试
 *
 * 截断:stdout / stderr 单独截断到 maxOutputChars;二者合并作为 LLM 或的回灌。
 * 非零 exit → 抛错(由 agent-loop 兜底转 isError,content 为已收集的 stdout+stderr)。
 */

import { Type } from "typebox";
import type { Static } from "typebox";
import { spawn } from "node:child_process";
import { mkdirSync, openSync, writeFileSync, closeSync, existsSync } from "node:fs";
import * as path from "node:path";
import type { AgentTool, AgentToolResult } from "../types.ts";
import { localExecutionEnv, type Shell, type ShellResult } from "../execution-env.ts";
import { findGitBash } from "../../utils/shell.ts";
import { DEFAULT_MAX_BYTES } from "./tool-support.ts";

export const bashSchema = Type.Object({
  command: Type.String({ description: "要执行的 shell 命令" }),
  timeout: Type.Optional(
    Type.Number({ description: "超时(ms),默认 60000;最大 2147483647" }),
  ),
  stdin: Type.Optional(
    Type.String({ description: "把这段文本通过 stdin 喂给子进程;缺省不喂。" }),
  ),
  run_in_background: Type.Optional(
    Type.Boolean({
      description: "true → 后台 detached 模式 spawn 命令,立即返回 bashId 与 log 路径。后续 turn 可 grep / read <logPath> 取输出。缺省 false。",
    }),
  ),
  output_format: Type.Optional(
    Type.String({
      description: '"text"(缺省:native stdout/stderr/exit 三段) | "stream-json"(stdout 每行 NDJSON: {"type":"stdout","line":"..."},stderr 类似,"type":"exit","code":N})。',
    }),
  ),
});

export type BashToolInput = Static<typeof bashSchema>;

export interface BashToolDetails {
  stdoutTruncated?: number;
  stderrTruncated?: number;
  exitCode?: number;
  /** 后台模式启动结果:bashId 与日志路径 */
  background?: {
    bashId: string;
    logPath: string;
  };
  /** 实际使用的 output_format */
  outputFormat?: "text" | "stream-json";
  stdoutChunk?: string;
  stderrChunk?: string;
  durationMs?: number;
}

export interface BashOperations {
  exec: (cmd: string, opts?: {
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    maxOutputChars?: number;
    signal?: AbortSignal;
    stdin?: string;
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
  }) => Promise<ShellResult>;
}

export interface BashToolOptions {
  operations?: BashOperations;
  cwd?: string;
  /** 默认 timeout(ms);可被 args.timeout 覆盖 */
  defaultTimeoutMs?: number;
  /** 默认 stdout/stderr 单边截断上限 */
  defaultMaxOutputChars?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export function createBashTool(
  cwd: string,
  options: BashToolOptions = {},
): AgentTool<typeof bashSchema, BashToolDetails> {
  const ops: BashOperations = options.operations ?? bashOpsFromLocalEnv();
  const defaultTimeout = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const defaultMaxOutput = options.defaultMaxOutputChars ?? DEFAULT_MAX_BYTES;
  return {
    name: "bash",
    label: "bash",
    description: "在 shell 中执行一条命令,流式回传 stdout/stderr。非零退出码视为错误。",
    parameters: bashSchema,
    isDestructive: () => true,
    async execute(_toolCallId, params, signal, onUpdate): Promise<AgentToolResult<BashToolDetails>> {
      const cmd = params.command;
      const stdin = params.stdin;
      const runInBackground = params.run_in_background === true;
      const outputFormat: "text" | "stream-json" =
        params.output_format === "stream-json" ? "stream-json" : "text";

      // 校验 timeout
      let timeoutMs = defaultTimeout;
      if (typeof params.timeout === "number" && Number.isFinite(params.timeout) && params.timeout > 0) {
        timeoutMs = Math.min(params.timeout, 2_147_483_647);
      }

      // === 后台模式 ===
      if (runInBackground) {
        const bg = spawnBackground(cmd, { cwd, stdin });
        if (bg === null) {
          return {
            content: [
              {
                type: "text",
                text: `bash: run_in_background 需要 localExecutionEnv().shell 派生的 ops;注入的 BashOperations 不支持后台 spawn。请去掉 run_in_background 或换用本地 shell。`,
              },
            ],
            details: { exitCode: 127 },
            isError: true,
            terminate: false,
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `Started in background (bashId: ${bg.bashId}). stdout/stderr appending to: ${bg.logPath}\nUse \`bash\` tail/cat 或 \`read\` ${bg.logPath} 取后续输出。`,
            },
          ],
          details: {
            background: bg,
            outputFormat,
          },
          terminate: false,
        };
      }

      // === 前台模式 ===
      let r: ShellResult;
      const startedAt = Date.now();
      try {
        r = await ops.exec(cmd, {
          cwd,
          timeoutMs,
          maxOutputChars: defaultMaxOutput,
          signal,
          stdin,
          onStdout: (chunk) => {
            onUpdate?.({
              content: [{ type: "text", text: chunk }],
              details: { stdoutChunk: chunk, outputFormat },
            });
          },
          onStderr: (chunk) => {
            onUpdate?.({
              content: [{ type: "text", text: chunk }],
              details: { stderrChunk: chunk, outputFormat },
            });
          },
        });
      } catch (e) {
        return {
          content: [{ type: "text", text: `bash 执行失败: ${(e as Error).message ?? String(e)}` }],
          details: { exitCode: 127 },
          isError: true,
          terminate: false,
        };
      }

      const details: BashToolDetails = {
        exitCode: r.exitCode,
        durationMs: Date.now() - startedAt,
      };
      // 截断标记:Shell 内部已截断,这里仅 details 透传
      if (r.stdout && r.stdout.length >= defaultMaxOutput) {
        details.stdoutTruncated = defaultMaxOutput;
      }
      if (r.stderr && r.stderr.length >= defaultMaxOutput) {
        details.stderrTruncated = defaultMaxOutput;
      }
      details.outputFormat = outputFormat;

      let text: string;
      if (outputFormat === "stream-json") {
        text = renderStreamJson(r);
      } else {
        const combined: string[] = [];
        if (r.stdout) combined.push(`STDOUT:\n${r.stdout}`);
        if (r.stderr) combined.push(`STDERR:\n${r.stderr}`);
        combined.push(`EXIT: ${r.exitCode}`);
        text = combined.join("\n");
      }
      return {
        content: [{ type: "text", text }],
        details,
        isError: r.exitCode !== 0 || r.signaled === true,
        terminate: false,
      };
    },
  };
}

/**
 * 把 stdout/stderr/exit 渲染成每行 NDJSON 的 stream-json 格式。
 * 每行 stdout → `{"type":"stdout","line":"..."}`;stderr 同理。
 * 末尾一条 exit → `{"type":"exit","code":N}`。
 * 对齐 pi core/tools/bash.ts output_format=stream-json。
 */
function renderStreamJson(r: ShellResult): string {
  const lines: string[] = [];
  for (const l of r.stdout.split("\n")) {
    lines.push(JSON.stringify({ type: "stdout", line: l }));
  }
  for (const l of r.stderr.split("\n")) {
    lines.push(JSON.stringify({ type: "stderr", line: l }));
  }
  lines.push(JSON.stringify({ type: "exit", code: r.exitCode }));
  return lines.join("\n");
}

/**
 * 后台 spawn:返回 { bashId, logPath } 或 null(无法执行)。
 *
 * 实现:在平台 shell 选好后,用 detached child + stdio redirect 到 logPath 文件
 * (append-only),子进程与父进程解绑(unref),让父进程立即返回。
 *
 * 与 ops 注入路径互斥:仅当 options.operations 没注入时(即 BashOperations 派生
 * 自 localExecutionEnv)才能可靠执行;否则退化为 null 让调用方降级。
 *
 * 为简化,本期不提供 kill / wait api;只起进程并把 log 路径告诉 LLM,后续 turn
 * 自行 read/grep 该文件取输出。对齐 docs/tools/bash-tool.mdx §"Run in background"。
 */
function spawnBackground(
  cmd: string,
  args: { cwd: string; stdin?: string },
): { bashId: string; logPath: string } | null {
  let shellCmd: string;
  let shellArgs: string[];
  if (process.platform === "win32") {
    try {
      shellCmd = findGitBash();
    } catch {
      return null;
    }
    shellArgs = ["-c", cmd];
  } else {
    shellCmd = "bash";
    shellArgs = ["-c", cmd];
  }
  // mkdir tmp/
  try {
    mkdirSync(path.join(args.cwd, "tmp"), { recursive: true });
  } catch {
    return null;
  }
  const bashId = `bgd-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const logPath = path.join(args.cwd, "tmp", `bash-${bashId}.log`);
  // 先写头行(stdout/stderr 接续 append)
  try {
    writeFileSync(
      logPath,
      `# bashId=${bashId} cwd=${args.cwd} started=${new Date().toISOString()}\n`,
    );
  } catch {
    return null;
  }
  // 打开 log file 以 append 模式给子进程写
  let fd: number;
  try {
    fd = openSync(logPath, "a");
  } catch {
    return null;
  }
  // 把 stdio 重定向到 log 文件
  let child;
  try {
    child = spawn(shellCmd, shellArgs, {
      cwd: args.cwd,
      env: { ...process.env },
      stdio: ["pipe", fd, fd],
      detached: true,
      windowsHide: true,
    });
  } catch {
    closeSync(fd);
    return null;
  }
  if (args.stdin !== undefined && child.stdin) {
    child.stdin.end(args.stdin);
  } else {
    child.stdin?.end();
  }
  try {
    child.unref();
  } catch {
    // ignore
  }
  closeSync(fd);
  if (!existsSync(logPath)) return null;
  return { bashId, logPath };
}

/** 从本地 ExecutionEnv 派生 BashOperations(走 git-bash + child_process)。 */
function bashOpsFromLocalEnv(): BashOperations {
  const env = localExecutionEnv();
  const shell: Shell = env.shell;
  return {
    async exec(cmd, opts) {
      return shell.exec(cmd, opts);
    },
  };
}
