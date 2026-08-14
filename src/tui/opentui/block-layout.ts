/** Codex ExecCell 命令续行的显示前缀。 */
export const EXEC_CONTINUATION_PREFIX = "  │ ";
export const EXEC_CONTINUATION_MAX_LINES = 2;

/** Codex ExecCell 输出块的首行前缀和屏幕行预算。 */
export const EXEC_OUTPUT_PREFIX = "  └ ";
export const EXEC_OUTPUT_CONTINUATION_INDENT = "    ";
export const EXEC_OUTPUT_MAX_LINES = 5;
export const EXEC_OUTPUT_MAX_LINES_TOOL = EXEC_OUTPUT_MAX_LINES;
export const EXEC_OUTPUT_MAX_LINES_USER_SHELL = 50;

/** 交互式命令预览的字符预算。 */
export const EXEC_INTERACTION_PREVIEW_CHARS = 80;

/** PlanUpdateCell 步骤前缀和续行对齐缩进。 */
export const PLAN_STEP_PREFIX = "  └ ";
export const PLAN_STEP_CONTINUATION_INDENT = "    ";

/** Diff 行中的 tab 显示宽度。 */
export const DIFF_TAB_REPLACEMENT = "    ";

/** 状态指示详情行的前缀和数量上限。 */
export const STATUS_DETAILS_PREFIX = "  └ ";
export const STATUS_DETAILS_MAX_LINES = 3;

/** NoticeCell warning 前缀和续行缩进。 */
export const NOTICE_WARN_PREFIX = "⚠ ";
export const NOTICE_CONTINUATION_INDENT = "  ";

/** Exec 中段截断提示的括号部分。 */
export const EXEC_TRUNCATION_HINT = "(Ctrl+T for transcript)";

export function planWrapWidth(width: number): number {
	return Math.max(1, Math.floor(finiteOrZero(width)) - PLAN_STEP_CONTINUATION_INDENT.length);
}

export function diffLineNumberWidth(maxLineNumber: number): number {
	return String(Math.max(0, Math.floor(finiteOrZero(maxLineNumber)))).length;
}

export function formatElapsedCompact(seconds: number): string {
	const totalSeconds = Math.max(0, Math.floor(finiteOrZero(seconds)));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const remainingSeconds = totalSeconds % 60;
	if (minutes < 60) return `${minutes}m ${String(remainingSeconds).padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${String(minutes % 60).padStart(2, "0")}m ${String(remainingSeconds).padStart(2, "0")}s`;
}

export function formatExecTruncationHint(omittedLines: number): string {
	return `… +${Math.max(0, Math.floor(finiteOrZero(omittedLines)))} lines ${EXEC_TRUNCATION_HINT}`;
}

function finiteOrZero(value: number): number {
	return Number.isFinite(value) ? value : 0;
}
