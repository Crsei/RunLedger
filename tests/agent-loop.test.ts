/**
 * agent-loop 单测
 *
 * 流程断言:
 *   1. 启动 mock 循环(prompt = "hello");
 *   2. 收集事件序列与 ledger 落盘条目;
 *   3. 验证事件序列、最终 messages 数、ledger 条目数与类型分布。
 */

import { describe, expect, it } from "vitest";

import {
  Agent,
  MemoryLedger,
  mockStreamFn,
  mockModel,
  echoTool,
} from "../src/index.ts";
import type { AgentEvent } from "../src/index.ts";

describe("runAgentLoop with mockStreamFn + echoTool", () => {
	it("revalidates and reauthorizes hook-updated tool input before execution", async () => {
		const ledger = new MemoryLedger();
		const seen: unknown[] = [];
		let updated = false;
		const agent = new Agent({
			initialState: {
				systemPrompt: "",
				model: mockModel,
				tools: [echoTool],
			},
			streamFn: mockStreamFn,
			ledger,
			loopConfig: {
				beforeToolCall: async ({ args }) => {
					seen.push(args);
					if (!updated) {
						updated = true;
						return { updatedInput: { text: "rewritten" } };
					}
					return undefined;
				},
			},
		});

		const final = await agent.prompt("original");
		const result = final.find((message) => message.role === "toolResult");
		expect(seen.slice(0, 2)).toEqual([{ text: "original" }, { text: "rewritten" }]);
		expect(result).toMatchObject({ role: "toolResult", content: [{ type: "toolResult", content: [{ type: "text", text: "rewritten" }] }] });
	});

	it("runs the full start→message→tool→end loop and persists ledger", async () => {
    const ledger = new MemoryLedger({ metadata: { test: 1 } });
    const agent = new Agent({
      initialState: {
        systemPrompt: "test system prompt",
        model: mockModel,
        tools: [echoTool],
      },
      streamFn: mockStreamFn,
      ledger,
      toolExecution: "sequential",
    });

    const events: AgentEvent[] = [];
    agent.subscribe((ev) => {
      events.push(ev);
    });

    const finalMessages = await agent.prompt("hello");

    // 至少 2 个 user / assistant / toolResult / assistant 消息(2 user, 2 assistant, 1 toolResult)
    expect(finalMessages.length).toBeGreaterThanOrEqual(4);

    // 最后一条是 assistant 摘要消息
    const tail = finalMessages[finalMessages.length - 1];
    expect(tail).toBeDefined();
    expect(tail!.role).toBe("assistant");

    // 关键事件存在
    const types = events.map((e) => e.type);
    expect(types).toContain("agent_start");
    expect(types).toContain("turn_start");
    expect(types).toContain("message_start");
    expect(types).toContain("message_end");
    expect(types).toContain("tool_execution_start");
    expect(types).toContain("tool_execution_end");
    expect(types).toContain("turn_end");
    expect(types).toContain("agent_end");

    // 顺序:agent_start 一定在 events[0],agent_end 一定是最后
    expect(events[0]!.type).toBe("agent_start");
    expect(events[events.length - 1]!.type).toBe("agent_end");

    // 至少有一次 tool_execution_start
    const toolStarts = events.filter(
      (e) => e.type === "tool_execution_start",
    ).length;
    expect(toolStarts).toBeGreaterThanOrEqual(1);
    const toolEnds = events.filter(
      (e) => e.type === "tool_execution_end",
    ).length;
    expect(toolEnds).toBe(toolStarts);

    // === Ledger 断言 ===
    const ledgerEntries = ledger.entries();
    // 至少:1 个 agent_start + 2 user(message x2) + 2 turn + 1 assistant message + 1 tool_call + 1 tool_result + 1 agent_end
    // 估算下限:
    expect(ledgerEntries.length).toBeGreaterThanOrEqual(8);
    // 包含 tool_call 与 tool_result
    const ledgerTypes = ledgerEntries.map((e) => e.type);
    expect(ledgerTypes).toContain("tool_call");
    expect(ledgerTypes).toContain("tool_result");
    expect(ledgerTypes).toContain("agent_event");

    // 每个 entry 都有 sessionId 等于 ledger.sessionId
    for (const e of ledgerEntries) {
      expect(e.sessionId).toBe(ledger.sessionId);
    }
  });

  it("echo tool receives the user's text as input", async () => {
    const ledger = new MemoryLedger();
    const agent = new Agent({
      initialState: {
        systemPrompt: "",
        model: mockModel,
        tools: [echoTool],
      },
      streamFn: mockStreamFn,
      ledger,
    });
    const final = await agent.prompt("ping");
    // 在 messages 中找到第一条 toolResult,内容应该 echo 出 ping
    const toolResultMsg = final.find(
      (m) => m.role === "toolResult",
    );
    expect(toolResultMsg).toBeDefined();
    if (toolResultMsg && toolResultMsg.role === "toolResult") {
      const first = toolResultMsg.content[0];
      expect(first).toBeDefined();
      if (first && first.type === "toolResult") {
        expect(first.content[0]?.text).toBe("ping");
      }
    }
  });
});
