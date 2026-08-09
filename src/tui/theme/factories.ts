/**
 * 主题工厂：把 Theme 色槽转为 pure component 所需的 ANSI presentation 函数。
 *
 * 对照 development-doc/tui/05-theme.md §3。
 *
 * M6 阶段升级:
 *   - makeMarkdownTheme 用真 ANSI 16 色回退包装;
 *   - makeSelectListTheme 使用 accent / muted / hint 等色槽;
 *   - makeEditorTheme borderColor 用 theme.border;
 *   - 任何 fn 失败时回退 identity(text),防止 ANSI 残留导致渲染错位。
 */

import type { MarkdownTheme, SelectListTheme, EditorTheme } from "../index.ts";
import type { Theme } from "./theme.ts";
import { wrapFg, wrapBg, wrapBold, wrapItalic, wrapUnderline, wrapStrikethrough } from "./ansi.ts";

const identity = (text: string): string => text;

export function makeMarkdownTheme(theme: Theme): MarkdownTheme {
  const heading = wrapFg(theme.primary);
  const link = wrapFg(theme.link);
  const linkUrl = wrapFg(theme.muted);
  const code = wrapFg(theme.warning);
  const codeBlock = wrapFg(theme.success);
  const codeBlockBorder = wrapFg(theme.border);
  const quote = wrapFg(theme.muted);
  const quoteBorder = wrapFg(theme.border);
  const hr = wrapFg(theme.muted);
  const listBullet = wrapFg(theme.accent);
  const bold = (text: string): string => wrapBold(wrapFg(theme.primary)(text));
  const italic = (text: string): string => wrapItalic(wrapFg(theme.secondary)(text));
  const strikethrough = (text: string): string => wrapStrikethrough(wrapFg(theme.muted)(text));
  const underline = (text: string): string => wrapUnderline(wrapFg(theme.link)(text));
  return {
    heading,
    link,
    linkUrl,
    code,
    codeBlock,
    codeBlockBorder,
    quote,
    quoteBorder,
    hr,
    listBullet,
    bold,
    italic,
    strikethrough,
    underline,
  };
}

export function makeSelectListTheme(theme: Theme): SelectListTheme {
  const selectedPrefix = (text: string): string => wrapFg(theme.accent)(text);
  const selectedText = (text: string): string => wrapBold(wrapFg(theme.primary)(text));
  const description = (text: string): string => wrapFg(theme.muted)(text);
  const scrollInfo = (text: string): string => wrapFg(theme.hint)(text);
  const noMatch = (text: string): string => wrapFg(theme.error)(text);
  return { selectedPrefix, selectedText, description, scrollInfo, noMatch };
}

export function makeEditorTheme(theme: Theme, selectList: SelectListTheme): EditorTheme {
  return {
    borderColor: (str: string): string => wrapFg(theme.border)(str),
    backgroundColor: (str: string): string => wrapBg(theme.editorBackground)(str),
    placeholderColor: (str: string): string => wrapFg(theme.hint)(str),
    prompt: (str: string): string => wrapBold(wrapFg(theme.accent)(str)),
    selectList,
  };
}

// 备份:identity 留作回退路径,防止 M6 真实 ANSI 链路某天被关
void identity;
