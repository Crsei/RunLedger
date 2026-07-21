/**
 * BackgroundTaskComponent —— 后台任务(SST/mcp/skills 加载等)在 chat 区域的占位行。
 *
 * 对照 development-doc/tui/02-component-spec.md §6 与 07-roadmap.md M3。
 *
 * 设计:
 *   - 单行渲染,显示 "… <label>" 形式:M3 阶段作为占位;
 *   - finish(label) 把状态切到 done,显示 "✓ <label>";
 *   - 不持态事件流,由 InteractiveMode 在 SST/mcp 真实加载时 push。
 *
 * 本期由 InteractiveMode 不真正接入;M3 落组件后等 M4 与 M5 的真实 Stilization 接入。
 */

import type { Component } from "../index.ts";

export type BackgroundTaskStatus = "running" | "done" | "error";

export interface BackgroundTaskComponentProps {
  label: string;
  initialStatus?: BackgroundTaskStatus;
}

const ICON: Record<BackgroundTaskStatus, string> = {
  running: "…",
  done: "✓",
  error: "✗",
};

export class BackgroundTaskComponent implements Component {
  private readonly label: string;
  private status: BackgroundTaskStatus;

  constructor(props: BackgroundTaskComponentProps) {
    this.label = props.label;
    this.status = props.initialStatus ?? "running";
  }

  invalidate(): void {
    // 无缓存
  }

  setStatus(status: BackgroundTaskStatus): void {
    this.status = status;
  }

  render(width: number): string[] {
    const line = `${ICON[this.status]} ${this.label}`;
    if (line.length <= width) return [line];
    return [line.slice(0, Math.max(0, width - 1)) + "…"];
  }
}
