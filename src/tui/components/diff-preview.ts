/**
 * DiffPreviewComponent —— 工具(read/write/edit/bash 等)调用前后文件 diff 的折叠预览块。
 *
 * M5 升级:与 ToolCallComponent 一致的状态机 (pending|running|ok|error)。
 *   - 表头追加状态图标 (⏳ … ✓ ✗) + 失败时 OK 行后追加 ERR 行。
 *   - 折叠态仍单行;展开态追加 forker/after 行 + (status=error) ERR 行。
 *
 * 对照 development-doc/tui/02-component-spec.md §7 与 04-rendering.md §3。
 */

import type { Component } from "../index.ts";
import { fitLinesToWidth, fitToWidth } from "./render-width.ts";

export type DiffVerb = "read" | "write" | "edit" | "bash";
export type DiffStatus = "pending" | "running" | "ok" | "error";

export interface DiffPreviewComponentProps {
  verb: DiffVerb;
  path: string;
  before?: string;
  after?: string;
  expanded?: boolean;
  initialStatus?: DiffStatus;
  errorMessage?: string;
}

const STATUS_ICON: Record<DiffStatus, string> = {
  pending: "⏳",
  running: "…",
  ok: "✓",
  error: "✗",
};

export class DiffPreviewComponent implements Component {
  private readonly verb: DiffVerb;
  private readonly path: string;
  private readonly before: string | undefined;
  private readonly after: string | undefined;
  private expanded: boolean;
  private status: DiffStatus;
  private errorMessage: string | undefined;

  constructor(props: DiffPreviewComponentProps) {
    this.verb = props.verb;
    this.path = props.path;
    this.before = props.before;
    this.after = props.after;
    this.expanded = props.expanded ?? false;
    this.status = props.initialStatus ?? "pending";
    this.errorMessage = props.errorMessage;
  }

  invalidate(): void {
    // 无缓存
  }

  toggle(): void {
    this.expanded = !this.expanded;
  }

  setStatus(status: DiffStatus): void {
    this.status = status;
  }

  setError(message: string): void {
    this.errorMessage = message;
    this.status = "error";
  }

  render(width: number): string[] {
    const icon = STATUS_ICON[this.status];
    const header = `${icon} ▸ ${this.verb} ${this.path}`;
    if (!this.expanded) {
      return [fitToWidth(header, width)];
    }
    const lines = [header];
    if (this.before !== undefined) {
      lines.push(`  - ${this.before}`);
    }
    if (this.after !== undefined) {
      lines.push(`  + ${this.after}`);
    }
    if (this.status === "error" && this.errorMessage) {
      lines.push(`  ! ERR: ${this.errorMessage}`);
    }
    return fitLinesToWidth(lines, width);
  }
}
