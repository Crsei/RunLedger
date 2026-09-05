/** 纯终端文本测量与折行；不依赖 renderer、组件或 Session。 */

import stringWidth from "string-width";
import stripAnsi from "strip-ansi";

const ESCAPE_PATTERN = /(?:\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)|\x1B\[[0-?]*[ -\/]*[@-~]|\x1B_[^\x07]*\x07)/gu;
export function visibleWidth(value: string): number { return stringWidth(stripAnsi(value.replace(ESCAPE_PATTERN, ""))); }
function tokenize(value: string): string[] {
  const tokens: string[] = [];
  let offset = 0;
  for (const match of value.matchAll(ESCAPE_PATTERN)) {
    if (match.index > offset) tokens.push(...Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value.slice(offset, match.index)), (entry) => entry.segment));
    tokens.push(match[0]);
    offset = match.index + match[0].length;
  }
  if (offset < value.length) tokens.push(...Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value.slice(offset)), (entry) => entry.segment));
  return tokens;
}
export function sliceByColumn(value: string, start: number, end = Number.POSITIVE_INFINITY, _preserveAnsi = false): string {
  let column = 0;
  let result = "";
  for (const token of tokenize(value)) {
    const width = visibleWidth(token);
    if (width === 0) { if (column >= start && column < end) result += token; continue; }
    if (column >= start && column + width <= end) result += token;
    column += width;
    if (column >= end) break;
  }
  return result;
}
export function truncateToWidth(value: string, width: number, ellipsis = ""): string {
  if (visibleWidth(value) <= width) return value;
  const suffix = visibleWidth(ellipsis) <= width ? ellipsis : "";
  const body = sliceByColumn(value, 0, Math.max(0, width - visibleWidth(suffix)), true);
  return body + suffix + (value.includes("\x1b[") ? "\x1b[0m" : "");
}
export function wrapTextWithAnsi(value: string, width: number): string[] {
  if (width <= 0) return [""];
  const lines: string[] = [];
  for (const source of value.split("\n")) {
    let line = "";
    let columns = 0;
    for (const token of tokenize(source)) {
      const tokenWidth = visibleWidth(token);
      if (tokenWidth > 0 && columns > 0 && columns + tokenWidth > width) {
        lines.push(line);
        line = "";
        columns = 0;
      }
      // 宽字符不可切开；极窄宽度下独占一行，保留正文而不丢弃字符。
      line += token;
      columns += tokenWidth;
    }
    lines.push(line);
  }
  return lines;
}
export function hyperlink(text: string, url: string): string { return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`; }
