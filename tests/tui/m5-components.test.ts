/**
 * M5 TUI 升级单测 —— DiffPreview 三态 / BashExecution / ToolCall running 三态.
 *
 * 覆盖:
 *   - DiffPreview: pending / running / ok / error 四态表头 icon + 折叠/展开 + error 行.
 *   - BashExecution: pending → running → ok 流程;appendOutput 多行 chunk 保留 tail;
 *     run_in_background 标记 "(bg)";ok 后 exit+duration 出现。
 *   - BashExecution: error 态 + truncated large stdout tail。
 *   - ToolCall:三态(pending / running / ok / error)render 各自 icon 正确。
 */

import { describe, it, expect } from "vitest";
import { DiffPreviewComponent } from "../../src/tui/components/diff-preview.ts";
import { BashExecutionComponent } from "../../src/tui/components/bash-execution.ts";
import { ToolCallComponent } from "../../src/tui/components/tool-call.ts";
import { loadTheme } from "../../src/tui/theme/theme.ts";

describe("M5 TUI: DiffPreview 三态", () => {
  it("pending → 表头 ⏳", () => {
    const c = new DiffPreviewComponent({ verb: "edit", path: "a.ts" });
    const line = c.render(40)[0] ?? "";
    expect(line).toContain("⏳");
    expect(line).toContain("edit");
    expect(line).toContain("a.ts");
  });

  it("running → 表头 …", () => {
    const c = new DiffPreviewComponent({ verb: "write", path: "x.txt", initialStatus: "running" });
    expect(c.render(40)[0] ?? "").toContain("…");
  });

  it("expanded running → 表头 + before/after 行,无 error 行", () => {
    const c = new DiffPreviewComponent({
      verb: "edit",
      path: "a.ts",
      before: "old",
      after: "new",
      expanded: true,
      initialStatus: "running",
    });
    const lines = c.render(60);
    expect(lines[0]).toContain("…");
    expect(lines.join("\n")).toContain("- old");
    expect(lines.join("\n")).toContain("+ new");
    expect(lines.join("\n")).not.toContain("ERR");
  });

  it("error expanded → ERR 行", () => {
    const c = new DiffPreviewComponent({
      verb: "edit",
      path: "a.ts",
      expanded: true,
      initialStatus: "error",
    });
    c.setError("patch mismatch at line 42");
    const lines = c.render(60);
    expect(lines[0]).toContain("✗");
    expect(lines.join("\n")).toContain("ERR: patch mismatch at line 42");
  });

  it("折叠态下从未触发错误就行缩短处理 (header length > width)", () => {
    const c = new DiffPreviewComponent({
      verb: "edit",
      path: "x".repeat(80),
      initialStatus: "pending",
    });
    const line = c.render(20)[0] ?? "";
    expect(line.length).toBeLessThanOrEqual(20);
    expect(line.endsWith("…")).toBe(true);
  });
});

describe("M5 TUI: BashExecution", () => {
  it("pending → $ cmd ⏳", () => {
    const c = new BashExecutionComponent({ command: "npm run build" });
    const line = c.render(40)[0] ?? "";
    expect(line).toContain("$");
    expect(line).toContain("npm run build");
    expect(line).toContain("⏳");
  });

  it("running → 改为 …", () => {
    const c = new BashExecutionComponent({ command: "ls" });
    c.setStatus("running");
    expect(c.render(40)[0] ?? "").toContain("…");
  });

  it("background 模式 → 表头含 (bg)", () => {
    const c = new BashExecutionComponent({ command: "ls", runInBackground: true });
    expect(c.render(40)[0] ?? "").toContain("(bg)");
  });

  it("appendOutput 多行 chunk → tail 保留", () => {
    const c = new BashExecutionComponent({ command: "ls", maxTailLines: 5 });
    c.appendOutput("a\nb\nc\nd\ne\nf\ng\n", "stdout");
    c.toggle(); // expand
    c.setStatus("ok");
    c.finalize(0, 100);
    const lines = c.render(80);
    // tail 至少保留 e/f/g
    expect(lines.join("\n")).toContain("g");
    expect(lines.join("\n")).toContain("e");
    expect(lines.join("\n")).not.toContain("a\n"); // 较旧行被丢
  });

  it("error + 大 stdout → stderr 行 + ERR 行", () => {
    const c = new BashExecutionComponent({ command: "x", maxTailLines: 3 });
    c.setStatus("running");
    c.appendOutput("ok1\nok2\nok3\nok4\n", "stdout");
    c.appendOutput("warn1\nwarn2\n", "stderr");
    c.finalize(1, 50, true, "exit 1");
    c.toggle();
    const lines = c.render(80);
    expect(lines[0]).toContain("✗");
    expect(lines.join("\n")).toContain("exit=1");
    expect(lines.join("\n")).toContain("ERR: exit 1");
    // stdout tail 保留最后 3 行(但 maxTailLines=3, slice(-1) by display threshold)
    expect(lines.join("\n")).toContain("ok4");
  });

  it("折叠态默认不显示 stdout 详", () => {
    const c = new BashExecutionComponent({ command: "ls" });
    c.appendOutput("hello\n", "stdout");
    c.setStatus("ok");
    c.finalize(0, 10);
    const lines = c.render(40);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("✓");
    expect(lines[0]).not.toContain("hello");
  });
});

describe("M5 TUI: ToolCall 三态", () => {
  const theme = loadTheme("dark");
  it("pending → ⏳ [echo]", () => {
    const c = new ToolCallComponent({ theme, toolCallId: "tc", toolName: "echo" });
    expect(c.render(40)[0] ?? "").toContain("⏳");
  });
  it("running → … [echo]", () => {
    const c = new ToolCallComponent({ theme, toolCallId: "tc", toolName: "echo" });
    c.setStatus("running");
    expect(c.render(40)[0] ?? "").toContain("…");
  });
  it("ok → ✓ [echo …]", () => {
    const c = new ToolCallComponent({ theme, toolCallId: "tc", toolName: "echo" });
    c.finalize(
      { content: [{ type: "text", text: "hi" }], details: {}, terminate: false },
      false,
    );
    const line = c.render(40)[0] ?? "";
    expect(line).toContain("✓");
    expect(line).toContain("hi");
  });
  it("error → ✗ [echo … | ERR: …]", () => {
    const c = new ToolCallComponent({ theme, toolCallId: "tc", toolName: "echo" });
    c.setError("boom");
    const line = c.render(60)[0] ?? "";
    expect(line).toContain("✗");
    expect(line).toContain("ERR: boom");
  });
});
