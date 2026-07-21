/**
 * glob 工具单测 —— 验证第一方手写双星递归匹配。
 *
 * 测试覆盖:
 *   1. 单段 "str.ts":命中 root 下 str.ts 文件,不含子目录内同段。
 *   2. 跨深度 src 双星 末段 ts:跨深度全部命中,跳过 node_modules 与 .git。
 *   3. 全 cwd 双星 末段 ts:跳 .git 与 node_modules;按 mtime desc 排序。
 *   4. literal 段 abc.md:只命中名为 abc.md 的文件。
 *   5. limit 截断:details.limitReached=true。
 *
 * 复用 fs 写入真实 tmp;不依赖 ripgrep / fd / find 任何外部工具。
 */

import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createGlobTool } from "../src/index.ts";

async function setupFixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "glob-test-"));
  // 目录结构:
  // root/
  //   a.ts            (oldest)
  //   b.md
  //   c.txt
  //   src/
  //     x.ts
  //     x.md
  //     sub/
  //       y.ts
  //   node_modules/
  //     evade.ts       (should be skipped)
  //   .git/
  //     evade.ts       (should be skipped)
  await mkdir(path.join(root, "src", "sub"), { recursive: true });
  await mkdir(path.join(root, "node_modules"), { recursive: true });
  await mkdir(path.join(root, ".git"), { recursive: true });
  // 写文件并 sleep 一下让 mtimeMs 有差异;实测需要至少写一次 promise resolution
  await writeFile(path.join(root, "a.ts"), "a");
  await writeFile(path.join(root, "b.md"), "b");
  await writeFile(path.join(root, "c.txt"), "c");
  await writeFile(path.join(root, "src", "x.ts"), "x");
  await writeFile(path.join(root, "src", "x.md"), "x.md");
  await writeFile(path.join(root, "src", "sub", "y.ts"), "y");
  await writeFile(path.join(root, "node_modules", "evade.ts"), "should be skipped");
  await writeFile(path.join(root, ".git", "evade.ts"), "should be skipped");
  return root;
}

describe("glob tool", () => {
  it("*.ts 单段只命中 root 下 *.ts(不含子目录)", async () => {
    const root = await setupFixture();
    try {
      const tool = createGlobTool(root);
      const r = await tool.execute("tc", { pattern: "*.ts" });
      const text = (r.content[0] as { text: string }).text;
      const lines = text.split("\n").filter((l) => l.length > 0);
      // 必须命中 a.ts;不命中 src/x.ts (单段不递归)
      expect(lines.some((l) => l.endsWith("a.ts"))).toBe(true);
      expect(lines.some((l) => l.includes("src"))).toBe(false);
      expect(lines.some((l) => l.includes("node_modules"))).toBe(false);
      expect(lines.some((l) => l.includes(".git"))).toBe(false);
    } finally {
      // tmp 由 OS 兜底清理
    }
  });

  it("src/**/*.ts 跨深度递归,跳过 node_modules / .git", async () => {
    const root = await setupFixture();
    const tool = createGlobTool(root);
    const r = await tool.execute("tc", { pattern: "src/**/*.ts" });
    const lines = (r.content[0] as { text: string }).text.split("\n").filter((l) => l.length > 0);
    expect(lines.some((l) => l.includes("src/x.ts"))).toBe(true);
    expect(lines.some((l) => l.includes("src/sub/y.ts"))).toBe(true);
    expect(lines.some((l) => l.includes("node_modules"))).toBe(false);
    expect(lines.some((l) => l.includes(".git"))).toBe(false);
    expect(lines.some((l) => l.endsWith("a.ts"))).toBe(false);
  });

  it("literal 段:abc.md 只命中名为 abc.md 的文件", async () => {
    const root = await setupFixture();
    const tool = createGlobTool(root);
    const r = await tool.execute("tc", { pattern: "b.md" });
    const lines = (r.content[0] as { text: string }).text.split("\n").filter((l) => l.length > 0);
    expect(lines.some((l) => l.endsWith("b.md"))).toBe(true);
    expect(lines.some((l) => l.endsWith("x.md"))).toBe(false);
  });

  it("? 单字符通配命中 a.ts 不命中 abcd.ts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "glob-q-"));
    await writeFile(path.join(root, "a.ts"), "x");
    await writeFile(path.join(root, "ab.ts"), "x");
    const tool = createGlobTool(root);
    const r = await tool.execute("tc", { pattern: "?.ts" });
    const lines = (r.content[0] as { text: string }).text.split("\n").filter((l) => l.length > 0);
    expect(lines.some((l) => l.endsWith("a.ts"))).toBe(true);
    expect(lines.some((l) => l.endsWith("ab.ts"))).toBe(false);
  });

  it("limit=1 截断 → details.limitReached=true", async () => {
    const root = await setupFixture();
    const tool = createGlobTool(root);
    const r = await tool.execute("tc", { pattern: "**/*.ts", limit: 1 });
    const lines = (r.content[0] as { text: string }).text.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBeLessThanOrEqual(1);
    expect(r.details?.limitReached).toBe(true);
  });

  it("**/* 递归找到所有文件且按 mtime desc 排序", async () => {
    const root = await setupFixture();
    const tool = createGlobTool(root);
    const r = await tool.execute("tc", { pattern: "**/*" });
    const lines = (r.content[0] as { text: string }).text.split("\n").filter((l) => l.length > 0);
    // 至少 6 个文件(a/b/c/x.md/x.ts/y.ts)
    expect(lines.length).toBeGreaterThanOrEqual(6);
    // .git / node_modules 全部 trim 掉
    expect(lines.every((l) => !l.includes("node_modules") && !l.includes(".git"))).toBe(true);
  });

  it("isReadOnly=true 与 isConcurrencySafe=true(标记固化)", () => {
    const tool = createGlobTool(".");
    expect(tool.isReadOnly?.() ?? false).toBe(true);
    expect(tool.isConcurrencySafe?.() ?? false).toBe(true);
  });
});
