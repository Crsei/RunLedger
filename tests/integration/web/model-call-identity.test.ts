import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { runtimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import { describe, expect, it } from "vitest";
import { createModels } from "../../../src/models.ts";
import { SessionModelCalls, observeSessionModels } from "../../../src/runtime/session-runtime/model-call-observer.ts";
import { webFixture } from "./fixture.ts";
import { UsageProjection } from "../../../src/web/usage-projection.ts";
import { runAgentLoop } from "../../../src/runtime/agent-loop.ts";
import { mockModel } from "../../../src/runtime/providers/mock-stream.ts";
import { createAssistantMessageEventStream } from "../../../src/utils/event-stream.ts";
import type { AgentEvent, StreamFn } from "../../../src/runtime/types.ts";
import type { AssistantMessage } from "../../../src/types.ts";

const usage: AssistantMessage["usage"] = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
describe("actual dispatch model-call identity", () => {
  it("records start/finish with one identity and binds the final message to it", async () => {
    const events: AgentEvent[] = [];
    const streamFn: StreamFn = () => {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: "assistant", content: [{ type: "text", text: "done" }], api: mockModel.api, provider: mockModel.provider, model: mockModel.id, timestamp: Date.now(), stopReason: "stop", usage };
      queueMicrotask(() => { stream.push({ type: "done", reason: "stop", message }); stream.end(message); });
      return stream;
    };
    await runAgentLoop([], { messages: [], tools: [] }, { model: mockModel }, async (event) => { events.push(event); }, undefined, streamFn);
    const calls = events.filter((event) => event.type === "model_call");
    expect(calls.map((event) => event.phase)).toEqual(["started", "finished"]);
    expect(calls[0].callId).toBe(calls[1].callId);
    expect(calls[1].usage).toEqual(usage);
    expect(events.find((event) => event.type === "message_end" && event.role === "assistant")).toMatchObject({ modelCallId: calls[0].callId });
  });
  it("closes the dispatch identity when the provider throws and never invents zero usage", async () => {
    const events: AgentEvent[] = [];
    await expect(runAgentLoop([], { messages: [], tools: [] }, { model: mockModel }, async (event) => { events.push(event); }, undefined, () => { throw new Error("provider failed"); })).rejects.toThrow("provider failed");
    const calls = events.filter((event) => event.type === "model_call");
    expect(calls.map((event) => event.phase)).toEqual(["started", "finished"]);
    expect(calls[1].usage).toBeUndefined();
  });
  it("counts overflow retries as distinct dispatches and excludes pre-dispatch cancellation", async () => {
    const events: AgentEvent[] = []; let dispatches = 0;
    const streamFn: StreamFn = () => {
      const stream = createAssistantMessageEventStream(), first = dispatches++ === 0;
      const message: AssistantMessage = { role: "assistant", content: [], api: mockModel.api, provider: mockModel.provider, model: mockModel.id, timestamp: Date.now(), stopReason: first ? "error" : "stop", ...(first ? { errorMessage: "input exceeds the context window" } : {}), usage };
      queueMicrotask(() => { if (first) stream.push({ type: "error", reason: "error", error: message }); else stream.push({ type: "done", reason: "stop", message }); stream.end(message); });
      return stream;
    };
    const digest = runtimeDigest({ fixture: true });
    await runAgentLoop([], { messages: [], tools: [] }, { model: mockModel, modelContextOverflowRecovery: async ({ context }) => ({ context, receipt: {
      requestId: createRuntimeId("command", "retry"), modelProfileId: "fixture", fragmentIds: [], omittedFragments: [], estimatedInputTokens: 0, reservedOutputTokens: 0, contextDigest: digest, diagnostics: [], sourceHead: { streamId: createRuntimeId("event", "source"), sequence: 0, eventHash: digest }, projectionDigest: digest, assembledAt: new Date().toISOString(),
    } }) }, async (event) => { events.push(event); }, undefined, streamFn);
    const calls = events.filter((event): event is Extract<AgentEvent, { type: "model_call" }> => event.type === "model_call" && event.phase === "finished");
    expect(dispatches).toBe(2); expect(new Set(calls.map((call) => call.callId)).size).toBe(2);
    const projection = new UsageProjection();
    for (const call of calls) projection.event(call.originSessionId, call.callId, call);
    expect(projection.snapshot("p", 0, Date.now() + 1, true).uniqueCalls).toBe(2);
    const signal = new AbortController(), cancelled = new UsageProjection(); dispatches = 0;
    await runAgentLoop([], { messages: [], tools: [] }, { model: mockModel }, async (event) => {
      if (event.type === "model_call") {
        cancelled.event(event.originSessionId, event.callId, event);
        if (event.phase === "started") signal.abort();
      }
    }, signal.signal, streamFn);
    expect(dispatches).toBe(0); expect(cancelled.snapshot("p", 0, Date.now() + 1, true).uniqueCalls).toBe(0);
  });
  it("records auxiliary complete calls through the session facade without consuming stream events", async () => {
    const fixture = webFixture(), session = fixture.create("model-observer"), models = createModels();
    const produce = () => {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: "assistant", content: [{ type: "text", text: "title" }], api: mockModel.api, provider: mockModel.provider, model: mockModel.id, timestamp: Date.now(), stopReason: "stop", usage };
      queueMicrotask(() => { stream.push({ type: "done", reason: "stop", message }); stream.end(message); });
      return stream;
    };
    models.setProvider({ id: mockModel.provider, name: "fixture", auth: { apiKey: { name: "fixture", login: async () => ({ type: "api_key", key: "fixture" }), resolve: async () => ({ auth: { apiKey: "fixture" }, source: "fixture" }) } }, getModels: () => [mockModel], stream: produce, streamSimple: produce });
    const observed = observeSessionModels(models, new SessionModelCalls(fixture.store, session.fence));
    try {
      const stream = observed.streamSimple(mockModel, { messages: [] }, { metadata: { modelCallId: "trace-call" } });
      const events = []; for await (const event of stream) events.push(event.type);
      expect(events).toContain("done");
      expect((await stream.result()).content).toEqual([{ type: "text", text: "title" }]);
      await observed.completeSimple(mockModel, { messages: [] });
      const receipts = fixture.store.replaySessionEvents(session.sessionId).filter((event) => event.eventType === "model.call");
      expect(receipts).toHaveLength(4);
      const projection = new UsageProjection();
      for (const event of receipts) projection.event(session.sessionId, event.eventId, JSON.parse(event.payloadJson));
      expect(projection.snapshot("project", 0, Date.now() + 1, true).uniqueCalls).toBe(2);
    } finally { fixture.close(); }
  });

});
