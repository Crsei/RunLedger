/**
 * ToolResultComponent —— tool call 结果的"成功 / 失败"最终态块,在 ToolCallComponent 之后展示。
 *
 * 对照 development-doc/tui/02-component-spec.md §6 与 03-event-binding §1 表的 tool_execution_end。
 *
 * 设计:
 *   - 在 tool_execution_end 事件到达后由 InteractiveMode 创建并 push 到 chat;
 *   - 持有 toolCallId / toolName / isError / result.content 文本摘要;
 *   - render 单行,使用符号 ✓ / ✗ 区分成功错误;色盲安全(05 §2);
 *   - 当 isError=true 时,把 content 第一行作为错误摘要直接展示,不裁剪多余元数据。
 */

import type { Component } from "../index.ts";
import type { Theme } from "../theme/theme.ts";
import { visibleWidth } from "../index.ts";
import type { AgentToolResult } from "../../runtime/types.ts";

export interface ToolResultComponentProps {
  theme: Theme;
  toolCallId: string;
  toolName: string;
  result: AgentToolResult;
  isError: boolean;
  timestamp: number;
}

function extract(result: AgentToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
}

export class ToolResultComponent implements Component {
  private readonly props: ToolResultComponentProps;

  constructor(props: ToolResultComponentProps) {
    this.props = props;
  }

  invalidate(): void {
    // 无缓存
  }

  render(width: number): string[] {
    void this.props.theme;
    const icon = this.props.isError ? "✗" : "✓";
    const text = extract(this.props.result);
    const oneLine = (text.split("\n")[0] ?? "").trim();
    const prefix = `${icon} ${this.props.toolName} `;
    const available = Math.max(0, width - prefix.length - 1);
    const trimmed = oneLine.length > available ? oneLine.slice(0, available - 1) + "…" : oneLine;
    const line = prefix + trimmed;
    if (visibleWidth(line) <= width) return [line];
    return [line.slice(0, Math.max(0, width - 1)) + "…"];
  }
}
