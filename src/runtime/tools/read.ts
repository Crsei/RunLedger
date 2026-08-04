/**
 * read 工具 —— 读文件内容,带行/字节截断 + 可选 cat -n 行号 + mtime 去重缓存。
 *
 * 对齐 pi `core/tools/read.ts` 与 claude-code-bun docs/tools/read-tool.mdx:
 *   - 默认 `cat -n` 行号格式 `右对齐6位 + tab + 内容`,与 GNU cat -n 一致
 *   - mtime 去重缓存:同 mtimeMs 的重复 read 直接走缓存的 text buffer,不重复 I/O。
 *     缓存键 = absolutePath,条目值 = { mtimeMs, text }。
 *     缓存共享于 createReadTool 工厂之内;不同 tool 实例不共享(测试隔离)。
 *
 * 行为:`{ path, offset?, limit?, lineNumbers?, noCache? }` →
 *   stat(mtimeMs) →
 *   缓存命中?cached.text : readFile → toString(utf8) →
 *   split("\n") → 切片 → 可选 cat -n → truncateHead →
 *   截断 hint → 返回 content[{type:text}] + details.truncation。
 */

import { Type } from "typebox";
import type { Static } from "typebox";
import type { AgentTool, AgentToolResult } from "../types.ts";
import { localExecutionEnv } from "../execution-env.ts";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  resolveToCwd,
  truncateHead,
  type TruncationResult,
} from "./tool-support.ts";

export const readSchema = Type.Object({
  path: Type.String({ description: "要读的文件路径(相对或绝对)" }),
  offset: Type.Optional(Type.Number({ description: "起始行号 (1-indexed)" })),
  limit: Type.Optional(Type.Number({ description: "最多读取行数" })),
  lineNumbers: Type.Optional(
    Type.Boolean({ description: "是否在每行行首加 cat -n 风格行号;缺省 true。" }),
  ),
  noCache: Type.Optional(
    Type.Boolean({ description: "跳过 mtime 去重缓存,强制重新读盘;缺省 false。" }),
  ),
});

export type ReadToolInput = Static<typeof readSchema>;

/** read details —— pi 同款:仅承载 truncation 信息。 */
export interface ReadToolDetails {
  truncation?: TruncationResult;
  /** 命中 mtime 去重缓存;UI / ledger 可选消费 */
  cacheHit?: boolean;
}

/** 可替换 IO;默认走 node:fs。便于测试注入 / 远端代理。 */
export interface ReadOperations {
  readFile: (absolutePath: string) => Promise<Buffer>;
  access: (absolutePath: string) => Promise<void>;
  stat: (absolutePath: string) => Promise<{ mtimeMs: number }>;
}

const defaultReadOperations: ReadOperations = {
  readFile: (p) => localExecutionEnv().fs.readFile(p),
  access: async (p) => { await localExecutionEnv().fs.stat(p); },
  stat: async (p) => ({ mtimeMs: (await localExecutionEnv().fs.stat(p)).mtimeMs }),
};

export interface ReadToolOptions {
  operations?: ReadOperations;
  /** 是否启用 mtime 去重缓存;缺省 true。 */
  enableCache?: boolean;
  /** 缓存容量上限(LRU);缺省 64 条。 */
  cacheLimit?: number;
}

interface CacheEntry {
  mtimeMs: number;
  text: string;
}

/**
 * cat -n 格式化:右对齐 6 位行号 + tab + 内容。
 * 行号超过 6 位时自然溢出(GNU cat -n 也是动态宽度,6 位对齐覆盖到 999999 行)。
 */
function formatLineNumber(lineNo: number, line: string): string {
  return `${String(lineNo).padStart(6, " ")}\t${line}`;
}

