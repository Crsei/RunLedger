import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { repeatedToolFailure } from "../../../src/runtime/agent-loop/run-budget.ts";
import { runAgentLoop } from "../../../src/runtime/agent-loop.ts";
import { DEFAULT_AGENT_RUN_BUDGET } from "../../../src/runtime/types.ts";
import type { AgentEvent, AgentTool, StreamFn } from "../../../src/runtime/types.ts";
import { createAssistantMessageEventStream } from "../../../src/utils/event-stream.ts";
import type { Api, AssistantMessage, Model, ToolCall } from "../../../src/types.ts";

const MODEL: Model<Api> = {
	id: "run-budget-model",
	name: "Run Budget Model",
	api: "mock",
	provider: "run-budget",
	baseUrl: "http://localhost",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8_192,
	maxTokens: 1_024,
};

const USAGE: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const parameters = Type.Object({ value: Type.String() });

describe("production Agent run budget", () => {
	it("completes a productive task beyond the former sixteen tool turns", async () => {
		let calls = 0;
		const tool: AgentTool<typeof parameters> = {
			name: "budget", label: "budget", description: "fixture", parameters,
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		};
		const streamFn: StreamFn = () => {
			calls++;
			const message = calls <= 20
				? assistant([{ type: "toolCall", id: `step-${calls}`, name: "budget", arguments: { value: String(calls) } }], "toolUse")
				: assistant([{ type: "text", text: "finished" }], "stop");
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: { ...message, content: [] } });
				stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
				stream.end(message);
			});
			return stream;
		};
		const events: AgentEvent[] = [];
		await runAgentLoop([{ role: "user", content: [{ type: "text", text: "work" }] }], { messages: [], tools: [tool], systemPrompt: "" },
			{ model: MODEL, runBudget: DEFAULT_AGENT_RUN_BUDGET },
			async (event) => { events.push(event); }, undefined, streamFn);
		expect(calls).toBe(21);
		expect(events.at(-1)).toMatchObject({ type: "agent_end", stopReason: "stop" });
	});

	it("stops before an extra model or tool call when the model-turn budget is exhausted", async () => {
		let modelCalls = 0;
		let toolCalls = 0;
		const streamFn: StreamFn = () => {
			modelCalls += 1;
			if (modelCalls > 2) throw new Error("model called after budget exhaustion");
			const call: ToolCall = { type: "toolCall", id: `budget-call-${modelCalls}`, name: "budget", arguments: { value: String(modelCalls) } };
			const message = assistant([call], "toolUse");
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: { ...message, content: [] } });
				stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
				stream.push({ type: "done", reason: "toolUse", message });
				stream.end(message);
			});
			return stream;
		};
		const tool: AgentTool<typeof parameters> = {
			name: "budget",
			label: "budget",
			description: "budget fixture",
			parameters,
			execute: async () => {
				toolCalls += 1;
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
		const events: AgentEvent[] = [];
		const context = { messages: [], tools: [tool] };

		const messages = await runAgentLoop(
			[{ role: "user", content: [{ type: "text", text: "loop" }] }],
			context,
			{
				model: MODEL,
				runBudget: {
					maxModelTurns: 2,
					maxToolTurns: 8,
					maxActiveDurationMs: 60_000,
					maxRepeatedFailureFingerprint: 3,
					maxApprovalExpirations: 2,
				},
			},
			async (event) => { events.push(event); },
			undefined,
			streamFn,
		);

		expect(modelCalls).toBe(2);
		expect(toolCalls).toBe(2);
		expect(messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "length",
			content: [{ type: "text", text: expect.stringMatching(/model turn limit|模型轮次上限/iu) }],
		});
		expect(events.at(-1)).toMatchObject({
			type: "agent_end",
			stopReason: "length",
			terminationReason: "model_turn_limit",
		});
	});

	it("settles the current tool batch and stops before another model call at the tool-turn limit", async () => {
		let modelCalls = 0;
		let toolCalls = 0;
		const streamFn: StreamFn = () => {
			modelCalls += 1;
			if (modelCalls > 1) throw new Error("model called after tool-turn budget exhaustion");
			const call: ToolCall = { type: "toolCall", id: "tool-budget-call", name: "budget", arguments: { value: "one" } };
			const message = assistant([call], "toolUse");
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: { ...message, content: [] } });
				stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
				stream.push({ type: "done", reason: "toolUse", message });
				stream.end(message);
			});
			return stream;
		};
		const tool: AgentTool<typeof parameters> = {
			name: "budget",
			label: "budget",
			description: "budget fixture",
			parameters,
			execute: async () => {
				toolCalls += 1;
				return { content: [{ type: "text", text: "settled" }], details: {} };
			},
		};
		const events: AgentEvent[] = [];

		await runAgentLoop(
			[{ role: "user", content: [{ type: "text", text: "loop" }] }],
			{ messages: [], tools: [tool] },
			{
				model: MODEL,
				runBudget: {
					maxModelTurns: 8,
					maxToolTurns: 1,
					maxActiveDurationMs: 60_000,
					maxRepeatedFailureFingerprint: 3,
					maxApprovalExpirations: 2,
				},
			},
			async (event) => { events.push(event); },
			undefined,
			streamFn,
		);

		expect(modelCalls).toBe(1);
		expect(toolCalls).toBe(1);
		expect(events.at(-1)).toMatchObject({
			type: "agent_end",
			stopReason: "length",
			terminationReason: "tool_turn_limit",
		});
	});

	it("uses Runtime active time and stops after settling the current tool batch", async () => {
		let modelCalls = 0;
		let toolCalls = 0;
		let activeDurationMs = 5;
		const streamFn: StreamFn = () => {
			modelCalls += 1;
			if (modelCalls > 1) throw new Error("model called after active-duration exhaustion");
			const call: ToolCall = { type: "toolCall", id: "active-budget-call", name: "budget", arguments: { value: "one" } };
			const message = assistant([call], "toolUse");
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: { ...message, content: [] } });
				stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
				stream.push({ type: "done", reason: "toolUse", message });
				stream.end(message);
			});
			return stream;
		};
		const tool: AgentTool<typeof parameters> = {
			name: "budget",
			label: "budget",
			description: "active budget fixture",
			parameters,
			execute: async () => {
				toolCalls += 1;
				activeDurationMs = 11;
				return { content: [{ type: "text", text: "settled" }], details: {} };
			},
		};
		const events: AgentEvent[] = [];

		await runAgentLoop(
			[{ role: "user", content: [{ type: "text", text: "loop" }] }],
			{ messages: [], tools: [tool] },
			{
				model: MODEL,
				runBudget: {
					maxModelTurns: 8,
					maxToolTurns: 8,
					maxActiveDurationMs: 10,
					maxRepeatedFailureFingerprint: 3,
					maxApprovalExpirations: 2,
				},
				runBudgetUsage: { activeDurationMs: () => activeDurationMs },
			},
			async (event) => { events.push(event); },
			undefined,
			streamFn,
		);

		expect(modelCalls).toBe(1);
		expect(toolCalls).toBe(1);
		expect(events.at(-1)).toMatchObject({
			type: "agent_end",
			stopReason: "length",
			terminationReason: "active_duration_limit",
		});
	});

	it("stops the same failed request while ignoring private incidental metadata", async () => {
		let modelCalls = 0;
		let toolCalls = 0;
		const streamFn: StreamFn = () => {
			modelCalls += 1;
			if (modelCalls > 2) throw new Error("model called after repeated failure exhaustion");
			const call: ToolCall = {
				type: "toolCall",
				id: `failure-call-${modelCalls}`,
				name: "budget",
				arguments: { value: "/private/same-request" },
			};
			const message = assistant([call], "toolUse");
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: { ...message, content: [] } });
				stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
				stream.push({ type: "done", reason: "toolUse", message });
				stream.end(message);
			});
			return stream;
		};
		const tool: AgentTool<typeof parameters> = {
			name: "budget",
			label: "budget",
			description: "repeated failure fixture",
			parameters,
			execute: async () => {
				toolCalls += 1;
				return {
					content: [{ type: "text", text: "same failure" }],
					details: { errorCode: "process_failed", exitCode: 7, path: `/private/path-${toolCalls}`, token: `secret-${toolCalls}` },
					isError: true,
				};
			},
		};
		const events: AgentEvent[] = [];

		await runAgentLoop(
			[{ role: "user", content: [{ type: "text", text: "loop" }] }],
			{ messages: [], tools: [tool] },
			{
				model: MODEL,
				runBudget: {
					maxModelTurns: 8,
					maxToolTurns: 8,
					maxActiveDurationMs: 60_000,
					maxRepeatedFailureFingerprint: 2,
					maxApprovalExpirations: 8,
				},
			},
			async (event) => { events.push(event); },
			undefined,
			streamFn,
		);

		expect(modelCalls).toBe(2);
		expect(toolCalls).toBe(2);
		expect(events.at(-1)).toMatchObject({
			type: "agent_end",
			stopReason: "length",
			terminationReason: "repeated_tool_failure",
		});
	});

	it("stops after the configured number of typed approval expirations", async () => {
		let modelCalls = 0;
		let toolCalls = 0;
		const streamFn: StreamFn = () => {
			modelCalls += 1;
			if (modelCalls > 2) throw new Error("model called after approval expiration exhaustion");
			const call: ToolCall = { type: "toolCall", id: `approval-call-${modelCalls}`, name: "budget", arguments: { value: String(modelCalls) } };
			const message = assistant([call], "toolUse");
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: { ...message, content: [] } });
				stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
				stream.push({ type: "done", reason: "toolUse", message });
				stream.end(message);
			});
			return stream;
		};
		const tool: AgentTool<typeof parameters> = {
			name: "budget",
			label: "budget",
			description: "approval expiration fixture",
			parameters,
			execute: async () => {
				toolCalls += 1;
				throw Object.assign(new Error(`approval request ${toolCalls} failed`), { code: "approval_expired" });
			},
		};
		const events: AgentEvent[] = [];

		await runAgentLoop(
			[{ role: "user", content: [{ type: "text", text: "loop" }] }],
			{ messages: [], tools: [tool] },
			{
				model: MODEL,
				runBudget: {
					maxModelTurns: 8,
					maxToolTurns: 8,
					maxActiveDurationMs: 60_000,
					maxRepeatedFailureFingerprint: 8,
					maxApprovalExpirations: 2,
				},
			},
			async (event) => { events.push(event); },
			undefined,
			streamFn,
		);

		expect(modelCalls).toBe(2);
		expect(toolCalls).toBe(2);
		expect(events.at(-1)).toMatchObject({
			type: "agent_end",
			stopReason: "length",
			terminationReason: "approval_expiration_limit",
		});
	});

	it("rejects an invalid budget before starting a run", async () => {
		let modelCalls = 0;
		const streamFn: StreamFn = () => {
			modelCalls += 1;
			throw new Error("invalid budget reached the provider");
		};

		await expect(runAgentLoop(
			[{ role: "user", content: [{ type: "text", text: "invalid" }] }],
			{ messages: [], tools: [] },
			{
				model: MODEL,
				runBudget: {
					maxModelTurns: 0,
					maxToolTurns: 1,
					maxActiveDurationMs: 1,
					maxRepeatedFailureFingerprint: 1,
					maxApprovalExpirations: 1,
				},
			},
			async () => undefined,
			undefined,
			streamFn,
		)).rejects.toThrow(/positive safe integer/u);
		expect(modelCalls).toBe(0);
	});
});

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: MODEL.api,
		provider: MODEL.provider,
		model: MODEL.id,
		usage: USAGE,
		stopReason,
		timestamp: Date.now(),
	};
}

