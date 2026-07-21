/**
 * tool-context 单测
 *
 * M1 验收目标:验证
 *   1. `makeToolContext` 工厂正确构造 7 字段 ToolContext(cwd / env / ledger /
 *      envVars / signal / sessionId / toolCallId)。
 *   2. `envVars` 缺省归一为空 Record,不出现 undefined 透传。
 *   3. `ledger` 缺省归一为 undefined(由 agent-loop 决定是否透传)。
 *   4. 工具上 `isReadOnly()` / `isConcurrencySafe()` / `isDestructive()` 的
 *      8 个 stdlib 工具标记固化 —— 防止后续 PR 误改 concurrency 标签
 *      退化到 sequential 全表(对齐 docs/tools/what-are-tools.mdx)。
 *
 * 注意该测试不跑 agent-loop,只断言「ToolContext 数据 + 工具 meta」,
 * 因此不依赖 mkdtemp / shell,可与其他 unit test 并行。
 */

import { describe, expect, it } from "vitest";

import {
  makeToolContext,
  localExecutionEnv,
  MemoryLedger,
  echoTool,
  createReadTool,
  createWriteTool,
  createEditTool,
  createBashTool,
  createGrepTool,
  createFindTool,
  createLsTool,
} from "../src/index.ts";
import type { AgentTool, ToolContext } from "../src/index.ts";

describe("ToolContext makeToolContext", () => {
  it("构造完整 7 字段 ToolContext,所有字段按入参透传", () => {
    const cwd = "/tmp/example";
    const env = localExecutionEnv(cwd);
    const ledger = new MemoryLedger();
    const ctrl = new AbortController();
    const ctx = makeToolContext({
      cwd,
      env,
      ledger,
      envVars: { FOO: "bar" },
      signal: ctrl.signal,
      sessionId: "sess-abc",
      toolCallId: "call_xyz",
    });

    expect(ctx.cwd).toBe(cwd);
    expect(ctx.env).toBe(env);
    expect(ctx.ledger).toBe(ledger);
    expect(ctx.envVars).toEqual({ FOO: "bar" });
    expect(ctx.signal).toBe(ctrl.signal);
    expect(ctx.sessionId).toBe("sess-abc");
    expect(ctx.toolCallId).toBe("call_xyz");
  });

  it("envVars 缺省归一为空 Record 而不是 undefined", () => {
    const ctx = makeToolContext({
      cwd: ".",
      env: localExecutionEnv("."),
      signal: new AbortController().signal,
      sessionId: "s1",
      toolCallId: "c1",
    });
    expect(ctx.envVars).toEqual({});
    expect(ctx.ledger).toBeUndefined();
  });

  it("ToolContext 类型字段完整:静态 keyof 校验防止字段漂移", () => {
    const keys: (keyof ToolContext)[] = [
      "cwd",
      "env",
      "ledger",
      "envVars",
      "signal",
      "sessionId",
      "toolCallId",
    ];
    expect(keys.length).toBe(7);
  });
});

/**
 * 工具 meta 标记固化。read/grep/find/ls 必须 read-only 且 concurrency-safe;
 * write/edit/bash 必须不能(那是 sequential 默认)。
 * echo 同样 read-only + concurrency-safe(零副作用)。
 */
describe("stdlib tool concurrency / read-only markers", () => {
  type MarkerTab = {
    name: string;
    tool: AgentTool;
    isReadOnly?: boolean;
    isConcurrencySafe?: boolean;
    isDestructive?: boolean;
  };

  const tab: MarkerTab[] = [
    { name: "read", tool: createReadTool("."), isReadOnly: true, isConcurrencySafe: true },
    { name: "write", tool: createWriteTool("."), isDestructive: true },
    { name: "edit", tool: createEditTool("."), isDestructive: true },
    { name: "bash", tool: createBashTool("."), isDestructive: true },
    { name: "grep", tool: createGrepTool("."), isReadOnly: true, isConcurrencySafe: true },
    { name: "find", tool: createFindTool("."), isReadOnly: true, isConcurrencySafe: true },
    { name: "ls", tool: createLsTool("."), isReadOnly: true, isConcurrencySafe: true },
    { name: "echo", tool: echoTool, isReadOnly: true, isConcurrencySafe: true },
  ];

  for (const t of tab) {
    it(`${t.name}:isReadOnly()=${t.isReadOnly ? "true" : "false(未声明)"}`, () => {
      expect(t.tool.isReadOnly?.() ?? false).toBe(t.isReadOnly ?? false);
    });
    it(`${t.name}:isConcurrencySafe()=${t.isConcurrencySafe ? "true" : "false(未声明)"}`, () => {
      expect(t.tool.isConcurrencySafe?.() ?? false).toBe(t.isConcurrencySafe ?? false);
    });
    it(`${t.name}:isDestructive()=${t.isDestructive ? "true" : "false(未声明)"}`, () => {
      expect(t.tool.isDestructive?.() ?? false).toBe(t.isDestructive ?? false);
    });
  }
});
