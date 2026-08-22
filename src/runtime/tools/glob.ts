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
import { resolveToCwd, truncateHead, DEFAULT_MAX_BYTES, type TruncationResult } from "./tool-support.ts";

export const globSchema = Type.Object({
  pattern: Type.String({
    description:
      "Glob pattern,支持 * / ** / ?;不支持字符集 [abc]。例:src/**/*.ts",
  }),
  path: Type.Optional(Type.String({ description: "搜索根目录;缺省 cwd" })),
  limit: Type.Optional(Type.Number({ description: "结果条目上限,默认 100" })),
});

export type GlobToolInput = Static<typeof globSchema>;

export interface GlobToolDetails {
  matchCount: number;
  truncation?: TruncationResult;
  /** 命中条目达到 limit 时为 true,见 details.matchCount == limit */
  limitReached?: boolean;
}

export interface GlobOperations {
  readdir: (p: string) => Promise<string[]>;
  stat: (p: string) => Promise<{ isDirectory: boolean; mtimeMs: number; isSymbolicLink: boolean }>;
}

/** glob 默认 ops:本地 fs;生产由 createStdlibTools 注入 governed env。 */
export interface GlobToolOptions {
	operations?: GlobOperations;
	/** settings 注入的默认结果上限；调用参数 limit 仍优先。 */
	defaultLimit?: number;
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
	const defaultLimit = options.defaultLimit ?? DEFAULT_LIMIT;
  return {
    name: "glob",
    label: "glob",
    description:
      "按 glob pattern 查找文件路径。第一方手写 ** 递归;默认跳过 .git / node_modules;按 mtime desc 排序。",
    parameters: globSchema,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(_toolCallId, params, _signal?): Promise<AgentToolResult<GlobToolDetails>> {
      const root = resolveToCwd(params.path ?? "", cwd);
		const limit = params.limit ?? defaultLimit;
      const segs = parsePattern(params.pattern);
      const compiledStarsiSegs = segs.map((s) =>
        s.kind === "star-any" && s.literal ? compileStarAnySeg(s.literal) : null,
      );

      const matches: Array<{ path: string; mtimeMs: number }> = [];

      /**
       * 语义:pattern 在 root 之下的相对路径上匹配。即 basename(child) 必须匹配
       * 当前 seg,而非 fsPath 本身的 basename。
       *
       * 入口 walk(dir, idx):遍历 dir 下子项,逐个 basename 与 segs[idx] 匹配。
       *   - 命中且 idx==last:collect(if 文件)
       *   - 命中且 idx<last:子项 must be dir → walk(child, idx+1)
       *   - `**` 段:walk(dir, idx+1)(.consume 0) + 每个 dir 子项 walk(c, idx)(consume1+)
       */
      async function walk(dir: string, idx: number): Promise<void> {
        if (matches.length >= limit) return;
        // 边界:idx 已超出 segs.end
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
          const childPath = path.join(dir, name);
          let st: Awaited<ReturnType<typeof ops.stat>> | null = null;
          try {
            st = await ops.stat(childPath);
          } catch {
            continue;
          }
          if (st.isSymbolicLink) continue;
          const seg = segs[idx]!;
          if (seg === undefined) {
            // idx 已超出(seg 已用尽),child 视为收尾 → 不收 dir
            if (!st.isDirectory) {
              matches.push({ path: childPath, mtimeMs: st.mtimeMs });
            }
            continue;
          }
          if (seg.kind === "double-star") {
            // ** 可吃 0 段(在 child 上递归 walk(dir, idx+1)) 或吃 1 段(walk(child, idx))
            // 我们在 dir 旁路推进(0-consume):walk(dir, idx+1) 在外层 loop 外做。
            // 此处只做"吃 1 段":递归到 child 上,继续看 ** 是否还要吃。
            if (st.isDirectory) {
              await walk(childPath, idx);
            }
            continue;
          }
          // literal / star-any:child 的 basename 必须匹配此段
          let matched = false;
          if (seg.kind === "literal") {
            matched = name === seg.literal;
          } else if (compiledStarsiSegs[idx] != null) {
            matched = compiledStarsiSegs[idx]!.test(name);
          }
          if (!matched) continue;
          if (idx === segs.length - 1) {
            // 末段命中;只收文件,跳过目录
            if (!st.isDirectory) {
              matches.push({ path: childPath, mtimeMs: st.mtimeMs });
            }
            continue;
          }
          // idx < end:必须是目录才能继续往下匹配
          if (st.isDirectory) {
            await walk(childPath, idx + 1);
          }
        }
        // ** 吃 0 段:在 walk 入口处也尝试推进 idx+1(只 ** 段触发,避免无谓递归)
        const lastSeg = segs[idx]!;
        if (lastSeg && lastSeg.kind === "double-star" && idx < segs.length - 1) {
          await walk(dir, idx + 1);
        }
      }

      // 顶部:如果第一个 seg 是 `**`,walk(root, 0) 自身已经迭代;
      // 如果第一个 seg 是 normal literal/star-any,walk(root, 0) 同样工作(列 root 下子项,匹配首段)。
      await walk(root, 0);

      // 按 mtime desc 排序
      matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
      // 截到 limit
      const limited = matches.slice(0, limit);
      const limitReached = matches.length >= limit;
      // 路径 posix 化
      const lines = limited.map((m) => m.path.split("\\").join("/"));
      const { text, truncation } = truncateHead(lines.join("\n"), {
        maxLines: Number.MAX_SAFE_INTEGER,
        maxBytes: DEFAULT_MAX_BYTES,
      });
      const details: GlobToolDetails = {
        matchCount: lines.length,
      };
      if (truncation.truncated) details.truncation = truncation;
      if (limitReached) details.limitReached = true;

      return {
        content: [{ type: "text", text }],
        details,
        terminate: false,
      };
    },
  };
}
