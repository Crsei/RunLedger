import { describe, expect, it } from "vitest";

import { runAgentLoop } from "../../src/runtime/agent-loop.ts";
import type { AgentContext, AgentMessage, AgentEvent, AgentLoopConfig, StreamFn } from "../../src/runtime/types.ts";
import { createAssistantMessageEventStream } from "../../src/utils/event-stream.ts";
import { mockModel } from "../../src/runtime/providers/mock-stream.ts";
import { assembleAgentModelContext } from "../../src/runtime/context/model-request-adapter.ts";
import { ContextAssemblyError } from "../../src/runtime/context/context-engine.ts";
import { SettingsResolver } from "../../src/storage/settings-resolver.ts";
import type { AssistantMessage, LlmContext } from "../../src/types.ts";
import { echoTool } from "../../src/runtime/tools/echo.ts";

function user(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }] };
}

function assistant(text: string): AgentMessage {
	return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };
}

function providerMessage(model: AgentLoopConfig["model"]): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "final response" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function streamFnFor(captured: LlmContext[]): StreamFn {
	return (model, context) => {
		captured.push(context);
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const message = providerMessage(model);
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: "stop", message });
			stream.end(message);
		});
		return stream;
	};
}

async function run(
	context: AgentContext,
	config: Omit<AgentLoopConfig, "model">,
	streamFn: StreamFn,
): Promise<AgentMessage[]> {
	const events: AgentEvent[] = [];
	return runAgentLoop([], context, { model: mockModel, ...config }, (event) => { events.push(event); }, undefined, streamFn);
}

