/**
 * EditorHint 单测:左侧快捷键 hint / 右侧模式指示 / 左侧优先截断 / 聚焦可见性。
 *
 * 对照 src/tui/components/editor-hint.ts 与 codex footer.rs single_line_footer_layout。
 */

import { describe, it, expect } from "vitest";
import stripAnsi from "strip-ansi";
import { EditorHint } from "../../src/tui/components/editor-hint.ts";
import { loadTheme } from "../../src/tui/theme/theme.ts";
import { visibleWidth } from "../../src/tui/index.ts";
import type { FooterSnapshotProvider } from "../../src/tui/types.ts";

const HINTS = [
  { key: "enter", action: "send" },
  { key: "alt+enter", action: "follow-up" },
  { key: "ctrl+c", action: "interrupt" },
  { key: "ctrl+d", action: "quit" },
];

function providerWith(state: "working" | "waiting" | "recovery_required" | undefined): FooterSnapshotProvider {
  return {
    isStreaming: () => false,
    getStopReason: () => undefined,
    getModelId: () => "<no-model>",
    getSessionId: () => "<no-session>",
    getRunTiming: () => state === undefined ? undefined : { state, activeDurationMs: 0 },
  };
}

describe("EditorHint", () => {
  it("未聚焦(overlay 打开)时渲染空行集合", () => {
    const hint = new EditorHint({
      theme: loadTheme("dark"),
      provider: providerWith(undefined),
      hints: HINTS,
      getVisible: () => false,
    });
    expect(hint.render(80)).toEqual([]);
  });
  it("空闲时左侧快捷键 hint + 右侧 idle", () => {
    const hint = new EditorHint({
      theme: loadTheme("dark"),
      provider: providerWith(undefined),
      hints: HINTS,
      getVisible: () => true,
    });
    const line = stripAnsi(hint.render(120)[0] ?? "");
    expect(line).toContain("enter:send");
    expect(line).toContain("alt+enter:follow-up");
    expect(line).toContain("ctrl+c:interrupt");
    expect(line).toContain("ctrl+d:quit");
    expect(line).toContain("idle");
    expect(line.indexOf("idle")).toBe(120 - "idle".length);
  });
  it("working / waiting / recovery 模式指示", () => {
    for (const [state, label] of [
      ["working", "working"],
      ["waiting", "waiting"],
      ["recovery_required", "recovery required"],
    ] as const) {
      const hint = new EditorHint({
        theme: loadTheme("dark"),
        provider: providerWith(state),
        hints: HINTS,
        getVisible: () => true,
      });
      const line = stripAnsi(hint.render(120)[0] ?? "");
      expect(line).toContain(label);
    }
  });
  it("宽度不足时左侧优先截断(右侧模式指示保留)", () => {
    const hint = new EditorHint({
      theme: loadTheme("dark"),
      provider: providerWith("working"),
      hints: HINTS,
      getVisible: () => true,
    });
    const line = hint.render(24)[0] ?? "";
    expect(visibleWidth(line)).toBe(24);
    const plain = stripAnsi(line);
    expect(plain).toContain("working");
    expect(plain).toContain("…");
    expect(plain).not.toContain("enter:send");
  });
  it("极窄宽度不崩溃,输出不超宽", () => {
    const hint = new EditorHint({
      theme: loadTheme("dark"),
      provider: providerWith("working"),
      hints: HINTS,
      getVisible: () => true,
    });
    const line = hint.render(6)[0] ?? "";
    expect(visibleWidth(line)).toBeLessThanOrEqual(6);
  });
});
