import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { Agent } from "../../src/runtime/agent.ts";
import {
  AllowAllToolAuthorizationPolicy,
  DenyAllToolAuthorizationPolicy,
  authorizationBeforeToolCall,
} from "../../src/runtime/tool-authorization.ts";
import type {
  AgentEvent,
  AgentTool,
  AgentToolResult,
  LlmContext,
  StreamFn,
  ToolAuthorizationPolicy,
} from "../../src/runtime/types.ts";
import type { Api, AssistantMessage, Model, ToolCall } from "../../src/types.ts";
import { createAssistantMessageEventStream } from "../../src/utils/event-stream.ts";

const MODEL: Model<Api> = {
  id: "tool-model",
  name: "Tool Model",
  api: "mock",
  provider: "tool-provider",
  baseUrl: "http://localhost",
  reasoning: false,
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

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: MODEL.api,
    provider: MODEL.provider,
    model: MODEL.id,
    usage: { ...ZERO_USAGE },
    stopReason,
    timestamp: Date.now(),
  };
}

function oneToolThenStopStream(toolCall: ToolCall): StreamFn {
  return (_model, context: LlmContext) => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const hasResult = context.messages.some((message) => message.role === "toolResult");
      const message = hasResult
        ? assistant([{ type: "text", text: "done" }], "stop")
        : assistant([toolCall], "toolUse");
      stream.push({ type: "start", partial: { ...message, content: [] } });
      if (!hasResult) {
        stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
      }
      stream.push({ type: "done", reason: message.stopReason, message });
      stream.end(message);
    });
    return stream;
  };
}

const parameters = Type.Object({ value: Type.String() });

describe("tool event payload and authorization", () => {
  it("defaults can fail closed while AllowAll remains an explicit fixture", () => {
    const request = {} as Parameters<DenyAllToolAuthorizationPolicy["authorize"]>[0];
    expect(new DenyAllToolAuthorizationPolicy().authorize(request)).toEqual({
      decision: "deny",
      reason: "tool execution is unavailable until an authorization policy is explicitly composed",
    });
    expect(new AllowAllToolAuthorizationPolicy().authorize(request)).toEqual({ decision: "allow" });
  });

  it("start/update/end 保留参数、串行 partial 和完整结果", async () => {
    const call: ToolCall = {
      type: "toolCall",
      id: "call-1",
      name: "fixture",
      arguments: { value: "hello" },
    };
    const tool: AgentTool<typeof parameters, { marker: string }> = {
      name: "fixture",
      label: "fixture",
      description: "fixture tool",
      parameters,
      async execute(_id, args, _signal, onUpdate): Promise<AgentToolResult<{ marker: string }>> {
        onUpdate?.({ content: [{ type: "text", text: "one" }], details: { marker: "u1" } });
        onUpdate?.({ content: [{ type: "text", text: "two" }], details: { marker: "u2" } });
        return {
          content: [{ type: "text", text: `final:${args.value}` }],
          details: { marker: "final" },
        };
      },
    };
    const agent = new Agent({
      initialState: { systemPrompt: "test", model: MODEL, tools: [tool] },
      streamFn: oneToolThenStopStream(call),
    });
    const events: AgentEvent[] = [];
    agent.subscribe(async (event) => {
      if (event.type === "tool_execution_update" && event.partialResult.details !== undefined) {
        const marker = (event.partialResult.details as { marker: string }).marker;
        if (marker === "u1") await new Promise((resolve) => setTimeout(resolve, 5));
      }
      events.push(event);
    });

    await agent.prompt("run tool");

    const start = events.find((event) => event.type === "tool_execution_start");
    expect(start).toMatchObject({ toolCallId: "call-1", toolName: "fixture", args: { value: "hello" } });
    const updates = events.filter((event) => event.type === "tool_execution_update");
    expect(updates.map((event) => event.type === "tool_execution_update"
      ? (event.partialResult.details as { marker: string }).marker
      : "")).toEqual(["u1", "u2"]);
    const end = events.find((event) => event.type === "tool_execution_end");
    expect(end).toMatchObject({
      toolCallId: "call-1",
      toolName: "fixture",
      isError: false,
      result: {
        content: [{ type: "text", text: "final:hello" }],
        details: { marker: "final" },
      },
    });
  });

  it("deny policy 不执行工具，并生成可审计 error result", async () => {
    let executed = false;
    const call: ToolCall = {
      type: "toolCall",
      id: "call-denied",
      name: "fixture",
      arguments: { value: "blocked" },
    };
    const tool: AgentTool<typeof parameters> = {
      name: "fixture",
      label: "fixture",
      description: "fixture tool",
      parameters,
      execute(): AgentToolResult {
        executed = true;
        return { content: [{ type: "text", text: "should not run" }], details: {} };
      },
    };
    const policy: ToolAuthorizationPolicy = {
      authorize: () => ({ decision: "deny", reason: "policy denied fixture" }),
    };
    const agent = new Agent({
      initialState: { systemPrompt: "test", model: MODEL, tools: [tool] },
      streamFn: oneToolThenStopStream(call),
      loopConfig: { beforeToolCall: authorizationBeforeToolCall(policy) },
    });
    const ends: Extract<AgentEvent, { type: "tool_execution_end" }>[] = [];
    agent.on("tool_execution_end", (event) => {
      ends.push(event);
    });

    await agent.prompt("run denied tool");

    expect(executed).toBe(false);
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ isError: true });
    expect(ends[0]!.result.content[0]).toMatchObject({ text: "policy denied fixture" });
  });

  it("按 schema -> PreToolUse rewrite -> revalidate -> authorization -> execute 排序", async () => {
    const observed: string[] = [];
    const call: ToolCall = {
      type: "toolCall",
      id: "call-rewrite",
      name: "fixture",
      arguments: { value: "original" },
    };
    const tool: AgentTool<typeof parameters> = {
      name: "fixture",
      label: "fixture",
      description: "fixture tool",
      parameters,
      async execute(_id, args) {
        observed.push(`execute:${args.value}`);
        return { content: [{ type: "text", text: args.value }], details: {} };
      },
    };
    const agent = new Agent({
      initialState: { systemPrompt: "test", model: MODEL, tools: [tool] },
      streamFn: oneToolThenStopStream(call),
      loopConfig: {
        beforeToolCall: ({ args }) => {
          observed.push(`hook:${(args as { value: string }).value}`);
          return { updatedInput: { value: "rewritten" } };
        },
        authorizeToolCall: ({ args }) => {
          observed.push(`authorize:${(args as { value: string }).value}`);
        },
      },
    });

    const messages = await agent.prompt("rewrite");
    expect(observed).toEqual(["hook:original", "authorize:rewritten", "execute:rewritten"]);
    const result = messages.find((message) => message.role === "toolResult");
    expect(result?.content[0]?.content).toEqual([{ type: "text", text: "rewritten" }]);
  });
});
