import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { createAssistantMessageEventStream } from "../../../src/utils/event-stream.ts";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Model,
} from "../../../src/types.ts";
import type {
	AgentTool,
	StreamFn,
	ToolAuthorizationPolicy,
} from "../../../src/runtime/types.ts";
import type { ExecutionEnv } from "../../../src/runtime/execution-env.ts";
import type { ChildModelRuntimeFactoryPort } from "../../../src/runtime/agents/child-model-runtime.ts";
import { runtimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import { createRuntimeId, type AgentId } from "../../../src/runtime/protocol/ids.ts";
import {
	createInProcessChildRuntimeProvider,
	type ChildPrepareSpec,
	type ChildRuntimeBudget,
} from "../../../src/runtime/agents/child-runtime.ts";

const MODEL: Model<Api> = {
	id: "child-fixture-model",
	name: "Child Fixture Model",
	api: "mock",
	provider: "child-fixture-provider",
	baseUrl: "http://child-fixture.invalid",
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

const EMPTY_PARAMETERS = Type.Object({}, { additionalProperties: false });

function executionEnv(): ExecutionEnv {
	return {
		cwd: "/workspace",
		fs: {
			readFile: async () => Buffer.from(""),
			writeFile: async () => undefined,
			stat: async () => ({ size: 0, mtimeMs: 0, isFile: true, isDirectory: false }),
			readdir: async () => [],
			mkdir: async () => undefined,
			rm: async () => undefined,
			rename: async () => undefined,
		},
		shell: { exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }) },
	};
}

function allowingPolicy(): ToolAuthorizationPolicy {
	return { authorize: () => ({ decision: "allow" }) };
}

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

function emitMessage(
	stream: AssistantMessageEventStream,
	message: AssistantMessage,
): void {
	stream.push({ type: "start", partial: { ...message, content: [] } });
	if (message.content.length > 0) {
		for (const [contentIndex, content] of message.content.entries()) {
			if (content.type === "text") {
				stream.push({ type: "text_delta", contentIndex, delta: content.text });
			}
			if (content.type === "toolCall") {
				stream.push({ type: "toolcall_end", contentIndex, toolCall: content, partial: message });
			}
		}
	}
	stream.push({ type: "done", reason: message.stopReason, message });
	stream.end(message);
}

function textStream(text: string, calls: { count: number }): StreamFn {
	return (_model, _context) => {
		calls.count += 1;
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => emitMessage(stream, assistant([{ type: "text", text }], "stop")));
		return stream;
	};
}

function toolStream(toolName: string, calls: { count: number }): StreamFn {
	return (_model, context) => {
		calls.count += 1;
		const stream = createAssistantMessageEventStream();
		const hasToolResult = context.messages.some((message) => message.role === "toolResult");
		const message = hasToolResult
			? assistant([{ type: "text", text: "complete" }], "stop")
			: assistant([{
				type: "toolCall",
				id: `tool-call-${calls.count}`,
				name: toolName,
				arguments: {},
			}], "toolUse");
		queueMicrotask(() => emitMessage(stream, message));
		return stream;
	};
}

function waitingForAbortStream(calls: { count: number }): StreamFn {
	return (_model, _context, options) => {
		calls.count += 1;
		const stream = createAssistantMessageEventStream();
		const signal = options?.signal;
		if (signal?.aborted) {
			queueMicrotask(() => stream.end(assistant([], "aborted")));
		} else {
			signal?.addEventListener("abort", () => {
				const message = assistant([], "aborted");
				stream.push({ type: "start", partial: { ...message, content: [] } });
				stream.push({ type: "error", reason: "aborted", error: message });
				stream.end(message);
			}, { once: true });
		}
		return stream;
	};
}

function modelRuntimeFactory(streamFn: StreamFn): ChildModelRuntimeFactoryPort {
	return {
		prepare: async ({ tools }) => ({
			ok: true,
			value: {
				model: MODEL,
				tools: Object.freeze([...tools]),
				descriptor: {
					providerId: MODEL.provider,
					modelId: MODEL.id,
					profileId: `${MODEL.provider}/${MODEL.id}`,
					api: MODEL.api,
					thinkingLevel: "off",
					systemPromptDigest: runtimeDigest("child system"),
					toolManifestDigest: runtimeDigest(tools.map((tool) => tool.name)),
				},
				streamFn,
			},
		}),
	};
}

