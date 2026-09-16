import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { runAgentLoop } from "../../src/runtime/agent-loop.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, ModelContextAssemblyInput, StreamFn } from "../../src/runtime/types.ts";
import type { AssistantMessage, Model } from "../../src/types.ts";
import { createAssistantMessageEventStream } from "../../src/utils/event-stream.ts";

const model: Model<"mock"> = { id: "incomplete", name: "incomplete", provider: "fixture", api: "mock", baseUrl: "http://localhost", reasoning: false, input: ["text"], contextWindow: 10_000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
function assistant(stopReason: "length" | "toolUse" | "stop", id?: string): AssistantMessage {
	return { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: 0, stopReason,
		content: id === undefined ? [{ type: "text", text: "partial-output" }] : [{ type: "toolCall", id, name: "count", arguments: {} }],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function streamSequence(responses: readonly AssistantMessage[]) {
	let calls = 0;
	const stream: StreamFn = () => {
		const output = createAssistantMessageEventStream();
		const message = responses[Math.min(calls, responses.length - 1)]!; calls += 1;
		queueMicrotask(() => {
			if (message.stopReason === "error" || message.stopReason === "aborted") throw new Error("invalid fixture");
			output.push({ type: "done", reason: message.stopReason, message }); output.end(message);
		});
		return output;
	};
	return { stream, calls: () => calls };
}
const prompt = [{ role: "user" as const, origin: "user" as const, content: [{ type: "text" as const, text: "continue work" }] }];
describe("bounded incomplete output recovery", () => {
	it("runs after turn settlement and never replays executed or incomplete tool calls", async () => {
		let executions = 0; let admissions = 0;
		const context: AgentContext = { messages: [], tools: [{ name: "count", label: "count", description: "fixture", parameters: Type.Object({}), execute: async () => { executions += 1; return { content: [{ type: "text", text: "counted" }], details: {} }; } }] };
		const wire = streamSequence([assistant("toolUse", "executed"), assistant("length", "incomplete"), assistant("stop")]);
		const events: AgentEvent[] = []; const recoveries: ModelContextAssemblyInput[] = [];
		const messages = await runAgentLoop(prompt, context, { model, beforeToolCall: async () => { admissions += 1; }, modelIncompleteOutputRecovery: async (input) => {
			expect(events.at(-1)?.type).toBe("turn_end"); recoveries.push(input); return true;
		} }, async (event) => { events.push(event); }, undefined, wire.stream);
		expect(executions).toBe(1); expect(admissions).toBe(1); expect(wire.calls()).toBe(3); expect(recoveries).toHaveLength(1);
		expect(recoveries[0]!.context.messages.filter((message) => message.role === "toolResult")).toMatchObject([{ toolCallId: "executed", isError: false }, { toolCallId: "incomplete", isError: true }]);
		expect(messages.filter((message) => message.role === "toolResult")).toHaveLength(2);
		expect(events.at(-1)).toMatchObject({ type: "agent_end", stopReason: "stop" });
	});
	it("limits recovery attempts to two per run even if every partial output claims progress", async () => {
		const wire = streamSequence([assistant("length")]); let recoveries = 0;
		const events: AgentEvent[] = [];
		await runAgentLoop(prompt, { messages: [], tools: [] }, { model, modelIncompleteOutputRecovery: async () => { recoveries += 1; return true; } }, async (event) => { events.push(event); }, undefined, wire.stream);
		expect(recoveries).toBe(2); expect(wire.calls()).toBe(3); expect(events.at(-1)).toMatchObject({ type: "agent_end", stopReason: "length" });
	});
	it.each(["declined", "failed", "stopped"])("ends normally when recovery is %s", async (mode) => {
		const wire = streamSequence([assistant("length")]); let recoveries = 0;
		const config: AgentLoopConfig = { model, modelIncompleteOutputRecovery: async () => { recoveries += 1; if (mode === "failed") throw new Error("fixture"); return false; }, ...(mode === "stopped" ? { shouldStopAfterTurn: () => true } : {}) };
		await runAgentLoop(prompt, { messages: [], tools: [] }, config, async () => undefined, undefined, wire.stream);
		expect(wire.calls()).toBe(1); expect(recoveries).toBe(mode === "stopped" ? 0 : 1);
	});
	it("honors cancellation before entering recovery", async () => {
		const wire = streamSequence([assistant("length")]); const abort = new AbortController(); let recoveries = 0;
		await runAgentLoop(prompt, { messages: [], tools: [] }, { model, modelIncompleteOutputRecovery: async () => { recoveries += 1; return true; } }, async (event) => { if (event.type === "turn_end") abort.abort(); }, abort.signal, wire.stream);
		expect(recoveries).toBe(0); expect(wire.calls()).toBe(1);
	});
});
