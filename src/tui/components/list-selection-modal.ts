/**
 * SecondarySelectionView —— 统一的 Codex 风格二级选择界面。
 *
 * 对照 codex-rs `bottom_pane/list_selection_view.rs` 的展示格式:
 *   - 头部:bold 标题 + dim 副标题;
 *   - 行:`› N. name (current)` / `  N. name (default)`,name 之后按 desc 列
 *     (AutoVisible:可见行最大 name 宽度 + 2,上限 70% 宽)对齐 dim 描述;
 *   - 尾部:footer hint(如 "Press Enter to confirm or Esc to go back");
 *   - maxVisible 默认 8(对照 codex MAX_POPUP_ROWS),选中行居中滚动;
 *   - Up/Down/PageUp/PageDown/Enter/Esc 导航,Enter 选中并回调 onSelect。
 *
 * 与 SelectorModal 的区别:后者是 SelectList 直投影(单行 name+description),
 * 本组件复刻 codex 的编号行 + current/default 标记 + 标题/副标题/footer 结构。
 */

import type { Component, SelectListTheme } from "../primitives.ts";
import { matchesKey, visibleWidth } from "../primitives.ts";
import { wrapBold, wrapDim } from "../theme/ansi.ts";
import { fitLinesToWidth, fitToWidth } from "./render-width.ts";

export interface SecondarySelectionItem {
  readonly value: string;
  readonly name: string;
  readonly description?: string;
  /** 当前选中项,行尾追加 " (current)"(对照 codex SelectionItem.is_current)。 */
  readonly isCurrent?: boolean;
  /** 默认项,行尾追加 " (default)"(对照 codex SelectionItem.is_default)。 */
  readonly isDefault?: boolean;
  readonly disabled?: boolean;
}

export interface SecondarySelectionViewProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly items: readonly SecondarySelectionItem[];
  readonly maxVisible?: number;
  readonly initialSelectedValue?: string;
  readonly onSelectionChange?: (item: SecondarySelectionItem) => void;
  /** 底部提示行,默认 "Press Enter to confirm or Esc to go back"(对照 codex standard_popup_hint_line)。 */
  readonly footerHint?: string;
  readonly selectListTheme: SelectListTheme;
  readonly onSelect: (item: SecondarySelectionItem) => void;
  readonly onCancel: () => void;
  /** 二级界面可选的预览行，位于标题/副标题与选项之间。 */
  readonly detailLines?: readonly string[];
  /** 业务快捷键映射到 item.value；未匹配时仍走通用导航。 */
  readonly shortcutValue?: (data: string) => string | undefined;
}

const DEFAULT_FOOTER_HINT = "Press Enter to confirm or Esc to go back";

export class SecondarySelectionView implements Component {
  protected readonly props: SecondarySelectionViewProps;
  protected selectedIndex = 0;

  constructor(props: SecondarySelectionViewProps) {
    this.props = props;
    const selected = props.initialSelectedValue === undefined
      ? -1
      : props.items.findIndex((item) => item.value === props.initialSelectedValue);
    this.selectedIndex = selected < 0 ? 0 : selected;
  }

  invalidate(): void {
    // 无缓存。
  }

  handleInput(data: string): void {
    const items = this.props.items;
    const shortcutValue = this.props.shortcutValue?.(data);
    if (shortcutValue !== undefined) {
      this.selectValue(shortcutValue);
      return;
    }
    if (matchesKey(data, "up")) {
      this.selectedIndex = this.nextEnabledIndex(-1);
      this.notifySelectionChange();
      return;
    }
    if (matchesKey(data, "down")) {
      this.selectedIndex = this.nextEnabledIndex(1);
      this.notifySelectionChange();
      return;
    }
    if (matchesKey(data, "pageUp")) {
      const maxVisible = this.props.maxVisible ?? 8;
      this.selectedIndex = Math.max(0, this.selectedIndex - maxVisible);
      this.notifySelectionChange();
      return;
    }
    if (matchesKey(data, "pageDown")) {
      const maxVisible = this.props.maxVisible ?? 8;
      this.selectedIndex = Math.min(Math.max(0, items.length - 1), this.selectedIndex + maxVisible);
      this.notifySelectionChange();
      return;
    }
    if (matchesKey(data, "enter")) {
      const selected = items[this.selectedIndex];
      if (selected && !selected.disabled) this.props.onSelect(selected);
      return;
    }
    if (/^[1-9]$/u.test(data)) {
      const selected = items[Number(data) - 1];
      if (selected && !selected.disabled) this.props.onSelect(selected);
      return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.props.onCancel();
    }
  }

