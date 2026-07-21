/**
 * M7 integration test —— mock-stream phase 0 → BashExecutionComponent.tail →
 * ToolCallComponent.render 三态快照拼接(全 e2e 不依赖 LLM 网络键)。
 */

import { describe, it, expect } from "vitest";
import { mockStreamFn, mockModel, detectMockPhase } from "../../src/runtime/providers/mock-stream.ts";
import { ToolCallComponent } from "../../src/tui/components/tool-call.ts";
import { BashExecutionComponent } from "../../src/tui/components/bash-execution.ts";
import { loadTheme } from "../../src/tui/theme/theme.ts";
import type { AssistantMessageEvent, LlmContext } from "../../src/runtime/types.ts";

describe("M7 integration: mockStream → BashExecution + ToolCall 三态", () => {
  const theme = loadTheme("dark");

  it("phase 0 mock turn → 单条工具调用 + BashExecution tail 同步", async () => {
    const ctx: LlmContext = {
      systemPrompt: "test",
      tools: [{ name: "echo" } as never],
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    };
    const phaseCbs: number[] = [];
    const events: AssistantMessageEvent[] = [];
    const stream = mockStreamFn(mockModel, ctx, {
      onPhase: (p: number) => phaseCbs.push(p),
    } as never);
    for await (const e of stream) {
      events.push(e);
    }
    // 应该有 start / text_* / toolcall_* / done
    expect(events.some((e) => e.type === "start")).toBe(true);
    expect(events.some((e) => e.type === "toolcall_end")).toBe(true);
    expect(phaseCbs).toEqual([0]);

    // 模拟 BashExecution 收 stdout tail + finalize → 三态成行
    const bash = new BashExecutionComponent({ command: "echo hi" });
    bash.setStatus("running");
    bash.appendOutput("hi\nok\n", "stdout");
    bash.finalize(0, 50);
    expect(bash.render(40)[0] ?? "").toContain("✓");

    // ToolCallComponent 三态最终也应该 pin same icons
    const tc = new ToolCallComponent({ theme, toolCallId: "tc", toolName: "echo" });
    expect((tc.render(40)[0] ?? "").match(/⏳/) !== null).toBe(true);
    tc.setStatus("running");
    expect((tc.render(40)[0] ?? "").match(/…/) !== null).toBe(true);
    tc.finalize(
      { content: [{ type: "text", text: "hi" }], details: {}, terminate: false },
      false,
    );
    expect((tc.render(40)[0] ?? "").match(/✓/) !== null).toBe(true);
  });

  it("phase 2 detect: 超 MAX_TOOL_TURNS_PER_SESSION → phase==2 (无需实跑流)", () => {
    const msgs = [];
    msgs.push({ role: "user", content: [{ type: "text", text: "x" }] });
    for (let i = 0; i < 6; i++) {
      msgs.push({
        role: "toolResult",
        toolCallId: `c${i}`,
        content: [{ type: "text", text: `r${i}` }],
      } as LlmContext["messages"][number]);
    }
    expect(detectMockPhase({ systemPrompt: "", tools: [], messages: msgs as never })).toBe(2);
  });
});
