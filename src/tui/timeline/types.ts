import type { TuiField } from "../application/common.ts";
import type {
	SafeBoundedText,
	SafeToolPresentation,
	SafeToolUsageView,
} from "../presentation/tools/types.ts";

export type TimelineStatus =
	| "pending"
	| "running"
	| "succeeded"
	| "failed"
	| "cancelled"
	| "aborted";

export interface TimelineRowBase {
	readonly id: string;
	readonly timestamp: string;
	readonly displayOrder: number;
	readonly status: TimelineStatus;
	readonly generation?: number;
	readonly correlationId?: string;
}

export type TimelineRow =
	| (TimelineRowBase & { readonly kind: "user"; readonly text: SafeBoundedText })
	| (TimelineRowBase & {
			readonly kind: "assistant";
			readonly text: SafeBoundedText;
			readonly streaming: boolean;
			readonly thinking?: SafeBoundedText;
			readonly usage?: Pick<SafeToolUsageView, "input" | "output">;
	  })
	| (TimelineRowBase & {
			readonly kind: "tool";
			readonly toolCallId: string;
			readonly toolName: SafeBoundedText;
			readonly presentation: TuiField<SafeToolPresentation>;
	  })
	| (TimelineRowBase & {
			readonly kind: "notice";
			readonly severity: "info" | "warning" | "error";
			readonly message: SafeBoundedText;
	  })
	| (TimelineRowBase & {
			readonly kind: "goal";
			readonly goalId: string;
			readonly label: SafeBoundedText;
			readonly phase: SafeBoundedText;
	  })
	| (TimelineRowBase & {
			readonly kind: "queue";
			readonly queueId: string;
			readonly state: "pending" | "claimed" | "cancelled" | "unknown";
			readonly label: SafeBoundedText;
	  })
	| (TimelineRowBase & {
			readonly kind: "agent";
			readonly agentId: string;
			readonly label: SafeBoundedText;
			readonly phase: SafeBoundedText;
		  })
	| (TimelineRowBase & {
			readonly kind: "run-boundary";
			readonly runId: string;
			readonly stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
			readonly activeDurationMs?: number;
			readonly elapsedMs?: number;
			readonly messageCountAtEnd?: number;
		  });

export interface ActiveRunState {
	readonly runId: string;
	readonly state: "working" | "waiting" | "recovery_required";
	readonly startedAtMs: number;
	readonly activeDurationMs: number;
	readonly lastResumedAtMs?: number;
	readonly waitId?: string;
	readonly waitReason?: "approval" | "credential";
}

export interface TimelineProjectionCursor {
	readonly messageIndex: number;
	readonly activeMessageId?: string;
	readonly toolStepCorrelationId?: string;
	readonly authorityRevision?: number;
}

export interface TimelineState {
	readonly generation: number;
	readonly committedRows: readonly TimelineRow[];
	readonly activeRowsByCorrelationId: Readonly<Record<string, TimelineRow>>;
	readonly activeOrder: readonly string[];
	readonly cursor: TimelineProjectionCursor;
	readonly activeRun?: ActiveRunState;
}

export type TimelineEvent =
	| { readonly type: "message_start"; readonly generation: number; readonly correlationId: string; readonly row: TimelineRow }
	| { readonly type: "message_update"; readonly generation: number; readonly correlationId: string; readonly text: SafeBoundedText; readonly thinking?: SafeBoundedText }
	| { readonly type: "message_end"; readonly generation: number; readonly correlationId: string; readonly status: TimelineStatus }
	| { readonly type: "tool_start"; readonly generation: number; readonly correlationId: string; readonly row: TimelineRow }
	| { readonly type: "tool_update"; readonly generation: number; readonly correlationId: string; readonly presentation: TuiField<SafeToolPresentation> }
	| { readonly type: "tool_end"; readonly generation: number; readonly correlationId: string; readonly status: TimelineStatus }
	| { readonly type: "usage"; readonly generation: number; readonly correlationId: string; readonly usage: Pick<SafeToolUsageView, "input" | "output"> }
	| { readonly type: "notice"; readonly generation: number; readonly correlationId: string; readonly severity: "info" | "warning" | "error"; readonly message: SafeBoundedText }
	| { readonly type: "goal_lifecycle"; readonly generation: number; readonly correlationId: string; readonly goalId: string; readonly status: "pending" | "running" | "succeeded" | "failed" | "cancelled" }
	| { readonly type: "agent_lifecycle"; readonly generation: number; readonly correlationId: string; readonly agentId: string; readonly status: "pending" | "running" | "succeeded" | "failed" | "cancelled" }
	| { readonly type: "run_start"; readonly generation: number; readonly runId: string; readonly timestamp: number; readonly activeDurationMs: number }
	| { readonly type: "run_pause"; readonly generation: number; readonly runId: string; readonly waitId: string; readonly reason: "approval" | "credential"; readonly timestamp: number; readonly activeDurationMs: number }
	| { readonly type: "run_resume"; readonly generation: number; readonly runId: string; readonly waitId: string; readonly timestamp: number; readonly activeDurationMs: number }
	| { readonly type: "run_end"; readonly generation: number; readonly runId: string; readonly timestamp: number; readonly stopReason: "stop" | "length" | "toolUse" | "error" | "aborted"; readonly elapsedMs?: number; readonly activeDurationMs?: number; readonly messageCountAtEnd?: number }
	| { readonly type: "run_restore"; readonly generation: number; readonly runId: string; readonly timestamp: number; readonly status: "completed" | "active" | "recovery_required"; readonly stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted"; readonly elapsedMs?: number; readonly activeDurationMs?: number; readonly messageCountAtEnd?: number }
	| { readonly type: "cleanup"; readonly generation: number; readonly correlationId?: string; readonly reason: "session-switch" | "abort" | "destroy" };
