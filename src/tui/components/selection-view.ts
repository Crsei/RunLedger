/**
 * SelectionView —— 通用确认/选择二级展示(对照 codex SelectionViewParams + 确认框如 /archive)。
 *
 * 对照 development-doc/tui/20-codex-slash-command-adaptation-plan.md P5。
 *
 * 设计:
 *   - title / subtitle / footerHint + items 列表(SelectList);
 *   - 选中 item 触发 action(可携带 dismissOnSelect 语义,由集成层决定是否关闭);
 *   - Esc → onCancel(集成层关闭);
 *   - render:标题 + 副标题 + 列表 + footer 提示,窄终端下逐行截断不溢出。
 */

import type { Component, SelectItem, SelectListTheme } from "../index.ts";
import { SelectList } from "../index.ts";
import { fitLinesToWidth, fitToWidth } from "./render-width.ts";
import type { PresentationBlock } from "../presentation.ts";

export interface SelectionItem {
  readonly name: string;
  readonly description?: string;
  /** 选中后是否由集成层关闭视图(对照 codex dismiss_on_select)。 */
  readonly dismissOnSelect?: boolean;
  /** 选中动作;缺省时集成层只读取 name。 */
  readonly action?: () => void;
}

export interface SelectionViewProps {
  readonly title?: string;
  readonly subtitle?: string;
  readonly footerHint?: string;
  readonly items: readonly SelectionItem[];
  readonly selectListTheme: SelectListTheme;
  readonly maxVisible?: number;
  /** 选中 item 后的回调(集成层);与 item.action 并存时 action 优先。 */
  readonly onSelect?: (item: SelectionItem) => void;
  /** dismissOnSelect=true 时在 action/onSelect 之前关闭当前 overlay。 */
  readonly onDismiss?: () => void;
  readonly onCancel?: () => void;
}

export class SelectionView implements Component {
  private readonly list: SelectList;
  private readonly props: SelectionViewProps;

  constructor(props: SelectionViewProps) {
    this.props = props;
    const items: SelectItem[] = props.items.map((item) => ({
      value: item.name,
      label: item.name,
      description: item.description,
    }));
    this.list = new SelectList(
      items,
      props.maxVisible ?? Math.min(props.items.length, 8),
      props.selectListTheme,
    );
    this.list.onSelect = (item) => {
      const selection = props.items.find((candidate) => candidate.name === item.value);
      if (selection?.dismissOnSelect === true) props.onDismiss?.();
      if (selection?.action !== undefined) selection.action();
      else if (selection !== undefined) props.onSelect?.(selection);
    };
    this.list.onCancel = props.onCancel;
  }

  invalidate(): void {
    this.list.invalidate();
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
  }

  render(width: number): string[] {
    const lines: string[] = [];
    if (this.props.title !== undefined) lines.push(fitToWidth(this.props.title, width));
    if (this.props.subtitle !== undefined) lines.push(fitToWidth(this.props.subtitle, width));
    lines.push(...fitLinesToWidth(this.list.render(width), width));
    if (this.props.footerHint !== undefined) lines.push(fitToWidth(this.props.footerHint, width));
    return lines;
  }

  present(): PresentationBlock[] {
    return [{
      kind: "select",
      title: this.props.title ?? "",
      options: this.list.getVisibleItems(),
      selectedIndex: this.list.getSelectedIndex(),
    }];
  }
}
