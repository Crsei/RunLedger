/**
 * theme.factories 单测:makeMarkdownTheme / makeSelectListTheme / makeEditorTheme 输出 ANSI 函数可调用、不抛错。
 *
 * 对照 src/tui/theme/factories.ts 与 development-doc/tui/05-theme.md §3。
 */

import { describe, it, expect } from "vitest";
import stripAnsi from "strip-ansi";
import { makeMarkdownTheme, makeSelectListTheme, makeEditorTheme } from "../../src/tui/theme/factories.ts";
import { loadTheme } from "../../src/tui/theme/theme.ts";
import {
  blend,
  isLight,
  computeEditorBackground,
  resolveTerminalBackground,
  editorBackgroundFromTerminal,
  rgbToHex,
  parseHexColor,
} from "../../src/tui/theme/editor-background.ts";
import { Editor, ProcessTerminal, TUI, visibleWidth, parseOsc11BackgroundColor } from "../../src/tui/index.ts";

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
  it("backgroundColor / placeholderColor / prompt 都返回包含原文的 ANSI 串", () => {
    const theme = loadTheme("dark");
    const et = makeEditorTheme(theme, makeSelectListTheme(theme));
    expect(et.backgroundColor("x")).toContain("x");
    expect(et.placeholderColor("x")).toContain("x");
    expect(et.prompt("›")).toContain("›");
  });
});

