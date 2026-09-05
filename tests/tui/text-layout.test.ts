import { describe, expect, it } from "vitest";
import stripAnsi from "strip-ansi";
import { sliceByColumn, visibleWidth, wrapTextWithAnsi } from "../../src/tui/text-layout.ts";

describe("lossless terminal text layout", () => {
  it.each(["\x07", "\x1b\\"])("keeps OSC hyperlink labels visible with terminator %j", (end) => {
    const link = `\x1b]8;;https://example.test${end}link\x1b]8;;${end}`;
    expect(visibleWidth(link)).toBe(4);
    expect(stripAnsi(sliceByColumn(link, 0, 4))).toBe("link");
    expect(wrapTextWithAnsi(link, 2).map(stripAnsi)).toEqual(["li", "nk"]);
  });

  it("keeps an indivisible wide grapheme when one column cannot contain it", () => {
    expect(wrapTextWithAnsi("汉a", 1)).toEqual(["汉", "a"]);
    expect(wrapTextWithAnsi("👩‍💻e\u0301", 1)).toEqual(["👩‍💻", "e\u0301"]);
  });

  it("preserves color tokens, explicit empty lines and the complete narrow text", () => {
    const input = "\x1b[31m汉abc\x1b[0m";
    expect(wrapTextWithAnsi(input, 2).join("")).toBe(input);
    expect(wrapTextWithAnsi("ab\n\ncd", 1)).toEqual(["a", "b", "", "c", "d"]);
  });
});
