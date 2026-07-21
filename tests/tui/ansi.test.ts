/**
 * ANSI helper 单测:rgbToAnsi256 / ansi256ToAnsi16 / wrapFg / wrapBold 等。
 *
 * 对照 development-doc/tui/05-theme.md §4 与 src/tui/theme/ansi.ts。
 */

import { describe, it, expect } from "vitest";
import {
  rgbToAnsi256,
  ansi256ToAnsi16,
  wrapFg,
  wrapBold,
  wrapItalic,
  wrapUnderline,
  wrapStrikethrough,
} from "../../src/tui/theme/ansi.ts";

describe("rgbToAnsi256", () => {
  it("黑色 (0,0,0) -> 16", () => {
    expect(rgbToAnsi256(0, 0, 0)).toBe(16);
  });
  it("白色 (255,255,255) -> 231", () => {
    expect(rgbToAnsi256(255, 255, 255)).toBe(231);
  });
  it("灰色 (128,128,128) -> 灰阶索引", () => {
    expect(rgbToAnsi256(128, 128, 128)).toBeGreaterThanOrEqual(232);
    expect(rgbToAnsi256(128, 128, 128)).toBeLessThanOrEqual(255);
  });
  it("红色 (255,0,0) -> 196", () => {
    expect(rgbToAnsi256(255, 0, 0)).toBe(196);
  });
});

describe("ansi256ToAnsi16", () => {
  it("0->0,15->15 黑白保持", () => {
    expect(ansi256ToAnsi16(0)).toBe(0);
    expect(ansi256ToAnsi16(15)).toBe(15);
  });
  it("232(深灰)->0", () => {
    expect(ansi256ToAnsi16(232)).toBe(0);
  });
  it("255(亮灰)->15", () => {
    expect(ansi256ToAnsi16(255)).toBe(15);
  });
});

describe("wrapFg / wrap bold italic underline", () => {
  it("wrapFg 输出含 SGR ANSI 序列(16 色回退形态)", () => {
    const fn = wrapFg("#ff0000");
    const out = fn("hi");
    expect(out).toContain("hi");
    // 16 色回退输出 \x1b[<code>m...\x1b[39m 或 \x1b[38;5;n m 形态;两者任一可接受
    expect(out).toMatch(/\x1b\[(3[0-9]|9[0-9]|38;5;[0-9]+)m/);
    expect(out).toContain("\x1b[39m");
  });
  it("非法 hex 回退到 0,0,0 ANSI wrap,不抛错", () => {
    const fn = wrapFg("not-a-hex");
    // 解析失败 -> [0,0,0] -> 16 色回退到 ANSI 0(black) -> SGR 30,但 xterm 通常映射为
    // 16 色回退时按 ANSI 16 表里 black=0 -> 输出 \x1b[30m...\x1b[39m
    const out = fn("hi");
    expect(out).toContain("hi");
  });
  it("wrapBold 加 \x1b[1m / \x1b[22m", () => {
    expect(wrapBold("x")).toBe("\x1b[1mx\x1b[22m");
  });
  it("wrapItalic 加 \x1b[3m / \x1b[23m", () => {
    expect(wrapItalic("x")).toBe("\x1b[3mx\x1b[23m");
  });
  it("wrapUnderline 加 \x1b[4m / \x1b[24m", () => {
    expect(wrapUnderline("x")).toBe("\x1b[4mx\x1b[24m");
  });
  it("wrapStrikethrough 加 \x1b[9m / \x1b[29m", () => {
    expect(wrapStrikethrough("x")).toBe("\x1b[9mx\x1b[29m");
  });
});
