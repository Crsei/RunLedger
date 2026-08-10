/**
 * SlashCommandSelector —— `/` 命令输入期补全弹窗的兼容出口。
 *
 * 对照 development-doc/tui/20-codex-slash-command-adaptation-plan.md P3:
 * 实现已迁移到 SlashCommandPopup(components/slash-command-popup.ts);
 * InteractiveMode 以 nonCapturing overlay 直接挂载 SlashCommandPopup,
 * 本类保留为旧 export 兼容,仅做薄代理。
 *
 * @deprecated 使用 SlashCommandPopup。
 */

import { SlashCommandPopup, type SlashCommandPopupOptions } from "./slash-command-popup.ts";

export type SlashCommandSelectorProps = SlashCommandPopupOptions;

export class SlashCommandSelector extends SlashCommandPopup {
  constructor(props: SlashCommandSelectorProps) {
    super(props);
  }
}
