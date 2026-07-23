/**
 * grep 工具 —— 在文件 / 目录内查找 pattern;实现走 ExecutionEnv.shell.spawn rg 或 grep。
 *
 * 对齐 pi `core/tools/grep.ts`,但用更简化的实现:
 *   - 优先用 `rg`;若 rg 不在 PATH 中,降级到 `grep -rn`
 *   - 不流式 emit onUpdate(把 stdout 一次返回即可,因为 shell.exec 本身一次性)
 *   - pattern 不区分 literal / ignore-case 是否竖选项,直接透传给底层
 *
 * Schema:
 *   { pattern: string; path?: string; glob?: string;
 *     ignoreCase?: boolean; literal?: boolean;
 *     context?: number; limit?: number(默认 100) }
 */

import { Type } from "typebox";
import type { Static } from "typebox";
import { localExecutionEnv, type Shell } from "../execution-env.ts";
import type { AgentTool, AgentToolResult } from "../types.ts";
import { resolveToCwd, truncateHead, DEFAULT_MAX_BYTES, type TruncationResult } from "./tool-support.ts";

const grepSchema = Type.Object({
  pattern: Type.String({ description: "搜索模式(默认正则)" }),
  path: Type.Optional(Type.String({ description: "搜索路径;默认 cwd" })),
  glob: Type.Optional(Type.String({ description: "文件名 glob 过滤" })),
  ignoreCase: Type.Optional(Type.Boolean({ description: "大小写不敏感" })),
  literal: Type.Optional(Type.Boolean({ description: "原文匹配(fixed strings)" })),
  context: Type.Optional(Type.Number({ description: "上下文行数(对称 before+after)" })),
  afterContext: Type.Optional(
    Type.Number({ description: "匹配行后的上下文行数;不设时由 context 填充" }),
  ),
  beforeContext: Type.Optional(
    Type.Number({ description: "匹配行前的上下文行数;不设时由 context 填充" }),
  ),
  multiline: Type.Optional(
    Type.Boolean({ description: "允许多行 pattern(?<NL>...) 匹配;rg 加 -U, grep 加 -P -z。缺省 false。" }),
  ),
  outputFormat: Type.Optional(
    Type.String({
      description:
        '"text"(缺省) | "files-with-matches"(只输出命中文件名,等价 rg -l / grep -l)。用于快速 inventory 哪些文件含某 pattern。',
    }),
  ),
  limit: Type.Optional(Type.Number({ description: "结果行数上限,默认 100" })),
});

export type GrepToolInput = Static<typeof grepSchema>;

export interface GrepToolDetails {
  truncation?: TruncationResult;
  matchLimitReached?: number;
}

export interface GrepToolOptions {
  shell?: Shell;
}

const DEFAULT_LIMIT = 100;
const MAX_LINE_LENGTH = 2000;

export function createGrepTool(
  cwd: string,
  options: GrepToolOptions = {},
): AgentTool<typeof grepSchema, GrepToolDetails> {
  const legacyShell = options.shell ?? localExecutionEnv(cwd).shell;
  return {
    name: "grep",
    label: "grep",
    description: `在文件或目录内搜索文本。默认上限 ${DEFAULT_LIMIT} 个匹配。优先 ripgrep,失败回退 grep。`,
    parameters: grepSchema,
    governedExecution: "tool-context",
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(_toolCallId, params, signal?, _onUpdate?, toolContext?): Promise<AgentToolResult<GrepToolDetails>> {
      const activeCwd = toolContext ? toolContext.cwd : cwd;
      const activeSignal = toolContext ? toolContext.signal : signal;
      const shell = toolContext ? toolContext.env.shell : legacyShell;
      const shellEnv = toolContext ? toolContext.envVars : undefined;
      const searchPath = resolveToCwd(params.path, activeCwd);
      const limit = params.limit ?? DEFAULT_LIMIT;
      const ignoreCase = params.ignoreCase === true;
      const literal = params.literal === true;
      const context = params.context ?? 0;
      const afterContext = params.afterContext ?? context;
      const beforeContext = params.beforeContext ?? context;
      const multiline = params.multiline === true;
      const outputFormat: "text" | "files-with-matches" =
        params.outputFormat === "files-with-matches" ? "files-with-matches" : "text";
      const glob = params.glob;

      // 探测 rg 可用;失败直接走 grep -rn fallback
      const probe = await shell.exec("rg --version", {
        cwd: activeCwd,
        ...(shellEnv ? { env: shellEnv } : {}),
        maxOutputChars: 1024,
        timeoutMs: 5_000,
        signal: activeSignal,
      });
      const hasRg = probe.exitCode === 0;

      let r;
      let isError: boolean;
      if (hasRg) {
        const rgArgs = buildRgArgs(params.pattern, searchPath, {
          ignoreCase,
          literal,
          afterContext,
          beforeContext,
          multiline,
          outputFormat,
          glob,
          limit,
        });
        r = await shell.exec(rgArgs.cmd, {
          cwd: activeCwd,
          ...(shellEnv ? { env: shellEnv } : {}),
          maxOutputChars: DEFAULT_MAX_BYTES,
          signal: activeSignal,
          timeoutMs: 30_000,
        });
        // rg exit=1 表示无匹配,不算错误
        isError = r.exitCode !== 0 && r.exitCode !== 1;
      } else {
        const grepCmd = buildGrepArgs(params.pattern, searchPath, {
          ignoreCase,
          literal,
          afterContext,
          beforeContext,
          multiline,
          outputFormat,
          glob,
          limit,
        });
        r = await shell.exec(grepCmd.cmd, {
          cwd: activeCwd,
          ...(shellEnv ? { env: shellEnv } : {}),
          maxOutputChars: DEFAULT_MAX_BYTES,
          signal: activeSignal,
          timeoutMs: 30_000,
        });
        isError = r.exitCode !== 0 && r.exitCode !== 1;
      }

      // 截断每行(MAX_LINE_LENGTH)
      const trimmed = r.stdout
        .split("\n")
        .map((l) => (l.length > MAX_LINE_LENGTH ? l.slice(0, MAX_LINE_LENGTH) + "… [truncated]" : l))
        .join("\n");
      const { text, truncation } = truncateHead(trimmed, { maxLines: Number.MAX_SAFE_INTEGER, maxBytes: DEFAULT_MAX_BYTES });
      const details: GrepToolDetails = {};
      if (truncation.truncated) details.truncation = truncation;
      // 实际匹配行数(rg 输出按行计)≈ trim 后行数
      const matchCount = trimmed.split("\n").filter((l) => l.length > 0).length;
      if (matchCount >= limit) details.matchLimitReached = limit;

      return {
        content: [{ type: "text", text: isError ? `${r.stderr}\n${r.stdout}` : text }],
        details,
        terminate: false,
      };
    },
  };
}

