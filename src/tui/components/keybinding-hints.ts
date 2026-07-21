/**
 * KeybindingHints 组件 —— Footer 之上的单行键位提示。
 *
 * 对照 development-doc/tui/02-component-spec.md §3。
 *
 * 设计:
 *   - render(width) 返回一行字符串,宽度被 truncateToWidth 截到 width;
 *   - 不持态,提示内容由构造时传入的 keybindingMap 决定;
 *   - 主题通过 props.theme 注入,使用 hint 色槽。
 *
 * 本 M1 阶段只做空骨架:render 返回固定提示字符串;真实键位映射与 fg/bg ANSI 上色在 M6 接入。
 */

import type { Component } from "../index.ts";
import type { Theme } from "../theme/theme.ts";

/** 键位 → 动作名映射;由 KeybindingsManager 在 InteractiveMode 装配时构造。 */
export type KeybindingHintMap = ReadonlyArray<{ key: string; action: string }>;

export interface KeybindingHintsProps {
  theme: Theme;
  /** 由 KeybindingsManager 在装配时取得的不可变 hint 列表;M1 阶段可传 []。 */
  hints: KeybindingHintMap;
}

/** 单行键位提示组件。 */
export class KeybindingHints implements Component {
  private readonly props: KeybindingHintsProps;

  constructor(props: KeybindingHintsProps) {
    this.props = props;
  }

  invalidate(): void {
    // 无缓存,无需 invalidate
  }

  render(width: number): string[] {
    if (this.props.hints.length === 0) {
      return [""];
    }
    // M1 阶段:逗号分隔的原始字符串拼接;M6 阶段上 ANSI fg/bg。
    const line = this.props.hints.map((h) => `${h.key}:${h.action}`).join("  ");
    if (line.length <= width) {
      return [line];
    }
    return [line.slice(0, Math.max(0, width - 1)) + "…"];
  }
}
