import type { CorrelatedRequestRef } from "./common.ts";

export type TuiEffect =
	| ({ readonly type: "provider.list" } & CorrelatedRequestRef)
	| ({ readonly type: "auth.inspect" } & CorrelatedRequestRef)
	| ({ readonly type: "model.list"; readonly providerId: string } & CorrelatedRequestRef)
	| ({ readonly type: "thinking.inspect" } & CorrelatedRequestRef)
	| ({ readonly type: "prompt.list" } & CorrelatedRequestRef)
	| ({ readonly type: "keymap.inspect" } & CorrelatedRequestRef)
	| ({ readonly type: "queue.inspect" } & CorrelatedRequestRef)
	| ({ readonly type: "queue.cancel"; readonly itemId: string; readonly expectedQueueRevision: number; readonly reason: string } & CorrelatedRequestRef)
	| ({ readonly type: "approval.inspect" } & CorrelatedRequestRef)
	| ({ readonly type: "approval.resolve"; readonly approvalId: string; readonly expectedDecisionRevision: number; readonly decision: "allowed" | "denied" | "cancelled" } & CorrelatedRequestRef)
	| ({ readonly type: "task-goal.inspect" } & CorrelatedRequestRef)
	| ({ readonly type: "plan.inspect"; readonly planId: string; readonly expectedRevision: number } & CorrelatedRequestRef)
	| ({ readonly type: "agent.inspect" } & CorrelatedRequestRef)
	| ({ readonly type: "extension.inspect" } & CorrelatedRequestRef)
	| ({ readonly type: "runtime-snapshot.inspect" } & CorrelatedRequestRef)
	| ({ readonly type: "security-mode.inspect" } & CorrelatedRequestRef)
	| ({ readonly type: "shutdown.request"; readonly trigger: "user" | "host" | "signal" | "unknown" } & CorrelatedRequestRef)
	| ({ readonly type: "workspace-git.inspect"; readonly workspaceId: string } & CorrelatedRequestRef)
	| ({ readonly type: "process.list" } & CorrelatedRequestRef)
	| ({ readonly type: "process.output"; readonly executionId: string; readonly cursor: string } & CorrelatedRequestRef)
	| ({ readonly type: "update.inspect" } & CorrelatedRequestRef);