  protected selectValue(value: string): void {
    const selected = this.props.items.find((item) => item.value === value);
    if (selected !== undefined && !selected.disabled) this.props.onSelect(selected);
  }

  private notifySelectionChange(): void {
    const selected = this.props.items[this.selectedIndex];
    if (selected !== undefined) this.props.onSelectionChange?.(selected);
  }

  private nextEnabledIndex(direction: -1 | 1): number {
    const items = this.props.items;
    if (items.length === 0) return 0;
    for (let offset = 1; offset <= items.length; offset += 1) {
      const index = (this.selectedIndex + direction * offset + items.length) % items.length;
      if (items[index]?.disabled !== true) return index;
    }
    return this.selectedIndex;
  }

  render(width: number): string[] {
    const items = this.props.items;
    const theme = this.props.selectListTheme;
    const maxVisible = this.props.maxVisible ?? 8;
    const lines: string[] = [wrapBold(this.props.title)];
    if (this.props.subtitle !== undefined) lines.push(wrapDim(this.props.subtitle));
    if (this.props.detailLines !== undefined) lines.push(...this.props.detailLines);
    if (items.length === 0) {
      lines.push(wrapDim(theme.noMatch("No matching items")));
    } else {
      const numberWidth = String(items.length).length;
      const prefixWidth = 2 + numberWidth + 2; // "› " + "N. "
      const start = Math.max(0, Math.min(
        this.selectedIndex - Math.floor(maxVisible / 2),
        Math.max(0, items.length - maxVisible),
      ));
      const visible = items.slice(start, start + maxVisible);
      // AutoVisible desc 列:可见行 name(含 marker)最大宽度 + 2,上限 70% 宽(对照 codex compute_desc_col)。
      const maxNameWidth = visible.reduce((max, item) => Math.max(max, visibleWidth(this.rowName(item))), 0);
      const descCol = Math.min(width - 1, Math.floor(width * 0.7), prefixWidth + maxNameWidth + 2);
      visible.forEach((item, offset) => {
        const index = start + offset;
        const selected = index === this.selectedIndex;
        const prefix = selected ? theme.selectedPrefix("› ") : "  ";
        const number = `${index + 1}. `;
        const name = this.rowName(item);
        // name 上限 descCol - 2(对照 codex name_limit),超长截断保留两列间隙。
        const nameLimit = Math.max(0, descCol - 2 - prefixWidth);
        const fittedName = selected
          ? theme.selectedText(truncateName(name, nameLimit))
          : truncateName(name, nameLimit);
        const used = visibleWidth(prefix) + visibleWidth(number) + visibleWidth(fittedName);
        const gap = Math.max(0, descCol - used);
        const description = item.description !== undefined
          ? theme.description(item.description)
          : "";
        lines.push(fitToWidth(`${prefix}${number}${fittedName}${" ".repeat(gap)}${description}`, width));
      });
    }
    const footer = this.props.footerHint ?? DEFAULT_FOOTER_HINT;
    lines.push(wrapDim(footer));
    return fitLinesToWidth(lines, width);
  }

  /** name + current/default 标记(对照 codex build_rows 的 name_with_marker)。 */
  private rowName(item: SecondarySelectionItem): string {
    if (item.isCurrent) return `${item.name} (current)`;
    if (item.isDefault) return `${item.name} (default)`;
    return item.name;
  }
}

/** 兼容旧名；新代码应使用 SecondarySelectionView。 */
export { SecondarySelectionView as ListSelectionModal };
export type ListSelectionItem = SecondarySelectionItem;
export type ListSelectionModalProps = SecondarySelectionViewProps;

/** 超宽时按可见宽度截断并追加 "…"(对照 codex build_full_line truncated 路径)。 */
function truncateName(name: string, limit: number): string {
  if (visibleWidth(name) <= limit) return name;
  const body = Array.from(name).reduce((acc, char) => {
    if (visibleWidth(acc + char) + 1 > limit) return acc;
    return acc + char;
  }, "");
  return `${body}…`;
}
