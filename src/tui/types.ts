/**
 * TUI 层共享类型与 AgentEvent → TuiEvent 适配层。
 *
 * 对照 development-doc/tui/01-architecture.md §3 与 02-component-spec.md §0。
 *
 * 设计:
 *   - TuiEvent 把 AgentEvent 改名为主控 `handleEvent` 内 switch 用得顺手的标签;
 *   - adaptAgentEvent 是纯函数,无副作用,可单测;
 *   - BaseComponentProps 是所有 11 个业务组件共享的 props 契约;
 *   - FooterSnapshotProvider 由 InteractiveMode 实现,Footer 每帧 pull 一次不可变快照。
 */

import type { AgentEvent, AgentMessage, AgentRunTerminationReason, RuntimeAssistantMessageEvent, ToolResultContent } from "../runtime/types.ts";
import type { FooterSnapshot } from "./footer/field-registry.ts";

/** TUI 主控 switch 标签;对照 03-event-binding.md §1 表。 */
export type TuiEvent =
  | { type: "agent_start"; timestamp: number; runId?: string }
  | { type: "agent_end"; timestamp: number; runId?: string; stopReason?: string; elapsedMs?: number; activeDurationMs?: number; messageCountAtEnd?: number; terminationReason?: AgentRunTerminationReason }
  | { type: "agent_work_pause" | "agent_work_resume"; timestamp: number; runId: string; waitId: string; reason: "approval" | "credential"; activeDurationMs: number }
  | {
      type: "turn_start" | "turn_end";
      timestamp: number;
      turn: number;
      stopReason?: string;
      runId?: string;
    }
  | {
      type: "message_start" | "message_end";
      timestamp: number;
      role: "user" | "assistant";
      stopReason?: string;
      message?: AgentMessage;
      runId?: string;
    }
  | { type: "message_update"; timestamp: number; assistantMessageEvent: RuntimeAssistantMessageEvent; runId?: string }
  | {
      type: "tool_execution_start";
      timestamp: number;
      toolCallId: string;
      toolName: string;
      args: unknown;
      runId?: string;
    }
  | {
      type: "tool_execution_end";
      timestamp: number;
      toolCallId: string;
      toolName: string;
      isError: boolean;
      result: ToolResultContent;
      runId?: string;
    }
  | {
      type: "tool_execution_update";
      timestamp: number;
      toolCallId: string;
      toolName: string;
      partialResult: unknown;
      runId?: string;
    }
  | {
      type: "queue_update";
      timestamp: number;
      steering: AgentMessage[];
      followUp: AgentMessage[];
      runId?: string;
    };

/**
 * 把 AgentEvent 改名流式转换为 TuiEvent。
 *
 * 改名映射保持 1:1,只做 type 字段重命名以便主控 switch 与 02 spec 表对齐;
 * stopReason 从 StopReason 联合(string 子集)放宽为 string 以避免本层ssen 类型守卫。
 */
export function adaptAgentEvent(ev: AgentEvent): TuiEvent {
  switch (ev.type) {
    case "agent_start":
      return { type: ev.type, timestamp: ev.timestamp, runId: ev.runId };
    case "agent_end":
      return { type: ev.type, timestamp: ev.timestamp, runId: ev.runId, stopReason: ev.stopReason, elapsedMs: ev.elapsedMs, activeDurationMs: ev.activeDurationMs, messageCountAtEnd: ev.messageCountAtEnd, terminationReason: ev.terminationReason };
    case "agent_work_pause":
    case "agent_work_resume":
      return { ...ev };
    case "turn_start":
    case "turn_end":
      return {
        type: ev.type,
        timestamp: ev.timestamp,
        turn: ev.turn,
        stopReason: ev.stopReason,
        runId: ev.runId,
      };
    case "message_start":
    case "message_end":
      return {
        type: ev.type,
        timestamp: ev.timestamp,
        role: ev.role,
        stopReason: ev.stopReason,
        message: ev.message,
        runId: ev.runId,
      };
    case "message_update":
      return {
        type: "message_update",
        timestamp: ev.timestamp,
        assistantMessageEvent: ev.assistantMessageEvent,
        runId: ev.runId,
      };
    case "tool_execution_start":
      return {
        type: "tool_execution_start",
        timestamp: ev.timestamp,
        toolCallId: ev.toolCallId,
        toolName: ev.toolName,
        args: ev.args,
        runId: ev.runId,
      };
    case "tool_execution_end":
      return {
        type: "tool_execution_end",
        timestamp: ev.timestamp,
        toolCallId: ev.toolCallId,
        toolName: ev.toolName,
        isError: ev.isError,
        result: ev.result,
        runId: ev.runId,
      };
    case "tool_execution_update":
      return {
        type: "tool_execution_update",
        timestamp: ev.timestamp,
        toolCallId: ev.toolCallId,
        toolName: ev.toolName,
        partialResult: ev.partialResult,
        runId: ev.runId,
      };
    case "queue_update":
      return {
        type: "queue_update",
        timestamp: ev.timestamp,
        steering: ev.steering,
        followUp: ev.followUp,
        runId: ev.runId,
      };
  }
}

/**
 * 所有 11 个业务组件共享的 props 契约。
 * theme 是依赖注入入口(对照 01-architecture.md §7 可独立测试性)。
 */
export interface BaseComponentProps<TTheme = unknown> {
  /** 主题对象,由 InteractiveMode 在装配时注入;不通过全局单例访问。 */
  theme: TTheme;
}

/**
 * Footer 周期性 pull 状态的 provider 契约;
 * InteractiveMode 实现此接口,Footer 在 render 时一次取得完整快照。
 *
 * 设计:Footer 不订阅事件,只取快照;这样 Footer 与事件流解耦,便于单测。
 */
export interface FooterSnapshotProvider {
  /** 一帧只读取一次，避免各字段跨 revision 读取不一致。 */
  getFooterSnapshot(): FooterSnapshot;
}
