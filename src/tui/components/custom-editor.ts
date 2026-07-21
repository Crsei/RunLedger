/**
 * CustomEditor —— RunLedger TUI 的输入框,扩展 pi-tui Editor 装配 app.* 全局动作。
 *
 * 对照 development-doc/tui/02-component-spec.md §10。
 *
 * 设计:
 *   - extends pi-tui Editor,保留所有原生编辑能力;
 *   - 本 M1 阶段只装配构造参数(传入 tui / theme.createEditorTheme() / paddingX=0);
 *   - 提交路径:挂在 onSubmit 回调,由 InteractiveMode 装配时接通 agent.prompt;
 *   - 键位扩展(Ctrl+C / Ctrl+D / Esc+Q / Ctrl+L)在 M6 接入,
 *     通过 keybindingsManager.take(this) + handleInput dispatch 实现。
 *
 * 本期放弃直接访问 Editor 私有 state / theme(继承受限于 private);
 * CustomEditor 只持有 onSubmit / appInterrupt / appExit 三回调引。
 */

import { Editor, type TUI, type EditorTheme } from "../index.ts";
import type { Theme } from "../theme/theme.ts";
import type { SelectListTheme } from "../index.ts";

/** CustomEditor 构造参数(由 InteractiveMode 装配时传入)。 */
export interface CustomEditorProps {
  theme: Theme;
  /** 用于 EditorTheme.borderColor 与 autocomplete.selectList 主题。 */
  selectListTheme: SelectListTheme;
  /** 提交文本时回调;InteractiveMode 装配时接通 agent.prompt。 */
  onSubmit?: (text: string) => void;
  /** 文本变化时回调;可选,记录在 InteractiveMode 输入缓存(本期不挂)。 */
  onChange?: (text: string) => void;
  /** 中断当前 turn;对应 app.interrupt 动作。本期不接通,占位。 */
  onInterrupt?: () => void;
  /** 退出 TUI;对应 app.exit 动作。本期不接通,占位。 */
  onExit?: () => void;
  /** paddingX,默认 0;若需要左侧留白(对照 pi 默认 1)由装配方调。 */
  paddingX?: number;
}

/** 包装 pi-tui EditorTheme,从 Theme 取 border / selectList 主题。 */
export function makeEditorTheme(theme: Theme, selectList: SelectListTheme): EditorTheme {
  return {
    borderColor: (str: string) => str,
    selectList,
  };
}

export class CustomEditor extends Editor {
  constructor(tui: TUI, theme: EditorTheme, props: CustomEditorProps) {
    super(tui, theme, { paddingX: props.paddingX ?? 0 });
    this.onSubmit = props.onSubmit;
    this.onChange = props.onChange;
    this.disableSubmit = false;
  }
}
