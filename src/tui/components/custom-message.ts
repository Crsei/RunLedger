/**
 * CustomMessageComponent —— 自定义消息(非 user 也非 assistant)渲染块。
 *
 * 对照 development-doc/tui/02-component-spec.md §5 与 04-rendering.md §6 OSC 133。
 *
 * 设计:
 *   - 持有单条文本与 kind(用于 OSC 133 内部 sub-type 标记,本 M2 阶段不上 OSC 133);
 *   - render 单行,带 kind 前缀;<kind>:<text> 形式渲染,避免与 user/assistant 混淆;
 *   - kind 取值 "system" / "note" 等,容器层决定是否显示。
 */

import type { Component } from "../index.ts";
import type { Theme } from "../theme/theme.ts";
import { fitToWidth } from "./render-width.ts";

export interface CustomMessageComponentProps {
  theme: Theme;
  kind: string;
  text: string;
  timestamp: number;
}

export class CustomMessageComponent implements Component {
  private readonly props: CustomMessageComponentProps;

  constructor(props: CustomMessageComponentProps) {
    this.props = props;
  }

  invalidate(): void {
    // 无缓存
  }

  render(width: number): string[] {
    const prefix = `[${this.props.kind}] `;
    void this.props.theme;
    return [fitToWidth(prefix + this.props.text, width)];
  }
}
