import type { AgentMessage, AgentToolResult } from "../../runtime/types.ts";
import type { AssistantMessage } from "../../types.ts";
import type { TuiEvent } from "../types.ts";
import type {
  TimelineEvent,
  TimelineProjectionCursor,
  TimelineTerminalStatus,
} from "./types.ts";

export function createTimelineProjectionCursor(): TimelineProjectionCursor {
  return { nextMessageIndex: 0, activeMessageByRole: {} };
}

export function projectReplay(messages: readonly AgentMessage[]): readonly TimelineEvent[] {
  const events: TimelineEvent[] = [];
  let messageIndex = 0;
  for (const message of messages) {
    const timestamp = message.role === "assistant" ? message.timestamp ?? messageIndex : messageIndex;
    if (message.role === "user") {
      events.push({
        type: "message.end",
        id: `message:${messageIndex++}`,
        timestamp,
        role: "user",
        text: userText(message),
        status: "succeeded",
      });
      continue;
    }
    if (message.role === "assistant") {
      events.push({
        type: "message.end",
        id: `message:${messageIndex++}`,
        timestamp,
        role: "assistant",
        text: assistantText(message),
        status: assistantStatus(message.stopReason),
      });
      for (const content of message.content) {
        if (content.type !== "toolCall") continue;
        events.push({
          type: "tool.start",
          id: content.id,
          timestamp,
          toolName: content.name,
          args: content.arguments,
        });
      }
      continue;
    }
    for (const result of message.content) {
      events.push({
        type: "tool.end",
        id: result.toolCallId,
        timestamp,
        toolName: result.toolName,
        output: contentText(result.content),
        status: result.isError ? "failed" : "succeeded",
      });
    }
  }
  return events;
}

export function projectLive(
  cursor: TimelineProjectionCursor,
  event: TuiEvent,
): { cursor: TimelineProjectionCursor; events: readonly TimelineEvent[] } {
  const next: TimelineProjectionCursor = {
    nextMessageIndex: cursor.nextMessageIndex,
    activeMessageByRole: { ...cursor.activeMessageByRole },
  };
  switch (event.type) {
    case "message_start": {
      const id = `message:${next.nextMessageIndex++}`;
      next.activeMessageByRole[event.role] = id;
      return {
        cursor: next,
        events: [{
          type: "message.start",
          id,
          timestamp: event.timestamp,
          role: event.role,
          text: event.message?.role === "user" ? userText(event.message) : "",
        }],
      };
    }
    case "message_update": {
      const id = next.activeMessageByRole.assistant;
      const partial = "partial" in event.assistantMessageEvent
        ? event.assistantMessageEvent.partial
        : undefined;
      if (!id || !partial || partial.role !== "assistant") return { cursor: next, events: [] };
      return {
        cursor: next,
        events: [{
          type: "message.update",
          id,
          timestamp: event.timestamp,
          text: assistantText(partial),
        }],
      };
    }
    case "message_end": {
      const id = next.activeMessageByRole[event.role] ?? `message:${next.nextMessageIndex++}`;
      delete next.activeMessageByRole[event.role];
      return {
        cursor: next,
        events: [{
          type: "message.end",
          id,
          timestamp: event.timestamp,
          role: event.role,
          ...(event.message
            ? {
                text: event.message.role === "user"
                  ? userText(event.message)
                  : event.message.role === "assistant"
                    ? assistantText(event.message)
                    : "",
              }
            : {}),
          status: event.stopReason === "aborted" ? "aborted" : event.stopReason === "error" ? "failed" : "succeeded",
        }],
      };
    }
    case "tool_execution_start":
      return {
        cursor: next,
        events: [{
          type: "tool.start",
          id: event.toolCallId,
          timestamp: event.timestamp,
          toolName: event.toolName,
          args: event.args,
        }],
      };
    case "tool_execution_update":
      return {
        cursor: next,
        events: [{
          type: "tool.update",
          id: event.toolCallId,
          timestamp: event.timestamp,
          output: resultText(event.partialResult as AgentToolResult),
        }],
      };
    case "tool_execution_end":
      return {
        cursor: next,
        events: [{
          type: "tool.end",
          id: event.toolCallId,
          timestamp: event.timestamp,
          toolName: event.toolName,
          output: contentText(event.result.content),
          status: event.isError ? "failed" : "succeeded",
        }],
      };
    default:
      return { cursor: next, events: [] };
  }
}

function assistantStatus(stopReason: string): TimelineTerminalStatus {
  if (stopReason === "aborted") return "aborted";
  if (stopReason === "error") return "failed";
  return "succeeded";
}

function userText(message: Extract<AgentMessage, { role: "user" }>): string {
  return message.content.map((content) => content.text).join("");
}

function assistantText(message: AssistantMessage | Extract<AgentMessage, { role: "assistant" }>): string {
  return message.content
    .filter((content): content is Extract<typeof content, { type: "text" }> => content.type === "text")
    .map((content) => content.text)
    .join("");
}

function resultText(result: AgentToolResult): string {
  return contentText(result.content);
}

function contentText(content: readonly { type: string; text?: string }[]): string {
  return content.filter((item) => item.type === "text").map((item) => item.text ?? "").join("");
}
