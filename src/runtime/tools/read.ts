/**
 * read 工具 —— 读文件内容,带行选择器、行/字节截断 + 可选 cat -n 行号 + mtime 去重缓存。
 *
 * 对齐 pi `core/tools/read.ts` 与 claude-code-bun docs/tools/read-tool.mdx:
 *   - 默认 `cat -n` 行号格式 `右对齐6位 + tab + 内容`,与 GNU cat -n 一致
 *   - mtime 去重缓存:同 mtimeMs 的重复 read 直接走缓存的 text buffer,不重复 I/O。
 *     缓存键 = absolutePath,条目值 = { mtimeMs, text }。
 *     缓存共享于 createReadTool 工厂之内;不同 tool 实例不共享(测试隔离)。
 *
 * 行选择器内联在 path 尾部(对齐 oh-my-pi 的 read 调用形态):
 *   `src/foo.ts:50-200`、`src/foo.ts:-60`(末尾 60 行)、`src/foo.ts:120`、
 *   `src/foo.ts:1-50:raw`(去行号)、`src/foo.ts:5-16,960-973`(多段)。
 *   选择器与显式 offset/limit 同时给出时以选择器为准,并在 details 记录。
 *
 * 不支持的 read 模式(`:conflicts` / `:img`)与非法选择器一律 throw —— 由
 * agent-loop 转 isError,避免静默放宽成整文件读取。
 */

import { Type } from "typebox";
import type { Static } from "typebox";
import type { AgentTool, AgentToolResult } from "../types.ts";
import { localReadOperations } from "./local-defaults.ts";
import {
  isRawSelector,
  parseSel,
  resolveTailSelector,
  splitPathAndSel,
  type ResolvedSelector,
} from "./read-selector.ts";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  resolveToCwd,
  truncateHead,
  type TruncationResult,
} from "./tool-support.ts";
import { looksLikeArchiveBytes, parseArchiveReadTarget, readArchiveBytes } from "./read-archive.ts";
import {
  isOfficeDocumentSizeAllowed,
  parseOfficeReadTarget,
  readOfficeBytes,
} from "./read-office.ts";
import { looksLikeSqlite, parseSqliteReadTarget, readSqliteBytes } from "./read-sqlite.ts";

export const readSchema = Type.Object({
  path: Type.String({
    description:
      "要读的文件路径(相对或绝对),可在尾部内联行选择器:`file:A-B`、`file:-N`(末尾 N 行)、`file:A-B:raw`(去行号)、`file:5-16,960-973`(多段)。",
  }),
  offset: Type.Optional(Type.Number({ description: "起始行号 (1-indexed);与选择器同时给出时选择器优先。" })),
  limit: Type.Optional(Type.Number({ description: "最多读取行数;与选择器同时给出时选择器优先。" })),
  lineNumbers: Type.Optional(
    Type.Boolean({ description: "是否在每行行首加 cat -n 风格行号;缺省 true。选择器带 :raw 时为 false。" }),
  ),
  noCache: Type.Optional(
    Type.Boolean({ description: "跳过 mtime 去重缓存,强制重新读盘;缺省 false。" }),
  ),
});

export type ReadToolInput = Static<typeof readSchema>;

/** read details —— pi 同款:仅承载 truncation 信息。 */
export interface ReadToolDetails {
  /** 每次执行均报告 Runtime source 截断边界，供安全 presentation 区分来源。 */
  truncation: TruncationResult;
  /** 返回给 Agent 的正文行数（不含 continuation hint）。 */
  lineCount: number;
  /** 命中 mtime 去重缓存;UI / ledger 可选消费 */
  cacheHit?: boolean;
  /** 本次生效的行选择器原文(未给出则不设置)。 */
  selector?: string;
  /** 选择器生效时被忽略的 offset/limit 参数名,便于模型纠正调用。 */
  ignoredParams?: readonly string[];
  /** 本次走的是非文本分支(sqlite 库 / 归档);缺省为普通文本读取。 */
  media?: "sqlite" | "archive" | "office";
}

/** 可替换 IO;默认走 node:fs。便于测试注入 / 远端代理。 */
export interface ReadOperations {
  readFile: (absolutePath: string) => Promise<Buffer>;
  access: (absolutePath: string) => Promise<void>;
  stat: (absolutePath: string) => Promise<{ mtimeMs: number; size?: number }>;
}

/** read 默认 ops:本地 fs;生产由 createStdlibTools 注入 governed env。 */
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
 * 按行切分并丢弃"末尾换行哨兵"。`"a\nb\n"` 是两行而不是三行;`"a\n\n"` 的第二个
 * 空行是真实空行,保留。选择器与 `:-N` 的行号都依赖这个行模型。
 */
function splitAddressableLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  return lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
}

/**
 * cat -n 格式化:右对齐 6 位行号 + tab + 内容。
 * 行号超过 6 位时自然溢出(GNU cat -n 也是动态宽度,6 位对齐覆盖到 999999 行)。
 */
function formatLineNumber(lineNo: number, line: string): string {
  return `${String(lineNo).padStart(6, " ")}\t${line}`;
}

