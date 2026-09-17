/**
 * `read` 工具的类型分派端到端测试。
 *
 * 单独测 `read-sqlite` / `read-archive` 覆盖不到本层的核心风险：**分派必须发生在
 * `splitPathAndSel` 之前**。`db.sqlite:users` 与 `a.zip:inner` 的 `:users`/`:inner`
 * 会被行选择器解析成选择器语法，从而把路径截断成 `db.sqlite`/`a.zip` 并丢掉成员名。
 * 这里用真实的 `createReadTool` 证明两者都能按预期分流，且普通文本路径行为不变。
 */

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createReadTool, type ReadToolDetails } from "../../../src/runtime/tools/read.ts";
import { encodeZip } from "../../../src/websource/internal/ar/zip.ts";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "runledger-read-dispatch-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 造一个真实 sqlite 库文件，返回其文件名。 */
function makeSqlite(name: string): string {
  const path = join(dir, name);
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
  db.exec("INSERT INTO users (id, name) VALUES (1, 'alice'), (2, 'bob')");
  db.close();
  return name;
}

async function makeZip(name: string): Promise<string> {
  const encoder = new TextEncoder();
  const bytes = await encodeZip([
    ["member.txt", encoder.encode("zip member body")],
    ["nested/deep.txt", encoder.encode("nested body")],
  ]);
  writeFileSync(join(dir, name), bytes);
  return name;
}

async function read(path: string): Promise<{ text: string; details: ReadToolDetails }> {
  const tool = createReadTool(dir);
  const result = await tool.execute("tc", { path });
  const [first] = result.content;
  return { text: first?.type === "text" ? first.text : "", details: result.details };
}

describe("read type dispatch", () => {
  it("keeps plain text reads on the existing path", async () => {
    writeFileSync(join(dir, "plain.txt"), "line one\nline two\nline three\n");
    const { text, details } = await read("plain.txt");
    expect(text).toContain("line one");
    expect(text).toContain("line three");
    expect(details.media).toBeUndefined();
    expect(details.lineCount).toBe(3);
  });

  it("still applies inline line selectors to text files", async () => {
    writeFileSync(join(dir, "sel.txt"), "a\nb\nc\nd\ne\n");
    const { text } = await read("sel.txt:2-4");
    expect(text).toContain("b");
    expect(text).toContain("d");
    expect(text).not.toContain("e");
  });

  it("lists sqlite tables when only the database path is given", async () => {
    const { text, details } = await read(makeSqlite("plain.db"));
    expect(details.media).toBe("sqlite");
    expect(text).toContain("users");
  });

  it("reads a sqlite table through the colon selector", async () => {
    // 关键回归：`users` 必须被当作表名，而不是被 splitPathAndSel 吞成行选择器。
    const { text, details } = await read(`${makeSqlite("table.db")}:users`);
    expect(details.media).toBe("sqlite");
    expect(text).toContain("users");
    expect(text).toContain("CREATE TABLE");
  });

  it("reads a sqlite row through the table:key selector", async () => {
    const { text } = await read(`${makeSqlite("row.db")}:users:2`);
    expect(text).toContain("bob");
    expect(text).not.toContain("alice");
  });

  it("runs a raw sqlite query through the ?q= form", async () => {
    const { text, details } = await read(`${makeSqlite("query.db")}?q=SELECT name FROM users ORDER BY name`);
    expect(details.media).toBe("sqlite");
    expect(text).toContain("alice");
    expect(text).toContain("bob");
  });

  it("treats a non-sqlite file with a db extension as text", async () => {
    // 扩展名命中但魔数不符：必须回落文本，绝不按数据库打开。
    writeFileSync(join(dir, "notes.db"), "not a database, just text\n");
    const { text, details } = await read("notes.db");
    expect(details.media).toBeUndefined();
    expect(text).toContain("not a database, just text");
  });

  it("lists archive entries when only the archive path is given", async () => {
    const { text, details } = await read(await makeZip("plain.zip"));
    expect(details.media).toBe("archive");
    expect(text).toContain("member.txt");
    expect(text).toContain("nested/");
  });

  it("reads an archive member through the colon selector", async () => {
    // 同上：`member.txt` 必须被当作成员名，而不是行选择器。
    const { text, details } = await read(`${await makeZip("member.zip")}:member.txt`);
    expect(details.media).toBe("archive");
    expect(text).toBe("zip member body");
  });

  it("reads a nested archive member", async () => {
    const { text } = await read(`${await makeZip("nested.zip")}:nested/deep.txt`);
    expect(text).toBe("nested body");
  });

  it("reports a typed failure for a missing archive member", async () => {
    await expect(read(`${await makeZip("missing.zip")}:nope.txt`)).rejects.toThrow();
  });
});
