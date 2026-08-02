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
import type { AgentTool, AgentToolResult } from "../types.ts";
import { localExecutionEnv, type Shell, type ShellResult } from "../execution-env.ts";
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
      description: "true → 请求受治理的后台执行。当前 Host process manager 尚未接线时 fail closed。缺省 false。",
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
  unsupported?: {
    code: "managed_process_unavailable";
    operation: "run_in_background";
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
     description: "在受治理 shell 中执行一条命令,流式回传 stdout/stderr。非零退出码视为错误。",
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
        return {
          content: [
            {
              type: "text",
              text: "bash: run_in_background 当前不可用；Runtime Host process manager 尚未接线。未创建子进程。",
            },
          ],
          details: {
            unsupported: {
              code: "managed_process_unavailable",
              operation: "run_in_background",
            },
            outputFormat,
          },
          isError: true,
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

/** 从本地 ExecutionEnv 派生 BashOperations；后台入口不会绕过 Host process manager。 */
function bashOpsFromLocalEnv(): BashOperations {
  const env = localExecutionEnv();
  const shell: Shell = env.shell;
  return {
    async exec(cmd, opts) {
      return shell.exec(cmd, opts);
    },
  };
}
