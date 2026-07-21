import { describe, expect, it } from "vitest";
import { visibleWidth, type Component } from "../../src/tui/index.ts";
import type { AssistantMessage } from "../../src/types.ts";
import type { AgentToolResult } from "../../src/runtime/types.ts";
import { loadTheme } from "../../src/tui/theme/theme.ts";
import { fitToWidth, padToWidth } from "../../src/tui/components/render-width.ts";
import { AssistantMessageComponent } from "../../src/tui/components/assistant-message.ts";
import { ChatContainer } from "../../src/tui/components/chat-container.ts";
import { UserMessageComponent } from "../../src/tui/components/user-message.ts";
import { CustomMessageComponent } from "../../src/tui/components/custom-message.ts";
import { ToolCallComponent } from "../../src/tui/components/tool-call.ts";
import { ToolResultComponent } from "../../src/tui/components/tool-result.ts";
import { BashExecutionComponent } from "../../src/tui/components/bash-execution.ts";
import { DiffPreviewComponent } from "../../src/tui/components/diff-preview.ts";
import { SearchableSelectorModal } from "../../src/tui/components/searchable-selector-modal.ts";
import { AuthInputModal } from "../../src/tui/components/auth-input-modal.ts";

const theme = loadTheme("dark");

function assistantWithThinking(thinking: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "thinking", thinking }],
    api: "openai-completions",
    provider: "deepseek",
    model: "deepseek-v4-pro",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

function expectWithinWidth(component: Component, width: number): void {
  for (const line of component.render(width)) {
    expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  }
}

describe("TUI 可见列宽约束", () => {
  it("ANSI、中文和 emoji 按终端列宽截断与补齐", () => {
    const input = `\x1b[31m${"太阳系🪐".repeat(20)}\x1b[0m`;
    expect(visibleWidth(fitToWidth(input, 17))).toBeLessThanOrEqual(17);
    expect(visibleWidth(padToWidth(input, 18))).toBe(18);
  });

  it("复现并修复 143 列 thinking 行溢出", () => {
    const thinking = "用户想要在项目中构建一个展示太阳系的新页面，越真实越好。".repeat(4);
    const component = new AssistantMessageComponent({
      theme,
      partial: assistantWithThinking(thinking),
    });

    const collapsed = component.render(143);
    expect(collapsed[0]).toContain("[thinking]");
    expectWithinWidth(component, 143);

    component.toggleThinking();
    const expanded = component.render(143);
    expect(expanded.length).toBeGreaterThan(2);
    expectWithinWidth(component, 143);
  });

  it("消息、工具、diff、bash 和 overlay 对宽字符保持限宽", () => {
    const long = "太阳系🪐".repeat(80);
    const result = {
      content: [{ type: "text", text: long }],
      details: undefined,
    } as AgentToolResult;
    const toolCall = new ToolCallComponent({
      theme,
      toolCallId: "tc",
      toolName: "write",
      args: { content: long },
      initialStatus: "running",
    });
    toolCall.finalize(result, false);
    const bash = new BashExecutionComponent({ command: long });
    bash.appendOutput(long, "stdout");
    bash.toggle();
    bash.finalize(0, 1);
    const auth = new AuthInputModal({
      title: long,
      message: long,
      placeholder: long,
      onSubmit: () => {},
      onCancel: () => {},
    });
    const components: Component[] = [
      new UserMessageComponent({ theme, text: long, timestamp: 0 }),
      new CustomMessageComponent({ theme, kind: "note", text: long, timestamp: 0 }),
      toolCall,
      new ToolResultComponent({
        theme,
        toolCallId: "tc",
        toolName: "write",
        result,
        isError: false,
        timestamp: 0,
      }),
      bash,
      new DiffPreviewComponent({
        verb: "edit",
        path: long,
        before: long,
        after: long,
        expanded: true,
      }),
      new SearchableSelectorModal({
        title: long,
        items: [{ value: "solar", label: long, description: long }],
        onSelect: () => {},
        onCancel: () => {},
      }),
      auth,
    ];

    for (const component of components) expectWithinWidth(component, 31);
  });

  it("ChatContainer 会收口不遵守契约的第三方 child", () => {
    const chat = new ChatContainer();
    chat.push({
      invalidate(): void {},
      render(): string[] {
        return ["外部组件🪐".repeat(100)];
      },
    });
    expectWithinWidth(chat, 20);
  });
});
