/**
 * stdlib 工具集单测 —— 覆盖 read / write / edit / bash / grep / glob / ls
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
import { createGlobTool } from "../src/runtime/tools/glob.ts";
import { createLsTool } from "../src/runtime/tools/ls.ts";
import { createStdlibTools, stdlibTools } from "../src/runtime/tools/index.ts";
import { unavailableWebSearchCredentials } from "../src/websource/credentials.ts";
import type { ExecutionEnv } from "../src/runtime/execution-env.ts";

/** 只用于装配期判定:任何真实调用都会抛出,确保测试不触碰真实 I/O。 */
function inertExecutionEnv(cwd: string): ExecutionEnv {
  const unavailable = async (): Promise<never> => { throw new Error("not executed by stdlib registration test"); };
  return {
    cwd,
    fs: { readFile: unavailable, writeFile: unavailable, stat: unavailable, readdir: unavailable, mkdir: unavailable, rm: unavailable, rename: unavailable },
    shell: { exec: unavailable },
  };
}

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
		expect(r.details).toMatchObject({ lineCount: 2, truncation: { truncated: false, outputLines: 2, totalLines: 2 } });
  });

  it("read: 不存在文件抛错", async () => {
    const tool = createReadTool(dir);
    await expect(tool.execute("tc1", { path: "nope.txt" })).rejects.toThrow();
  });

  it("read: 内联行选择器切片,并与 offset/limit 报告优先级", async () => {
    const file = path.join(dir, "sel.txt");
    await writeFile(file, "line1\nline2\nline3\nline4\nline5\n", "utf-8");
    const tool = createReadTool(dir);

    const ranged = await tool.execute("tc1", { path: "sel.txt:2-3" });
    const rangedText = (ranged.content[0] as { text: string }).text;
    expect(rangedText).toContain("line2");
    expect(rangedText).toContain("line3");
    expect(rangedText).not.toContain("line4");
    expect(ranged.details).toMatchObject({ selector: "2-3", lineCount: 2 });

    const tailed = await tool.execute("tc2", { path: "sel.txt:-2" });
    const tailedText = (tailed.content[0] as { text: string }).text;
    expect(tailedText).toContain("line4");
    expect(tailedText).toContain("line5");
    expect(tailedText).not.toContain("line3");

    // 选择器带 :raw 时不加行号前缀。
    const raw = await tool.execute("tc3", { path: "sel.txt:1-2:raw" });
    expect((raw.content[0] as { text: string }).text).not.toMatch(/^\s+1\t/m);

    // 选择器与 offset/limit 同时给出时选择器优先,并在 details 记录被忽略的参数。
    const precedence = await tool.execute("tc4", { path: "sel.txt:5", offset: 1, limit: 1 });
    expect((precedence.content[0] as { text: string }).text).toContain("line5");
    expect(precedence.details).toMatchObject({ selector: "5", ignoredParams: ["offset", "limit"] });
  });

  it("read: 多段选择器保留行号以标出省略区间", async () => {
    const file = path.join(dir, "multi.txt");
    await writeFile(file, Array.from({ length: 20 }, (_, i) => `row${i + 1}`).join("\n") + "\n", "utf-8");
    const tool = createReadTool(dir);
    const r = await tool.execute("tc1", { path: "multi.txt:1-2,10-11" });
    const text = (r.content[0] as { text: string }).text;
    expect(text).toContain("row1");
    expect(text).toContain("row10");
    expect(text).not.toContain("row5");
    expect(r.details).toMatchObject({ selector: "1-2,10-11", lineCount: 4 });
  });

  it("read: 未实现的选择器模式报错而不是放宽成整文件读取", async () => {
    const file = path.join(dir, "unsupported.txt");
    await writeFile(file, "a\nb\n", "utf-8");
    const tool = createReadTool(dir);
    await expect(tool.execute("tc1", { path: "unsupported.txt:conflicts" })).rejects.toThrow(/not supported by this runtime/);
    await expect(tool.execute("tc2", { path: "unsupported.txt:0" })).rejects.toThrow(/1-indexed/);
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

  it("edit: prepareArguments 接受 oh-my-pi 命名 old_string/new_string/replace_all", async () => {
    const file = path.join(dir, "alias.txt");
    await writeFile(file, "alpha beta alpha\n", "utf-8");
    const tool = createEditTool(dir);
    const prepared = tool.prepareArguments!({
      path: "alias.txt",
      edits: [{ old_string: "alpha", new_string: "A", replace_all: true }],
    });
    expect(prepared).toEqual({ path: "alias.txt", edits: [{ oldText: "alpha", newText: "A", replaceAll: true, findActualString: false }] });
    await tool.execute("tc1", prepared);
    expect(await readFile(file, "utf-8")).toBe("A beta A\n");
  });

  it("bash: echo 输出 stdout", async () => {
    const tool = createBashTool(dir);
    const r = await tool.execute("tc1", { command: "echo ping" });
    expect(r.details?.exitCode).toBe(0);
    expect((r.content[0] as { text: string }).text).toContain("ping");
  });

  it("bash: missing command explains how to inspect the tool environment", async () => {
    const result = await createBashTool(dir).execute("missing", { command: "runledger_nonexistent_command_8be1" });
    expect(result.details?.exitCode).toBe(127);
    expect((result.content[0] as { text: string }).text).toContain("command -v");
  });

  it("bash: 非零 exit 标 details.exitCode 非 0", async () => {
    const tool = createBashTool(dir);
    const r = await tool.execute("tc1", { command: "false" });
    expect(r.details?.exitCode).not.toBe(0);
  });

	it("bash: preserves a typed Host denial without parsing its message", async () => {
		const failure = Object.assign(new Error("request failed without a parseable marker"), { code: "approval_expired" });
		const tool = createBashTool(dir, {
			managedProcess: {
				start: async () => ({ ok: false, code: "unused" }),
				exec: async () => { throw failure; },
			},
		});

		const result = await tool.execute("tc-expired", { command: "printf never" });

		expect(result).toMatchObject({ isError: true, details: { errorCode: "approval_expired" } });
	});

	it("bash: preserves a typed background-process rejection", async () => {
		const tool = createBashTool(dir, {
			managedProcess: {
				start: async () => ({ ok: false, code: "approval_expired" }),
			},
		});

		const result = await tool.execute("tc-expired-background", { command: "printf never", run_in_background: true });

		expect(result).toMatchObject({ isError: true, details: { errorCode: "approval_expired" } });
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
		expect(r.details).toMatchObject({ matchCount: 1, truncation: { truncated: false, outputLines: 1, totalLines: 1 } });
    // 至少有 ripgrep probe + grep fallback 两次调用
    expect(calls.find((c) => c.cmd.startsWith("grep"))).toBeDefined();
  });

  it("grep: context 输出只计真实命中行", async () => {
    const file = path.join(dir, "context.txt").replace(/\\/g, "/");
    const mockShell = {
      async exec(cmd: string) {
        if (cmd === "rg --version") return { stdout: "ripgrep 14", stderr: "", exitCode: 0 };
        return {
          stdout: [
            `${file}:2:needle first`,
            `${file}-3-context after first`,
            "--",
            `${file}-7-context before second`,
            `${file}:8:needle second`,
          ].join("\n"),
          stderr: "",
          exitCode: 0,
        };
      },
    };
    const tool = createGrepTool(dir, { shell: mockShell as never });
    const result = await tool.execute("tc-context", { pattern: "needle", path: ".", context: 1 });

    expect(result.details).toMatchObject({
      matchCount: 2,
      fileCount: 1,
      resultCount: 2,
      resultUnit: "matches",
    });
  });

  it("grep: 文件名中的 -数字- 不会把真实命中误判为 context", async () => {
    const file = path.join(dir, "file-2-old.ts").replace(/\\/g, "/");
    const mockShell = {
      async exec(cmd: string) {
        if (cmd === "rg --version") return { stdout: "ripgrep 14", stderr: "", exitCode: 0 };
        return {
          stdout: [
            `${file}-7-context before match`,
            `${file}:8:needle`,
          ].join("\n"),
          stderr: "",
          exitCode: 0,
        };
      },
    };
    const tool = createGrepTool(dir, { shell: mockShell as never });
    const result = await tool.execute("tc-context-hyphenated-path", { pattern: "needle", path: ".", context: 1 });

    expect(result.details).toMatchObject({
      matchCount: 1,
      fileCount: 1,
      resultCount: 1,
      resultUnit: "matches",
    });
  });

  it("grep: files-with-matches 以文件数作为结果单位", async () => {
    const first = path.join(dir, "a.ts").replace(/\\/g, "/");
    const second = path.join(dir, "b.ts").replace(/\\/g, "/");
    const mockShell = {
      async exec(cmd: string) {
        if (cmd === "rg --version") return { stdout: "ripgrep 14", stderr: "", exitCode: 0 };
        return { stdout: `${first}\n${second}\n`, stderr: "", exitCode: 0 };
      },
    };
    const tool = createGrepTool(dir, { shell: mockShell as never });
    const result = await tool.execute("tc-files", {
      pattern: "needle",
      path: ".",
      outputFormat: "files-with-matches",
    });

    expect(result.details).toMatchObject({
      fileCount: 2,
      resultCount: 2,
      resultUnit: "files",
    });
    expect(result.details).not.toHaveProperty("matchCount");
  });

  it("grep: skip 跳过前 N 个命中文件,与 limit 组成翻页", async () => {
    const first = path.join(dir, "a.ts").replace(/\\/g, "/");
    const second = path.join(dir, "b.ts").replace(/\\/g, "/");
    const third = path.join(dir, "c.ts").replace(/\\/g, "/");
    const mockShell = {
      async exec(cmd: string) {
        if (cmd === "rg --version") return { stdout: "ripgrep 14", stderr: "", exitCode: 0 };
        return { stdout: `${first}:1:hit a\n${second}:1:hit b\n${third}:1:hit c\n`, stderr: "", exitCode: 0 };
      },
    };
    const tool = createGrepTool(dir, { shell: mockShell as never });

    const page2 = await tool.execute("tc1", { pattern: "hit", path: ".", skip: 1 });
    const text = (page2.content[0] as { text: string }).text;
    expect(text).toContain("hit b");
    expect(text).toContain("hit c");
    expect(text).not.toContain("hit a");
    expect(page2.details).toMatchObject({ skippedFileCount: 1, resultCount: 2, fileCount: 2 });

    // 不传 skip 时行为与历史一致。
    const firstPage = await tool.execute("tc2", { pattern: "hit", path: "." });
    expect((firstPage.content[0] as { text: string }).text).toContain("hit a");
    expect(firstPage.details).not.toHaveProperty("skippedFileCount");
  });

  it("glob: 不含 / 的 pattern 在任意深度匹配(承接原 find 语义)", { skip: process.platform === "win32" }, async () => {
    await mkdir(path.join(dir, "nested"), { recursive: true });
    await writeFile(path.join(dir, "a.ts"), "export const x = 1;", "utf-8");
    await writeFile(path.join(dir, "nested", "b.ts"), "export const y = 2;", "utf-8");
    await writeFile(path.join(dir, "c.txt"), "hello", "utf-8");
    const tool = createGlobTool(dir);
    const r = await tool.execute("tc1", { pattern: "*.ts", path: "." });
    const text = (r.content[0] as { text: string }).text;
    expect(text).toContain("a.ts");
    expect(text).toContain("b.ts");
    expect(text).not.toContain("c.txt");
    expect(r.details).toMatchObject({ matchCount: 2 });
  });

  it("glob: 分号分隔多个 pattern 并按路径去重", { skip: process.platform === "win32" }, async () => {
    await writeFile(path.join(dir, "a.ts"), "x", "utf-8");
    await writeFile(path.join(dir, "b.md"), "y", "utf-8");
    const tool = createGlobTool(dir);
    const r = await tool.execute("tc1", { pattern: "*.ts; *.md", path: "." });
    const text = (r.content[0] as { text: string }).text;
    expect(text).toContain("a.ts");
    expect(text).toContain("b.md");
    expect(r.details).toMatchObject({ matchCount: 2 });
  });

  it("glob: 默认跳过隐藏条目,hidden=true 时包含", { skip: process.platform === "win32" }, async () => {
    await writeFile(path.join(dir, ".hidden.ts"), "x", "utf-8");
    await writeFile(path.join(dir, "shown.ts"), "y", "utf-8");
    const tool = createGlobTool(dir);

    const hiddenOff = await tool.execute("tc1", { pattern: "*.ts", path: "." });
    expect((hiddenOff.content[0] as { text: string }).text).not.toContain(".hidden.ts");
    expect(hiddenOff.details).toMatchObject({ skippedHidden: 1 });

    const hiddenOn = await tool.execute("tc2", { pattern: "*.ts", path: ".", hidden: true });
    expect((hiddenOn.content[0] as { text: string }).text).toContain(".hidden.ts");
  });

  it("glob: gitignore=true 跳过根 .gitignore 命中的条目", { skip: process.platform === "win32" }, async () => {
    await writeFile(path.join(dir, ".gitignore"), "ignored/\n*.log\n", "utf-8");
    await mkdir(path.join(dir, "ignored"), { recursive: true });
    await writeFile(path.join(dir, "ignored", "deep.ts"), "x", "utf-8");
    await writeFile(path.join(dir, "debug.log"), "y", "utf-8");
    await writeFile(path.join(dir, "keep.ts"), "z", "utf-8");
    const tool = createGlobTool(dir);

    const respecting = await tool.execute("tc1", { pattern: "**/*", path: "." });
    const respectingText = (respecting.content[0] as { text: string }).text;
    expect(respectingText).toContain("keep.ts");
    expect(respectingText).not.toContain("debug.log");
    expect(respectingText).not.toContain("deep.ts");
    expect(respecting.details.skippedIgnored).toBeGreaterThan(0);

    const ignoring = await tool.execute("tc2", { pattern: "**/*", path: ".", gitignore: false });
    expect((ignoring.content[0] as { text: string }).text).toContain("debug.log");
  });

  it("ls: 列目录 + 目录条目尾部 '/'", async () => {
    await mkdir(path.join(dir, "subdir"), { recursive: true });
    await writeFile(path.join(dir, "f.txt"), "x", "utf-8");
    const tool = createLsTool(dir);
    const r = await tool.execute("tc1", { path: "." });
    const text = (r.content[0] as { text: string }).text;
    expect(text).toContain("subdir/");
    expect(text).toContain("f.txt");
		expect(r.details).toMatchObject({ entryCount: 2, truncation: { truncated: false, outputLines: 2, totalLines: 2 } });
  });

  it("ls: 不存在路径 → 抛错", async () => {
    const tool = createLsTool(dir);
    await expect(tool.execute("tc1", { path: "no-such-dir" })).rejects.toThrow();
  });

  it("createStdlibTools: 注册 13 个工具(7 个内置 + todo + 4 占位 + echo)", () => {
    const r = createStdlibTools(dir);
    expect(r.size).toBe(13);
    expect(r.has("read")).toBe(true);
    expect(r.has("write")).toBe(true);
    expect(r.has("edit")).toBe(true);
    expect(r.has("MultiEdit")).toBe(true);
    expect(r.has("bash")).toBe(true);
    expect(r.has("grep")).toBe(true);
    // find 已并入 glob;旧调用名由别名表解析,不再单独占一个注册条目。
    expect(r.has("find")).toBe(false);
    expect(r.has("glob")).toBe(true);
    expect(r.has("ls")).toBe(true);
    expect(r.has("todo")).toBe(true);
    expect(r.has("WebFetch")).toBe(true);
    expect(r.has("Skill")).toBe(true);
    expect(r.has("NotebookEdit")).toBe(true);
    expect(r.has("echo")).toBe(true);
    expect(r.has("nonexistent")).toBe(false);
  });

  it("createStdlibTools: 注入 webSearch 且提供 executionEnv 时才注册 web_search", () => {
    // 未接线(缺端口)时不注册:否则模型会看到一个必然失败的工具。
    expect(createStdlibTools(dir).has("web_search")).toBe(false);
    const env = inertExecutionEnv(dir);
    const withoutPorts = createStdlibTools(dir, { executionEnv: env });
    expect(withoutPorts.has("web_search")).toBe(false);
    const withPorts = createStdlibTools(dir, {
      executionEnv: env,
      webSearch: { credentials: unavailableWebSearchCredentials() },
    });
    expect(withPorts.has("web_search")).toBe(true);
    expect(withPorts.size).toBe(15);
    // 出站工具的 capability claim 必须为 network,否则 Plan Mode 会按未知效果拒绝。
    expect(withPorts.get("web_search")?.capabilityClaims?.map((claim) => claim.name)).toEqual(["network"]);
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
