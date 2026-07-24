/** TUI 展示层只消费这些不可变视图，不直接依赖 runtime/storage。 */

export type TuiSessionFormat = "v1" | "v2" | "v3" | "demo" | "unknown";

export type TuiSessionLifecycle =
  | "active"
  | "read-only"
  | "stopped"
  | "recovery-required"
  | "unknown";

export interface TuiBootstrapSnapshot {
  workspace: string;
  session: {
    id: string;
    format: TuiSessionFormat;
    lifecycle: TuiSessionLifecycle;
    title?: string;
  };
}

export interface ContextHeaderView {
  workspace: string;
  sessionId: string;
  sessionTitle?: string;
  format: TuiSessionFormat;
  lifecycle: TuiSessionLifecycle;
}

export interface ActiveStateView {
  query: "idle" | "dispatching" | "running";
  activeTurn?: number;
  steeringCount: number;
  followUpCount: number;
  frozen: boolean;
  recoveryRequired: boolean;
}

export interface ToolResultView {
  content: readonly {
    type: "text" | "image";
    text?: string;
  }[];
  details?: unknown;
  isError?: boolean;
}

export interface CommandSuggestionView {
  canonicalName: string;
  label: string;
  description: string;
  disabledReason?: string;
}

export interface CommandTimelineView {
  invocationId: string;
  canonicalName: string;
  args: readonly string[];
  state: "pending" | "running" | "succeeded" | "failed" | "cancelled" | "aborted";
  summary?: string;
}