export function createReadTool(
  cwd: string,
  options: ReadToolOptions = {},
): AgentTool<typeof readSchema, ReadToolDetails> {
  const ops = options.operations ?? defaultReadOperations;
  const enableCache = options.enableCache ?? true;
  const cacheLimit = options.cacheLimit ?? 64;
  // 简单 LRU:Map insertion order,LRU 通过 delete+set 实现
  const cache = new Map<string, CacheEntry>();

  function cacheGet(p: string): CacheEntry | undefined {
    const e = cache.get(p);
    if (e === undefined) return undefined;
    // re-insert at end (LRU)
    cache.delete(p);
    cache.set(p, e);
    return e;
  }
  function cacheSet(p: string, e: CacheEntry): void {
    if (cache.size >= cacheLimit && !cache.has(p)) {
      // evict oldest
      const firstKey = cache.keys().next().value;
      if (firstKey !== undefined) cache.delete(firstKey);
    }
    cache.set(p, e);
  }

  return {
    name: "read",
    label: "read",
    description: `读取文件内容,按行/字节截断。默认上限 ${DEFAULT_MAX_LINES} 行 / ${DEFAULT_MAX_BYTES} 字节。`,
    parameters: readSchema,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(_toolCallId, params, _signal?): Promise<AgentToolResult<ReadToolDetails>> {
      const { path: rawPath, offset, limit } = params;
      const addLineNumbers = params.lineNumbers ?? true;
      const noCache = params.noCache === true;
      // Path resolution is lexical here; a governed operations port performs
      // canonicalization and policy checks before touching the filesystem.
      const absolutePath = resolveToCwd(rawPath, cwd);
      await ops.access(absolutePath);

      // mtime 去重缓存
      let text: string;
      let cacheHit = false;
      if (enableCache && !noCache) {
        const stat = await ops.stat(absolutePath);
        const cached = cacheGet(absolutePath);
        if (cached && cached.mtimeMs === stat.mtimeMs) {
          text = cached.text;
          cacheHit = true;
        } else {
          const buf = await ops.readFile(absolutePath);
          text = buf.toString("utf8");
          cacheSet(absolutePath, { mtimeMs: stat.mtimeMs, text });
        }
      } else {
        const buf = await ops.readFile(absolutePath);
        text = buf.toString("utf8");
      }

      const allLines = text === "" ? [] : text.split("\n");
      const startLine = (offset ?? 1) - 1;
      const sliceEnd = limit !== undefined ? startLine + limit : allLines.length;
      const sliced = allLines.slice(Math.max(0, startLine), Math.max(0, sliceEnd));

      // cat -n 前缀只能在输出时加工,不污染切片逻辑。
      let displayLines: string[];
      if (addLineNumbers) {
        const base = offset ?? 1;
        displayLines = sliced.map((ln, i) => formatLineNumber(base + i, ln));
      } else {
        displayLines = sliced;
      }
      const joined = displayLines.join("\n");

      const maxLines = limit ?? DEFAULT_MAX_LINES;
      const { text: outText, truncation } = truncateHead(joined, {
        maxLines,
        maxBytes: DEFAULT_MAX_BYTES,
        detectBytesPerLine: true,
      });

      // 截断附 hint
      let displayText = outText;
      const hints: string[] = [];
      if (truncation.truncated) {
        if (truncation.firstLineExceedsLimit) {
          hints.push(
            `Line ${truncation.firstLineExceedsLimit} exceeds byte limit; use \`bash sed -n '${truncation.firstLineExceedsLimit}p' ${absolutePath} | head -c ${DEFAULT_MAX_BYTES}\` to read it.`,
          );
        } else if (
          truncation.truncatedBy === "bytes" ||
          truncation.truncatedBy === "lines-and-bytes"
        ) {
          hints.push(`Use \`offset=${startLine + sliced.length}\` to continue reading.`);
        } else if (truncation.truncatedBy === "lines") {
          hints.push(`Use \`offset=${startLine + sliced.length}\` to continue reading.`);
        }
      }
      if (hints.length > 0) {
        displayText = `${outText}\n\n${hints.join("\n")}`;
      }

      const details: ReadToolDetails = {};
      if (truncation.truncated) details.truncation = truncation;
      if (cacheHit) details.cacheHit = true;
      return {
        content: [{ type: "text", text: displayText }],
        details,
      };
    },
  };
}
