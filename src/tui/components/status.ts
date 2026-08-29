/**
 * StatusComponent —— Footer 临时消息组件，仅显示 idle recap。
 *
 * 对照 development-doc/tui/02-component-spec.md §2 与 03-event-binding §1 表。
 *
 * 设计:
 *   - 参数字段统一由 FooterFieldRegistry 投影;
 *   - 本组件只持有 transient idle recap;
 *   - 有内容时 render 单行,左对齐,宽度被截到 width;空状态不占 footer 行;
 *   - 仅文本展示(无 ANSI 色,色盲安全,05 §2 原则)。
 */

import type { Component } from "../index.ts";
import { padToWidth } from "./render-width.ts";

export interface StatusComponentProps {}

export class StatusComponent implements Component {
  private idleRecap: string | undefined;

  constructor(_props: StatusComponentProps) {}

  invalidate(): void {
    // 无缓存
  }

  /** Transient side-channel status; never projected into the transcript. */
  setIdleRecap(text: string | undefined): void {
    this.idleRecap = text === undefined || text.trim().length === 0 ? undefined : text;
  }

  render(width: number): string[] {
    if (this.idleRecap === undefined) return [];
    return [padToWidth(`※ recap: ${this.idleRecap}`, width)];
  }
}
