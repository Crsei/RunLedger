/**
 * editor-height 单测:折行计数与最小高度(对照 codex chat_composer.rs desired_height)。
 */

import { describe, it, expect } from "vitest";
import {
  editorHeight,
  wrapCount,
  EDITOR_LEFT_PAD,
  EDITOR_RIGHT_PAD,
  EDITOR_TOP_PAD,
  EDITOR_BOTTOM_PAD,
  EDITOR_VERTICAL_PAD,
  EDITOR_MIN_HEIGHT,
} from "../../src/tui/editor-height.ts";

describe("wrapCount", () => {
  it("空文本计 1 行", () => {
    expect(wrapCount("", 40)).toBe(1);
  });
  it("显式换行按行计", () => {
    expect(wrapCount("a\nb", 40)).toBe(2);
  });
  it("窄宽度折行增长", () => {
    expect(wrapCount("a".repeat(40), 17)).toBe(3);
  });
  it("按单词边界折行,与 OpenTUI wrapMode=word 一致", () => {
    expect(wrapCount("1234567890 1234567890 1234567890", 17)).toBe(3);
  });
});

describe("editorHeight", () => {
  it("常量与输入区布局对齐:左 2 / 右 1 / 上 1 / 下 0 / 最小 2", () => {
    expect(EDITOR_LEFT_PAD).toBe(2);
    expect(EDITOR_RIGHT_PAD).toBe(1);
    expect(EDITOR_TOP_PAD).toBe(1);
    expect(EDITOR_BOTTOM_PAD).toBe(0);
    expect(EDITOR_VERTICAL_PAD).toBe(1);
    expect(EDITOR_MIN_HEIGHT).toBe(2);
  });
  it("空文本 = 最小高度 2", () => {
    expect(editorHeight("", 60)).toBe(2);
  });
  it("单行文本 = 2(1 行 + 顶部留白,低于下限取 2)", () => {
    expect(editorHeight("hi", 60)).toBe(2);
  });
  it("两行显式换行 -> 3(2 + 顶部留白)", () => {
    expect(editorHeight("a\nb", 60)).toBe(3);
  });
  it("窄终端折行增长:40 字符 / 20 列 -> 4(3 折行 + 顶部留白)", () => {
    expect(editorHeight("a".repeat(40), 20)).toBe(4);
  });
  it("宽度不足时内部宽度至少 1 列,不崩溃(5 字符逐字折行 -> 5 + 顶部留白)", () => {
    expect(editorHeight("hello", 1)).toBe(6);
  });
});
