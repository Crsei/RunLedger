/**
 * 流式 Markdown 的保守稳定前缀声明。
 *
 * 这里不负责解析或渲染 Markdown，只在硬空行边界上声明一段可以复用的
 * 原文前缀。误判只会损失缓存机会，因此所有无法证明的情况都保持可变。
 */

export interface SettledSpan {
  /** UTF-16 文本偏移；当前实现的 settled span 总是从正文开头开始。 */
  readonly start: number;
  /** UTF-16 exclusive end。 */
  readonly end: number;
  /** 对应的、未经改写的稳定正文前缀。 */
  readonly prefixText: string;
  /** 前缀中完整换行的数量，供行级缓存消费。 */
  readonly lineCount: number;
}

interface FenceState {
  readonly marker: "`" | "~";
  readonly length: number;
}

interface MathState {
  readonly close: string;
}

interface ListMarker {
  readonly bullet?: "*" | "+" | "-";
  readonly delimiter?: "." | ")";
}

const FENCE_LINE = /^( {0,3})(`{3,}|~{3,})(.*)$/u;
const LIST_ITEM = /^ {0,3}(?:([*+-])|\d{1,9}([.)]))(?:[ \t]+|$)/u;
const REFERENCE_DEFINITION = /^ {0,3}\[(?:\\.|[^\]\\])+\]:/mu;

/**
 * 返回当前文本中最大的、可声明为稳定的前缀。
 *
 * `previous` 是同一 append-only lineage 上一次的结果。若文本不再以旧
 * 前缀开头，函数返回 undefined，调用方必须丢弃旧缓存并重新开始判定。
 */
export function freezeStreamPrefix(text: string, previous?: SettledSpan): SettledSpan | undefined {
  if (previous !== undefined) {
    if (text.length < previous.end || !text.startsWith(previous.prefixText)) return undefined;
    if (text.length > 0 && text.includes("\r")) return previous;
  }
  if (text.includes("\r") || REFERENCE_DEFINITION.test(text)) return previous;

  const candidateEnd = findStableBoundary(text);
  if (candidateEnd === undefined) return previous;
  if (previous !== undefined && candidateEnd <= previous.end) return previous;

  const prefixText = text.slice(0, candidateEnd);
  return {
    start: 0,
    end: candidateEnd,
    prefixText,
    lineCount: countLines(prefixText),
  };
}

function findStableBoundary(text: string): number | undefined {
  let cursor = 0;
  let fence: FenceState | undefined;
  let math: MathState | undefined;
  let blockStart = 0;
  let best: number | undefined;

  while (cursor < text.length) {
    const newline = text.indexOf("\n", cursor);
    const hasNewline = newline >= 0;
    const lineEnd = hasNewline ? newline : text.length;
    const line = text.slice(cursor, lineEnd);
    const wasInsideFence = fence !== undefined;
    const wasInsideMath = math !== undefined;

    if (fence !== undefined) {
      if (isFenceClose(line, fence)) fence = undefined;
    } else if (math !== undefined) {
      if (line.trim() === math.close) math = undefined;
    } else {
      const nextFence = parseFenceOpen(line);
      if (nextFence !== undefined) fence = nextFence;
      else {
        const nextMath = parseMathOpen(line);
        if (nextMath !== undefined) math = nextMath;
      }
    }

    const lineAfter = hasNewline ? lineEnd + 1 : lineEnd;
    const isHardBlank = line.length === 0 && cursor > 0 && text[cursor - 1] === "\n";
    if (isHardBlank && !wasInsideFence && !wasInsideMath && fence === undefined && math === undefined) {
      const boundaryEnd = lineAfter;
      const next = text[boundaryEnd];
      if (next !== undefined && !isWhitespace(next)) {
        const list = listMarkerForBlock(text.slice(blockStart, cursor));
        if (list === undefined || !listMayContinueAt(text, boundaryEnd, list)) {
          best = boundaryEnd;
          blockStart = boundaryEnd;
        }
      }
    }

    if (!hasNewline) break;
    cursor = lineAfter;
  }

  return best;
}

function parseFenceOpen(line: string): FenceState | undefined {
  const match = FENCE_LINE.exec(line);
  if (match === null) return undefined;
  const marker = match[2]?.[0];
  if (marker !== "`" && marker !== "~") return undefined;
  return { marker, length: match[2]?.length ?? 0 };
}

function isFenceClose(line: string, fence: FenceState): boolean {
  const pattern = new RegExp(`^ {0,3}${escapeRegExp(fence.marker)}{${fence.length},}[ \\t]*$`, "u");
  return pattern.test(line);
}

function parseMathOpen(line: string): MathState | undefined {
  const trimmed = line.trim();
  if (trimmed === "$$") return { close: "$$" };
  if (trimmed === "\\[") return { close: "\\]" };
  const begin = /^\\begin\{([^}]+)\}$/u.exec(trimmed);
  if (begin !== null) return { close: `\\end{${begin[1]}}` };
  return undefined;
}

function listMarkerForBlock(block: string): ListMarker | undefined {
  const lines = block.split("\n");
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const match = LIST_ITEM.exec(line);
    if (match === null) return undefined;
    const bullet = match[1];
    if (bullet === "*" || bullet === "+" || bullet === "-") return { bullet };
    const delimiter = match[2];
    if (delimiter === "." || delimiter === ")") return { delimiter };
    return undefined;
  }
  return undefined;
}

function listMayContinueAt(text: string, tailStart: number, marker: ListMarker): boolean {
  let index = tailStart;
  let spaces = 0;
  while (index < text.length && spaces < 3 && text[index] === " ") {
    index += 1;
    spaces += 1;
  }
  if (index >= text.length) return true;

  if (marker.bullet !== undefined) {
    if (text[index] !== marker.bullet) return false;
    index += 1;
  } else {
    let digits = 0;
    while (index < text.length && digits < 10 && isDigit(text[index])) {
      index += 1;
      digits += 1;
    }
    if (digits === 0 || digits > 9) return false;
    if (index >= text.length) return true;
    if (text[index] !== marker.delimiter) return false;
    index += 1;
  }

  if (index >= text.length) return true;
  const afterMarker = text[index];
  return afterMarker === " " || afterMarker === "\t" || afterMarker === "\n";
}

function isDigit(value: string | undefined): boolean {
  return value !== undefined && value >= "0" && value <= "9";
}

function isWhitespace(value: string): boolean {
  return value === " " || value === "\t" || value === "\n";
}

function countLines(text: string): number {
  let count = 0;
  for (const character of text) {
    if (character === "\n") count += 1;
  }
  return count;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
