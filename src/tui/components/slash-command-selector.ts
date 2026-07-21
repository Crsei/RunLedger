/**
 * SlashCommandSelector —— `/` 触发的 slash 命令选择器。
 *
 * 对照 development-doc/tui/02-component-spec.md §8 与 09-* Ideographic.
 *
 * 设计:
 *   - 构造时传入 SelectItem[] (slash command idem list);
 *   - onSelect 回调把 item.value 与当前 Editor text 拼接(由 InteractiveMode 决定);
 *   - onCancel 触发 OverlayHandle.hide();
 *
 * 本 M5 阶段:
 *   - items 由 InteractiveMode 装配时构造占位(/help /clear /model /mcp /prompt 几条);
 *   - 真实 slash 注册器在 M5+ 远期接通。
 */

import { SelectorModal, type SelectorModalProps } from "./selector-modal.ts";

export type SlashCommandSelectorProps = SelectorModalProps;

export class SlashCommandSelector extends SelectorModal {
  constructor(props: SlashCommandSelectorProps) {
    super(props);
  }
}
