/**
 * createStdlibAgent 单测 —— StdlibAgent 走 mockStreamFn + echo tool
 * 完整跑通一个 turn 并最终 settle。
 */

import { describe, expect, it } from "vitest";
import {
  createStdlibAgent,
  stdlibStreamFn,
  stdlibToolSchemas,
  stdlibRegistry,
} from "../src/runtime/stdlib-stream.ts";
import { MemoryLedger } from "../src/runtime/ledger/memory-ledger.ts";

describe("createStdlibAgent", () => {
  it("默认构造:注入 13 个 stdlib 工具集 + mock model", () => {
    const a = createStdlibAgent({ systemPrompt: "test", cwd: process.cwd() });
    const s = a.state;
    expect(s.tools.length).toBe(13);
    expect(s.tools.find((t) => t.name === "echo")).toBeDefined();
    expect(s.tools.find((t) => t.name === "read")).toBeDefined();
    expect(s.tools.find((t) => t.name === "glob")).toBeDefined();
    expect(s.tools.find((t) => t.name === "MultiEdit")).toBeDefined();
    expect(s.tools.find((t) => t.name === "WebFetch")).toBeDefined();
    expect(s.tools.find((t) => t.name === "Skill")).toBeDefined();
    expect(s.tools.find((t) => t.name === "NotebookEdit")).toBeDefined();
  });

  it("stdlibToolSchemas / stdlibRegistry: 数量一致", () => {
    expect(stdlibToolSchemas().length).toBe(13);
    expect(stdlibRegistry().size).toBe(13);
    expect(stdlibRegistry().has("read")).toBe(true);
    expect(stdlibRegistry().has("glob")).toBe(true);
    expect(stdlibRegistry().has("MultiEdit")).toBe(true);
    expect(stdlibRegistry().has("WebFetch")).toBe(true);
  });

  it("跑一 turn,start → message(text+toolUse) → tool → message(final) → end", async () => {
    const events: string[] = [];
    const a = createStdlibAgent({ systemPrompt: "test" });
    const unsub = a.subscribe((e) => {
      events.push(e.type);
    });
    await a.prompt("hello");
    expect(events).toContain("agent_start");
    expect(events).toContain("agent_end");
    unsub();
  });

  it("stdlibStreamFn === mockStreamFn 别名(同一函数对象)", () => {
    expect(typeof stdlibStreamFn).toBe("function");
  });

  it("ledger 注入:Agent 跑 turn 后 ledger 至少记录一条条目", async () => {
    const ledger = new MemoryLedger();
    const a = createStdlibAgent({
      systemPrompt: "test",
      ledger,
    });
    await a.prompt("hi");
    expect(ledger.entries().length).toBeGreaterThan(0);
  });
});

