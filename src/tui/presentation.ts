import type { SafeBoundedText } from "./presentation/tools/types.ts";

export type PlanStepStatus = "pending" | "in-progress" | "completed";

export interface PlanStepView {
	/** 已经经过 safe projector bounds 的步骤文本。 */
	readonly text: SafeBoundedText;
	readonly status: PlanStepStatus;
}

export type PlanUpdateBlock = {
	id?: string;
	kind: "plan-update";
	explanation?: SafeBoundedText;
	steps: readonly PlanStepView[];
};

export type PresentationBlock =
  | { id?: string; kind: "text"; content: string }
  | { id?: string; kind: "markdown"; content: string; streaming: boolean }
  | { id?: string; kind: "command"; command: string }
  | {
    id?: string;
    kind: "exec";
    command: string;
    status: "pending" | "running" | "succeeded" | "failed" | "cancelled" | "aborted";
    output: readonly { readonly channel: "stdout" | "stderr"; readonly text: string }[];
    exitCode?: number;
    durationMs?: number;
    background?: boolean;
    continuationPrefix?: string;
    continuationMaxLines?: number;
    outputPrefix?: string;
    outputMaxLines?: number;
    transcriptForm?: "dollar";
  }
  | {
    id?: string;
    kind: "diff";
    document: import("./presentation/tools/types.ts").SafeDiffDocument;
  }
  | PlanUpdateBlock
  | {
    id?: string;
    kind: "status-line";
    segments: readonly import("./highlight/status-style.ts").StatusLineSegment[];
  }
  | { id?: string; kind: "separator"; label: string; content?: string }
  | {
    id?: string;
    kind: "select";
    title: string;
    query?: string;
    options: readonly { value: string; label: string; description?: string }[];
    selectedIndex: number;
  }
  | {
    id?: string;
    kind: "input";
    title: string;
    message: string;
    value: string;
    placeholder?: string;
  };
