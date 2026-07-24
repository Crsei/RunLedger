export type TimelineTerminalStatus = "succeeded" | "failed" | "cancelled" | "aborted";
export type TimelineStatus = "pending" | "running" | TimelineTerminalStatus;

export interface TimelineRowBase {
  id: string;
  timestamp: number;
  status: TimelineStatus;
}

export type TimelineRow =
  | (TimelineRowBase & {
      kind: "user" | "assistant";
      text: string;
    })
  | (TimelineRowBase & {
      kind: "tool";
      toolCallId: string;
      toolName: string;
      args?: unknown;
      output: string;
      truncated: boolean;
      orphanDeadline?: number;
    })
  | (TimelineRowBase & {
      kind: "notice";
      level: "note" | "error";
      text: string;
    });

export interface TimelineState {
  committedRows: readonly TimelineRow[];
  activeRowsByCorrelationId: Readonly<Record<string, TimelineRow>>;
  activeOrder: readonly string[];
}

export type TimelineEvent =
  | {
      type: "message.start";
      id: string;
      timestamp: number;
      role: "user" | "assistant";
      text: string;
    }
  | {
      type: "message.update";
      id: string;
      timestamp: number;
      text: string;
    }
  | {
      type: "message.end";
      id: string;
      timestamp: number;
      role: "user" | "assistant";
      text?: string;
      status: TimelineTerminalStatus;
    }
  | {
      type: "tool.start";
      id: string;
      timestamp: number;
      toolName: string;
      args?: unknown;
    }
  | {
      type: "tool.update";
      id: string;
      timestamp: number;
      output: string;
    }
  | {
      type: "tool.end";
      id: string;
      timestamp: number;
      toolName: string;
      output: string;
      status: TimelineTerminalStatus;
    }
  | {
      type: "notice";
      id: string;
      timestamp: number;
      level: "note" | "error";
      text: string;
    }
  | { type: "cleanup"; timestamp: number };

export interface TimelineProjectionCursor {
  nextMessageIndex: number;
  activeMessageByRole: Partial<Record<"user" | "assistant", string>>;
}