describe("agent-loop compaction projection", () => {
	it("projects a compacted request while preserving raw history and ledger-facing context", async () => {
		const runtimeSettings = new SettingsResolver({
			user: { compaction: { thresholdTokens: 1, retainRecentTurns: 1, minCompactedTurns: 1 } },
		}).effectiveRuntimeSnapshot();
		const rawMessages: AgentMessage[] = [
			user("first question"),
			assistant("first answer"),
			user("second question"),
			assistant("second answer"),
			user("latest question"),
		];
		const context: AgentContext = { systemPrompt: "system", messages: rawMessages.slice(), tools: [] };
		const captured: LlmContext[] = [];
		const summaries: AgentMessage[][] = [];
		const config: Omit<AgentLoopConfig, "model"> = {
			runtimeSettings,
			compactionSummarizer: ({ messages }) => {
				summaries.push([...messages]);
				return "first two turns";
			},
		};

		const result = await run(context, config, streamFnFor(captured));

		expect(captured).toHaveLength(1);
		expect(captured[0]?.messages).toHaveLength(2);
		expect(captured[0]?.messages[0]).toMatchObject({
			role: "user",
			content: [{ type: "text", text: expect.stringContaining("first two turns") }],
		});
		expect(captured[0]?.messages[1]).toMatchObject({ role: "user", content: [{ type: "text", text: "latest question" }] });
		expect(summaries).toHaveLength(1);
		expect(summaries[0]).toEqual(rawMessages.slice(0, 4));
		expect(context.messages).toHaveLength(rawMessages.length + 1);
		expect(context.messages.slice(0, rawMessages.length)).toEqual(rawMessages);
		expect(result.slice(0, rawMessages.length)).toEqual(rawMessages);
		expect(result.some((message) => message.role === "user" && message.content[0]?.text.includes("[RunLedger compaction summary]"))).toBe(false);
	});

	it("uses the effective snapshot compaction policy before a legacy policy seam", async () => {
		const runtimeSettings = new SettingsResolver({
			user: { compaction: { enabled: false, thresholdTokens: 1 } },
		}).effectiveRuntimeSnapshot();
		const captured: LlmContext[] = [];
		let summarizeCalls = 0;
		const context: AgentContext = {
			systemPrompt: "system",
			messages: [user("one"), assistant("one reply"), user("two")],
			tools: [],
		};

		await run(context, {
			runtimeSettings,
			compactionPolicy: { ...runtimeSettings.compaction, enabled: true, thresholdTokens: 1 },
			compactionSummarizer: () => { summarizeCalls += 1; return "must not be used"; },
		}, streamFnFor(captured));

		expect(summarizeCalls).toBe(0);
		expect(captured[0]?.messages).toHaveLength(3);
	});

	it("honors a one-shot manual trigger even when the threshold is not reached", async () => {
		const runtimeSettings = new SettingsResolver({
			user: { compaction: { thresholdPercent: 100, thresholdTokens: 0 } },
		}).effectiveRuntimeSnapshot();
		const captured: LlmContext[] = [];
		const context: AgentContext = {
			systemPrompt: "system",
			messages: [user("one"), assistant("one reply"), user("two")],
			tools: [],
		};

		await run(context, {
			runtimeSettings,
			compactionTrigger: "manual",
			compactionSummarizer: () => "manual summary",
		}, streamFnFor(captured));

		expect(captured[0]?.messages[0]).toMatchObject({ role: "user", content: [{ type: "text", text: expect.stringContaining("manual summary") }] });
	});

	it("uses one overflow compaction retry before sending a model request", async () => {
		const runtimeSettings = new SettingsResolver({
			user: { compaction: { thresholdPercent: 100, thresholdTokens: 0 } },
		}).effectiveRuntimeSnapshot();
		const captured: LlmContext[] = [];
		let assemblyCalls = 0;
		const context: AgentContext = {
			systemPrompt: "system",
			messages: [user("one"), assistant("one reply"), user("two")],
			tools: [],
		};

		await run(context, {
			runtimeSettings,
			compactionSummarizer: () => "overflow summary",
			modelContextAssembler: ({ model, context: llmContext, sessionId, turn }) => {
				assemblyCalls += 1;
				if (assemblyCalls === 1) throw new ContextAssemblyError("required_fragment_exceeds_budget", "fixture overflow");
				return assembleAgentModelContext({ model, context: llmContext, sessionId, turn });
			},
		}, streamFnFor(captured));

		expect(assemblyCalls).toBe(2);
		expect(captured[0]?.messages[0]).toMatchObject({ role: "user", content: [{ type: "text", text: expect.stringContaining("overflow summary") }] });
	});

	it("uses the same projection for a model-switch trigger on the next turn", async () => {
		const runtimeSettings = new SettingsResolver({
			user: { compaction: { thresholdPercent: 100, thresholdTokens: 0 } },
		}).effectiveRuntimeSnapshot();
		const switchedModel = { ...mockModel, id: "mock-switched" };
		const captured: LlmContext[] = [];
		let followUpTaken = false;
		const context: AgentContext = {
			systemPrompt: "system",
			messages: [user("one"), assistant("one reply")],
			tools: [],
		};

		await run(context, {
			runtimeSettings,
			compactionSummarizer: ({ reason }) => `summary for ${reason}`,
			prepareNextTurn: () => ({ model: switchedModel }),
			getFollowUpMessages: () => {
				if (followUpTaken) return [];
				followUpTaken = true;
				return [user("continue after switch")];
			},
		}, streamFnFor(captured));

		expect(captured).toHaveLength(2);
		expect(captured[1]?.messages[0]).toMatchObject({ role: "user", content: [{ type: "text", text: expect.stringContaining("summary for model_switch") }] });
	});

	it("treats a tool continuation as mid-turn for compaction policy", async () => {
		const runtimeSettings = new SettingsResolver({
			user: {
				compaction: {
					thresholdTokens: 1,
					retainRecentTurns: 1,
					minCompactedTurns: 1,
					midTurnEnabled: false,
				},
			},
		}).effectiveRuntimeSnapshot();
		let requestCount = 0;
		let summaryCount = 0;
		const streamFn: StreamFn = (model) => {
			requestCount += 1;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const message: AssistantMessage = requestCount === 1
					? {
						...providerMessage(model),
						content: [{ type: "toolCall", id: "echo-1", name: "echo", arguments: { text: "continue" } }],
						stopReason: "toolUse",
					}
					: providerMessage(model);
				stream.push({ type: "start", partial: { ...message, content: [] } });
				stream.push({ type: "done", reason: message.stopReason, message });
				stream.end(message);
			});
			return stream;
		};
		const context: AgentContext = {
			systemPrompt: "system",
			messages: [user("old question"), assistant("old answer"), user("current question")],
			tools: [echoTool],
		};

		await run(context, {
			runtimeSettings,
			compactionSummarizer: () => {
				summaryCount += 1;
				return "summary";
			},
		}, streamFn);

		expect(requestCount).toBe(2);
		expect(summaryCount).toBe(1);
	});
});
