import type { TaskPriority, TaskStatus } from "../../runtime/tasks/types.ts";
import type { TuiPortRequest, TuiResultEnvelope } from "../application/common.ts";
import type { SafeBoundedText } from "../presentation/tools/types.ts";

export interface TaskView {
	readonly taskId: string;
	readonly content: SafeBoundedText;
	readonly priority: TaskPriority;
	readonly status: TaskStatus;
	readonly revision: number;
}

export interface GoalView {
	readonly goalId: string;
	readonly label: SafeBoundedText;
	readonly lifecycle: "active" | "paused" | "blocked" | "completed" | "failed" | "unknown";
	readonly repositoryRevision: number;
	readonly digestPrefix: SafeBoundedText;
}

export interface TaskGoalSnapshot {
	readonly repositoryId: string;
	readonly repositoryRevision: number;
	readonly tasks: readonly TaskView[];
	readonly goals: readonly GoalView[];
}

export type TaskGoalResult = TuiResultEnvelope<TaskGoalSnapshot>;

export type TaskGoalWorkflowState =
	| { readonly state: "unavailable"; readonly reason: string }
	| { readonly state: "idle"; readonly generation: number }
	| { readonly state: "loading"; readonly generation: number; readonly requestId: string }
	| { readonly state: "ready"; readonly generation: number; readonly value: TaskGoalSnapshot }
	| { readonly state: "empty"; readonly generation: number }
	| { readonly state: "error"; readonly generation: number; readonly code: string; readonly message: string; readonly retryable: boolean };

export interface TaskGoalQueryPort {
	readonly inspect: (input: TuiPortRequest) => Promise<TaskGoalResult>;
}
