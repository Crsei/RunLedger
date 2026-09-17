/**
 * `read` 归档分支测试。
 *
 * 覆盖三件事：
 * 1. 分派判定 —— `a.zip:inner` 必须在行选择器解析之前被识别，否则 `inner` 会被
 *    `read-selector` 当成选择器语法吞掉（这是本分支存在的主要理由）；
 * 2. 渲染语义 —— 根目录清单、子目录清单、成员正文、二进制提示；
 * 3. 边界 —— 未识别格式、成员不存在、非归档路径不误分流。
 *
 * 归档字节由 `src/websource/internal/ar` 自带的编码器构造（纯 TS，无外部工具）。
 */

import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import {
  looksLikeArchiveBytes,
  parseArchiveReadTarget,
  readArchiveBytes,
} from "../../../src/runtime/tools/read-archive.ts";
import { encodeTar } from "../../../src/websource/internal/ar/tar.ts";
import { encodeZip } from "../../../src/websource/internal/ar/zip.ts";

const encoder = new TextEncoder();
const utf8 = (text: string): Uint8Array => encoder.encode(text);

/** 构造一个含根文件与子目录文件的 zip。 */
function zipBytes(): Promise<Uint8Array> {
  return encodeZip([
    ["hello.txt", utf8("hello from zip")],
    ["docs/readme.md", utf8("# inner markdown")],
  ]);
}

/** 构造一个含一条目的 tar.gz。 */
async function tarGzBytes(): Promise<Uint8Array> {
  return new Uint8Array(gzipSync(await encodeTar([["notes.txt", utf8("hello from tar")]])));
}

describe("archive dispatch", () => {
  it("sniffs archive bytes and rejects non-archives", async () => {
    expect(looksLikeArchiveBytes(await zipBytes())).toBe(true);
    expect(looksLikeArchiveBytes(await tarGzBytes())).toBe(true);
    expect(looksLikeArchiveBytes(utf8("just text"))).toBe(false);
    expect(looksLikeArchiveBytes(new Uint8Array([0, 1, 2, 3]))).toBe(false);
  });

  it("splits a zip member path before selector parsing", () => {
    const target = parseArchiveReadTarget("build/a.zip:docs/readme.md");
    expect(target).toEqual({ archivePath: "build/a.zip", subPath: "docs/readme.md" });
  });

  it("treats a bare archive path as the archive root", () => {
    expect(parseArchiveReadTarget("a.tar.gz")).toEqual({ archivePath: "a.tar.gz", subPath: "" });
  });

  it("does not claim non-archive paths", () => {
    expect(parseArchiveReadTarget("src/foo.ts:50-200")).toBeNull();
    expect(parseArchiveReadTarget("plain.txt")).toBeNull();
  });

  it("keeps the outer archive segment when nested extensions appear", () => {
    expect(parseArchiveReadTarget("a.tar.gz:inner.txt")).toEqual({ archivePath: "a.tar.gz", subPath: "inner.txt" });
  });
});

describe("archive rendering", () => {
  it("lists the root directory", async () => {
    const result = await readArchiveBytes(await zipBytes(), "");
    expect(result.method).toBe("archive-list");
    expect(result.text).toContain("hello.txt");
    expect(result.text).toContain("docs/");
  });

  it("lists a subdirectory without descending further", async () => {
    const result = await readArchiveBytes(await zipBytes(), "docs");
    expect(result.method).toBe("archive-list");
    expect(result.text).toContain("readme.md");
    expect(result.text).not.toContain("hello.txt");
  });

  it("reads a text member verbatim", async () => {
    const result = await readArchiveBytes(await zipBytes(), "hello.txt");
    expect(result.method).toBe("archive-member");
    expect(result.text).toBe("hello from zip");
  });

  it("reads a nested member", async () => {
    const result = await readArchiveBytes(await zipBytes(), "docs/readme.md");
    expect(result.method).toBe("archive-member");
    expect(result.text).toBe("# inner markdown");
  });

  it("reads a gzip-compressed tar member", async () => {
    const result = await readArchiveBytes(await tarGzBytes(), "notes.txt");
    expect(result.method).toBe("archive-member");
    expect(result.text).toBe("hello from tar");
  });

  it("flags a binary member instead of inlining it", async () => {
    const zip = await encodeZip([["blob.bin", new Uint8Array([0, 1, 2, 3])]]);
    const result = await readArchiveBytes(zip, "blob.bin");
    expect(result.method).toBe("archive-binary");
    expect(result.text).toContain("不是文本");
  });

  it("fails on an unknown member path", async () => {
    await expect(readArchiveBytes(await zipBytes(), "nope.txt")).rejects.toThrow();
  });

  it("fails on unrecognized bytes", async () => {
    await expect(readArchiveBytes(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), "")).rejects.toThrow();
  });
});
