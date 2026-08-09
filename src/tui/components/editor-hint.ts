/**
 * EditorHint 组件 —— 输入区下方的一行 codex footer 风格 hint。
 *
 * 对照 codex bottom_pane/footer.rs 的 single_line_footer_layout 简化版:
 *   - 左侧:快捷键 hint(submit / followUp / interrupt / quit);
 *   - 右侧:当前模式指示(idle / working / waiting / recovery required);
 *   - 宽度不足时左侧优先截断(codex 左右压缩规则的左侧优先语义);
 *   - 只在输入区聚焦时显示(InteractiveMode 经 getVisible 注入)。
 */

import type { Component } from "../index.ts";
import type { Theme } from "../theme/theme.ts";
import { wrapFg } from "../theme/ansi.ts";
import type { FooterSnapshotProvider } from "../types.ts";
import { sliceByColumn, visibleWidth } from "../primitives.ts";
import type { KeybindingHintMap } from "./keybinding-hints.ts";
import { padToWidth } from "./render-width.ts";

export interface EditorHintProps {
  theme: Theme;
  /** InteractiveMode 实现的快照 provider;模式指示从 getRunTiming 读取。 */
  provider: FooterSnapshotProvider;
  /** 左侧快捷键 hint;由 KeybindingsManager.getResolvedBindings() 装配。 */
  hints: KeybindingHintMap;
  /** 输入区聚焦时返回 true;overlay 打开期间隐藏。 */
  getVisible(): boolean;
}

function modeLabel(timing: { readonly state: "working" | "waiting" | "recovery_required" } | undefined): string {
  switch (timing?.state) {
    case "working":
      return "working";
    case "waiting":
      return "waiting";
    case "recovery_required":
      return "recovery required";
    default:
      return "idle";
  }
}

/** 左侧优先截断:保留尾部,前缀省略号(codex 压缩时左侧让位)。 */
function leftTruncate(value: string, maxWidth: number): string {
  if (visibleWidth(value) <= maxWidth) return value;
  const keep = Math.max(0, maxWidth - 1);
  if (keep <= 0) return "";
  return `…${sliceByColumn(value, visibleWidth(value) - keep, Number.POSITIVE_INFINITY)}`;
}

/** 输入区下方一行 hint;不持态,render 时 pull provider。 */
export class EditorHint implements Component {
  private readonly props: EditorHintProps;

  constructor(props: EditorHintProps) {
    this.props = props;
  }

  invalidate(): void {
    // 无缓存
  }

  render(width: number): string[] {
    if (!this.props.getVisible()) return [];
    const safeWidth = Math.max(0, Math.floor(width));
    const left = this.props.hints.map((hint) => `${hint.key}:${hint.action}`).join("  ");
    const rawRight = modeLabel(this.props.provider.getRunTiming?.());
    const right = visibleWidth(rawRight) <= safeWidth ? rawRight : sliceByColumn(rawRight, 0, safeWidth);
    const sep = "  ";
    const rightWidth = visibleWidth(right);
    const leftAvailable = Math.max(0, safeWidth - rightWidth - (rightWidth > 0 ? visibleWidth(sep) : 0));
    const fittedLeft = leftTruncate(left, leftAvailable);
    const gap = " ".repeat(Math.max(0, safeWidth - visibleWidth(fittedLeft) - rightWidth));
    const line = `${wrapFg(this.props.theme.hint)(fittedLeft)}${gap}${wrapFg(this.props.theme.muted)(right)}`;
    return [padToWidth(line, safeWidth)];
  }
}
