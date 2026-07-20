/**
 * path-utils 单测 —— encodeCwd / safeIso / buildSessionFileName。
 */

import { describe, expect, it } from "vitest";

import {
  buildSessionFileName,
  encodeCwd,
  safeIso,
} from "../../src/storage/path-utils.ts";

describe("encodeCwd", () => {
  it("POSIX 绝对路径:去首 / 后所有分隔符替换为 -", () => {
    expect(encodeCwd("/home/foo/projects/x")).toBe("--home-foo-projects-x--");
  });

  it("Windows 路径:盘符冒号与反斜杠各自替换为 -,可能出现连续 -", () => {
    // 与 pi 行为一致:不做去重,纯字符级替换。
    // `C:\Users\foo\bar` → strip 首 `C` 不属于 separator → `C` + `:`变`-` + `\`变`-` + `Users` ...
    // 结果:--C--Users-foo-bar--
    expect(encodeCwd("C:\\Users\\foo\\bar")).toBe("--C--Users-foo-bar--");
  });

  it("根路径:去首 / 后空串,前后包夹", () => {
    expect(encodeCwd("/")).toBe("----");
  });

  it("带冒号路径(Linux 极少见但需保持稳定)", () => {
    expect(encodeCwd("/a/b:c")).toBe("--a-b-c--");
  });
});

describe("safeIso", () => {
  it("ISO 时间戳中的 : 与 . 全替换为 -", () => {
    const d = new Date("2026-07-20T16:42:33.079Z");
    expect(safeIso(d)).toBe("2026-07-20T16-42-33-079Z");
  });

  it("safeIso 输出必为文件名安全字符", () => {
    const d = new Date(Date.UTC(2025, 0, 1, 0, 0, 0));
    expect(safeIso(d)).not.toMatch(/[:.]/);
  });
});

describe("buildSessionFileName", () => {
  it("传 id 时使用该 id 拼接 .jsonl 后缀", () => {
    const d = new Date("2026-07-20T16:42:33.079Z");
    expect(buildSessionFileName(d, "abc12345")).toBe(
      "2026-07-20T16-42-33-079Z_abc12345.jsonl",
    );
  });

  it("未传 id 时生成 8 字符随机 id", () => {
    const name = buildSessionFileName(new Date("2026-07-20T16:42:33.079Z"));
    expect(name).toMatch(/^2026-07-20T16-42-33-079Z_[0-9a-f]{8}\.jsonl$/);
  });
});
