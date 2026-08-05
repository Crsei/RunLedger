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
	| (TimelineRowBase & { readonly kind: "assistant"; readonly text: SafeBoundedText; readonly streaming: boolean })
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
	  });

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
}

export type TimelineEvent =
	| { readonly type: "message_start"; readonly generation: number; readonly correlationId: string; readonly row: TimelineRow }
	| { readonly type: "message_update"; readonly generation: number; readonly correlationId: string; readonly text: SafeBoundedText }
	| { readonly type: "message_end"; readonly generation: number; readonly correlationId: string; readonly status: TimelineStatus }
	| { readonly type: "tool_start"; readonly generation: number; readonly correlationId: string; readonly row: TimelineRow }
	| { readonly type: "tool_update"; readonly generation: number; readonly correlationId: string; readonly presentation: TuiField<SafeToolPresentation> }
	| { readonly type: "tool_end"; readonly generation: number; readonly correlationId: string; readonly status: TimelineStatus }
	| { readonly type: "usage"; readonly generation: number; readonly correlationId: string; readonly usage: Pick<SafeToolUsageView, "input" | "output"> }
	| { readonly type: "notice"; readonly generation: number; readonly correlationId: string; readonly severity: "info" | "warning" | "error"; readonly message: SafeBoundedText }
	| { readonly type: "goal_lifecycle"; readonly generation: number; readonly correlationId: string; readonly goalId: string; readonly status: "pending" | "running" | "succeeded" | "failed" | "cancelled" }
	| { readonly type: "agent_lifecycle"; readonly generation: number; readonly correlationId: string; readonly agentId: string; readonly status: "pending" | "running" | "succeeded" | "failed" | "cancelled" }
	| { readonly type: "cleanup"; readonly generation: number; readonly correlationId: string; readonly reason: "session-switch" | "abort" | "destroy" };