/**
 * 按定型后的选择器切片。多段选择器逐段切片;带行号时天然可辨识边界,不带行号时
 * 用 `[...]` 分隔行标出省略区间,避免两段被误读成连续内容。
 */
function sliceBySelector(
  allLines: readonly string[],
  selector: ResolvedSelector,
  addLineNumbers: boolean,
): { lines: string[]; firstLine: number } {
  if (selector.kind !== "lines") return { lines: [...allLines], firstLine: 1 };
  const out: string[] = [];
  let firstLine = 0;
  for (const range of selector.ranges) {
    const start = Math.max(1, range.startLine);
    const end = Math.min(range.endLine ?? allLines.length, allLines.length);
    if (end < start) continue;
    if (firstLine === 0) firstLine = start;
    if (out.length > 0 && !addLineNumbers) out.push(`[...]`);
    for (let lineNo = start; lineNo <= end; lineNo += 1) {
      const line = allLines[lineNo - 1] ?? "";
      out.push(addLineNumbers ? formatLineNumber(lineNo, line) : line);
    }
  }
  return { lines: out, firstLine: firstLine === 0 ? 1 : firstLine };
}

/** 将已解码文本统一套用 `read` 的选择器、行号与截断语义。 */
function renderTextResult(
  text: string,
  rawPath: string,
  absolutePath: string,
  params: ReadToolInput,
  options: { cacheHit?: boolean; media?: ReadToolDetails["media"] } = {},
): AgentToolResult<ReadToolDetails> {
  const { offset, limit } = params;
  const split = splitPathAndSel(rawPath);
  const parsed = parseSel(split.sel);
  const hasSelector = parsed.kind !== "none";
  const addLineNumbers = hasSelector
    ? !isRawSelector(parsed) && (params.lineNumbers ?? true)
    : (params.lineNumbers ?? true);
  const allLines = splitAddressableLines(text);

  let displayLines: string[];
  let startLine: number;
  let maxLines: number;
  if (hasSelector) {
    const resolved = resolveTailSelector(parsed, allLines.length);
    const sliced = sliceBySelector(allLines, resolved, addLineNumbers);
    displayLines = sliced.lines;
    startLine = sliced.firstLine - 1 + sliced.lines.length;
    maxLines = Number.MAX_SAFE_INTEGER;
  } else {
    const rawStartLine = (offset ?? 1) - 1;
    const sliceEnd = limit !== undefined ? rawStartLine + limit : allLines.length;
    const sliced = allLines.slice(Math.max(0, rawStartLine), Math.max(0, sliceEnd));
    const base = offset ?? 1;
    displayLines = addLineNumbers
      ? sliced.map((line, index) => formatLineNumber(base + index, line))
      : sliced;
    startLine = rawStartLine + sliced.length;
    maxLines = limit ?? DEFAULT_MAX_LINES;
  }
  const { text: outText, truncation } = truncateHead(displayLines.join("\n"), {
    maxLines,
    maxBytes: DEFAULT_MAX_BYTES,
    detectBytesPerLine: true,
  });
  const hints: string[] = [];
  if (truncation.truncated) {
    if (truncation.firstLineExceedsLimit) {
      hints.push(
        `Line ${truncation.firstLineExceedsLimit} exceeds byte limit; use \`bash sed -n '${truncation.firstLineExceedsLimit}p' ${absolutePath} | head -c ${DEFAULT_MAX_BYTES}\` to read it.`,
      );
    } else {
      hints.push(`Use \`offset=${startLine}\` to continue reading.`);
    }
  }
  const details: ReadToolDetails = { truncation, lineCount: truncation.outputLines };
  if (options.cacheHit) details.cacheHit = true;
  if (options.media !== undefined) details.media = options.media;
  if (hasSelector) {
    details.selector = split.sel;
    const ignored: string[] = [];
    if (offset !== undefined) ignored.push("offset");
    if (limit !== undefined) ignored.push("limit");
    if (ignored.length > 0) details.ignoredParams = ignored;
  }
  return {
    content: [{ type: "text", text: hints.length === 0 ? outText : `${outText}\n\n${hints.join("\n")}` }],
    details,
  };
}

