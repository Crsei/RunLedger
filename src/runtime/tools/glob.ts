/**
 * glob 工具 —— 第一方手写 ** 递归匹配,不依赖外部 fd / find。
 *
 * 对齐 claude-code-bun docs/tools/glob-tool.mdx 与 pi core/tools/glob.ts:
 *   - pattern 语法子集:`*` 单段非 `/`、`**` 跨段任意深度、字面量字符、`?` 单字符。
 *   - 不支持字符集 `[abc]`(本期不必要;LLM 可直接用 grep)
 *   - 缺省 path = cwd;缺省 limit = 100
 *   - 始终跳过语义噪音目录:`.git` / `node_modules` / `.DS_Store` 子树
 *   - 不-follow 符号链接,不返回目录条目(只返文件)。
 *   - 按 mtime desc 排序(最近改过的文件优先)。
 *
 * 实现策略:
 *   1. 把 pattern 按 `/` 切段,record 每段 `*` / `**` / literal 类型,组成匹配段链。
 *   2. 从 path 起,深度走读 readdir → stat → 若是目录递归,若是文件按段链做匹配。
 *   3. `**` 段可吃 0 段及以上子路径;实现时枚举所有"任耗"数目。
 *
 * 失败 throw,agent-loop 兜底转 isError。
 */

import { Type } from "typebox";
import type { Static } from "typebox";
import * as path from "node:path";
import type { AgentTool, AgentToolResult } from "../types.ts";
import { localGlobOperations } from "./local-defaults.ts";
import { parseGitignore, type GitignoreMatcher } from "./gitignore.ts";
import { resolveToCwd, truncateHead, DEFAULT_MAX_BYTES, type TruncationResult } from "./tool-support.ts";

export const globSchema = Type.Object({
  pattern: Type.String({
    description:
      "Glob pattern,支持 * / ** / ?;不支持字符集 [abc]。不含 `/` 的 pattern 在任意深度匹配(如 `*.ts`);例:src/**/*.ts",
  }),
  path: Type.Optional(Type.String({ description: "搜索根目录;缺省 cwd" })),
  hidden: Type.Optional(Type.Boolean({ description: "是否包含隐藏文件与目录(点开头);缺省 false。" })),
  gitignore: Type.Optional(
    Type.Boolean({ description: "是否跳过 .gitignore 命中的条目;缺省 true(与 rg/fd 默认一致)。" }),
  ),
  limit: Type.Optional(Type.Number({ description: "结果条目上限,默认 100" })),
});

export type GlobToolInput = Static<typeof globSchema>;

export interface GlobToolDetails {
  matchCount: number;
  truncation: TruncationResult;
  /** 命中条目达到 limit 时为 true,见 details.matchCount == limit */
  limitReached?: boolean;
  /** 因 hidden=false 跳过的隐藏条目数;未跳过时不设置。 */
  skippedHidden?: number;
  /** 因 gitignore=true 跳过的条目数;未跳过时不设置。 */
  skippedIgnored?: number;
}

export interface GlobOperations {
  readdir: (p: string) => Promise<string[]>;
  stat: (p: string) => Promise<{ isDirectory: boolean; mtimeMs: number; isSymbolicLink: boolean }>;
  /** 读 .gitignore;走同一个 governed fs,不在 execute 内另开 raw I/O。 */
  readFile: (p: string) => Promise<Buffer>;
}

/** glob 默认 ops:本地 fs;生产由 createStdlibTools 注入 governed env。 */
export interface GlobToolOptions {
  operations?: GlobOperations;
}

const DEFAULT_LIMIT = 100;

/**
 * 跳过这些目录名(深度递归时不进入)。
 * 对齐 claude-code-bun docs/tools/glob-tool.mdx §"默认行为"。
 */
const SKIP_DIRS = new Set([".git", "node_modules", ".DS_Store"]);

interface PatternSeg {
  kind: "double-star" | "star-any" | "literal";
  literal?: string;
}

/**
 * 把 pattern 按 `/` 切段;`**` 标 double-star、含 `*` 或 `?` 的段标 star-any。
 * 不支持字符集 `[abc]`;遇到即按字面量处理(grep 替代)。
 */
