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

/** 运行中的状态指示行；正文只来自 safe presentation。 */
export interface StatusIndicatorView {
	readonly indicator: string;
	readonly header: string;
	readonly elapsed: string;
	readonly inlineMessage?: string;
	readonly interruptKey?: string;
	readonly details?: readonly SafeBoundedText[];
}

export type NoticeSeverity = "info" | "warning" | "error";

export type NoticeBlock = {
	id?: string;
	kind: "notice";
	severity: NoticeSeverity;
	/** 已保留既有 severity label 的安全正文，例如 "warning: host is reconnecting"。 */
	message: string;
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
    /** 流式 diff 中最后一行仍可继续接收 delta；final 帧省略或置 false。 */
    streaming?: boolean;
    /** 显示右对齐的旧/新行号 gutter；缺省由 renderer 按 Codex 布局开启。 */
    showLineNumbers?: boolean;
    /** 行号 gutter 宽度；selector 会按当前文档最大行号预计算。 */
    lineNumberWidth?: number;
    /** 允许按 hunk 调用 23 的语法高亮服务。 */
    syntaxHighlight?: boolean;
  }
	| PlanUpdateBlock
	| NoticeBlock
  | {
    id?: string;
    kind: "status-line";
    segments: readonly import("./highlight/status-style.ts").StatusLineSegment[];
  }
  | { id?: string; kind: "separator"; label: string; content?: string; metrics?: readonly string[] }
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
