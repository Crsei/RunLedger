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

import type { AgentEvent, AgentMessage, AgentRunTerminationReason, RuntimeAssistantMessageEvent, ToolResultContent } from "../runtime/types.ts";

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
    }
  | {
      type: "message_start" | "message_end";
      timestamp: number;
      role: "user" | "assistant";
      stopReason?: string;
      message?: AgentMessage;
    }
  | { type: "message_update"; timestamp: number; assistantMessageEvent: RuntimeAssistantMessageEvent }
  | {
      type: "tool_execution_start";
      timestamp: number;
      toolCallId: string;
      toolName: string;
      args: unknown;
    }
  | {
      type: "tool_execution_end";
      timestamp: number;
      toolCallId: string;
      toolName: string;
      isError: boolean;
      result: ToolResultContent;
    }
  | {
      type: "tool_execution_update";
      timestamp: number;
      toolCallId: string;
      toolName: string;
      partialResult: unknown;
    }
  | {
      type: "queue_update";
      timestamp: number;
      steering: AgentMessage[];
      followUp: AgentMessage[];
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
      };
    case "message_start":
    case "message_end":
      return {
        type: ev.type,
        timestamp: ev.timestamp,
        role: ev.role,
        stopReason: ev.stopReason,
        message: ev.message,
      };
    case "message_update":
      return {
        type: "message_update",
        timestamp: ev.timestamp,
        assistantMessageEvent: ev.assistantMessageEvent,
      };
    case "tool_execution_start":
      return {
        type: "tool_execution_start",
        timestamp: ev.timestamp,
        toolCallId: ev.toolCallId,
        toolName: ev.toolName,
        args: ev.args,
      };
    case "tool_execution_end":
      return {
        type: "tool_execution_end",
        timestamp: ev.timestamp,
        toolCallId: ev.toolCallId,
        toolName: ev.toolName,
        isError: ev.isError,
        result: ev.result,
      };
    case "tool_execution_update":
      return {
        type: "tool_execution_update",
        timestamp: ev.timestamp,
        toolCallId: ev.toolCallId,
        toolName: ev.toolName,
        partialResult: ev.partialResult,
      };
    case "queue_update":
      return {
        type: "queue_update",
        timestamp: ev.timestamp,
        steering: ev.steering,
        followUp: ev.followUp,
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
  getProviderId?(): string;
  getThinkingLevel?(): import("../types.ts").ModelThinkingLevel;
  /** 当前 canonical session id；身份寻址使用，status line 不直接展示。 */
  getSessionId(): string;
  /**
   * P6：workspace/path 能力标签（如 "ws:linux-verified"）；来自真实 runner
   * 证据矩阵，不宣称 OS sandbox。未注入时不显示该段。
   */
  getWorkspaceCapability?(): string | undefined;
  /** agent 运行时绝对地址：sanitize + 有界但保留绝对路径（用户显式要求展示）；仅本机 footer。 */
  getWorkspaceDisplayAbsolutePath?(): string | undefined;
  getGitBranchLabel?(): string | undefined;
  /** 已知 task/plan 完成数；缺失时不显示 progress。 */
  getPlanProgress?(): { readonly completed: number; readonly total: number } | undefined;
  /** context window 的安全 token 快照；每个字段独立 capability-gated。 */
  getContextUsage?(): { readonly totalTokens?: number; readonly contextWindow?: number } | undefined;
  /** 可选会话标题/线程展示标签；未提供时不以 session id 伪造。 */
  getThreadLabel?(): string | undefined;
  /** 当前 run 的安全计时投影；等待态的 activeDurationMs 已冻结。 */
  getRunTiming?(): { readonly state: "working" | "waiting" | "recovery_required"; readonly activeDurationMs: number; readonly lastResumedAtMs?: number } | undefined;
  /** 测试时钟接缝；生产缺省 Date.now。 */
  now?(): number;
}
