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
});

export type BashToolInput = Static<typeof bashSchema>;

export interface BashToolDetails {
  stdoutTruncated?: number;
  stderrTruncated?: number;
  exitCode?: number;
}

export interface BashOperations {
  exec: (cmd: string, opts?: {
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    maxOutputChars?: number;
    signal?: AbortSignal;
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
    async execute(_toolCallId, params, signal?): Promise<AgentToolResult<BashToolDetails>> {
      const cmd = params.command;
      // 校验 timeout
      let timeoutMs = defaultTimeout;
      if (typeof params.timeout === "number" && Number.isFinite(params.timeout) && params.timeout > 0) {
        timeoutMs = Math.min(params.timeout, 2_147_483_647);
      }

      let r: ShellResult;
      try {
        r = await ops.exec(cmd, {
          cwd,
          timeoutMs,
          maxOutputChars: defaultMaxOutput,
          signal,
        });
      } catch (e) {
        return {
          content: [{ type: "text", text: `bash 执行失败: ${(e as Error).message ?? String(e)}` }],
          details: { exitCode: 127 },
          terminate: false,
        };
      }

      const details: BashToolDetails = {
        exitCode: r.exitCode,
      };
      // 截断标记:Shell 内部已截断,这里仅 details 透传
      if (r.stdout && r.stdout.length >= defaultMaxOutput) {
        details.stdoutTruncated = defaultMaxOutput;
      }
      if (r.stderr && r.stderr.length >= defaultMaxOutput) {
        details.stderrTruncated = defaultMaxOutput;
      }

      const combined: string[] = [];
      if (r.stdout) combined.push(`STDOUT:\n${r.stdout}`);
      if (r.stderr) combined.push(`STDERR:\n${r.stderr}`);
      combined.push(`EXIT: ${r.exitCode}`);

      const text = combined.join("\n");
      const isError = r.exitCode !== 0;
      return {
        content: [{ type: "text", text }],
        details,
        terminate: false,
      };
    },
  };
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
