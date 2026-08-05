/**
 * M7 TUI 补强测试:为 5 个未有测试覆盖的组件各加 1 用例。
 *
 * 已被覆盖(不在本文件):UserMessage / AssistantMessage / CustomMessage / LoadedResources / ToolCall /
 * DiffPreview(M5 升级)+ BashExecution(M5 新增)/ m5-components(三态对照)。
 *
 * 本文件覆盖:
 *   1) ToolResultComponent —— ok/error 态单行渲染 + truncate 宽度兜底;
 *   2) AbortButtonComponent —— 默认 label 与 trigger() 调用 onClick;
 *   3) BackgroundTaskComponent —— running → done/error 三态切换 + truncate;
 *   4) FooterComponent —— provider.snapshot → 单行组合 (含异常路径);
 *   5) (M5 DiffPreview edge case) — expanded 折叠后表头本身被截断时仍以 "…" 结尾(可读性安全网)。
 */

import { describe, it, expect, vi } from "vitest";
import { ToolResultComponent } from "../../src/tui/components/tool-result.ts";
import { AbortButtonComponent } from "../../src/tui/components/abort-button.ts";
import { BackgroundTaskComponent } from "../../src/tui/components/background-task.ts";
import { Footer } from "../../src/tui/components/footer.ts";
import { DiffPreviewComponent } from "../../src/tui/components/diff-preview.ts";
import { loadTheme } from "../../src/tui/theme/theme.ts";
import type { AgentToolResult } from "../../src/runtime/types.ts";
import type { FooterSnapshotProvider } from "../../src/tui/types.ts";

describe("M7 TUI: ToolResultComponent", () => {
  const theme = loadTheme("dark");
  it("ok 态单行 带 ✓ 与 firstLine", () => {
    const result: AgentToolResult = {
      content: [{ type: "text", text: "OK line1\nsecond" }],
      details: {},
      terminate: false,
    };
    const c = new ToolResultComponent({
      theme,
      toolCallId: "tc",
      toolName: "echo",
      result,
      isError: false,
      timestamp: 0,
    });
    const line = c.render(40)[0] ?? "";
    expect(line).toContain("✓");
    expect(line).toContain("echo");
    expect(line).toContain("OK line1");
    expect(line).not.toContain("second");
  });

  it("error 态带 ✗ 与错误摘要(不裁剪元数据)", () => {
    const result: AgentToolResult = {
      content: [{ type: "text", text: "boom at line 42" }],
      details: {},
      terminate: false,
    };
    const c = new ToolResultComponent({
      theme,
      toolCallId: "tc",
      toolName: "edit",
      result,
      isError: true,
      timestamp: 0,
    });
    const line = c.render(60)[0] ?? "";
    expect(line).toContain("✗");
    expect(line).toContain("boom at line 42");
  });
});

describe("M7 TUI: AbortButtonComponent", () => {
  it("默认 label 渲染 + 触发 onClick", () => {
    const onClick = vi.fn();
    const c = new AbortButtonComponent({ onClick });
    const lines = c.render(40);
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/Ctrl\+C.*中断/);
    c.trigger();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("标签超长 → 截断", () => {
    const c = new AbortButtonComponent({ label: "x".repeat(80) });
    const line = c.render(20)[0] ?? "";
    expect(line.length).toBeLessThanOrEqual(20);
    expect(line.endsWith("…")).toBe(true);
  });
});

describe("M7 TUI: BackgroundTaskComponent", () => {
  it("running → done / error 三态切换", () => {
    const c = new BackgroundTaskComponent({ label: "load SST" });
    expect(c.render(40)[0] ?? "").toContain("…");
    c.setStatus("done");
    expect(c.render(40)[0] ?? "").toContain("✓");
    c.setStatus("error");
    expect(c.render(40)[0] ?? "").toContain("✗");
  });

  it("label 超 width → 截断", () => {
    const c = new BackgroundTaskComponent({ label: "x".repeat(80) });
    const line = c.render(20)[0] ?? "";
    expect(line.length).toBeLessThanOrEqual(20);
    expect(line.endsWith("…")).toBe(true);
  });
});

describe("M7 TUI: Footer", () => {
  it("provider.snapshot: idle / modelId", () => {
    const provider: FooterSnapshotProvider = {
      isStreaming: () => false,
      getStopReason: () => undefined,
      getSessionId: () => "sess-123",
      getModelId: () => "mock-1",
      getThinkingLabel: () => "",
      getKeybindingHint: () => "^C abort",
      getWorkingDir: () => "/tmp",
    };
    const c = new Footer({ theme: loadTheme("dark"), provider });
    const line = c.render(80)[0] ?? "";
    expect(line).toContain("idle");
    expect(line).toContain("mock-1");
    expect(line).toContain("sess-123");
  });

  it("provider 抛错 → fallback footer line", () => {
    const provider: FooterSnapshotProvider = {
      isStreaming: () => { throw new Error("snap fail"); },
      getStopReason: () => "",
      getSessionId: () => "x",
      getModelId: () => "y",
      getThinkingLabel: () => "",
      getKeybindingHint: () => "",
      getWorkingDir: () => "/tmp",
    };
    const c = new Footer({ theme: loadTheme("dark"), provider });
    const line = c.render(80)[0] ?? "";
    expect(line).toMatch(/footer:err/i);
  });
});

describe("M7 TUI: DiffPreview 边界 (long header truncate in expanded folding)", () => {
  it("表头超 width → 截断 + 末尾 …", () => {
    const c = new DiffPreviewComponent({ verb: "edit", path: "x".repeat(80) });
    const line = c.render(15)[0] ?? "";
    expect(line.length).toBeLessThanOrEqual(15);
    expect(line.endsWith("…")).toBe(true);
  });

  it("provider.snapshot: workspace capability label renders only when provided (P6)", () => {
    const base = {
      isStreaming: () => false,
      getStopReason: () => undefined,
      getSessionId: () => "sess-1",
      getModelId: () => "mock-1",
    };
    const without = new Footer({ theme: loadTheme("dark"), provider: base });
    const plain = without.render(80)[0] ?? "";
    expect(plain).not.toContain("ws:");
    const withLabel = new Footer({ theme: loadTheme("dark"), provider: { ...base, getWorkspaceCapability: () => "ws:linux-verified" } });
    const labeled = withLabel.render(80)[0] ?? "";
    expect(labeled).toContain("ws:linux-verified");
    expect(labeled).not.toContain("sandbox");
  });
});
