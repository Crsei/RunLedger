/**
 * SelectorModal —— 通用 list 选择模态,把 pi-tui SelectList 包成可挂载的 Overlay 组件。
 *
 * 对照 development-doc/tui/02-component-spec.md §8 与 04-rendering.md §5 overlay。
 *
 * 设计:
 *   - 持有 SelectList 与 title(占位 caption);
 *   - render 把 title 行 + SelectList 的 render 拼成一个面板;
 *   - onSelect / onCancel 透传给 InteractiveMode,后者调用 OverlayHandle.hide();
 *   - InteractiveMode 通过 TUI.showOverlay(this, anchor) 挂载;焦点由 TUI 自动落到 SelectList。
 *
 * 注意:本 M5 阶段 SelectorModal 不自己接 keybinding;SelectList 自带 handleInput 接管
 * Up/Down/Enter/Esc 等。
 */

import { Box, SelectList, type SelectItem, type Component, type SelectListTheme, type SelectListLayoutOptions } from "../index.ts";
import type { Theme } from "../theme/theme.ts";
import { fitLinesToWidth, fitToWidth } from "./render-width.ts";

export interface SelectorModalProps {
  /** 主题:本期占位用,M6 阶段补 ANSI 色接入;ImagePasteOverlay 等不传。 */
  theme?: Theme;
  selectListTheme: SelectListTheme;
  title: string;
  items: SelectItem[];
  maxVisible?: number;
  layout?: SelectListLayoutOptions;
  onSelect?: (item: SelectItem) => void;
  onCancel?: () => void;
}

export class SelectorModal implements Component {
  private readonly title: string;
  private readonly list: SelectList;
  private readonly box: Box;

  constructor(props: SelectorModalProps) {
    this.title = props.title;
    this.list = new SelectList(
      props.items,
      props.maxVisible ?? Math.min(props.items.length, 8),
      props.selectListTheme,
      props.layout,
    );
    this.list.onSelect = props.onSelect;
    this.list.onCancel = props.onCancel;
    // Box 是 Container:paddingX=1 paddingY=0;SelectList 通过 addChild 嵌入。
    void props.theme;
    this.box = new Box(1, 0);
    this.box.addChild(this.list);
  }

  invalidate(): void {
    this.list.invalidate();
    this.box.invalidate();
  }

  handleInput(data: string): void {
    // SelectList 自带 handleInput 路由 up/down/pageUp/pageDown/confirm/cancel
    this.list.handleInput(data);
  }

  render(width: number): string[] {
    return [fitToWidth(this.title, width), ...fitLinesToWidth(this.box.render(width), width)];
  }
}
