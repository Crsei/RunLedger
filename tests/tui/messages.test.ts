/**
 * UserMessageComponent / CustomMessageComponent / ChatContainer 单测。
 *
 * 对照 src/tui/components/{user,custom,chat-container}.ts 与 development-doc/tui/02-component-spec.md §4 §5 §12。
 */

import { describe, it, expect } from "vitest";
import { UserMessageComponent } from "../../src/tui/components/user-message.ts";
import { CustomMessageComponent } from "../../src/tui/components/custom-message.ts";
import { ChatContainer } from "../../src/tui/components/chat-container.ts";
import { loadTheme } from "../../src/tui/theme/theme.ts";

describe("UserMessageComponent", () => {
  const theme = loadTheme("dark");

  it("包含 OSC 133;C 与 133;D 标记", () => {
    const comp = new UserMessageComponent({ theme, text: "hello", timestamp: 0 });
    const lines = comp.render(40);
    expect(lines.some((l) => l.includes("\x1b]133;C\x07"))).toBe(true);
    expect(lines.some((l) => l.includes("\x1b]133;D\x07"))).toBe(true);
  });
  it("短文本不改行", () => {
    const comp = new UserMessageComponent({ theme, text: "hi", timestamp: 0 });
    const lines = comp.render(40);
    expect(lines.some((l) => l.includes("hi"))).toBe(true);
  });
  it("长文本截断", () => {
    const long = "x".repeat(200);
    const comp = new UserMessageComponent({ theme, text: long, timestamp: 0 });
    const lines = comp.render(20);
    // 找正文行(非 OSC 行)
    const body = lines.find((l) => l.length > 0 && !l.includes("\x1b]") && !l.includes("\x1b]133"));
    expect(body).toBeDefined();
    expect((body ?? "").endsWith("…")).toBe(true);
  });
});

describe("CustomMessageComponent", () => {
  const theme = loadTheme("dark");

  it("渲染 [kind]:text", () => {
    const comp = new CustomMessageComponent({
      theme,
      kind: "note",
      text: "memo",
      timestamp: 0,
    });
    const line = comp.render(40)[0] ?? "";
    expect(line).toBe("[note] memo");
  });
  it("长文本截断", () => {
    const long = "y".repeat(300);
    const comp = new CustomMessageComponent({
      theme,
      kind: "note",
      text: long,
      timestamp: 0,
    });
    const line = comp.render(20)[0] ?? "";
    expect(line.endsWith("…")).toBe(true);
  });
});

describe("ChatContainer", () => {
  const theme = loadTheme("dark");

  it("空 chat 渲染 0 行", () => {
    const chat = new ChatContainer();
    expect(chat.render(40).length).toBe(0);
  });
  it("按顺序拼接 children 的 render", () => {
    const chat = new ChatContainer();
    chat.push(new CustomMessageComponent({ theme, kind: "a", text: "x", timestamp: 0 }));
    chat.push(new CustomMessageComponent({ theme, kind: "b", text: "y", timestamp: 0 }));
    const lines = chat.render(40);
    expect(lines).toEqual(["[a] x", "[b] y"]);
  });
  it("child 抛错时不外抛,记 stderr;空降占位行", () => {
    const chat = new ChatContainer();
    const badChild = {
      invalidate(): void {},
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      render(_width: number): string[] {
        throw new Error("simulated");
      },
    };
    chat.push(badChild);
    const lines = chat.render(20);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("[chat:child-render-error]");
  });
});
