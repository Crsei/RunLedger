/**
 * read 行选择器 —— 对齐 oh-my-pi `tools/read-selector.ts` 的语法契约。
 *
 * 覆盖:单段/开放段/计数段/末尾段/多段合并、`raw` 复合形态、路径与选择器的
 * 拆分边界,以及未实现模式(`:conflicts` / `:img`)与非法选择器必须报错而不是
 * 静默放宽成整文件读取。
 */

import { describe, expect, it } from "vitest";
import {
  isRawSelector,
  parseLineRanges,
  parseSel,
  parseTailCount,
  resolveTailSelector,
  splitPathAndSel,
} from "../src/runtime/tools/read-selector.ts";

describe("read 选择器语法", () => {
  it("parses single, open-ended, counted, and dotted ranges", () => {
    expect(parseLineRanges("120")).toEqual([{ startLine: 120, endLine: undefined }]);
    expect(parseLineRanges("50-200")).toEqual([{ startLine: 50, endLine: 200 }]);
    expect(parseLineRanges("301-")).toEqual([{ startLine: 301, endLine: undefined }]);
    expect(parseLineRanges("10+5")).toEqual([{ startLine: 10, endLine: 14 }]);
    expect(parseLineRanges("2724..2727")).toEqual([{ startLine: 2724, endLine: 2727 }]);
  });

  it("sorts and merges overlapping or adjacent multi-ranges", () => {
    expect(parseLineRanges("960-973,5-16")).toEqual([
      { startLine: 5, endLine: 16 },
      { startLine: 960, endLine: 973 },
    ]);
    expect(parseLineRanges("1-10,11-20")).toEqual([{ startLine: 1, endLine: 20 }]);
    expect(parseLineRanges("1-10,5-8")).toEqual([{ startLine: 1, endLine: 10 }]);
    // open-ended 段吸收其后所有段。
    expect(parseLineRanges("50-,60-70")).toEqual([{ startLine: 50, endLine: undefined }]);
  });

  it("rejects invalid bounds instead of degrading", () => {
    expect(() => parseLineRanges("0")).toThrowError(/1-indexed/);
    expect(() => parseLineRanges("200-50")).toThrowError(/end must be >= start/);
    expect(() => parseLineRanges("10+0")).toThrowError(/count must be >= 1/);
    expect(() => parseTailCount("-0")).toThrowError(/N >= 1/);
  });

  it("resolves a tail selector against the source line count", () => {
    const tail = parseSel("-60");
    expect(tail).toEqual({ kind: "tail", count: 60 });
    expect(resolveTailSelector(tail, 100)).toEqual({ kind: "lines", ranges: [{ startLine: 41, endLine: 100 }] });
    // 源比 N 短时钳到第 1 行。
    expect(resolveTailSelector(tail, 5)).toEqual({ kind: "lines", ranges: [{ startLine: 1, endLine: 5 }] });
  });

  it("treats raw as a display mode, alone or compounded with a range", () => {
    expect(parseSel("raw")).toEqual({ kind: "raw" });
    expect(isRawSelector(parseSel("raw"))).toBe(true);
    expect(parseSel("raw:50-100")).toEqual({ kind: "lines", ranges: [{ startLine: 50, endLine: 100 }], raw: true });
    expect(parseSel("50-100:raw")).toEqual({ kind: "lines", ranges: [{ startLine: 50, endLine: 100 }], raw: true });
    expect(isRawSelector(parseSel("50-100:raw"))).toBe(true);
    expect(isRawSelector(parseSel("50-100"))).toBe(false);
  });

  it("throws for selector-shaped garbage that would otherwise widen the read", () => {
    expect(() => parseSel("1-50:99")).toThrowError(/Invalid selector/);
  });

  it("rejects read modes this runtime does not implement", () => {
    expect(() => parseSel("conflicts")).toThrowError(/not supported by this runtime/);
    expect(() => parseSel("img")).toThrowError(/not supported by this runtime/);
  });

  it("returns none for a non-selector tail so ordinary paths keep working", () => {
    expect(parseSel(undefined)).toEqual({ kind: "none" });
    expect(parseSel("")).toEqual({ kind: "none" });
    expect(parseSel("draft")).toEqual({ kind: "none" });
  });
});

describe("read path 与选择器拆分", () => {
  it("splits a trailing line-range selector", () => {
    expect(splitPathAndSel("src/foo.ts:50-200")).toEqual({ path: "src/foo.ts", sel: "50-200" });
    expect(splitPathAndSel("src/foo.ts:120")).toEqual({ path: "src/foo.ts", sel: "120" });
    expect(splitPathAndSel("src/foo.ts:-60")).toEqual({ path: "src/foo.ts", sel: "-60" });
    expect(splitPathAndSel("src/foo.ts:5-16,960-973")).toEqual({ path: "src/foo.ts", sel: "5-16,960-973" });
  });

  it("splits compounded raw selectors in both orders", () => {
    expect(splitPathAndSel("src/foo.ts:1-50:raw")).toEqual({ path: "src/foo.ts", sel: "1-50:raw" });
    expect(splitPathAndSel("src/foo.ts:raw:1-50")).toEqual({ path: "src/foo.ts", sel: "raw:1-50" });
    expect(splitPathAndSel("src/foo.ts:raw")).toEqual({ path: "src/foo.ts", sel: "raw" });
  });

  it("keeps a path whole when the tail is not selector-shaped", () => {
    expect(splitPathAndSel("src/foo.ts")).toEqual({ path: "src/foo.ts" });
    expect(splitPathAndSel("notes:draft")).toEqual({ path: "notes:draft" });
    expect(splitPathAndSel("C:\\work\\foo.ts")).toEqual({ path: "C:\\work\\foo.ts" });
  });
});
