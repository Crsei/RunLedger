/**
 * 输入区高度模型:对照 codex chat_composer.rs::desired_height 的最小复刻。
 *
 * codex 侧:
 *   - inner_width = width - (LIVE_PREFIX_COLS + 1) - textarea_right_reserve;
 *   - 高度 = textarea.desired_height(inner_width) + 2(上下留白各 1);
 *   - composer 最小高度 Constraint::Min(3)。
 *
 * RunLedger 落地常量:
 *   - EDITOR_LEFT_PAD = 2(codex LIVE_PREFIX_COLS:prompt 列 + 1 空列);
 *   - EDITOR_RIGHT_PAD = 1;
 *   - EDITOR_VERTICAL_PAD = 1(上下各 1 行);
 *   - EDITOR_MIN_HEIGHT = 3。
 */

import { visibleWidth, wrapTextWithAnsi } from "./primitives.ts";

export const EDITOR_LEFT_PAD = 2;
export const EDITOR_RIGHT_PAD = 1;
export const EDITOR_VERTICAL_PAD = 1;
export const EDITOR_MIN_HEIGHT = 3;

/** 空输入占位符;OpenTUI 侧由 TextareaRenderable.placeholder 承接同一文本。 */
export const DEFAULT_EDITOR_PLACEHOLDER = "Message RunLedger…";

const WORD_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "word" });

/**
 * 纯组件使用的 word-wrap 投影。原生路径仍以 OpenTUI measureForDimensions
 * 为最终测量 authority；这里负责让非原生渲染与常见单词边界保持同语义。
 */
export function wrapEditorText(text: string, width: number): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  if (text.length === 0) return [""];
  const lines: string[] = [];
  for (const source of text.split("\n")) {
    if (source.length === 0) {
      lines.push("");
      continue;
    }
    let current = "";
    for (const entry of WORD_SEGMENTER.segment(source)) {
      const segment = entry.segment;
      if (current.length > 0 && visibleWidth(current + segment) > safeWidth) {
        lines.push(current);
        current = "";
      }
      if (visibleWidth(segment) > safeWidth) {
        const wrapped = wrapTextWithAnsi(segment, safeWidth);
        lines.push(...wrapped.slice(0, -1));
        current = wrapped.at(-1) ?? "";
      } else {
        current += segment;
      }
    }
    lines.push(current);
  }
  return lines;
}

/** 折行数;纯组件按 word-wrap,OpenTUI 原生路径再以 native measure 校正。 */
export function wrapCount(text: string, width: number): number {
  return wrapEditorText(text, width).length;
}

/** 输入区所需高度 = 折行数 + 上下留白,下限 EDITOR_MIN_HEIGHT。 */
export function editorHeight(text: string, width: number): number {
  const innerWidth = Math.max(1, width - EDITOR_LEFT_PAD - EDITOR_RIGHT_PAD);
  return Math.max(EDITOR_MIN_HEIGHT, wrapCount(text, innerWidth) + EDITOR_VERTICAL_PAD * 2);
}
