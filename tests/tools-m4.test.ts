/**
 * M4 占位工具单测 —— MultiEdit / WebFetch / Skill / NotebookEdit / TodoWrite.
 *
 * 覆盖:
 *   - MultiEdit: 一次调用 N 处编辑 + 任一 fail 整体 abort(不写文件)。
 *   - MultiEdit: replaceAll 全替换。
 *   - WebFetch: HTTP 升级 HTTPS(localhost 不升) + 大于 maxBytes 截断。
 *   - WebFetch: 跨 host redirect 报错。
 *   - Skill: handler 不存在 → 友好提示。
 *   - Skill: handler 命中 → 透传结果。
 *   - NotebookEdit: 永远返回 not-implemented 提示。
 *   - TodoWrite: 整盘覆盖增删改 status。
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createMultiEditTool, createWebFetchTool, createSkillTool, createNotebookEditTool, createTodoWriteTool, MemoryLedger } from "../src/index.ts";

describe("M4 占位工具", () => {
  describe("MultiEdit", () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(path.join(tmpdir(), "medit-"));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("一次调用 N 处编辑成功", async () => {
      const fp = path.join(dir, "a.txt");
      await writeFile(fp, "alpha beta gamma", "utf8");
      const tool = createMultiEditTool(dir);
      const r = await tool.execute("tc", {
        filePath: "a.txt",
        edits: [
          { oldString: "alpha", newString: "ALPHA" },
          { oldString: "gamma", newString: "GAMMA" },
        ],
      });
      const after = await readFile(fp, "utf8");
      expect(after).toBe("ALPHA beta GAMMA");
      expect(r.details.applied).toBe(2);
    });

    it("任一 oldString 不存在 → abort(不写文件)", async () => {
      const fp = path.join(dir, "b.txt");
      await writeFile(fp, "hello world", "utf8");
      const tool = createMultiEditTool(dir);
      await expect(
        tool.execute("tc", {
          filePath: "b.txt",
          edits: [
            { oldString: "hello", newString: "HELLO" },
            { oldString: "missing", newString: "x" },
          ],
        }),
      ).rejects.toThrow();
      // 文件未被改:仍 hello world
      expect(await readFile(fp, "utf8")).toBe("hello world");
    });

    it("replaceAll true → 全部替换", async () => {
      const fp = path.join(dir, "c.txt");
      await writeFile(fp, "x x x", "utf8");
      const tool = createMultiEditTool(dir);
      const r = await tool.execute("tc", {
        filePath: "c.txt",
        edits: [{ oldString: "x", newString: "Y", replaceAll: true }],
      });
      expect(await readFile(fp, "utf8")).toBe("Y Y Y");
      expect(r.details.applied).toBe(1);
    });
  });

  describe("WebFetch", () => {
    let tool: ReturnType<typeof createWebFetchTool>;
    let originalFetch: typeof globalThis.fetch;
    beforeEach(() => {
      tool = createWebFetchTool();
      originalFetch = globalThis.fetch;
    });
    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("HTTP 非 localhost → 升级 HTTPS", async () => {
      const calls: string[] = [];
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        calls.push(url);
        return new Response("hello", { status: 200, headers: { "content-type": "text/plain" } });
      }) as typeof globalThis.fetch;
      const r = await tool.execute("tc", { url: "http://example.com/x", prompt: "summarize" });
      expect(calls[0]).toMatch(/^https:\/\/example\.com/);
      expect((r.content[0] as { text: string }).text).toContain("hello");
    });

    it("HTTP localhost → 不升级 HTTPS", async () => {
      const calls: string[] = [];
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        calls.push(url);
        return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
      }) as typeof globalThis.fetch;
      await tool.execute("tc", { url: "http://localhost:3000/p", prompt: "x" });
      expect(calls[0]).toMatch(/^http:\/\/localhost/);
    });

    it("跨 host redirect → throw", async () => {
      globalThis.fetch = (async (_input: string | URL | Request) => {
        return new Response("", {
          status: 302,
          headers: { location: "http://other-host.com/y" },
        });
      }) as typeof globalThis.fetch;
      await expect(
        tool.execute("tc", { url: "https://example.com/x", prompt: "x" }),
      ).rejects.toThrow(/WebFetch: cross-host redirect/);
    });

    it("maxBytes 截断 → truncated=true", async () => {
      globalThis.fetch = (async (_input: string | URL | Request) => {
        const big = "A".repeat(100);
        return new Response(big, { status: 200, headers: { "content-type": "text/plain" } });
      }) as typeof globalThis.fetch;
      const r = await tool.execute("tc", { url: "https://example.com/x", prompt: "x", maxBytes: 20 });
      expect(r.details.truncated).toBe(true);
      expect(r.details.fetchedBytes).toBe(100);
    });
  });

  describe("Skill", () => {
    it("未注册 skill → 友好提示,matched=false", async () => {
      const tool = createSkillTool();
      const r = await tool.execute("tc", { name: "no-such-skill" });
      const text = (r.content[0] as { text: string }).text;
      expect(text).toMatch(/not registered/);
      expect(r.details.matched).toBe(false);
    });

    it("命中 handler,透传结果", async () => {
      const tool = createSkillTool({
        handlers: { greet: async (args) => `hi ${args?.name ?? "anon"}` },
      });
      const r = await tool.execute("tc", { name: "greet", args: { name: "alice" } });
      const text = (r.content[0] as { text: string }).text;
      expect(text).toContain("hi alice");
      expect(r.details.matched).toBe(true);
    });
  });

  describe("NotebookEdit (占位)", () => {
    it("永远返回 not-implemented", async () => {
      const tool = createNotebookEditTool();
      const r = await tool.execute("tc", {
        notebook_path: "x.ipynb",
        new_source: "print(1)",
      });
      const text = (r.content[0] as { text: string }).text;
      expect(text).toMatch(/不实现|占位|not.*implement/i);
      expect(r.details.notImplemented).toBe(true);
    });
  });

  describe("TodoWrite", () => {
    it("整盘覆盖:增 2 = written 2、删 1 = deleted 1", async () => {
      const ledger = new MemoryLedger();
      const tool = createTodoWriteTool({ ledger });
      // 第一轮:写两条
      const r1 = await tool.execute("tc", {
        todos: [
          { content: "task A", status: "pending" },
          { content: "task B", status: "in_progress" },
        ],
      });
      expect(r1.details.written).toBe(2);
      expect(r1.details.deleted).toBe(0);
      // 第二轮:只保留 A,旧 B 被删
      const r2 = await tool.execute("tc", {
        todos: [{ content: "task A", status: "in_progress" }],
      });
      expect(r2.details.written).toBe(0);
      expect(r2.details.updated).toBe(1);
      expect(r2.details.deleted).toBe(1);
    });
  });
});
