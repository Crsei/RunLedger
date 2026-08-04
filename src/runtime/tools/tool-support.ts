/**
 * 工具集共享:截断与路径工具。
 *
 * 对齐 pi `core/tools/truncate.ts` 与 `core/tools/path-utils.ts`,但只保留
 * RunLedger 工具集实际依赖的最小子集:
 *   - DEFAULT_MAX_LINES / DEFAULT_MAX_BYTES 常量
 *   - TruncationResult / TruncationOptions 类型
 *   - truncateHead: 行/字节上限的头部截断
 *   - resolveToCwd 路径工具
 *
 * pi 同款语义,不引 TUI / highlight / process image 等扩展点。
 */

import * as path from "node:path";

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 300_000;

/**
 * 截断结果。pi 同款字段:
 *   - truncated: 是否触发截断
 *   - truncatedBy: "lines" | "bytes" | "lines-and-bytes"
 *   - outputLines: 实际输出行数
 *   - totalLines: 输入总行数
 *   - maxLines / maxBytes: 上限
 *   - firstLineExceedsLimit: 首行超字节上限的行号(供 read 工具给"用 bash sed"提示)
 */
export interface TruncationResult {
  truncated: boolean;
  truncatedBy?: "lines" | "bytes" | "lines-and-bytes";
  outputLines: number;
  totalLines: number;
  maxLines: number;
  maxBytes?: number;
  firstLineExceedsLimit?: number;
}

export interface TruncationOptions {
  maxLines?: number;
  maxBytes?: number;
  /** 首行超字节时也截断;返回 firstLineExceedsLimit */
  detectBytesPerLine?: boolean;
}

/**
 * 头部截断:按 maxLines 与 maxBytes 取前缀,超限标 truncated。
 *
 * 与 pi `truncate.ts:truncateHead` 语义对齐:
 *   - 同时给定 maxLines 与 maxBytes 时,谁先到谁优先(以 truncatedBy 标注)
 *   - maxBytes 在按"完整行"累加判定,不在行内截断
 *   - 检测到首行单行超 maxBytes 时,直接 truncated 且 firstLineExceedsLimit=1
 */
export function truncateHead(input: string, opts: TruncationOptions = {}): {
  text: string;
  truncation: TruncationResult;
} {
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const allLines = input === "" ? [] : input.split("\n");
  const totalLines = allLines.length;

  // 输出限额为正:取前 N 行
  const outLines: string[] = [];
  let outBytes = 0;
  let truncatedByLines = false;
  let truncatedByBytes = false;
  let firstLineExceedsLimit: number | undefined;
  let stoppedAt = allLines.length;

  for (let i = 0; i < allLines.length; i++) {
    const line = allLines[i]!;
    // 行计数:达到 maxLines 时停在第 maxLines 行(已加入)
    if (i >= maxLines) {
      truncatedByLines = true;
      stoppedAt = i;
      break;
    }
    const lineByteLength = Buffer.byteLength(line, "utf8");
    if (opts.detectBytesPerLine && lineByteLength > maxBytes && firstLineExceedsLimit === undefined) {
      firstLineExceedsLimit = i + 1;
    }
    if (outBytes + lineByteLength > maxBytes) {
      truncatedByBytes = true;
      stoppedAt = i;
      break;
    }
    outBytes += lineByteLength;
    outLines.push(line);
  }

  const truncated = truncatedByLines || truncatedByBytes || firstLineExceedsLimit !== undefined;
  let truncatedBy: TruncationResult["truncatedBy"];
  if (truncatedByLines && truncatedByBytes) truncatedBy = "lines-and-bytes";
  else if (truncatedByLines) truncatedBy = "lines";
  else if (truncatedByBytes) truncatedBy = "bytes";

  const text = outLines.join("\n");
  return {
    text,
    truncation: {
      truncated,
      truncatedBy,
      outputLines: outLines.length,
      totalLines,
      maxLines,
      maxBytes: opts.maxBytes,
      firstLineExceedsLimit,
    },
  };
}

/**
 * 把 rawPath 解析为相对 cwd 的绝对路径。
 * 空字符串返回 cwd 本身。
 * `~` 不展开(pi 在 `path-utils.ts` 单独 helper,本期不引)。
 */
export function resolveToCwd(rawPath: string | undefined, cwd: string): string {
  if (!rawPath || rawPath === "") return cwd;
  if (path.isAbsolute(rawPath)) return path.normalize(rawPath);
  return path.normalize(path.resolve(cwd, rawPath));
}
