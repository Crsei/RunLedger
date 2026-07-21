/**
 * TUI 层共享类型与 AgentEvent → TuiEvent 适配层。
 *
 * 对照 development-doc/tui/01-architecture.md §3 与 02-component-spec.md §0。
 *
 * 设计:
 *   - TuiEvent 把 AgentEvent 改名为主控 `handleEvent` 内 switch 用得顺手的标签;
 *   - adaptAgentEvent 是纯函数,无副作用,可单测;
 *   - BaseComponentProps 是所有 11 个业务组件共享的 props 契约;
 *   - FooterSnapshotProvider 由 InteractiveMode 实现,Footer 周期性 pull 状态。
 */

import type { AgentEvent } from "../runtime/types.ts";
import type { AssistantMessageEvent } from "../types.ts";

/** TUI 主控 switch 标签;对照 03-event-binding.md §1 表。 */
export type TuiEvent =
  | { type: "agent_start" | "agent_end"; timestamp: number }
  | {
      type: "turn_start" | "turn_end";
      timestamp: number;
      turn: number;
      stopReason?: string;
    }
  | {
      type: "message_start" | "message_end";
      timestamp: number;
      role: "user" | "assistant";
      stopReason?: string;
    }
  | { type: "message_update"; timestamp: number; assistantMessageEvent: AssistantMessageEvent }
  | {
      type: "tool_execution_start" | "tool_execution_end";
      timestamp: number;
      toolCallId: string;
      toolName: string;
      isError?: boolean;
    }
  | {
      type: "tool_execution_update";
      timestamp: number;
      toolCallId: string;
      toolName: string;
      partialResult: unknown;
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
    case "agent_end":
      return { type: ev.type, timestamp: ev.timestamp };
    case "turn_start":
    case "turn_end":
      return {
        type: ev.type,
        timestamp: ev.timestamp,
        turn: ev.turn,
        stopReason: ev.stopReason,
      };
    case "message_start":
    case "message_end":
      return {
        type: ev.type,
        timestamp: ev.timestamp,
        role: ev.role,
        stopReason: ev.stopReason,
      };
    case "message_update":
      return {
        type: "message_update",
        timestamp: ev.timestamp,
        assistantMessageEvent: ev.assistantMessageEvent,
      };
    case "tool_execution_start":
    case "tool_execution_end":
      return {
        type: ev.type,
        timestamp: ev.timestamp,
        toolCallId: ev.toolCallId,
        toolName: ev.toolName,
        isError: ev.isError,
      };
    case "tool_execution_update":
      return {
        type: "tool_execution_update",
        timestamp: ev.timestamp,
        toolCallId: ev.toolCallId,
        toolName: ev.toolName,
        partialResult: ev.partialResult,
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
 * InteractiveMode 实现此接口,Footer 在 render 时调用 getSnapshot 取最新状态。
 *
 * 设计:Footer 不订阅事件,只取快照;这样 Footer 与事件流解耦,便于单测。
 */
export interface FooterSnapshotProvider {
  /** 当前活跃 turn 是否在流式中;Footer 据此显示 spinner 占位。 */
  isStreaming(): boolean;
  /** 当前活跃 turn 的 stopReason (流式中返回 undefined)。 */
  getStopReason(): string | undefined;
  /** 当前模型 id(显示在 footer 右侧)。 */
  getModelId(): string;
  /** 当前 session id(显示在 footer 中间)。 */
  getSessionId(): string;
}