function parsePattern(pattern: string): PatternSeg[] {
  const segs = pattern.split("/").filter((s) => s !== "");
  const out: PatternSeg[] = [];
  for (const s of segs) {
    if (s === "**") {
      out.push({ kind: "double-star" });
    } else if (s.includes("*") || s.includes("?")) {
      out.push({ kind: "star-any", literal: s });
    } else {
      out.push({ kind: "literal", literal: s });
    }
  }
  return out;
}

/**
 * 把入参 pattern 解析为多个段链:
 *   - `;` 分隔多个 pattern(对齐 oh-my-pi 的 path 列表写法 `"src/**\/*.ts; test/**\/*.ts"`)
 *   - 不含 `/` 的 pattern 视为"任意深度"(与 fd/omp 一致):`*.ts` → `**\/*.ts`
 */
function parseGlobPatterns(pattern: string): PatternSeg[][] {
  const parts = pattern
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const effective = parts.length === 0 ? [pattern] : parts;
  return effective.map((part) =>
    part.includes("/") ? parsePattern(part) : parsePattern(`**/${part}`),
  );
}

/** 多 pattern 命中同一文件时按路径去重,保留首条(含其 mtime)。 */
function dedupeByPath(matches: readonly { path: string; mtimeMs: number }[]): Array<{ path: string; mtimeMs: number }> {
  const byPath = new Map<string, { path: string; mtimeMs: number }>();
  for (const match of matches) {
    if (!byPath.has(match.path)) byPath.set(match.path, match);
  }
  return [...byPath.values()];
}

/** 读取搜索根目录的 .gitignore;不存在或不可读时返回 null(不阻断 glob)。 */
async function loadRootGitignore(ops: GlobOperations, root: string): Promise<GitignoreMatcher | null> {
  try {
    const text = (await ops.readFile(path.join(root, ".gitignore"))).toString("utf8");
    const matcher = parseGitignore(text);
    return matcher.ruleCount === 0 ? null : matcher;
  } catch {
    return null;
  }
}

/** 用相对搜索根的 posix 路径判定忽略;目录规则同时忽略其下内容。 */
async function isIgnoredPath(
  matcher: GitignoreMatcher,
  root: string,
  absolutePath: string,
  isDirectory: boolean,
): Promise<boolean> {
  const relative = path.relative(root, absolutePath).split("\\").join("/");
  if (relative.length === 0 || relative.startsWith("..")) return false;
  return matcher.isIgnored(relative, isDirectory);
}

/**
 * 把单个含 `*` / `?` 的 glob 段编译成正则。
 * `*` → `[^/]*`,`?` → `[^/]`,其他 escape。
 * 段内不会含有 `/`,因此该正则只匹配单段。
 */
