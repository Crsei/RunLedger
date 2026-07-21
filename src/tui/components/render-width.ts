import { sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** 把任意 ANSI/CJK 文本限制在终端列宽内。 */
export function fitToWidth(line: string, width: number): string {
  const safeWidth = Math.max(0, Math.floor(width));
  if (visibleWidth(line) <= safeWidth) return line;
  if (safeWidth === 0) return "";
  if (line.includes("\x1b")) return truncateToWidth(line, safeWidth, "…");
  return sliceByColumn(line, 0, Math.max(0, safeWidth - 1), true) + "…";
}

/** 限宽后补齐空格,用于需要覆盖上一帧内容的固定宽度行。 */
export function padToWidth(line: string, width: number): string {
  const safeWidth = Math.max(0, Math.floor(width));
  const fitted = fitToWidth(line, safeWidth);
  return fitted + " ".repeat(Math.max(0, safeWidth - visibleWidth(fitted)));
}

/** 自定义容器的最终防线:任何 child 都不能返回超出可见列宽的行。 */
export function fitLinesToWidth(lines: string[], width: number): string[] {
  return lines.map((line) => fitToWidth(line, width));
}
