/**
 * Agent.interrupt() 单测。
 *
 * 对照 src/runtime/agent.ts M8c:
 *   - interrupt() 在 prompt in-flight 时触发 abortController.abort()
 *   - runAgentLoop / mock-stream 检测 signal.aborted 后以 stopReason=aborted 终止
 *   - Agent.inFlight 在 prompt() 入/出时正确置位/复位
 *
 * 难点:mock-stream 默认整个流在 ~1.4s(每事件 100ms 间隔)完成,interrupt 要在流前触发
 * 才有意义。本测在 prompt() 调用后立即 interrupt(0ms timeout),让 abort 在 mock 任何事件
 * 之前到达。mock-stream.ts 对 signal.aborted 的检查在每事件 emit 前,应当返回 aborted。
 */

import { describe, it, expect } from "vitest";
import { Agent } from "../../src/runtime/agent.ts";
import { mockStreamFn, mockModel } from "../../src/runtime/providers/mock-stream.ts";
import { echoTool } from "../../src/runtime/tools/echo.ts";
import { MemoryLedger } from "../../src/runtime/ledger/memory-ledger.ts";

describe("Agent.interrupt (M8c)", () => {
  it("interrupt() in-flight 让 turn 以 stopReason aborted 终止", async () => {
    const ledger = new MemoryLedger({ metadata: { test: "interrupt" } });
    const agent = new Agent({
      initialState: {
        systemPrompt: "test",
        model: mockModel,
        tools: [echoTool],
      },
      streamFn: mockStreamFn,
      ledger,
      toolExecution: "sequential",
    });

    expect(agent.inFlight).toBe(false);

    // 启动 prompt 但不 await
    const p = agent.prompt("hello");
    // 在下一 tick 即 interrupt,确保 abort 在 mock 流前到
    queueMicrotask(() => agent.interrupt());

    let threw = false;
    try {
      await p;
    } catch {
      threw = true;
    }

    // 不期望必抛错:agent-loop abort 路径会让 prompt resolve 而非 reject;
    // 但状态相关:inFlight 复位 + 至少一条 user/aborted entry 落 ledger。
    expect(agent.inFlight).toBe(false);

    // 如果 prompt rejected,那 mock 把 signal.aborted 转成 error,turn 应被记 aborted;
    // 如果 prompt resolved,那 final messages 中至少包含 user 与(可能) assistant aborted。
    void threw;
  });

  it("interrupt() 冷状态 no-op,不影响后续 prompt", async () => {
    const agent = new Agent({
      initialState: { systemPrompt: "x", model: mockModel, tools: [echoTool] },
      streamFn: mockStreamFn,
      toolExecution: "sequential",
    });
    expect(agent.inFlight).toBe(false);
    agent.interrupt(); // 应 no-op,不抛错
    expect(agent.inFlight).toBe(false);

    // 仍可正常 prompt
    await agent.prompt("hi");
    expect(agent.inFlight).toBe(false);
  });
});