describe("Plan 14 failure progress accounting", () => {
  it.each(["distinct-requests", "changing-error", "batch", "no-details", "schema", "unknown-tool"] as const)("handles %s without conflating or losing failures", async (scenario) => {
    let turns = 0;
    let executed = 0;
    const tool: AgentTool<typeof parameters> = {
      name: "budget", label: "budget", description: "fixture", parameters,
      execute: async () => {
        executed++;
        return { isError: true, content: [{ type: "text", text: scenario === "changing-error" ? `failure-${turns}` : "same failure" }],
          details: scenario === "no-details" ? undefined : { exitCode: 1 } };
      },
    };
    const streamFn: StreamFn = () => {
      turns++;
      const calls: ToolCall[] = Array.from({ length: scenario === "batch" ? 2 : 1 }, (_, index) => ({
        type: "toolCall", id: `call-${turns}-${index}`, name: scenario === "unknown-tool" ? "missing" : "budget",
        arguments: scenario === "schema" ? {} : { value: scenario === "distinct-requests" ? `request-${turns}` : `request-${index}` },
      }));
      const message = turns <= 5 ? assistant(calls, "toolUse") : assistant([{ type: "text", text: "done" }], "stop");
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "done", reason: turns <= 5 ? "toolUse" : "stop", message });
        stream.end(message);
      });
      return stream;
    };
    const events: AgentEvent[] = [];
    await runAgentLoop([{ role: "user", content: [{ type: "text", text: "run" }] }], { messages: [], tools: [tool] },
      { model: MODEL, runBudget: { ...DEFAULT_AGENT_RUN_BUDGET, maxRepeatedFailureFingerprint: 3 } },
      async (event) => { events.push(event); }, undefined, streamFn);
    const changing = scenario === "distinct-requests" || scenario === "changing-error";
    expect(turns).toBe(changing ? 6 : 3);
    expect(events.at(-1)).toMatchObject(changing ? { stopReason: "stop" } : { terminationReason: "repeated_tool_failure" });
    if (scenario === "schema" || scenario === "unknown-tool") expect(executed).toBe(0);
  });
});


