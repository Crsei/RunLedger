import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeTraceRecorder } from "../../src/runtime/trace/recorder.ts";
import { JsonlTraceEventStore } from "../../src/runtime/trace/event-store.ts";
import { describe, expect, it, vi } from "vitest";
import { assembleAgentModelContext } from "../../src/runtime/context/model-request-adapter.ts";
import { Agent } from "../../src/runtime/agent.ts";
import type { LlmContext, StreamFn } from "../../src/runtime/types.ts";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Message,
  Model,
  SimpleStreamOptions,
} from "../../src/types.ts";
import { createAssistantMessageEventStream } from "../../src/utils/event-stream.ts";

const MODEL: Model<Api> = {
  id: "queue-model",
  name: "Queue Model",
  api: "mock",
  provider: "queue-provider",
  baseUrl: "http://localhost",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 1024,
};

const ZERO_USAGE: AssistantMessage["usage"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function finalMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: MODEL.api,
    provider: MODEL.provider,
    model: MODEL.id,
    usage: { ...ZERO_USAGE },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function pushStop(stream: AssistantMessageEventStream, text: string): void {
  const message = finalMessage(text);
  stream.push({ type: "start", partial: { ...message, content: [] } });
  stream.push({ type: "done", reason: "stop", message });
  stream.end(message);
}

function userTexts(messages: readonly Message[]): string[] {
  return messages.flatMap((message) => {
    if (message.role !== "user" || typeof message.content === "string") return [];
    return [message.content.filter((part) => part.type === "text").map((part) => part.text).join("")];
  });
}

function controlledStream(): {
  streamFn: StreamFn;
  calls: string[][];
  options: (SimpleStreamOptions | undefined)[];
  started: Promise<void>;
  release(): void;
} {
  const calls: string[][] = [];
  const options: (SimpleStreamOptions | undefined)[] = [];
  let releaseFirst: (() => void) | undefined;
  let markStarted: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const streamFn: StreamFn = (_model, context: LlmContext, streamOptions) => {
    const call = calls.length;
    calls.push(userTexts(context.messages));
    options.push(streamOptions);
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      void (async () => {
        if (call === 0) {
          markStarted?.();
          await firstGate;
        }
        pushStop(stream, `reply-${call + 1}`);
      })();
    });
    return stream;
  };
  return {
    streamFn,
    calls,
    options,
    started,
    release: () => releaseFirst?.(),
  };
}

describe("Agent queue and thinking runtime", () => {
  it("严格单飞，并按 steering 优先、one-at-a-time、follow-up 的顺序继续 turn", async () => {
    const controlled = controlledStream();
    const agent = new Agent({
      initialState: { systemPrompt: "test", model: MODEL, thinkingLevel: "high" },
      streamFn: controlled.streamFn,
      steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
    });

    const active = agent.prompt("initial");
    await controlled.started;
    await expect(agent.prompt("second active prompt")).rejects.toThrow("already processing");
    agent.followUp("follow-1");
    agent.steer("steer-1");
    agent.steer("steer-2");
    expect(agent.getSteeringMessages()).toHaveLength(2);
    expect(agent.getFollowUpMessages()).toHaveLength(1);

    controlled.release();
    await active;
    await agent.waitForIdle();

    expect(controlled.calls).toEqual([
      ["initial"],
      ["initial", "steer-1"],
      ["initial", "steer-1", "steer-2"],
      ["initial", "steer-1", "steer-2", "follow-1"],
    ]);
    expect(controlled.options.every((options) => options?.reasoning === "high")).toBe(true);
    expect(agent.getSteeringMessages()).toEqual([]);
    expect(agent.getFollowUpMessages()).toEqual([]);
    expect(agent.inFlight).toBe(false);
  });

  it("all mode 在一次后续请求中注入全部 steering，off 不发送 reasoning", async () => {
    const controlled = controlledStream();
    const agent = new Agent({
      initialState: { systemPrompt: "test", model: MODEL, thinkingLevel: "off" },
      streamFn: controlled.streamFn,
      steeringMode: "all",
    });

    const active = agent.prompt("initial");
    await controlled.started;
    agent.steer("steer-a");
    agent.steer("steer-b");
    controlled.release();
    await active;

    expect(controlled.calls).toEqual([
      ["initial"],
      ["initial", "steer-a", "steer-b"],
    ]);
    expect(controlled.options.every((options) => options?.reasoning === undefined)).toBe(true);
  });
});

