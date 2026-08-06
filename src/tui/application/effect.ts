import type { CorrelatedRequestRef, TuiField } from "./common.ts";
import type { AuthKind } from "../auth/types.ts";
import type { ModelThinkingLevel } from "../../types.ts";
import type { SafeBoundedText } from "../presentation/tools/types.ts";

export type TuiEffect =
	| ({ readonly type: "provider.list" } & CorrelatedRequestRef)
	| ({ readonly type: "auth.inspect" } & CorrelatedRequestRef)
	| ({ readonly type: "auth.login"; readonly providerId: string; readonly authKind: AuthKind } & CorrelatedRequestRef)
	| ({ readonly type: "auth.logout"; readonly providerId: string } & CorrelatedRequestRef)
	| ({ readonly type: "model.list"; readonly providerId: string } & CorrelatedRequestRef)
	| ({ readonly type: "model.select"; readonly providerId: string; readonly modelId: string } & CorrelatedRequestRef)
	| ({ readonly type: "thinking.inspect" } & CorrelatedRequestRef)
	| ({ readonly type: "thinking.select"; readonly level: ModelThinkingLevel } & CorrelatedRequestRef)
	| ({ readonly type: "prompt.list" } & CorrelatedRequestRef)
	| ({ readonly type: "prompt.submit"; readonly templateId: string; readonly text: SafeBoundedText } & CorrelatedRequestRef)
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
	| ({ readonly type: "security-mode.set"; readonly target: "guarded" | "unrestricted"; readonly expectedRevision: TuiField<number> } & CorrelatedRequestRef)
	| ({ readonly type: "shutdown.request"; readonly trigger: "user" | "host" | "signal" | "unknown" } & CorrelatedRequestRef)
	| ({ readonly type: "workspace-git.inspect"; readonly workspaceId: string } & CorrelatedRequestRef)
	| ({ readonly type: "process.list" } & CorrelatedRequestRef)
	| ({ readonly type: "process.output"; readonly executionId: string; readonly cursor: string } & CorrelatedRequestRef)
	| ({ readonly type: "update.inspect" } & CorrelatedRequestRef);