describe("Plan 14 failure fingerprint state transitions", () => {
  it("normalizes argument order and call IDs, and resets after success or approval expiry", () => {
    const call = (id: string, arguments_: Record<string, unknown>): ToolCall => ({ type: "toolCall", id, name: "bash", arguments: arguments_ });
    const result = (id: string, isError = true, errorCode = "tool_execution_error") => ({
      type: "toolResult" as const, toolCallId: id, toolName: "bash", isError,
      content: [{ type: "text" as const, text: `failure for ${id}` }], details: { errorCode },
    });
    const first = repeatedToolFailure([result("call_first")], [call("call_first", { b: 2, a: 1 })], new Map());
    const second = repeatedToolFailure([result("call_second")], [call("call_second", { a: 1, b: 2 })], first.fingerprints);
    expect(second.count).toBe(2);
    for (const resetResult of [result("reset", false), result("reset", true, "approval_expired")]) {
      const reset = repeatedToolFailure([resetResult], [call("reset", { a: 1, b: 2 })], second.fingerprints);
      expect(reset.count).toBe(0);
      const next = repeatedToolFailure([result("next")], [call("next", { a: 1, b: 2 })], reset.fingerprints);
      expect(next.count).toBe(1);
    }
    expect([...second.fingerprints.keys()]).toEqual([expect.stringMatching(/^[a-f0-9]{64}:[a-f0-9]{64}$/u)]);
  });

  it("bounds retained request state even for an unusually large failing batch", () => {
    const calls: ToolCall[] = Array.from({ length: 300 }, (_, index) => ({ type: "toolCall", id: `call-${index}`, name: "bash", arguments: { command: `private-command-${index}` } }));
    const results = calls.map((call) => ({ type: "toolResult" as const, toolCallId: call.id, toolName: call.name, isError: true, content: [{ type: "text" as const, text: "failed" }] }));
    const state = repeatedToolFailure(results, calls, new Map());
    expect(state.fingerprints.size).toBe(256);
    expect(state.count).toBe(1);
    expect(JSON.stringify([...state.fingerprints])).not.toContain("private-command");
  });
});
