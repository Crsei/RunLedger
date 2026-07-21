/**
 * ToolCallComponent / ToolResultComponent 单测:状态图标、错误摘要、宽度截断。
 *
 * 对照 src/tui/components/tool-call.ts 与 development-doc/tui/02-component-spec.md §6。
 */

import { describe, it, expect } from "vitest";
import { ToolCallComponent } from "../../src/tui/components/tool-call.ts";
import { ToolResultComponent } from "../../src/tui/components/tool-result.ts";
import { loadTheme } from "../../src/tui/theme/theme.ts";
import type { AgentToolResult } from "../../src/runtime/types.ts";

describe("ToolCallComponent", () => {
  const theme = loadTheme("dark");

  it("pending 状态显示 ⏳", () => {
    const comp = new ToolCallComponent({
      theme,
      toolCallId: "tc1",
      toolName: "echo",
      initialStatus: "pending",
    });
    const line = comp.render(40)[0] ?? "";
    expect(line).toContain("⏳");
    expect(line).toContain("[echo]");
  });
  it("running 状态显示 …", () => {
    const comp = new ToolCallComponent({
      theme,
      toolCallId: "tc1",
      toolName: "echo",
      initialStatus: "running",
    });
    expect(comp.render(40)[0]).toContain("…");
  });
  it("ok 状态 finalize 后显示 ✓ + 第一行结果", () => {
    const comp = new ToolCallComponent({
      theme,
      toolCallId: "tc1",
      toolName: "echo",
      initialStatus: "running",
    });
    comp.finalize(
      {
        content: [{ type: "text", text: "echoed: hi" }],
        details: undefined,
      } as AgentToolResult,
      false,
    );
    const line = comp.render(40)[0] ?? "";
    expect(line).toContain("✓");
    expect(line).toContain("echo");
    expect(line).toContain("echoed: hi");
  });
  it("error 状态显示 ✗", () => {
    const comp = new ToolCallComponent({
      theme,
      toolCallId: "tc1",
      toolName: "bash",
      initialStatus: "running",
    });
    comp.setError("boom");
    expect(comp.render(60)[0]).toContain("✗");
    expect(comp.render(60)[0]).toContain("boom");
  });
});

describe("ToolResultComponent", () => {
  const theme = loadTheme("dark");

  it("成功时显示 ✓ + toolHandle + 文本首行", () => {
    const comp = new ToolResultComponent({
      theme,
      toolCallId: "tc1",
      toolName: "echo",
      result: {
        content: [{ type: "text", text: "result text" }],
        details: undefined,
      } as AgentToolResult,
      isError: false,
      timestamp: 0,
    });
    const line = comp.render(40)[0] ?? "";
    expect(line.startsWith("✓ echo ")).toBe(true);
    expect(line).toContain("result text");
  });
  it("错误时显示 ✗ + toolHandle + 文本首行", () => {
    const comp = new ToolResultComponent({
      theme,
      toolCallId: "tc1",
      toolName: "bash",
      result: {
        content: [{ type: "text", text: "command failed" }],
        details: undefined,
      } as AgentToolResult,
      isError: true,
      timestamp: 0,
    });
    const line = comp.render(40)[0] ?? "";
    expect(line.startsWith("✗ bash ")).toBe(true);
    expect(line).toContain("command failed");
  });
  it("长文本截断到 width", () => {
    const long = "x".repeat(200);
    const comp = new ToolResultComponent({
      theme,
      toolCallId: "tc1",
      toolName: "echo",
      result: {
        content: [{ type: "text", text: long }],
        details: undefined,
      } as AgentToolResult,
      isError: false,
      timestamp: 0,
    });
    const line = comp.render(20)[0] ?? "";
    expect(line.endsWith("…")).toBe(true);
  });
});
