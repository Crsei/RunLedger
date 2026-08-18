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
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "../src/types.ts";
import { createAssistantMessageEventStream } from "../src/utils/event-stream.ts";
import type { StreamFn } from "../src/runtime/types.ts";
import { defaultConvertToLlm } from "../src/runtime/agent-loop.ts";

function assistantMessageFor(
	model: Model<Api>,
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		timestamp: Date.now(),
	};
}

describe("runAgentLoop with mockStreamFn + echoTool", () => {
	it("runs an ephemeral recap without mutating Agent state, ledger, events, or tools", async () => {
		const ledger = new MemoryLedger();
		const initialMessages = [{ role: "user" as const, content: [{ type: "text" as const, text: "ship the feature" }] }];
		let capturedContext: Context | undefined;
		let capturedOptions: SimpleStreamOptions | undefined;
		const streamFn: StreamFn = (requestModel, context, options) => {
			capturedContext = context as Context;
			capturedOptions = options;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const message: AssistantMessage = {
					role: "assistant",
					content: [
						{ type: "text", text: "recap: continue with the next action" },
						{ type: "toolCall", id: "tool_side", name: "echo", arguments: { text: "must not execute" } },
					],
					api: requestModel.api,
					provider: requestModel.provider,
					model: requestModel.id,
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "toolUse",
					timestamp: Date.now(),
				};
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: "toolUse", message });
				stream.end(message);
			});
			return stream;
		};
		const agent = new Agent({
			initialState: { systemPrompt: "system", model: mockModel, tools: [echoTool], messages: initialMessages },
			streamFn,
			ledger,
		});
		const events: AgentEvent[] = [];
		agent.subscribe((event) => events.push(event));
		const before = agent.state;

		const result = await (agent as unknown as {
			runEphemeralTurn: (input: { promptText: string; ownerGeneration: number; activityGeneration: number }) => Promise<{ replyText: string; assistantMessage: AssistantMessage }>;
		}).runEphemeralTurn({ promptText: "what should I do next?", ownerGeneration: 4, activityGeneration: 7 });

		expect(result.replyText).toContain("continue with the next action");
		expect(result.assistantMessage.content.some((part) => part.type === "toolCall")).toBe(false);
		expect(agent.state.messages).toEqual(before.messages);
		expect(ledger.entries()).toEqual([]);
		expect(events).toEqual([]);
		expect(capturedContext?.systemPrompt).toBe("system");
		expect(capturedContext?.tools).toHaveLength(1);
		expect(capturedOptions).toMatchObject({
			maxTokens: 128,
			timeoutMs: 30_000,
			maxRetries: 0,
			metadata: { requestKind: "idle-recap", ownerGeneration: 4, activityGeneration: 7 },
		});
		expect(capturedOptions?.sessionId).toContain(":owner-4:activity-7");
	});

	it("uses the system prompt and thinking level captured before async context conversion", async () => {
		const reasoningModel = { ...mockModel, reasoning: true };
		let releaseConversion!: () => void;
		let conversionStarted!: () => void;
		const conversionReady = new Promise<void>((resolve) => { conversionStarted = resolve; });
		const conversionRelease = new Promise<void>((resolve) => { releaseConversion = resolve; });
		let capturedContext: Context | undefined;
		let capturedOptions: SimpleStreamOptions | undefined;
		const streamFn: StreamFn = (requestModel, context, options) => {
			capturedContext = context as Context;
			capturedOptions = options;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const message: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: "snapshot reply" }],
					api: requestModel.api,
					provider: requestModel.provider,
					model: requestModel.id,
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "stop",
					timestamp: Date.now(),
				};
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: "stop", message });
				stream.end(message);
			});
			return stream;
		};
		const agent = new Agent({
			initialState: {
				systemPrompt: "system at request start",
				model: reasoningModel,
				thinkingLevel: "low",
				messages: [{ role: "user", content: [{ type: "text", text: "existing history" }] }],
			},
			streamFn,
			convertToLlm: async (messages) => {
				conversionStarted();
				await conversionRelease;
				return defaultConvertToLlm(messages);
			},
		});

		const request = agent.runEphemeralTurn({ promptText: "recap the current task" });
		await conversionReady;
		agent.setSystemPrompt("system changed while request was preparing");
		agent.setThinkingLevel("high");
		releaseConversion();
		await request;

		expect(capturedContext?.systemPrompt).toBe("system at request start");
		expect(capturedOptions?.reasoning).toBe("low");
	});

	it("suppresses a provider error from an ephemeral recap", async () => {
		const streamFn: StreamFn = (requestModel) => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const error = assistantMessageFor(requestModel, [], "error");
				stream.push({ type: "error", reason: "error", error });
				stream.end(error);
			});
			return stream;
		};
		const agent = new Agent({
			initialState: {
				systemPrompt: "system",
				model: mockModel,
				messages: [{ role: "user", content: [{ type: "text", text: "history" }] }],
			},
			streamFn,
		});

		await expect(agent.runEphemeralTurn({ promptText: "recap" })).resolves.toBeUndefined();
	});

	it.each([
		["router denial", "model route denied (profile_unknown)", "router_denied"],
		["missing auth", "Provider is not configured: fixture-provider", "auth_missing"],
		["provider timeout", "provider request timed out", "provider_timeout"],
	] as const)("reports a typed %s diagnostic without projecting recap success", async (_label, errorMessage, code) => {
		const streamFn: StreamFn = (requestModel) => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const error = { ...assistantMessageFor(requestModel, [], "error"), errorMessage };
				stream.push({ type: "error", reason: "error", error });
				stream.end(error);
			});
			return stream;
		};
		const agent = new Agent({
			initialState: {
				systemPrompt: "system",
				model: mockModel,
				messages: [{ role: "user", content: [{ type: "text", text: "history" }] }],
			},
			streamFn,
		});
		const diagnostics: unknown[] = [];
		const request = {
			promptText: "recap",
			requestId: "idle-recap-diagnostic-fixture",
			ownerGeneration: 4,
			activityGeneration: 2,
			onDiagnostic: (diagnostic: unknown) => diagnostics.push(diagnostic),
		} as Parameters<Agent["runEphemeralTurn"]>[0];

		await expect(agent.runEphemeralTurn(request)).resolves.toBeUndefined();
		expect(diagnostics).toEqual([expect.objectContaining({
			kind: "idle-recap",
			requestId: "idle-recap-diagnostic-fixture",
			ownerGeneration: 4,
			activityGeneration: 2,
			code,
		})]);
	});

	it("suppresses an aborted ephemeral recap without emitting a partial result", async () => {
		const abort = new AbortController();
		let streamStarted!: () => void;
		const started = new Promise<void>((resolve) => { streamStarted = resolve; });
		const streamFn: StreamFn = (requestModel, _context, options) => {
			const stream = createAssistantMessageEventStream();
			streamStarted();
			options?.signal?.addEventListener("abort", () => {
				const error = assistantMessageFor(requestModel, [], "aborted");
				stream.push({ type: "error", reason: "aborted", error });
				stream.end(error);
			}, { once: true });
			return stream;
		};
		const agent = new Agent({
			initialState: {
				systemPrompt: "system",
				model: mockModel,
				messages: [{ role: "user", content: [{ type: "text", text: "history" }] }],
			},
			streamFn,
		});

		const request = agent.runEphemeralTurn({ promptText: "recap", signal: abort.signal });
		await streamStarted;
		abort.abort();
		await expect(request).resolves.toBeUndefined();
	});

	it("suppresses an empty ephemeral reply", async () => {
		const streamFn: StreamFn = (requestModel) => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const message = assistantMessageFor(requestModel, [], "stop");
				stream.push({ type: "done", reason: "stop", message });
				stream.end(message);
			});
			return stream;
		};
		const agent = new Agent({
			initialState: {
				systemPrompt: "system",
				model: mockModel,
				messages: [{ role: "user", content: [{ type: "text", text: "history" }] }],
			},
			streamFn,
		});

		await expect(agent.runEphemeralTurn({ promptText: "recap" })).resolves.toBeUndefined();
	});

	it("suppresses malformed provider content instead of leaking an ephemeral error", async () => {
		const streamFn: StreamFn = (requestModel) => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const malformed = { ...assistantMessageFor(requestModel, [], "stop"), content: undefined } as unknown as AssistantMessage;
				stream.push({ type: "done", reason: "stop", message: malformed });
				stream.end(malformed);
			});
			return stream;
		};
		const agent = new Agent({
			initialState: {
				systemPrompt: "system",
				model: mockModel,
				messages: [{ role: "user", content: [{ type: "text", text: "history" }] }],
			},
			streamFn,
		});

		await expect(agent.runEphemeralTurn({ promptText: "recap" })).resolves.toBeUndefined();
	});

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
    const started = events.find((event) => event.type === "agent_start");
    const ended = events.find((event) => event.type === "agent_end");
    expect(started?.runId).toBeTruthy();
    expect(ended).toMatchObject({ runId: started?.runId, stopReason: "stop" });
    expect(ended?.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(ended?.activeDurationMs).toBe(ended?.elapsedMs);
    expect(events.filter((event) => event.type === "turn_start" || event.type === "turn_end" || event.type === "message_start" || event.type === "message_end" || event.type === "message_update" || event.type.startsWith("tool_execution_")).every((event) => event.runId === started?.runId)).toBe(true);

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

  it("emits one authoritative error completion when a run throws", async () => {
    const agent = new Agent({
      initialState: { systemPrompt: "", model: mockModel, tools: [] },
      streamFn: async () => { throw new Error("provider exploded"); },
    });
    const events: AgentEvent[] = [];
    agent.subscribe((event) => { events.push(event); });

    await expect(agent.prompt("fail")).rejects.toThrow("provider exploded");
    const starts = events.filter((event) => event.type === "agent_start");
    const ends = events.filter((event) => event.type === "agent_end");
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ runId: starts[0]?.runId, stopReason: "error" });
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
