/**
 * AbortButtonComponent —— Editor 区 KeyboardInterrupt 按钮(本期占位,不做实际中断)。
 *
 * 对照 development-doc/tui/02-component-spec.md §6 与 03-event-binding §4 abort。
 *
 * 设计:
 *   - 单行 ASCII 文本"[Ctrl+C 中断]";
 *   - onClick 由 InteractiveMode 装配时接 onInterrupt;M3 阶段 noop 回调;
 *   - 真正的 abort 是 agent.interrupt(M8 远期接通),本期 Abort 按钮仅作占位可视化。
 *
 * M3 阶段此组件不被 InteractiveMode 主动 push;由 M7 打磨时挂到 status 区。
 */

import type { Component } from "../index.ts";

export interface AbortButtonComponentProps {
  label?: string;
  onClick?: () => void;
}

export class AbortButtonComponent implements Component {
  private readonly props: AbortButtonComponentProps;

  constructor(props: AbortButtonComponentProps) {
    this.props = props;
  }

  invalidate(): void {
    // 无缓存
  }

  /** Trigger 触发 by keybinding;放在 InteractiveMode.handleEvent 的 app.abort 路径。 */
  trigger(): void {
    this.props.onClick?.();
  }

  render(width: number): string[] {
    const label = this.props.label ?? "[Ctrl+C 中断]";
    if (label.length <= width) return [label];
    return [label.slice(0, Math.max(0, width - 1)) + "…"];
  }
}