function tool(name: string, execute: AgentTool["execute"]): AgentTool {
	return {
		name,
		label: name,
		description: `${name} fixture`,
		parameters: EMPTY_PARAMETERS,
		execute,
	};
}

function budget(overrides: Partial<ChildRuntimeBudget> = {}): ChildRuntimeBudget {
	return {
		maxModelTurns: 4,
		maxToolCalls: 4,
		maxActiveDurationMs: 10_000,
		maxReportBytes: 1_024,
		...overrides,
	};
}

function prepareSpec(
	agentId: AgentId,
	streamFn: StreamFn,
	tools: readonly AgentTool[] = [],
	options: Partial<Pick<ChildPrepareSpec, "signal" | "activeDurationMs">> = {},
): ChildPrepareSpec {
	return {
		agentId,
		objective: "inspect the bounded workspace",
		systemPrompt: "child system",
		tools,
		modelRuntimeFactory: modelRuntimeFactory(streamFn),
		budget: budget(),
		cwd: "/workspace",
		executionEnv: executionEnv(),
		authorizationPolicy: allowingPolicy(),
		...options,
	};
}

describe("in-process governed child runtime", () => {
	it("does not call the model or tools during prepare and starts only after activate", async () => {
		const modelCalls = { count: 0 };
		const toolCalls = { count: 0 };
		const childTool = tool("read", async () => {
			toolCalls.count += 1;
			return { content: [{ type: "text", text: "read" }], details: {} };
		});
		const provider = createInProcessChildRuntimeProvider();
		const prepared = await provider.prepare(prepareSpec(
			createRuntimeId("agent", "prepare-barrier"),
			toolStream("read", modelCalls),
			[childTool],
		));
		expect(prepared).toMatchObject({ ok: true });
		expect(modelCalls.count).toBe(0);
		expect(toolCalls.count).toBe(0);
		if (!prepared.ok) return;

		const active = await prepared.value.activate();
		expect(active).toMatchObject({ ok: true });
		if (!active.ok) return;
		await expect(active.value.completion).resolves.toMatchObject({ ok: true });
		expect(modelCalls.count).toBe(2);
		expect(toolCalls.count).toBe(1);
	});

	it("stops with budget_exhausted when the model-turn ceiling is reached", async () => {
		const modelCalls = { count: 0 };
		const provider = createInProcessChildRuntimeProvider();
		const prepared = await provider.prepare({
			...prepareSpec(createRuntimeId("agent", "model-budget"), toolStream("missing", modelCalls)),
			budget: budget({ maxModelTurns: 1 }),
		});
		expect(prepared.ok).toBe(true);
		if (!prepared.ok) return;
		const active = await prepared.value.activate();
		expect(active.ok).toBe(true);
		if (!active.ok) return;
		const completion = await active.value.completion;
		expect(completion).toMatchObject({ ok: true, value: { report: { outcome: "stopped", reasonCode: "budget_exhausted" } } });
		if (completion.ok) expect(completion.value.report.usage.modelTurns).toBe(1);
		expect(modelCalls.count).toBe(1);
	});

	it("stops after the exact child tool-call ceiling", async () => {
		const modelCalls = { count: 0 };
		const toolCalls = { count: 0 };
		const childTool = tool("read", async () => {
			toolCalls.count += 1;
			return { content: [{ type: "text", text: "read" }], details: {} };
		});
		const provider = createInProcessChildRuntimeProvider();
		const prepared = await provider.prepare({
			...prepareSpec(createRuntimeId("agent", "tool-budget"), toolStream("read", modelCalls), [childTool]),
			budget: budget({ maxToolCalls: 1 }),
		});
		expect(prepared.ok).toBe(true);
		if (!prepared.ok) return;
		const active = await prepared.value.activate();
		expect(active.ok).toBe(true);
		if (!active.ok) return;
		const completion = await active.value.completion;
		expect(completion).toMatchObject({ ok: true, value: { report: { outcome: "stopped", reasonCode: "budget_exhausted" } } });
		if (completion.ok) expect(completion.value.report.usage.toolCalls).toBe(1);
		expect(toolCalls.count).toBe(1);
	});

	it("uses the child active-duration authority before making a model request", async () => {
		const modelCalls = { count: 0 };
		const provider = createInProcessChildRuntimeProvider();
		const prepared = await provider.prepare({
			...prepareSpec(
				createRuntimeId("agent", "duration-budget"),
				textStream("never requested", modelCalls),
				[],
				{ activeDurationMs: () => 11 },
			),
			budget: budget({ maxActiveDurationMs: 10 }),
		});
		expect(prepared.ok).toBe(true);
		if (!prepared.ok) return;
		const active = await prepared.value.activate();
		expect(active.ok).toBe(true);
		if (!active.ok) return;
		const completion = await active.value.completion;
		expect(completion).toMatchObject({ ok: true, value: { report: { outcome: "stopped", reasonCode: "budget_exhausted" } } });
		if (completion.ok) expect(completion.value.report.usage.modelTurns).toBe(0);
		expect(modelCalls.count).toBe(0);
	});

	it("rejects abort before activation without invoking the model", async () => {
		const controller = new AbortController();
		controller.abort();
		const modelCalls = { count: 0 };
		const provider = createInProcessChildRuntimeProvider();
		const prepared = await provider.prepare(prepareSpec(
			createRuntimeId("agent", "abort-before-activation"),
			textStream("never requested", modelCalls),
			[],
			{ signal: controller.signal },
		));
		expect(prepared.ok).toBe(true);
		if (!prepared.ok) return;
		const active = await prepared.value.activate();
		expect(active).toMatchObject({ ok: false, error: { code: "runtime_unavailable" } });
		expect(modelCalls.count).toBe(0);
	});

	it("stops when aborted during a model request", async () => {
		const controller = new AbortController();
		const modelCalls = { count: 0 };
		const provider = createInProcessChildRuntimeProvider();
		const prepared = await provider.prepare(prepareSpec(
			createRuntimeId("agent", "abort-during-model"),
			waitingForAbortStream(modelCalls),
			[],
			{ signal: controller.signal },
		));
		expect(prepared.ok).toBe(true);
		if (!prepared.ok) return;
		const active = await prepared.value.activate();
		expect(active.ok).toBe(true);
		if (!active.ok) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		controller.abort();
		const completion = await active.value.completion;
		expect(completion).toMatchObject({ ok: true, value: { report: { outcome: "stopped", reasonCode: "cancelled" } } });
		expect(modelCalls.count).toBe(1);
	});

	it("stops when aborted while a child tool is running", async () => {
		const controller = new AbortController();
		const modelCalls = { count: 0 };
		const toolCalls = { count: 0 };
		const childTool = tool("wait", async (_id, _args, signal) => {
			toolCalls.count += 1;
			await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
			return { content: [{ type: "text", text: "cancelled" }], details: {} };
		});
		const provider = createInProcessChildRuntimeProvider();
		const prepared = await provider.prepare(prepareSpec(
			createRuntimeId("agent", "abort-during-tool"),
			toolStream("wait", modelCalls),
			[childTool],
			{ signal: controller.signal },
		));
		expect(prepared.ok).toBe(true);
		if (!prepared.ok) return;
		const active = await prepared.value.activate();
		expect(active.ok).toBe(true);
		if (!active.ok) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		controller.abort();
		const completion = await active.value.completion;
		expect(completion).toMatchObject({ ok: true, value: { report: { outcome: "stopped", reasonCode: "cancelled" } } });
		expect(toolCalls.count).toBe(1);
	});

	it("reuses the supplied Session authorization policy before executing a child tool", async () => {
		let toolCalls = 0;
		const childTool = tool("read", async () => {
			toolCalls += 1;
			return { content: [{ type: "text", text: "must not execute" }], details: {} };
		});
		const provider = createInProcessChildRuntimeProvider();
		const prepared = await provider.prepare({
			...prepareSpec(createRuntimeId("agent", "authorization-policy"), toolStream("read", { count: 0 }), [childTool]),
			authorizationPolicy: { authorize: () => ({ decision: "deny", reason: "fixture authorization denied" }) },
		});
		expect(prepared.ok).toBe(true);
		if (!prepared.ok) return;
		const active = await prepared.value.activate();
		expect(active.ok).toBe(true);
		if (!active.ok) return;
		const completion = await active.value.completion;
		expect(completion).toMatchObject({ ok: true, value: { report: { outcome: "completed" } } });
		expect(toolCalls).toBe(0);
	});

	it("reports a certain activation rejection separately from an uncertain activation throw", async () => {
		const certainController = new AbortController();
		certainController.abort();
		const provider = createInProcessChildRuntimeProvider();
		const certainPrepared = await provider.prepare(prepareSpec(
			createRuntimeId("agent", "certain-activation"),
			textStream("unused", { count: 0 }),
			[],
			{ signal: certainController.signal },
		));
		expect(certainPrepared.ok).toBe(true);
		if (!certainPrepared.ok) return;
		expect(await certainPrepared.value.activate()).toMatchObject({ ok: false, error: { code: "runtime_unavailable" } });

		const uncertainProvider = createInProcessChildRuntimeProvider({
			start: () => {
				throw new Error("activation acknowledgement lost");
			},
		});
		const uncertainPrepared = await uncertainProvider.prepare(prepareSpec(
			createRuntimeId("agent", "uncertain-activation"),
			textStream("unused", { count: 0 }),
		));
		expect(uncertainPrepared.ok).toBe(true);
		if (!uncertainPrepared.ok) return;
		expect(await uncertainPrepared.value.activate()).toMatchObject({ ok: false, error: { code: "recovery_required" } });
	});

	it("derives usage from loop events and validates the final report by UTF-8 bytes", async () => {
		const modelCalls = { count: 0 };
		const report = "报告🙂";
		const provider = createInProcessChildRuntimeProvider();
		const prepared = await provider.prepare({
			...prepareSpec(createRuntimeId("agent", "usage-and-report"), textStream(report, modelCalls)),
			budget: budget({ maxReportBytes: new TextEncoder().encode(report).byteLength }),
		});
		expect(prepared.ok).toBe(true);
		if (!prepared.ok) return;
		const active = await prepared.value.activate();
		expect(active.ok).toBe(true);
		if (!active.ok) return;
		const completion = await active.value.completion;
		expect(completion).toMatchObject({ ok: true, value: { report: { outcome: "completed", report, reportBytes: 10 } } });
		if (completion.ok) {
			expect(completion.value.report.reportDigest).toEqual(runtimeDigest(report));
			expect(completion.value.report.usage).toMatchObject({ modelTurns: 1, toolCalls: 0 });
		}
		expect(modelCalls.count).toBe(1);
	});

	it("fails with report_limit_exceeded instead of truncating an oversized report", async () => {
		const report = "你好";
		const provider = createInProcessChildRuntimeProvider();
		const prepared = await provider.prepare({
			...prepareSpec(createRuntimeId("agent", "report-overflow"), textStream(report, { count: 0 })),
			budget: budget({ maxReportBytes: 5 }),
		});
		expect(prepared.ok).toBe(true);
		if (!prepared.ok) return;
		const active = await prepared.value.activate();
		expect(active.ok).toBe(true);
		if (!active.ok) return;
		const completion = await active.value.completion;
		expect(completion).toMatchObject({
			ok: true,
			value: { report: { outcome: "failed", reasonCode: "report_limit_exceeded", report: "", reportBytes: 0 } },
		});
	});

	it("makes dispose idempotent and prevents activation after prepared disposal", async () => {
		const provider = createInProcessChildRuntimeProvider();
		const prepared = await provider.prepare(prepareSpec(
			createRuntimeId("agent", "dispose-prepared"),
			textStream("unused", { count: 0 }),
		));
		expect(prepared.ok).toBe(true);
		if (!prepared.ok) return;
		expect(await prepared.value.dispose()).toEqual({ ok: true, value: undefined });
		expect(await prepared.value.dispose()).toEqual({ ok: true, value: undefined });
		expect(await prepared.value.activate()).toMatchObject({ ok: false, error: { code: "runtime_unavailable" } });
	});

	it("disposes an active child through the same cancellation path and remains idempotent", async () => {
		const provider = createInProcessChildRuntimeProvider();
		const prepared = await provider.prepare(prepareSpec(
			createRuntimeId("agent", "dispose-active"),
			waitingForAbortStream({ count: 0 }),
		));
		expect(prepared.ok).toBe(true);
		if (!prepared.ok) return;
		const active = await prepared.value.activate();
		expect(active.ok).toBe(true);
		if (!active.ok) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(await prepared.value.dispose()).toEqual({ ok: true, value: undefined });
		expect(await prepared.value.dispose()).toEqual({ ok: true, value: undefined });
		await expect(active.value.completion).resolves.toMatchObject({ ok: true, value: { report: { outcome: "stopped", reasonCode: "cancelled" } } });
	});
});
