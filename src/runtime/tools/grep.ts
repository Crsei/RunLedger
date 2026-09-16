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
import { localGrepShell } from "./local-defaults.ts";
import type { Shell } from "../execution-env.ts";
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
  skip: Type.Optional(
    Type.Number({
      description:
        "跳过前 N 个命中的文件(按结果顺序),用于翻页:上一页命中文件数达上限时,用 skip=已返回文件数 读取后续页。缺省 0。",
    }),
  ),
});

export type GrepToolInput = Static<typeof grepSchema>;

export interface GrepToolDetails {
  truncation: TruncationResult;
  matchCount?: number;
  fileCount: number;
  resultCount: number;
  resultUnit: "matches" | "files";
  matchLimitReached?: number;
  /** 本次因 skip 被丢弃的文件数;未使用 skip 时不设置。 */
  skippedFileCount?: number;
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
  const shell = options.shell ?? localGrepShell(cwd);
  return {
    name: "grep",
    label: "grep",
    description: `在文件或目录内搜索文本。默认上限 ${DEFAULT_LIMIT} 个匹配。优先 ripgrep,失败回退 grep。`,
    parameters: grepSchema,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(_toolCallId, params, signal?): Promise<AgentToolResult<GrepToolDetails>> {
      const searchPath = resolveToCwd(params.path, cwd);
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
      const probe = await shell.exec("rg --version", { cwd, maxOutputChars: 1024, timeoutMs: 5_000, signal });
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
        r = await shell.exec(rgArgs.cmd, { cwd, maxOutputChars: DEFAULT_MAX_BYTES, signal, timeoutMs: 30_000 });
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
        r = await shell.exec(grepCmd.cmd, { cwd, maxOutputChars: DEFAULT_MAX_BYTES, signal, timeoutMs: 30_000 });
        isError = r.exitCode !== 0 && r.exitCode !== 1;
      }

      // 截断每行(MAX_LINE_LENGTH)
      const trimmed = r.stdout
        .split("\n")
        .map((l) => (l.length > MAX_LINE_LENGTH ? l.slice(0, MAX_LINE_LENGTH) + "… [truncated]" : l))
        .join("\n");
      // skip 按"命中的文件"翻页:先剔除前 N 个文件的所有行,再截断与计数。
      const paged = dropLeadingFiles(trimmed, params.skip ?? 0, searchPath);
      const visible = paged.text;
      const { text, truncation } = truncateHead(visible, { maxLines: Number.MAX_SAFE_INTEGER, maxBytes: DEFAULT_MAX_BYTES });
      const counts = grepOutputCounts(visible, outputFormat, searchPath);
      const details: GrepToolDetails = {
        truncation,
        fileCount: counts.fileCount,
        resultCount: counts.resultCount,
        resultUnit: outputFormat === "files-with-matches" ? "files" : "matches",
        ...(counts.matchCount === undefined ? {} : { matchCount: counts.matchCount }),
        ...(paged.skipped === 0 ? {} : { skippedFileCount: paged.skipped }),
      };
      if (counts.matchCount !== undefined && counts.matchCount >= limit) details.matchLimitReached = limit;

      return {
        content: [{ type: "text", text: isError ? `${r.stderr}\n${r.stdout}` : text }],
        details,
      };
    },
  };
}

/**
 * 丢弃输出中最先出现的 `skip` 个文件的所有结果行(含其上下文行)。
 * 文件归属复用 `grepOutputFile`,与计数口径一致;`--` 分隔行随之丢弃。
 */
function dropLeadingFiles(
  output: string,
  skip: number,
  searchPath: string,
): { text: string; skipped: number } {
  if (skip <= 0 || output.length === 0) return { text: output, skipped: 0 };
  const lines = output.split(/\r?\n/u);
  const dropped = new Set<string>();
  for (const line of lines) {
    if (line.length === 0 || line === "--") continue;
    const file = grepOutputFile(line, searchPath);
    if (dropped.has(file)) continue;
    if (dropped.size >= skip) break;
    dropped.add(file);
  }
  if (dropped.size === 0) return { text: output, skipped: 0 };
  const kept = lines.filter((line) => {
    if (line.length === 0 || line === "--") return false;
    return !dropped.has(grepOutputFile(line, searchPath));
  });
  return { text: kept.join("\n"), skipped: dropped.size };
}

function grepOutputCounts(
  output: string,
  outputFormat: "text" | "files-with-matches",
  searchPath: string,
): { matchCount?: number; fileCount: number; resultCount: number } {
  const lines = output.split(/\r?\n/u).filter((line) => line.length > 0);
  if (outputFormat === "files-with-matches") {
    const fileCount = new Set(lines).size;
    return { fileCount, resultCount: fileCount };
  }
  const matchLines = lines.filter((line) => line !== "--" && !isContextLine(line));
  const files = new Set(matchLines.map((line) => grepOutputFile(line, searchPath)));
  return { matchCount: matchLines.length, fileCount: files.size, resultCount: matchLines.length };
}

function isContextLine(line: string): boolean {
  if (/^\d+:/u.test(line) || /:\d+:/u.test(line)) return false;
  return /^\d+-/u.test(line) || /^.+?-\d+-/u.test(line);
}

function grepOutputFile(line: string, searchPath: string): string {
  const numbered = line.match(/^(.+?)(?::\d+:|-\d+-)/u);
  if (numbered?.[1] !== undefined) return numbered[1];
  if (/^\d+:/u.test(line)) return searchPath;
  const separator = line.indexOf(":", /^[A-Za-z]:[\\/]/u.test(line) ? 2 : 0);
  return separator < 0 ? searchPath : line.slice(0, separator);
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
