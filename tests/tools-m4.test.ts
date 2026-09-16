/**
 * M4 占位工具单测 —— MultiEdit / WebFetch / Skill / NotebookEdit / todo。
 *
 * 覆盖:
 *   - MultiEdit: 一次调用 N 处编辑 + 任一 fail 整体 abort(不写文件)。
 *   - MultiEdit: replaceAll 全替换。
 *   - WebFetch: HTTP 升级 HTTPS(localhost 不升) + 大于 maxBytes 截断。
 *   - WebFetch: 跨 host redirect 报错。
 *   - Skill: handler 不存在 → 友好提示。
 *   - Skill: handler 命中 → 透传结果。
 *   - NotebookEdit: 永远返回 not-implemented 提示。
 *   - todo: 相位表 op 模型(init/append/start/done/block/view)。
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createMultiEditTool, createWebFetchTool, createSkillTool, createNotebookEditTool, createTodoTool, MemoryLedger } from "../src/index.ts";

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
          { oldText: "alpha", newText: "ALPHA" },
          { oldText: "gamma", newText: "GAMMA" },
        ],
      });
      const after = await readFile(fp, "utf8");
      expect(after).toBe("ALPHA beta GAMMA");
      expect(r.details.applied).toBe(2);
    });

    it("任一 oldText 不存在 → abort(不写文件)", async () => {
      const fp = path.join(dir, "b.txt");
      await writeFile(fp, "hello world", "utf8");
      const tool = createMultiEditTool(dir);
      await expect(
        tool.execute("tc", {
          filePath: "b.txt",
          edits: [
            { oldText: "hello", newText: "HELLO" },
            { oldText: "missing", newText: "x" },
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
        edits: [{ oldText: "x", newText: "Y", replaceAll: true }],
      });
      expect(await readFile(fp, "utf8")).toBe("Y Y Y");
      expect(r.details.applied).toBe(1);
    });

    it("prepareArguments 接受外部命名 oldString/newString 与 path", async () => {
      const fp = path.join(dir, "d.txt");
      await writeFile(fp, "one two", "utf8");
      const tool = createMultiEditTool(dir);
      const prepared = tool.prepareArguments!({
        path: "d.txt",
        edits: [{ oldString: "one", newString: "1", replace_all: true }],
      });
      expect(prepared).toEqual({ filePath: "d.txt", edits: [{ oldText: "one", newText: "1", replaceAll: true }] });
      await tool.execute("tc", prepared);
      expect(await readFile(fp, "utf8")).toBe("1 two");
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

    it("loader 拒绝时标记 isError=true", async () => {
      const tool = createSkillTool({
        loader: async () => ({ ok: false, code: "not_found", message: "skill not found" }),
      });
      const r = await tool.execute("tc", { name: "missing" });
      expect(r.isError).toBe(true);
      expect(r.details).toMatchObject({ matched: false, code: "not_found" });
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

  describe("todo(op 模型)", () => {
    it("init 建表 + start/done 改单条,不整表重发", async () => {
      const ledger = new MemoryLedger();
      const tool = createTodoTool({ ledger });

      const init = await tool.execute("tc", {
        op: "init",
        list: [{ phase: "Foundation", items: ["scaffold crate", "wire workspace"] }],
      });
      expect(init.details.operation).toBe("init");
      // 无 in_progress 时最早的 pending 自动提升。
      expect(init.details.phases).toEqual([
        { name: "Foundation", tasks: [
          { content: "scaffold crate", status: "in_progress" },
          { content: "wire workspace", status: "pending" },
        ] },
      ]);

      const done = await tool.execute("tc", { op: "done", task: "scaffold crate" });
      expect(done.details.transitions).toEqual([{ phase: "Foundation", content: "scaffold crate", to: "completed" }]);
      expect(done.details.phases[0]!.tasks).toEqual([
        { content: "scaffold crate", status: "completed" },
        { content: "wire workspace", status: "in_progress" },
      ]);
    });

    it("append 建新相位,block 记录 blocker,view 只读不写", async () => {
      const ledger = new MemoryLedger();
      const tool = createTodoTool({ ledger });
      await tool.execute("tc", { op: "init", list: [{ phase: "A", items: ["one"] }] });
      const appended = await tool.execute("tc", { op: "append", phase: "B", items: ["two"] });
      expect(appended.details.phases.map((phase) => phase.name)).toEqual(["A", "B"]);

      const blocked = await tool.execute("tc", { op: "block", task: "two", reason: "waiting on schema" });
      expect(blocked.details.phases[1]!.tasks[0]).toEqual({ content: "two", status: "blocked", blocker: "waiting on schema" });

      const before = (await ledger.findByType("custom")).length;
      const viewed = await tool.execute("tc", { op: "view" });
      expect(viewed.details.transitions).toEqual([]);
      expect((await ledger.findByType("custom")).length).toBe(before);
    });

    it("未给 task/phase 时目标为全部任务;给 phase 时只作用于该相位", async () => {
      const ledger = new MemoryLedger();
      const tool = createTodoTool({ ledger });
      await tool.execute("tc", { op: "init", list: [
        { phase: "A", items: ["a1"] },
        { phase: "B", items: ["b1"] },
      ] });

      const phaseOnly = await tool.execute("tc", { op: "done", phase: "A" });
      expect(phaseOnly.details.phases[0]!.tasks[0]).toMatchObject({ status: "completed" });
      // A 相位完成后没有 in_progress,最早的 pending(b1)自动提升。
      expect(phaseOnly.details.phases[1]!.tasks[0]).toMatchObject({ status: "in_progress" });

      const all = await tool.execute("tc", { op: "done" });
      expect(all.details.transitions.map((t) => t.content).sort()).toEqual(["a1", "b1"]);
      expect(all.details.phases.flatMap((p) => p.tasks).every((t) => t.status === "completed")).toBe(true);
    });

    it("block/unblock 必须给目标;blocked 不参与自动提升", async () => {
      const ledger = new MemoryLedger();
      const tool = createTodoTool({ ledger });
      await tool.execute("tc", { op: "init", list: [{ phase: "A", items: ["first", "second"] }] });
      await expect(tool.execute("tc", { op: "block" })).rejects.toThrow(/需要 task 或 phase 目标/);

      // 把唯一 in_progress 阻断后,指针应移到下一个 pending(而不是留在 blocked)。
      const blocked = await tool.execute("tc", { op: "block", task: "first", reason: "waiting\non\nschema" });
      const tasks = blocked.details.phases[0]!.tasks;
      expect(tasks[0]).toEqual({ content: "first", status: "blocked", blocker: "waiting on schema" });
      expect(tasks[1]).toMatchObject({ status: "in_progress" });

      const unblocked = await tool.execute("tc", { op: "unblock", task: "first" });
      expect(unblocked.details.phases[0]!.tasks[0]).toEqual({ content: "first", status: "pending" });
    });

    it("rm 给目标时只删该任务,不给目标时清空整表", async () => {
      const ledger = new MemoryLedger();
      const tool = createTodoTool({ ledger });
      await tool.execute("tc", { op: "init", list: [{ phase: "A", items: ["one", "two"] }] });
      const removed = await tool.execute("tc", { op: "rm", task: "two" });
      expect(removed.details.phases[0]!.tasks.map((t) => t.content)).toEqual(["one"]);

      const cleared = await tool.execute("tc", { op: "rm" });
      expect(cleared.details.phases).toEqual([]);
    });

    it("漏 op 时按参数形状推断(init/append)", async () => {
      const ledger = new MemoryLedger();
      const tool = createTodoTool({ ledger });
      const inferredInit = await tool.execute("tc", { list: [{ phase: "A", items: ["one"] }] } as never);
      expect(inferredInit.details).toMatchObject({ operation: "init", inferredOp: true });

      const inferredAppend = await tool.execute("tc", { phase: "A", items: ["two"] } as never);
      expect(inferredAppend.details).toMatchObject({ operation: "append", inferredOp: true });
      expect(inferredAppend.details.phases[0]!.tasks.map((t) => t.content)).toEqual(["one", "two"]);
    });

    it("init 支持扁平 items 写法", async () => {
      const ledger = new MemoryLedger();
      const tool = createTodoTool({ ledger });
      const flat = await tool.execute("tc", { op: "init", items: ["only"] });
      expect(flat.details.phases).toEqual([
        { name: "Tasks", tasks: [{ content: "only", status: "in_progress" }] },
      ]);
    });

    it("非法 op 与找不到目标任务都抛错,且不写 ledger", async () => {
      const ledger = new MemoryLedger();
      const tool = createTodoTool({ ledger });
      await tool.execute("tc", { op: "init", list: [{ phase: "A", items: ["only"] }] });
      const before = (await ledger.findByType("custom")).length;
      await expect(tool.execute("tc", { op: "done", task: "nonexistent" })).rejects.toThrow(/找不到任务 "nonexistent"/);
      await expect(tool.execute("tc", { op: "append", items: ["x"] })).rejects.toThrow(/需要 phase/);
      expect((await ledger.findByType("custom")).length).toBe(before);
    });
  });
});