function compileStarAnySeg(seg: string): RegExp {
  let r = "^";
  for (const ch of seg) {
    if (ch === "*") r += "[^/]*";
    else if (ch === "?") r += "[^/]";
    else r += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  r += "$";
  return new RegExp(r);
}

export function createGlobTool(
  cwd: string,
  options: GlobToolOptions = {},
): AgentTool<typeof globSchema, GlobToolDetails> {
  const ops = options.operations ?? localGlobOperations();
  return {
    name: "glob",
    label: "glob",
    description:
      "按 glob pattern 查找文件路径(第一方手写 ** 递归,不依赖外部 fd/find)。不含 `/` 的 pattern 在任意深度匹配;默认跳过 .git / node_modules、隐藏条目与根 .gitignore 命中项;按 mtime desc 排序。",
    parameters: globSchema,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(_toolCallId, params, _signal?): Promise<AgentToolResult<GlobToolDetails>> {
      const root = resolveToCwd(params.path ?? "", cwd);
      const limit = params.limit ?? DEFAULT_LIMIT;
      const patterns = parseGlobPatterns(params.pattern);
      const patternsWithStar = patterns.map((segs) =>
        segs.map((s) => (s.kind === "star-any" && s.literal ? compileStarAnySeg(s.literal) : null)),
      );

      // hidden 缺省跟随历史行为:不返回隐藏条目(与 rg/fd 默认一致)。
      const includeHidden = params.hidden === true;
      // gitignore 缺省开启;判定只在 root 的 .gitignore 上做(见 gitignore.ts 的限制说明)。
      const respectGitignore = params.gitignore !== false;
      const ignored = respectGitignore ? await loadRootGitignore(ops, root) : null;

      const matches: Array<{ path: string; mtimeMs: number }> = [];
      // `**` 的 0-consume 分支会让同一目录被多个 idx 重复遍历,跳过计数因此按
      // 路径去重统计,避免同一个条目被算多次。
      const skippedHidden = new Set<string>();
      const skippedIgnored = new Set<string>();

      /** `skip` 参数位:命中某个 pattern 即计入(多 pattern 去重由 matches 承担)。 */
      async function walk(segs: readonly PatternSeg[], compiled: readonly (RegExp | null)[], dir: string, idx: number): Promise<void> {
        if (matches.length >= limit) return;
        if (idx > segs.length) return;
        let entries: string[] = [];
        try {
          entries = await ops.readdir(dir);
        } catch {
          return;
        }
        for (const name of entries) {
          if (matches.length >= limit) return;
          if (SKIP_DIRS.has(name)) continue;
          if (!includeHidden && name.startsWith(".")) {
            skippedHidden.add(path.join(dir, name));
            continue;
          }
          const childPath = path.join(dir, name);
          let st: Awaited<ReturnType<typeof ops.stat>> | null = null;
          try {
            st = await ops.stat(childPath);
          } catch {
            continue;
          }
          if (st.isSymbolicLink) continue;
          if (ignored !== null && await isIgnoredPath(ignored, root, childPath, st.isDirectory)) {
            skippedIgnored.add(childPath);
            continue;
          }
          const seg = segs[idx]!;
          if (seg === undefined) {
            if (!st.isDirectory) {
              matches.push({ path: childPath, mtimeMs: st.mtimeMs });
            }
            continue;
          }
          if (seg.kind === "double-star") {
            if (st.isDirectory) {
              await walk(segs, compiled, childPath, idx);
            }
            continue;
          }
          let matched = false;
          if (seg.kind === "literal") {
            matched = name === seg.literal;
          } else if (compiled[idx] != null) {
            matched = compiled[idx]!.test(name);
          }
          if (!matched) continue;
          if (idx === segs.length - 1) {
            if (!st.isDirectory) {
              matches.push({ path: childPath, mtimeMs: st.mtimeMs });
            }
            continue;
          }
          if (st.isDirectory) {
            await walk(segs, compiled, childPath, idx + 1);
          }
        }
        const lastSeg = segs[idx]!;
        if (lastSeg && lastSeg.kind === "double-star" && idx < segs.length - 1) {
          await walk(segs, compiled, dir, idx + 1);
        }
      }

      for (let patternIndex = 0; patternIndex < patterns.length; patternIndex += 1) {
        if (matches.length >= limit) break;
        await walk(patterns[patternIndex]!, patternsWithStar[patternIndex]!, root, 0);
      }

      // 多 pattern 时同一文件可能被两个 pattern 命中,按路径去重。
      const deduped = dedupeByPath(matches);
      deduped.sort((a, b) => b.mtimeMs - a.mtimeMs);
      const limited = deduped.slice(0, limit);
      const limitReached = deduped.length >= limit;
      const lines = limited.map((m) => m.path.split("\\").join("/"));
      const { text, truncation } = truncateHead(lines.join("\n"), {
        maxLines: Number.MAX_SAFE_INTEGER,
        maxBytes: DEFAULT_MAX_BYTES,
      });
      const details: GlobToolDetails = {
        matchCount: lines.length,
        truncation,
      };
      if (limitReached) details.limitReached = true;
      if (skippedHidden.size > 0) details.skippedHidden = skippedHidden.size;
      if (skippedIgnored.size > 0) details.skippedIgnored = skippedIgnored.size;

      return {
        content: [{ type: "text", text }],
        details,
      };
    },
  };
}
