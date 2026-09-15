/**
 * Plan Mode 的 model-visible 指令片段。
 *
 * 纯函数：只按已校验的 PlanModeState 与工件正文产出文本，不读取 TUI、事件或
 * 外部状态。注入点由 composition 决定，片段本身不表达权限。
 */

import type { PlanArtifactRef, PlanModeState } from "./types.ts";

/** 计划质量标准：plan 是执行规格，不是设计文档。 */
const PLAN_QUALITY_RULES = [
	"Write the plan as an execution spec, not a design doc: a competent implementer who never saw this conversation must be able to execute it top to bottom without making a design decision.",
	"Every step names the concrete edit: verb, exact target, and the new behavior. Include exact signatures or literals for new or changed symbols.",
	"Give the end-to-end verification for the change: concrete input, expected observable output, and the exact command. Keep behavior-defining tests; do not plan mechanical cleanup like changelog, docs, formatting, or scaffold removal.",
	"Do not add decision-free sections (Non-Goals, Out of Scope, Alternatives Considered, Risks). State a scope boundary inline at the point it matters.",
	"Do not reference the planning conversation; the reader cannot see it. State each decision and its reason inline.",
];

export interface PlanFragmentInput {
	readonly state: PlanModeState;
	/** 当前 working 或已 pin 的正文；缺失时只注入状态与规则。 */
	readonly content?: string;
	/** approved 正文是否已在本轮内联，避免同一 revision 重复占用预算。 */
	readonly contentInlined?: boolean;
	/** 连续空转轮次的收敛提示序号（1..N，0 表示不提示）。 */
	readonly convergenceReminder?: number;
}

export interface PlanFragment {
	/** 供注入方去重：状态 + 工件 revision + digest 前缀。 */
	readonly key: string;
	readonly text: string;
}

/**
 * 按状态产出 plan fragment。inactive 返回 undefined：无 plan 状态时不注入任何
 * 指令，避免把 mode 约束泄漏到普通会话。
 */
export function buildPlanFragment(input: PlanFragmentInput): PlanFragment | undefined {
	const { state } = input;
	if (state.status === "inactive") return undefined;
	const plan = state.plan;
	const key = `${state.status}:${plan?.revision ?? "none"}:${plan?.digest.digest.slice(0, 16) ?? "none"}${input.convergenceReminder === undefined || input.convergenceReminder === 0 ? "" : `:c${input.convergenceReminder}`}`;
	if (state.status === "pending") {
		return { key, text: ["<plan-mode>", "Plan mode activation is pending. Keep working; the mode applies at the next turn boundary.", "</plan-mode>"].join("\n") };
	}
	if (state.status === "awaiting_approval") {
		const lines = [
			"<plan-mode>",
			"Plan mode: the plan is submitted and awaiting user approval on the pinned revision below.",
			"Do not start implementing, do not modify the workspace, and do not ask the user to approve in prose. Wait for the decision; if the user requests changes, revise the artifact with plan_write. Re-read the body with plan_read when you need it.",
			"</plan-mode>",
		];
		if (plan !== undefined) lines.push(describeArtifact(plan, { ...input, contentInlined: true }));
		return { key, text: lines.join("\n") };
	}
	if (state.status === "exit_pending") {
		const lines = [
			"<plan-mode>",
			"Plan mode: the plan below was approved. Finish the plan workflow before implementing; implementation happens only after the workflow is settled.",
			"</plan-mode>",
		];
		if (plan !== undefined) lines.push(describeArtifact(plan, input));
		return { key, text: lines.join("\n") };
	}
	const lines = [
		"<plan-mode>",
		"The workspace is read-only while plan mode is active: do not create, edit, delete, or rename working-tree files, and do not run state-changing commands.",
		"Keep the plan in the session-owned artifact with plan_write; it takes only a revision and the full body, never a path.",
		...PLAN_QUALITY_RULES.map((rule) => `- ${rule}`),
		"When the plan is decision-complete, submit it with exit_plan_mode. You cannot approve your own plan and the user cannot approve in prose.",
		"</plan-mode>",
	];
	if (plan !== undefined) lines.push(describeArtifact(plan, input));
	const reminder = input.convergenceReminder ?? 0;
	if (reminder > 0) {
		lines.push(
			`<convergence>Plan mode is active and this turn ${reminder === 1 ? "did not" : "still did not"} change the plan. Write the next revision with plan_write, or submit the current plan with exit_plan_mode. Do not keep exploring without updating the artifact.</convergence>`,
		);
	}
	return { key, text: lines.join("\n") };
}

function describeArtifact(plan: PlanArtifactRef, input: PlanFragmentInput): string {
	const header = `<plan revision="${plan.revision}" digest="${plan.digest.digest.slice(0, 16)}" bytes="${plan.artifactRef.size}" inlined="${input.contentInlined === true}">`;
	if (input.content === undefined || input.contentInlined === true) return header;
	return `${header}\n${input.content}\n</plan>`;
}