describe("editor-background (对照 codex style.rs / color.rs)", () => {
  it("blend 边界:alpha=0 返回 bg,alpha=1 返回 fg", () => {
    const fg = { r: 255, g: 0, b: 0 };
    const bg = { r: 0, g: 0, b: 255 };
    expect(blend(fg, bg, 0)).toEqual(bg);
    expect(blend(fg, bg, 1)).toEqual(fg);
  });
  it("blend 使用 Rust `as u8` 截断语义(非四舍五入)", () => {
    // 255*0.12 + 11*0.88 = 40.28 -> 40
    expect(blend({ r: 255, g: 255, b: 255 }, { r: 11, g: 14, b: 20 }, 0.12))
      .toEqual({ r: 40, g: 42, b: 48 });
  });
  it("isLight 阈值 128:黑 false、白 true、中性灰 128 不视为亮", () => {
    expect(isLight({ r: 0, g: 0, b: 0 })).toBe(false);
    expect(isLight({ r: 255, g: 255, b: 255 })).toBe(true);
    expect(isLight({ r: 128, g: 128, b: 128 })).toBe(false);
  });
  it("computeEditorBackground 暗分支:12% 白混入 #0b0e14 -> #282a30", () => {
    expect(rgbToHex(computeEditorBackground({ r: 0x0b, g: 0x0e, b: 0x14 }))).toBe("#282a30");
  });
  it("computeEditorBackground 暗分支保底:纯黑终端 -> #282a30(不再 #1e1e1e)", () => {
    // codex 在 bg=#000000 时产出 #1e1e1e,肉眼不可辨;RunLedger 保底到主题静态回退值。
    expect(rgbToHex(computeEditorBackground({ r: 0, g: 0, b: 0 }))).toBe("#282a30");
  });
  it("computeEditorBackground 亮分支:4% 黑混入 #ffffff -> #f4f4f4", () => {
    expect(rgbToHex(computeEditorBackground({ r: 255, g: 255, b: 255 }))).toBe("#f4f4f4");
  });
  it("resolveTerminalBackground:OSC 11 优先,缺失回退 theme.background 解析", () => {
    const theme = loadTheme("dark");
    expect(resolveTerminalBackground(theme, { r: 1, g: 2, b: 3 })).toEqual({ r: 1, g: 2, b: 3 });
    expect(resolveTerminalBackground(theme, undefined)).toEqual({ r: 0x0b, g: 0x0e, b: 0x14 });
  });
  it("主题静态 editorBackground 槽与 computeEditorBackground 一致(dark/light)", () => {
    for (const name of ["dark", "light"] as const) {
      const theme = loadTheme(name);
      const computed = rgbToHex(computeEditorBackground(resolveTerminalBackground(theme, undefined)));
      expect(theme.editorBackground).toBe(computed);
    }
  });
  it("editorBackgroundFromTerminal:无 OSC 回退 theme.background -> #282a30(接线回归)", () => {
    // 回归:InteractiveMode 曾把 resolveTerminalBackground 原值(终端背景 #0b0e14)直接当
    // 输入区背景,导致输入区与 transcript 同色(肉眼为黑);完整链必须经 blend。
    expect(editorBackgroundFromTerminal(loadTheme("dark"), undefined)).toBe("#282a30");
    expect(editorBackgroundFromTerminal(loadTheme("dark"), { r: 0, g: 0, b: 0 })).toBe("#282a30");
    expect(editorBackgroundFromTerminal(loadTheme("dark"), { r: 0x0b, g: 0x0e, b: 0x14 })).toBe("#282a30");
    expect(editorBackgroundFromTerminal(loadTheme("light"), undefined)).toBe("#f4f4f4");
  });
  it("parseHexColor 支持 #rgb 缩写与非法输入", () => {
    expect(parseHexColor("#fff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHexColor("nope")).toBeUndefined();
    expect(parseHexColor("")).toBeUndefined();
  });
  it("parseOsc11BackgroundColor 解析 4 位/2 位通道的 OSC 11 回复", () => {
    expect(parseOsc11BackgroundColor("\x1b]11;rgb:0b0e/0b0e/1414\x07"))
      .toEqual({ r: 11, g: 11, b: 20 });
    expect(parseOsc11BackgroundColor("\x1b]11;rgb:0b/0e/14\x07"))
      .toEqual({ r: 11, g: 14, b: 20 });
    expect(parseOsc11BackgroundColor("\x1b]11;#0b0e14\x07"))
      .toEqual({ r: 11, g: 14, b: 20 });
    expect(parseOsc11BackgroundColor("\x1b]10;rgb:ffff/ffff/ffff\x07")).toBeUndefined();
    expect(parseOsc11BackgroundColor("not-an-osc")).toBeUndefined();
  });
});

describe("Editor.render (codex 输入区复刻)", () => {
  function editor(): Editor {
    const theme = loadTheme("dark");
    return new Editor(new TUI(new ProcessTerminal()), makeEditorTheme(theme, makeSelectListTheme(theme)));
  }
  it("空输入渲染 dim 占位符,背景铺满整行", () => {
    const lines = editor().render(40);
    expect(lines.length).toBe(1);
    const line = lines[0] ?? "";
    expect(line).toContain("Message RunLedger");
    expect(line.startsWith("\x1b[4")).toBe(true); // 背景 SGR(16 色路径 40-49)
    expect(line).toContain("\x1b[39m"); // 前景 reset
    expect(visibleWidth(line)).toBe(40);
  });
  it("非空输入首行 `›` bold accent prompt,背景铺满", () => {
    const comp = editor();
    comp.setText("hello");
    const line = comp.render(40)[0] ?? "";
    expect(stripAnsi(line).startsWith("› hello")).toBe(true);
    expect(line).toMatch(/\x1b\[1m/u); // bold
    expect(visibleWidth(line)).toBe(40);
  });
  it("折行后续行无 prompt,左侧 2 列对齐", () => {
    const comp = editor();
    comp.setText("x".repeat(60));
    const lines = comp.render(30);
    expect(lines.length).toBeGreaterThan(1);
    expect(stripAnsi(lines[0] ?? "").startsWith("› x")).toBe(true);
    expect(stripAnsi(lines[1] ?? "").startsWith("  ")).toBe(true);
  });
  it("desiredHeight 与 editorHeight 一致(空输入 3)", () => {
    const comp = editor();
    expect(comp.desiredHeight(60)).toBe(3);
    comp.setText("a\nb");
    expect(comp.desiredHeight(60)).toBe(4);
  });
});
