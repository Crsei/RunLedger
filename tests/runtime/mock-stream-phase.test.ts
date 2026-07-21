/**
 * mock-stream phase detection 单测。
 *
 * - detectMockPhase:0 (无 toolResult) / 1 (1-3 个 toolResult) / 2 (>=4 个 toolResult)
 * - mockStreamFn options.onPhase 钩子调用一次,phase 与 detectMockPhase 一致
 */

import { describe, expect, it } from "vitest";
import {
  detectMockPhase,
  mockStreamFn,
  mockModel,
  MAX_TOOL_TURNS_PER_SESSION,
} from "../../src/runtime/providers/mock-stream.ts";
import type { LlmContext } from "../../src/runtime/types.ts";

function mkContext(toolResultCount: number): LlmContext {
  const msgs: LlmContext["messages"] = [];
  msgs.push({ role: "user", content: [{ type: "text", text: "hi" }] });
  for (let i = 0; i < toolResultCount; i++) {
    msgs.push({
      role: "toolResult",
      toolCallId: `c${i}`,
      content: [{ type: "text", text: `result ${i}` }],
    } as LlmContext["messages"][number]);
  }
  return { messages: msgs, systemPrompt: "sys", tools: [] };
}

describe("mockStreamFn phase detection", () => {
  it("detectMockPhase: 0 / 1 / 2 阶段区分", () => {
    expect(detectMockPhase(mkContext(0))).toBe(0);
    expect(detectMockPhase(mkContext(1))).toBe(1);
    expect(detectMockPhase(mkContext(MAX_TOOL_TURNS_PER_SESSION - 1))).toBe(1);
    expect(detectMockPhase(mkContext(MAX_TOOL_TURNS_PER_SESSION))).toBe(2);
    expect(detectMockPhase(mkContext(10))).toBe(2);
  });

  it("mockStreamFn 调用 onPhase 钩子一次,phase 与 detectMockPhase 一致", async () => {
    const captured: number[] = [];
    const stream = mockStreamFn(mockModel, mkContext(0), {
      onPhase: (p: number) => captured.push(p),
    } as never);
    // AsyncIterableIterator:全部耗尽 stream
    for await (const _e of stream) {
      void _e;
    }
    expect(captured).toEqual([0]);
  });

  it("phase 1 context 同样触发 onPhase(1)", async () => {
    const captured: number[] = [];
    const stream = mockStreamFn(mockModel, mkContext(2), {
      onPhase: (p: number) => captured.push(p),
    } as never);
    for await (const _e of stream) {
      void _e;
    }
    expect(captured).toEqual([1]);
  });
});

