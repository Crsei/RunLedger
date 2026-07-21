/**
 * Footer 组件 —— 屏幕底部一行的 status / hint / model 组合显示。
 *
 * 对照 development-doc/tui/02-component-spec.md §2。
 *
 * 设计:
 *   - Footer 不订阅事件,通过 FooterSnapshotProvider 在 render 时 pull 当前快照;
 *   - render(width) 返回单行字符串;
 *   - 主题由 props.theme 注入;使用 status / hint / muted 色槽;
 *   - 失败护栏:provider 任何方法抛错时,Footer 自身 catch 并展示 "[footer:err]"。
 */

import type { Component } from "../index.ts";
import type { Theme } from "../theme/theme.ts";
import type { FooterSnapshotProvider } from "../types.ts";

export interface FooterProps {
  theme: Theme;
  /** InteractiveMode 实现的快照 provider;Footer 周期性 pull。 */
  provider: FooterSnapshotProvider;
}

export class Footer implements Component {
  private readonly props: FooterProps;

  constructor(props: FooterProps) {
    this.props = props;
  }

  invalidate(): void {
    // 无缓存
  }

  render(width: number): string[] {
    let left: string;
    let middle: string;
    let right: string;
    try {
      const streaming = this.props.provider.isStreaming();
      const stopReason = this.props.provider.getStopReason();
      const sessionId = this.props.provider.getSessionId();
      const modelId = this.props.provider.getModelId();
      const providerId = this.props.provider.getProviderId?.();
      const thinking = this.props.provider.getThinkingLevel?.();
      const status = streaming ? "..." : stopReason ? `done:${stopReason}` : "idle";
      left = status;
      middle = sessionId.length > 0 ? sessionId : "<no-session>";
      right = `${providerId ? `${providerId}/` : ""}${modelId}${thinking ? ` · think:${thinking}` : ""}`;
    } catch {
      // 失败护栏:provider 抛错时给出可观测的占位,不影响整屏渲染
      left = "[footer:err]";
      middle = "";
      right = "";
    }
    const sep = "  ";
    const parts = [left, middle, right].filter((s) => s.length > 0);
    const joined = parts.join(sep);
    if (joined.length <= width) {
      // 左对齐,右边补空格到 width(防止上一帧残余字符)
      return [joined + " ".repeat(Math.max(0, width - joined.length))];
    }
    return [joined.slice(0, Math.max(0, width - 1)) + "…"];
  }
}
