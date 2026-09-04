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

import type { SelectListTheme } from "../primitives.ts";
import type { PresentationBlock } from "../presentation.ts";
import { SecondarySelectionView } from "./list-selection-modal.ts";

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

export class SelectionView extends SecondarySelectionView {
  private readonly selectionProps: SelectionViewProps;

  constructor(props: SelectionViewProps) {
    super({
      title: props.title ?? "",
      subtitle: props.subtitle,
      footerHint: props.footerHint,
      items: props.items.map((item, index) => ({ value: String(index), name: item.name, description: item.description })),
      maxVisible: props.maxVisible,
      selectListTheme: props.selectListTheme,
      onSelect: (item) => {
        const selection = props.items[Number(item.value)];
        if (selection?.dismissOnSelect === true) props.onDismiss?.();
        if (selection?.action !== undefined) selection.action();
        else if (selection !== undefined) props.onSelect?.(selection);
      },
      onCancel: () => props.onCancel?.(),
    });
    this.selectionProps = props;
  }

  present(): PresentationBlock[] {
    return [{
      kind: "select",
      title: this.selectionProps.title ?? "",
      options: this.selectionProps.items.map((item, index) => ({
        value: String(index),
        label: item.name,
        description: item.description,
      })),
      selectedIndex: this.selectedIndex,
    }];
  }
}
