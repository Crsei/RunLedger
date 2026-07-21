/**
 * ToolCallComponent —— 单个 toolCall 的折叠渲染块,展示调用态/状态/结果文本。
 *
 * 对照 development-doc/tui/02-component-spec.md §6 与 §9 折叠机制。
 *
 * 设计:
 *   - 持有 toolCallId / toolName / status (pending|running|ok|error) / partialResult;
 *   - render(width) 单行,带状态图标与截断的结果摘要;
 *   - 失败护栏:任何 setter 抛错时回退显示 "[toolcall:err]" 行;
 *   - 不渲染参数 JSON 或 details(M3 阶段折叠;C-R 按 o 展开 DiffPreview 是 M3+ 扩展接口);
 *   - 状态图标:pending=⏳ running=… ok=✓ error=✗(不依赖颜色,纯 ASCII,符合 05 §2 色盲安全)。
 */

import type { Component } from "../index.ts";
import type { Theme } from "../theme/theme.ts";
import { visibleWidth } from "../index.ts";
import type { AgentToolResult } from "../../runtime/types.ts";

export type ToolCallStatus = "pending" | "running" | "ok" | "error";

export interface ToolCallComponentProps {
  theme: Theme;
  toolCallId: string;
  toolName: string;
  initialStatus?: ToolCallStatus;
}

const STATUS_ICON: Record<ToolCallStatus, string> = {
  pending: "⏳",
  running: "…",
  ok: "✓",
  error: "✗",
};

export class ToolCallComponent implements Component {
  private readonly theme: Theme;
  private readonly toolCallId: string;
  private readonly toolName: string;
  private status: ToolCallStatus;
  private partialResult: AgentToolResult | undefined;
  private errorMessage: string | undefined;

  constructor(props: ToolCallComponentProps) {
    this.theme = props.theme;
    this.toolCallId = props.toolCallId;
    this.toolName = props.toolName;
    this.status = props.initialStatus ?? "pending";
  }

  invalidate(): void {
    // 无缓存
  }

  setStatus(status: ToolCallStatus): void {
    this.status = status;
  }

  setPartialResult(partial: AgentToolResult): void {
    this.partialResult = partial;
  }

  setError(message: string): void {
    this.errorMessage = message;
    this.status = "error";
  }

  finalize(result: AgentToolResult, isError: boolean): void {
    this.partialResult = result;
    this.status = isError ? "error" : "ok";
    if (isError) {
      this.errorMessage = this.extractError(result);
    }
  }

  private extractError(result: AgentToolResult): string {
    const text = result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("");
    return text;
  }

  render(width: number): string[] {
    void this.theme;
    const icon = STATUS_ICON[this.status];
    let summary = this.toolName;
    if (this.status === "ok" || this.status === "error") {
      const text = this.extractTextResult();
      if (text.length > 0) {
        const oneLine = text.split("\n")[0] ?? "";
        const maxLen = Math.max(0, width - summary.length - 4);
        const trimmed = oneLine.length > maxLen ? oneLine.slice(0, maxLen - 1) + "…" : oneLine;
        summary += " " + trimmed;
      }
    }
    if (this.status === "error" && this.errorMessage) {
      const maxLen = Math.max(0, width - summary.length - 4);
      const trimmed = this.errorMessage.length > maxLen ? this.errorMessage.slice(0, maxLen - 1) + "…" : this.errorMessage;
      summary += " | ERR: " + trimmed;
    }
    const line = `${icon} [${summary}]`;
    if (visibleWidth(line) <= width) return [line];
    // 截断兜底
    return [line.slice(0, Math.max(0, width - 1)) + "…"];
  }

  private extractTextResult(): string {
    if (!this.partialResult) return "";
    return this.partialResult.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("");
  }
}
