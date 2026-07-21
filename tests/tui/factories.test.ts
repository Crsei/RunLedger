/**
 * theme.factories 单测:makeMarkdownTheme / makeSelectListTheme / makeEditorTheme 输出 ANSI 函数可调用、不抛错。
 *
 * 对照 src/tui/theme/factories.ts 与 development-doc/tui/05-theme.md §3。
 */

import { describe, it, expect } from "vitest";
import { makeMarkdownTheme, makeSelectListTheme, makeEditorTheme } from "../../src/tui/theme/factories.ts";
import { loadTheme } from "../../src/tui/theme/theme.ts";

describe("makeMarkdownTheme", () => {
  it("所有 14 个必需 fn 都返回函数", () => {
    const theme = loadTheme("dark");
    const md = makeMarkdownTheme(theme);
    expect(typeof md.heading).toBe("function");
    expect(typeof md.link).toBe("function");
    expect(typeof md.linkUrl).toBe("function");
    expect(typeof md.code).toBe("function");
    expect(typeof md.codeBlock).toBe("function");
    expect(typeof md.codeBlockBorder).toBe("function");
    expect(typeof md.quote).toBe("function");
    expect(typeof md.quoteBorder).toBe("function");
    expect(typeof md.hr).toBe("function");
    expect(typeof md.listBullet).toBe("function");
    expect(typeof md.bold).toBe("function");
    expect(typeof md.italic).toBe("function");
    expect(typeof md.strikethrough).toBe("function");
    expect(typeof md.underline).toBe("function");
  });
  it("所有 fn 调用都返回包含原文的串(ANSI 不破坏原文)", () => {
    const theme = loadTheme("dark");
    const md = makeMarkdownTheme(theme);
    for (const fn of [
      md.heading, md.link, md.linkUrl, md.code, md.codeBlock, md.codeBlockBorder,
      md.quote, md.quoteBorder, md.hr, md.listBullet, md.bold, md.italic, md.strikethrough, md.underline,
    ]) {
      const out = fn("hello");
      expect(out).toContain("hello");
    }
  });
});

describe("makeSelectListTheme", () => {
  it("5 个 fn 都返回函数", () => {
    const theme = loadTheme("dark");
    const sl = makeSelectListTheme(theme);
    expect(typeof sl.selectedPrefix).toBe("function");
    expect(typeof sl.selectedText).toBe("function");
    expect(typeof sl.description).toBe("function");
    expect(typeof sl.scrollInfo).toBe("function");
    expect(typeof sl.noMatch).toBe("function");
  });
});

describe("makeEditorTheme", () => {
  it("borderColor 与 selectList 都存在", () => {
    const theme = loadTheme("dark");
    const sl = makeSelectListTheme(theme);
    const et = makeEditorTheme(theme, sl);
    expect(typeof et.borderColor).toBe("function");
    expect(et.selectList).toBe(sl);
  });
});