export function createReadTool(
  cwd: string,
  options: ReadToolOptions = {},
): AgentTool<typeof readSchema, ReadToolDetails> {
  const ops = options.operations ?? localReadOperations();
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
    description: `读取文件内容,按行/字节截断。默认上限 ${DEFAULT_MAX_LINES} 行 / ${DEFAULT_MAX_BYTES} 字节。path 尾部可内联行选择器,如 file:50-200、file:-60、file:1-50:raw、file:5-16,960-973。`,
    parameters: readSchema,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(_toolCallId, params, _signal?): Promise<AgentToolResult<ReadToolDetails>> {
      const { path: rawPath, offset, limit } = params;
      const noCache = params.noCache === true;

      // 类型分派必须先于行选择器解析：`a.zip:inner` 与 `db.sqlite:users` 里的
      // `inner`/`users` 会被 splitPathAndSel 当成选择器语法吞掉（见 read-selector
      // 的 isRangeOrTailChunk）。命中则整串交给对应分支，否则走既有文本路径。
      // `parseArchiveReadTarget` 自身就是形状判定（按归档扩展名切出成员路径），
      // 不要再用「整串是否以归档扩展名结尾」做前置门：`a.zip:inner` 的末尾是
      // 成员名，那样的门会把所有带成员的读取挡掉。
      // 形状命中后还要做字节嗅探：一个恰好叫 `notes.zip` 的文本文件必须回落文本，
      // 而不是被当成归档报错（与 sqlite 的魔数判定同款纪律）。未命中时**不 return**，
      // 让控制流继续走下面的文本路径。
      const archiveTarget = parseArchiveReadTarget(rawPath);
      const archiveBytes = archiveTarget === null
        ? undefined
        : await (async () => {
            const archivePath = resolveToCwd(archiveTarget.archivePath, cwd);
            await ops.access(archivePath);
            return ops.readFile(archivePath);
          })();
      if (archiveTarget !== null && archiveBytes !== undefined && looksLikeArchiveBytes(archiveBytes)) {
        const rendered = await readArchiveBytes(archiveBytes, archiveTarget.subPath);
        const { text: archiveText, truncation: archiveTruncation } = truncateHead(rendered.text, {
          maxLines: DEFAULT_MAX_LINES,
          maxBytes: DEFAULT_MAX_BYTES,
        });
        return {
          content: [{ type: "text", text: archiveText }],
          details: {
            truncation: archiveTruncation,
            lineCount: archiveTruncation.outputLines,
            media: "archive",
          },
        };
      }

      // sqlite 也有自有冒号语法（`db.sqlite:users`、`db.sqlite:users:1`、
      // `db.sqlite?q=SELECT 1`），同样必须先于行选择器解析切分——否则
      // `users:1` 会被 `splitPathAndSel` 拆成 path=`db.sqlite:users`。
      const sqliteTarget = parseSqliteReadTarget(rawPath);
      if (sqliteTarget !== null) {
        const sqlitePath = resolveToCwd(sqliteTarget.dbPath, cwd);
        await ops.access(sqlitePath);
        const raw = await ops.readFile(sqlitePath);
        // 后缀命中但魔数不符（例如一个恰好叫 `notes.db` 的文本文件）→ 回落到
        // 普通文本路径，绝不因为扩展名就把文本当数据库打开。
        if (looksLikeSqlite(raw)) {
          const rendered = readSqliteBytes(raw, sqliteTarget.selector);
          const { text: sqliteText, truncation: sqliteTruncation } = truncateHead(rendered.text, {
            maxLines: DEFAULT_MAX_LINES,
            maxBytes: DEFAULT_MAX_BYTES,
          });
          return {
            content: [{ type: "text", text: sqliteText }],
            details: {
              truncation: sqliteTruncation,
              lineCount: sqliteTruncation.outputLines,
              media: "sqlite",
            },
          };
        }
      }

      // Office/EPUB 容器的选择器属于转换后的 Markdown，而不是 ZIP 成员路径。
      // 先按既有选择器规则切出真实文件名，再检查 ZIP magic；伪造扩展名仍按文本
      // 读取，已确认的异常 ZIP 则必须以转换错误结束，不能静默泄漏二进制正文。
      const officeSplit = splitPathAndSel(rawPath);
      const officeTarget = parseOfficeReadTarget(officeSplit.path);
      if (officeTarget !== null) {
        const officePath = resolveToCwd(officeTarget.path, cwd);
        const officeStat = await ops.stat(officePath);
        if (officeStat.size !== undefined && !isOfficeDocumentSizeAllowed(officeStat.size)) {
          throw new Error(`Document exceeds Office/EPUB ${8 * 1024 * 1024} byte input limit`);
        }
        const officeBytes = await ops.readFile(officePath);
        if (looksLikeArchiveBytes(officeBytes)) {
          const rendered = await readOfficeBytes(officeBytes, officeTarget.format);
          return renderTextResult(rendered.text, rawPath, officePath, params, { media: "office" });
        }
      }

      // Path resolution is lexical here; a governed operations port performs
      // canonicalization and policy checks before touching the filesystem.
      const absolutePath = resolveToCwd(officeSplit.path, cwd);
      await ops.access(absolutePath);

      // mtime 去重缓存
      let text: string;
      let cacheHit = false;
      let bytes: Buffer | undefined;
      if (enableCache && !noCache) {
        const stat = await ops.stat(absolutePath);
        const cached = cacheGet(absolutePath);
        if (cached && cached.mtimeMs === stat.mtimeMs) {
          text = cached.text;
          cacheHit = true;
        } else {
          bytes = await ops.readFile(absolutePath);
          text = bytes.toString("utf8");
          cacheSet(absolutePath, { mtimeMs: stat.mtimeMs, text });
        }
      } else {
        bytes = await ops.readFile(absolutePath);
        text = bytes.toString("utf8");
      }

      return renderTextResult(text, rawPath, absolutePath, params, { cacheHit });
    },
  };
}
