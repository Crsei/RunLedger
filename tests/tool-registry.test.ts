/**
 * ToolRegistry 单测 —— 覆盖 register first-wins / unregister / has / get
 * / list / toContext / schemaOnlyView 的语义边界。
 */

import { describe, expect, it } from "vitest";
import { Type } from "typebox";

import { ToolRegistry, createToolRegistry } from "../src/runtime/tool-registry.ts";
import type { AgentTool } from "../src/runtime/types.ts";

function fakeTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: `fake ${name}`,
    parameters: Type.Object({}),
    async execute() {
      return { content: [], details: undefined };
    },
  };
}

describe("ToolRegistry", () => {
  it("register first-wins: 同 namespace 同名再注册被静默拒绝", () => {
    const r = new ToolRegistry();
    const t1 = fakeTool("a");
    const t2 = fakeTool("a");
    expect(r.register(t1)).toBe(true);
    expect(r.register(t2)).toBe(false);
    expect(r.get("a")).toBe(t1);
    expect(r.size).toBe(1);
  });

  it("register 跨 namespace 隔离:同名不同 namespace 互不影响", () => {
    const r = new ToolRegistry();
    const a = fakeTool("read");
    const b = fakeTool("read");
    expect(r.register(a, { namespace: "stdlib" })).toBe(true);
    expect(r.register(b, { namespace: "fs" })).toBe(true);
    expect(r.size).toBe(2);
    expect(r.get("read")).toBe(a);
    expect(r.get("read", "stdlib")).toBe(a);
    expect(r.get("read", "fs")).toBe(b);
  });

  it("has 不传 namespace 时任意域命中都返回 true", () => {
    const r = new ToolRegistry();
    r.register(fakeTool("x"), { namespace: "mcp" });
    expect(r.has("x")).toBe(true);
    expect(r.has("x", "mcp")).toBe(true);
    expect(r.has("x", "stdlib")).toBe(false);
    expect(r.has("y")).toBe(false);
  });

  it("unregister 仅匹配 namespace 时生效", () => {
    const r = new ToolRegistry();
    const t = fakeTool("a");
    r.register(t, { namespace: "stdlib" });
    expect(r.unregister("a", "fs")).toBe(false);
    expect(r.unregister("a", "stdlib")).toBe(true);
    expect(r.has("a")).toBe(false);
  });

  it("list 按 namespace 过滤;不传返回全部", () => {
    const r = new ToolRegistry();
    r.register(fakeTool("a"), { namespace: "stdlib" });
    r.register(fakeTool("b"), { namespace: "stdlib" });
    r.register(fakeTool("c"), { namespace: "mcp" });
    expect(r.list().length).toBe(3);
    expect(r.list("stdlib").map((t) => t.name).sort()).toEqual(["a", "b"]);
    expect(r.list("mcp").map((t) => t.name)).toEqual(["c"]);
  });

  it("toContext 返回扁平 AgentTool[],与 AgentContext.tools 兼容", () => {
    const r = new ToolRegistry();
    r.register(fakeTool("a"));
    r.register(fakeTool("b"));
    const arr = r.toContext();
    expect(Array.isArray(arr)).toBe(true);
    expect(arr.length).toBe(2);
    arr.forEach((t) => expect(typeof t.execute).toBe("function"));
  });

  it("schemaOnlyView 丢 execute / label / executionMode,只留 LLM 视角字段", () => {
    const r = new ToolRegistry();
    r.register(fakeTool("a"));
    const view = r.schemaOnlyView();
    expect(view.length).toBe(1);
    const t = view[0]!;
    expect(t.name).toBe("a");
    expect(t.description).toBe("fake a");
    expect((t as { execute?: unknown }).execute).toBeUndefined();
    expect((t as { label?: unknown }).label).toBeUndefined();
    expect((t as { executionMode?: unknown }).executionMode).toBeUndefined();
  });

  it("createToolRegistry helper 默认 namespace = stdlib", () => {
    const r = createToolRegistry([fakeTool("a"), fakeTool("b")]);
    expect(r.size).toBe(2);
    expect(r.has("a", "stdlib")).toBe(true);
    expect(r.has("a", "fs")).toBe(false);
  });
});