function buildRgArgs(
  pattern: string,
  searchPath: string,
  opts: {
    ignoreCase: boolean;
    literal: boolean;
    afterContext: number;
    beforeContext: number;
    multiline: boolean;
    outputFormat: "text" | "files-with-matches";
    glob?: string;
    limit: number;
  },
): { cmd: string } {
  const parts: string[] = ["rg", "--line-number", "--color=never", "--hidden"];
  if (opts.ignoreCase) parts.push("--ignore-case");
  if (opts.literal) parts.push("--fixed-strings");
  if (opts.afterContext > 0 && opts.afterContext !== opts.beforeContext) {
    parts.push("-A", String(opts.afterContext));
  }
  if (opts.beforeContext > 0 && opts.beforeContext !== opts.afterContext) {
    parts.push("-B", String(opts.beforeContext));
  }
  if (opts.afterContext > 0 && opts.beforeContext > 0 && opts.afterContext === opts.beforeContext) {
    parts.push("--context", String(opts.afterContext));
  }
  if (opts.multiline) parts.push("-U", "--multiline-dotall");
  if (opts.outputFormat === "files-with-matches") parts.push("--files-with-matches");
  if (opts.glob) parts.push("--glob", quote(opts.glob));
  if (opts.outputFormat !== "files-with-matches") parts.push("--max-count", String(opts.limit));
  parts.push("--", quote(pattern), quote(toPosixPath(searchPath)));
  return { cmd: parts.join(" ") };
}

function buildGrepArgs(
  pattern: string,
  searchPath: string,
  opts: {
    ignoreCase: boolean;
    literal: boolean;
    afterContext: number;
    beforeContext: number;
    multiline: boolean;
    outputFormat: "text" | "files-with-matches";
    glob?: string;
    limit: number;
  },
): { cmd: string } {
  const parts: string[] = ["grep", "-rn", "--color=never"];
  if (opts.ignoreCase) parts.push("-i");
  if (opts.literal) parts.push("-F");
  if (opts.afterContext > 0 && opts.afterContext !== opts.beforeContext) {
    parts.push("-A", String(opts.afterContext));
  }
  if (opts.beforeContext > 0 && opts.beforeContext !== opts.afterContext) {
    parts.push("-B", String(opts.beforeContext));
  }
  if (opts.afterContext > 0 && opts.beforeContext > 0 && opts.afterContext === opts.beforeContext) {
    parts.push("-C", String(opts.afterContext));
  }
  if (opts.multiline) parts.push("-P", "-z");
  if (opts.outputFormat === "files-with-matches") parts.push("-l");
  if (opts.glob) parts.push("--include", quote(opts.glob));
  parts.push("--", quote(pattern), quote(toPosixPath(searchPath)));
  return { cmd: parts.join(" ") };
}

/** Windows 反斜杠 → 正斜杠。git-bash 的 rg / grep 兼容正斜杠。 */
function toPosixPath(p: string): string {
  return p.split("\\").join("/");
}

/** 单引号 quote;pattern 自身已含 ' 时用 '\'' 转义。 */
function quote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

void MAX_LINE_LENGTH;