describe("Plan 14 queue cancellation boundaries", () => {
  it.each(["before-drain", "during-drain", "turn-end"] as const)("does not lose accepted steering at %s", async (boundary) => {
    const calls: string[][] = [];
    let cancelled = false;
    const agent = new Agent({
      initialState: { systemPrompt: "fixture", model: MODEL },
      streamFn: (_model, context) => {
        calls.push(userTexts(context.messages));
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => pushStop(stream, "done"));
        return stream;
      },
    });
    if (boundary !== "turn-end") agent.steer("accepted correction");
    const endings: string[] = [];
    agent.subscribe((event) => {
      if (!cancelled && agent.inFlight && (
        (boundary === "before-drain" && event.type === "agent_start")
        || (boundary === "during-drain" && event.type === "queue_update" && event.steering.length === 0)
        || (boundary === "turn-end" && event.type === "turn_end")
      )) {
        cancelled = true;
        if (boundary === "turn-end") agent.steer("accepted correction");
        agent.interrupt();
      }
      if (event.type === "agent_end") endings.push(event.stopReason ?? "missing");
    });
    await agent.prompt("initial");
    expect(cancelled).toBe(true);
    expect(endings).toEqual(["aborted"]);
    const history = agent.state.messages.filter((message) => message.role === "user" && JSON.stringify(message.content).includes("accepted correction"));
    expect(history.length + agent.getSteeringMessages().length).toBe(1);
    expect(calls.length).toBe(boundary === "turn-end" ? 1 : 0);
    await agent.prompt("continue");
    expect(calls.at(-1)?.filter((text) => text === "accepted correction")).toHaveLength(1);
  });

  it("retains committed inputs after context assembly fails and continues without duplicate delivery", async () => {
    let fail = true;
    const calls: string[][] = [];
    const agent = new Agent({
      initialState: { systemPrompt: "fixture", model: MODEL },
      streamFn: (_model, context) => {
        calls.push(userTexts(context.messages));
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => pushStop(stream, "done"));
        return stream;
      },
      loopConfig: { modelContextAssembler: (input) => {
        if (fail) throw new Error("required context exceeds budget");
        return assembleAgentModelContext(input);
      } },
    });
    const events: string[] = [];
    agent.subscribe((event) => { events.push(event.type); });
    agent.steer("preserve correction");
    await expect(agent.prompt("original task")).rejects.toThrow("required context exceeds budget");
    expect(events.filter((type) => type === "turn_start")).toHaveLength(1);
    expect(events.filter((type) => type === "turn_end")).toHaveLength(1);
    expect(events.filter((type) => type === "agent_end")).toHaveLength(1);
    expect(agent.state.messages.filter((message) => message.role === "user")).toHaveLength(2);
    expect(agent.getSteeringMessages()).toHaveLength(0);
    expect(calls).toHaveLength(0);
    fail = false;
    await agent.prompt("continue");
    expect(calls).toEqual([["original task", "preserve correction", "continue"]]);
  });

  it("does not dispatch a provider request when cancelled during conversion", async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    let requests = 0;
    const events: string[] = [];
    const agent = new Agent({
      initialState: { systemPrompt: "fixture", model: MODEL },
      convertToLlm: async () => { entered(); await gate; return []; },
      streamFn: () => {
        requests++;
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => pushStop(stream, "must not dispatch"));
        return stream;
      },
    });
    agent.subscribe((event) => { events.push(event.type); });
    const running = agent.prompt("initial");
    await ready;
    agent.interrupt();
    release();
    await running;
    expect(requests).toBe(0);
    expect(events.filter((type) => type === "turn_start")).toHaveLength(1);
    expect(events.filter((type) => type === "turn_end")).toHaveLength(1);
    expect(events.filter((type) => type === "agent_end")).toHaveLength(1);
  });
  it("does not dispatch when cancellation occurs while opening a model trace", async () => {
    const home = await mkdtemp(join(tmpdir(), "runledger-trace-cancel-"));
    const recorder = new RuntimeTraceRecorder({ eventStore: new JsonlTraceEventStore({ filePath: join(home, "events.jsonl"), traceId: "trace-cancel" }), traceId: "trace-cancel", redactionPolicyDigest: "fixture", mode: "events", failurePolicy: "best_effort" });
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const start = recorder.startModel.bind(recorder);
    const spy = vi.spyOn(recorder, "startModel").mockImplementation(async (input) => { const handle = await start(input); entered(); await gate; return handle; });
    let requests = 0;
    const agent = new Agent({ initialState: { systemPrompt: "fixture", model: MODEL }, loopConfig: { traceRecorder: recorder }, streamFn: () => {
      requests++;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => pushStop(stream, "should not dispatch"));
      return stream;
    } });
    try {
      const running = agent.prompt("initial");
      await ready;
      agent.interrupt(); release();
      await running;
      expect(requests).toBe(0);
    } finally { spy.mockRestore(); await rm(home, { recursive: true, force: true }); }
  });

});
