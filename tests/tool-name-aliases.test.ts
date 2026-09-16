/**
 * 工具名别名 —— 历史调用名解析。
 *
 * `find` 并入 `glob` 后,旧会话历史、旧提示词与旧 Skill 声明里的 `find` 调用必须
 * 仍解析到同一个 glob 工具实例(而不是报 tool_not_found,也不是新增一个只有名字
 * 不同的重复工具)。
 */

import { describe, expect, it } from "vitest";
import { findToolByCallName, resolveToolName } from "../src/runtime/tool-name-aliases.ts";

const tools = [
  { name: "glob", label: "glob" },
  { name: "grep", label: "grep" },
];

describe("工具名别名", () => {
  it("maps legacy names to their canonical successor", () => {
    expect(resolveToolName("find")).toBe("glob");
    expect(resolveToolName("glob")).toBe("glob");
    // 仓库从未注册过 `search`,不得凭空接受。
    expect(resolveToolName("search")).toBe("search");
    expect(resolveToolName("unknown_tool")).toBe("unknown_tool");
  });

  it("resolves a legacy call name to the canonical tool instance", () => {
    expect(findToolByCallName(tools, "find")).toBe(tools[0]);
    expect(findToolByCallName(tools, "glob")).toBe(tools[0]);
    expect(findToolByCallName(tools, "grep")).toBe(tools[1]);
  });

  it("returns undefined for a genuinely unknown tool", () => {
    expect(findToolByCallName(tools, "ast_grep")).toBeUndefined();
  });

  it("prefers an exact match when both the alias and the canonical name exist", () => {
    const withLegacy = [{ name: "glob" }, { name: "find" }];
    expect(findToolByCallName(withLegacy, "find")).toBe(withLegacy[1]);
  });
});
