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
import { DEFAULT_AGENT_RUN_BUDGET } from "../src/runtime/types.ts";
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
	it.each(["error", "aborted"] as const)("opens an assistant message when the provider reports %s before stream start", async (stopReason) => {
		const ledger = new MemoryLedger();
		const agent = new Agent({
			initialState: { systemPrompt: "system", model: mockModel },
			ledger,
			streamFn: (model) => {
				const stream = createAssistantMessageEventStream();
				const error = { ...assistantMessageFor(model, [], stopReason), errorMessage: "provider failed before headers" };
				stream.push({ type: "error", reason: stopReason, error });
				stream.end(error);
				return stream;
			},
		});
		const events: AgentEvent[] = [];
		agent.subscribe((event) => { events.push(event); });

		await agent.prompt("hello");

		const assistantEvents = events.filter((event) => (event.type === "message_start" || event.type === "message_end") && event.role === "assistant");
		expect(assistantEvents.map((event) => event.type)).toEqual(["message_start", "message_end"]);
		expect(assistantEvents[1]).toMatchObject({ stopReason, message: { content: [], errorMessage: "provider failed before headers" } });
		expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason, errorMessage: "provider failed before headers" });
		expect(ledger.entries().filter((entry) => entry.type === "message" && entry.payload.role === "assistant")).toHaveLength(1);
	});

	it("runs an ephemeral recap without mutating Agent state, ledger, events, or tools", async () => {
		const ledger = new MemoryLedger();
		const initialMessages = [{ role: "user" as const, origin: "user" as const, content: [{ type: "text" as const, text: "ship the feature" }] }];
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
		agent.subscribe((event) => { events.push(event); });
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
				messages: [{ role: "user", origin: "user", content: [{ type: "text", text: "existing history" }] }],
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
				messages: [{ role: "user", origin: "user", content: [{ type: "text", text: "history" }] }],
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
				messages: [{ role: "user", origin: "user", content: [{ type: "text", text: "history" }] }],
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
				messages: [{ role: "user", origin: "user", content: [{ type: "text", text: "history" }] }],
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
				messages: [{ role: "user", origin: "user", content: [{ type: "text", text: "history" }] }],
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
				messages: [{ role: "user", origin: "user", content: [{ type: "text", text: "history" }] }],
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
        expect(first.content[0]).toMatchObject({ type: "text", text: "ping" });
      }
    }
  });

  it.each([
    ["policy_denied", "repeated_tool_failure", "repeated tool failures", 3],
    ["approval_expired", "approval_expiration_limit", "approval expirations", 2],
  ] as const)("explains %s termination without claiming token exhaustion", async (code, reason, text, count) => {
    let turns = 0;
    const streamFn: StreamFn = (model) => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message = assistantMessageFor(model, [{ type: "toolCall", id: `failure-${++turns}`, name: "echo", arguments: { text: "test" } }], "toolUse");
        stream.push({ type: "done", reason: "toolUse", message });
        stream.end(message);
      });
      return stream;
    };
    const agent = new Agent({
      initialState: { systemPrompt: "", model: mockModel, tools: [{ ...echoTool, execute: async () => ({ content: [{ type: "text", text: code }], details: { errorCode: code }, isError: true }) }] },
      streamFn, loopConfig: { runBudget: DEFAULT_AGENT_RUN_BUDGET },
    });
    const events: AgentEvent[] = [];
    agent.subscribe((event) => { events.push(event); });
    const messages = await agent.prompt("test failures");
    expect(turns).toBe(count);
    expect(events.at(-1)).toMatchObject({ type: "agent_end", stopReason: "length", terminationReason: reason });
    expect(messages.at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: expect.stringContaining(text) }] });
    expect(JSON.stringify(messages.at(-1))).not.toContain("execution budget was exhausted");
  });

  it("terminates at the model turn budget with a typed budget summary", async () => {
    const agent = new Agent({
      initialState: {
        systemPrompt: "",
        model: mockModel,
        tools: [echoTool],
      },
      streamFn: mockStreamFn,
      loopConfig: {
        runBudget: {
          maxModelTurns: 1,
          maxToolTurns: 4,
          maxActiveDurationMs: 60_000,
          maxApprovalExpirations: 2,
          maxRepeatedFailureFingerprint: 3,
        },
      },
    });
    const events: AgentEvent[] = [];
    agent.subscribe((ev) => {
      events.push(ev);
    });

    const finalMessages = await agent.prompt("budget");

    const ended = events[events.length - 1]!;
    expect(ended).toMatchObject({
      type: "agent_end",
      stopReason: "length",
      terminationReason: "model_turn_limit",
    });
    const tail = finalMessages[finalMessages.length - 1]!;
    expect(tail.role).toBe("assistant");
    expect(tail).toMatchObject({ role: "assistant", stopReason: "length" });
  });

  it("consumes steering messages only at the next turn boundary", async () => {
    const calls: Context["messages"][] = [];
    let agent: Agent;
    const streamFn: StreamFn = (requestModel, context) => {
      calls.push(context.messages);
      if (calls.length === 1) {
        agent.steer({ role: "user", origin: "user", content: [{ type: "text", text: "steer" }] });
      }
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message: AssistantMessage = {
          role: "assistant",
          content: [{ type: "text", text: calls.length === 1 ? "first" : "second" }],
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
    agent = new Agent({
      initialState: {
        systemPrompt: "",
        model: mockModel,
        tools: [],
      },
      streamFn,
    });
    const events: AgentEvent[] = [];
    agent.subscribe((ev) => {
      events.push(ev);
    });

    await agent.prompt("go");

    // steering 进入第二次 LLM 请求,而不是混入第一次。
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[1])).toContain("steer");
    const firstTurnEnd = events.findIndex((e) => e.type === "turn_end");
    const steeringStart = events.findIndex(
      (e) => e.type === "message_start" && e.role === "user" && "message" in e && JSON.stringify(e.message).includes("steer"),
    );
    expect(steeringStart).toBeGreaterThan(firstTurnEnd);
  });
});

