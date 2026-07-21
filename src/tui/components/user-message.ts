/**
 * UserMessageComponent —— 单条用户输入的渲染块,带 OSC 133 包裹标记。
 *
 * 对照 development-doc/tui/02-component-spec.md §4 与 04-rendering.md §6 OSC 133。
 *
 * 设计:
 *   - 持有单条用户文本(text 纯字符串);
 *   - render 输出 OSC 133 集成区开始 + 文本 + 集成区结束 + 空行视觉留白;
 *   - 不需要 Markdown 渲染(用户输入是纯文本,但保留 setText 入口以备后续 SSE 注入);
 *   - OSC 133 标记字符:
 *       C: \x1b]133;C\x07   (输入开始)
 *       D: \x1b]133;D\x07   (输入结束)
 */

import type { Component } from "../index.ts";
import type { Theme } from "../theme/theme.ts";
import { visibleWidth } from "../index.ts";

export interface UserMessageComponentProps {
  theme: Theme;
  text: string;
  timestamp: number;
}

const OSC_INTERACTIVE_START = "\x1b]133;C\x07";
const OSC_INTERACTIVE_END = "\x1b]133;D\x07";

export class UserMessageComponent implements Component {
  private text: string;
  private readonly timestamp: number;

  constructor(props: UserMessageComponentProps) {
    this.text = props.text;
    this.timestamp = props.timestamp;
  }

  invalidate(): void {
    // 无缓存
  }

  setText(text: string): void {
    this.text = text;
  }

  render(width: number): string[] {
    const lines: string[] = [];
    lines.push(OSC_INTERACTIVE_START);
    // 简单按 width 截断并补齐:多行用户输入本期按单行处理,M6 再做 wrapping
    const visible = visibleWidth(this.text);
    const display = visible <= width ? this.text : this.text.slice(0, Math.max(0, width - 1)) + "…";
    lines.push(display);
    lines.push(OSC_INTERACTIVE_END);
    lines.push("");
    void this.timestamp;
    return lines;
  }
}
