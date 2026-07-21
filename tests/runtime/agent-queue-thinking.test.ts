import { describe, expect, it } from "vitest";
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