describe("Plan 14 model terminal execution boundary", () => {
  it.each(["error", "aborted", "length"] as const)("does not admit tools from a %s response", async (reason) => {
    let executions = 0;
    let admissions = 0;
    const ledger = new MemoryLedger();
    const events: AgentEvent[] = [];
    const streamFn: StreamFn = (model) => {
      const stream = createAssistantMessageEventStream();
      const message = assistantMessageFor(model, [{ type: "toolCall", id: "unexecuted", name: "echo", arguments: { text: "do not execute" } }], reason);
      queueMicrotask(() => {
        if (reason === "length") stream.push({ type: "done", reason, message });
        else stream.push({ type: "error", reason, error: message });
        stream.end(message);
      });
      return stream;
    };
    const agent = new Agent({
      initialState: { systemPrompt: "fixture", model: mockModel, tools: [{ ...echoTool, execute: async () => { executions++; return { content: [{ type: "text", text: "ok" }], details: {} }; } }] },
      streamFn,
      ledger,
      loopConfig: { beforeToolCall: async () => { admissions++; } },
    });
    agent.subscribe((event) => { events.push(event); });
    const messages = await agent.prompt("run");
    expect(executions).toBe(0);
    expect(admissions).toBe(0);
    const results = messages.flatMap((message) => message.role === "toolResult" ? message.content : []);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ toolCallId: "unexecuted", isError: true });
    expect(JSON.stringify(results[0]?.content)).toContain("not executed");
    expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "agent_end", stopReason: reason });
    expect(ledger.entries().filter((entry) => entry.type === "tool_result")).toHaveLength(1);
  });

  it("does not execute a stream that ends without a terminal event", async () => {
    let executions = 0;
    const agent = new Agent({
      initialState: { systemPrompt: "fixture", model: mockModel, tools: [{ ...echoTool, execute: async () => { executions++; return { content: [], details: {} }; } }] },
      streamFn: (model) => {
        const stream = createAssistantMessageEventStream();
        const toolCall = { type: "toolCall" as const, id: "unfinished", name: "echo", arguments: { text: "unfinished" } };
        const message = assistantMessageFor(model, [toolCall], "toolUse");
        queueMicrotask(() => {
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
          stream.end(message);
        });
        return stream;
      },
    });
    const messages = await agent.prompt("run");
    expect(executions).toBe(0);
    expect(messages.find((message) => message.role === "assistant")).toMatchObject({ stopReason: "error" });
  });

  it.each(["toolUse", "stop"] as const)("executes a complete compatible %s response once", async (reason) => {
    let executions = 0;
    let requests = 0;
    const streamFn: StreamFn = (model) => {
      const stream = createAssistantMessageEventStream();
      const first = requests++ === 0;
      const message = assistantMessageFor(model, first ? [{ type: "toolCall", id: "complete", name: "echo", arguments: { text: "ok" } }] : [{ type: "text", text: "done" }], first ? reason : "stop");
      queueMicrotask(() => {
        stream.push({ type: "done", reason: first ? reason : "stop", message });
        stream.end(message);
      });
      return stream;
    };
    const agent = new Agent({
      initialState: { systemPrompt: "fixture", model: mockModel, tools: [{ ...echoTool, execute: async () => { executions++; return { content: [{ type: "text", text: "ok" }], details: {} }; } }] },
      streamFn,
    });
    await agent.prompt("run");
    expect(executions).toBe(1);
  });
});
