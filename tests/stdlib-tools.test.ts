/**
 * stdlib 工具集单测 —— 覆盖 read / write / edit / bash / grep / find / ls
 * 各工具的关键行为。
 *
 * 设计选择:跨平台测试,工具走真实 fs 与 shell(execution-env 已独立测试)。
 * 测试目录用 mkdtemp 隔离,afterEach 清理。
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { createReadTool } from "../src/runtime/tools/read.ts";
import { createWriteTool } from "../src/runtime/tools/write.ts";
import { createEditTool } from "../src/runtime/tools/edit.ts";
import { createBashTool } from "../src/runtime/tools/bash.ts";
import { createGrepTool } from "../src/runtime/tools/grep.ts";
import { createFindTool } from "../src/runtime/tools/find.ts";
import { createLsTool } from "../src/runtime/tools/ls.ts";
import { createStdlibTools, stdlibTools } from "../src/runtime/tools/index.ts";

describe("stdlib tools (cross-platform)", () => {
  let dir: string;

  it("production composition rejects a missing governed ExecutionEnv", () => {
    expect(() => createStdlibTools("/workspace", { requireExecutionEnv: true })).toThrow(
      "governed ExecutionEnv is required",
    );
  });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "runledger-stdlib-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("read: 文本读 + offset/limit 切片", async () => {
    const file = path.join(dir, "lines.txt");
    await writeFile(file, "line1\nline2\nline3\nline4\nline5\n", "utf-8");
    const tool = createReadTool(dir);
    const r = await tool.execute("tc1", { path: "lines.txt", offset: 2, limit: 2 });
    expect(r.content[0]?.type).toBe("text");
    expect((r.content[0] as { text: string }).text).toContain("line2");
    expect((r.content[0] as { text: string }).text).toContain("line3");
    expect((r.content[0] as { text: string }).text).not.toContain("line4");
  });

  it("read: 不存在文件抛错", async () => {
    const tool = createReadTool(dir);
    await expect(tool.execute("tc1", { path: "nope.txt" })).rejects.toThrow();
  });

  it("write: 递归创建目录 + 覆盖已有内容", async () => {
    const file = path.join(dir, "sub", "a", "b.txt");
    const tool = createWriteTool(dir);
    const r = await tool.execute("tc1", { path: "sub/a/b.txt", content: "hello" });
    expect((r.content[0] as { text: string }).text).toContain("Successfully wrote 5 bytes");
    const disk = await readFile(file, "utf-8");
    expect(disk).toBe("hello");
    // 二次写:覆盖
    await tool.execute("tc2", { path: "sub/a/b.txt", content: "world" });
    const disk2 = await readFile(file, "utf-8");
    expect(disk2).toBe("world");
  });

  it("edit: oldText 多块替换 + details.diff 包含 '-' '+'", async () => {
    const file = path.join(dir, "e.txt");
    await writeFile(file, "alpha\nbeta\ngamma\n", "utf-8");
    const tool = createEditTool(dir);
    const r = await tool.execute("tc1", {
      path: "e.txt",
      edits: [
        { oldText: "beta", newText: "BETA" },
        { oldText: "gamma", newText: "GAMMA" },
      ],
    });
    expect((r.content[0] as { text: string }).text).toContain("Successfully edited");
    expect(r.details?.diff).toContain("-beta");
    expect(r.details?.diff).toContain("+BETA");
    const disk = await readFile(file, "utf-8");
    expect(disk).toBe("alpha\nBETA\nGAMMA\n");
  });

  it("edit: oldText 未匹配 → 抛错 + 不写入", async () => {
    const file = path.join(dir, "ne.txt");
    await writeFile(file, "abc\n", "utf-8");
    const tool = createEditTool(dir);
    await expect(
      tool.execute("tc1", { path: "ne.txt", edits: [{ oldText: "XYZ", newText: "QQQ" }] }),
    ).rejects.toThrow(/未在文件内找到/);
    // 输出未变化
    const disk = await readFile(file, "utf-8");
    expect(disk).toBe("abc\n");
  });

  it("bash: echo 输出 stdout", async () => {
    const tool = createBashTool(dir);
    const r = await tool.execute("tc1", { command: "echo ping" });
    expect(r.details?.exitCode).toBe(0);
    expect((r.content[0] as { text: string }).text).toContain("ping");
  });

  it("bash: 非零 exit 标 details.exitCode 非 0", async () => {
    const tool = createBashTool(dir);
    const r = await tool.execute("tc1", { command: "false" });
    expect(r.details?.exitCode).not.toBe(0);
  });

  it("grep: 在文件内查 pattern(注入 mock shell 跑 grep -F)", async () => {
    const sub = path.join(dir, "sub");
    await mkdir(sub, { recursive: true });
    await writeFile(path.join(sub, "g.txt"), "needle in haystack\nanother line\n", "utf-8");

    // 注入 mock shell:模拟 rg 不可用,走 grep -F 兜底
    const calls: { cmd: string }[] = [];
    let probeTimes = 0;
    const mockShell = {
      async exec(cmd: string) {
        calls.push({ cmd });
        // 第一次 rg --version probe → 不可用(exitCode=127)
        if (cmd === "rg --version" && probeTimes++ === 0) {
          return { stdout: "", stderr: "rg not found", exitCode: 127 };
        }
        // 第二次 grep -F ".--" "./sub" → 模拟命中
        if (cmd.startsWith("grep")) {
          // 抛回测试目录真实 grep 输出格式:./sub/g.ts:needle in haystack
          return {
            stdout: `${path.join(sub, "g.txt").replace(/\\/g, "/")}:needle in haystack`,
            stderr: "",
            exitCode: 0,
          };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };

    const tool = createGrepTool(dir, { shell: mockShell as never });
    const r = await tool.execute("tc1", {
      pattern: "needle",
      path: ".",
      literal: true,
    });
    expect((r.content[0] as { text: string }).text).toContain("needle");
    // 至少有 ripgrep probe + grep fallback 两次调用
    expect(calls.find((c) => c.cmd.startsWith("grep"))).toBeDefined();
  });

  it("find: 找 .ts 文件(fallback find -name)", async () => {
    await writeFile(path.join(dir, "a.ts"), "export const x = 1;", "utf-8");
    await writeFile(path.join(dir, "b.txt"), "hello", "utf-8");
    const tool = createFindTool(dir);
    const r = await tool.execute("tc1", { pattern: "*.ts", path: "." });
    expect((r.content[0] as { text: string }).text).toContain("a.ts");
  });

  it("find: fd 不存在时走 find fallback(mock shell)", async () => {
    let probeTimes = 0;
    const calls: { cmd: string }[] = [];
    const mockShell = {
      async exec(cmd: string) {
        calls.push({ cmd });
        if (cmd === "fd --version" && probeTimes++ === 0) {
          return { stdout: "", stderr: "fd not found", exitCode: 127 };
        }
        if (cmd.startsWith("find")) {
          return {
            stdout: `${dir.replace(/\\/g, "/")}/c.ts`,
            stderr: "",
            exitCode: 0,
          };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
    const tool = createFindTool(dir, { shell: mockShell as never });
    const r = await tool.execute("tc1", { pattern: "*.ts", path: "." });
    expect((r.content[0] as { text: string }).text).toContain("c.ts");
    expect(calls.find((c) => c.cmd.startsWith("find"))).toBeDefined();
  });

  it("ls: 列目录 + 目录条目尾部 '/'", async () => {
    await mkdir(path.join(dir, "subdir"), { recursive: true });
    await writeFile(path.join(dir, "f.txt"), "x", "utf-8");
    const tool = createLsTool(dir);
    const r = await tool.execute("tc1", { path: "." });
    const text = (r.content[0] as { text: string }).text;
    expect(text).toContain("subdir/");
    expect(text).toContain("f.txt");
  });

  it("ls: 不存在路径 → 抛错", async () => {
    const tool = createLsTool(dir);
    await expect(tool.execute("tc1", { path: "no-such-dir" })).rejects.toThrow();
  });

  it("createStdlibTools: 注册 13 个工具(8 个内置 + 4 占位 + echo)", () => {
    const r = createStdlibTools(dir);
    expect(r.size).toBe(13);
    expect(r.has("read")).toBe(true);
    expect(r.has("write")).toBe(true);
    expect(r.has("edit")).toBe(true);
    expect(r.has("MultiEdit")).toBe(true);
    expect(r.has("bash")).toBe(true);
    expect(r.has("grep")).toBe(true);
    expect(r.has("find")).toBe(true);
    expect(r.has("glob")).toBe(true);
    expect(r.has("ls")).toBe(true);
    expect(r.has("WebFetch")).toBe(true);
    expect(r.has("Skill")).toBe(true);
    expect(r.has("NotebookEdit")).toBe(true);
    expect(r.has("echo")).toBe(true);
    expect(r.has("nonexistent")).toBe(false);
  });

  it("stdlibTools helper: 返回 AgentTool[]", () => {
    const tools = stdlibTools(dir);
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBe(13);
    expect(tools.find((t) => t.name === "read")?.parameters).toBeDefined();
    expect(tools.find((t) => t.name === "glob")?.parameters).toBeDefined();
    expect(tools.find((t) => t.name === "MultiEdit")?.parameters).toBeDefined();
    expect(tools.find((t) => t.name === "WebFetch")?.parameters).toBeDefined();
    expect(tools.find((t) => t.name === "Skill")?.parameters).toBeDefined();
    expect(tools.find((t) => t.name === "NotebookEdit")?.parameters).toBeDefined();
  });
});
