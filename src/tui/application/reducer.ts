/**
 * TUI application 纯 reducer：TuiAction -> TuiState。
 *
 * 不做 IO、render 或 timer；不 import OpenTUI、Node、controller 或 storage。
 * 非法/未知 action 返回 unchanged 或确定状态，绝不 throw。
 */

import type { TuiAction } from "./action.ts";
import type { TuiState } from "./state.ts";
import type { TuiEffect } from "./effect.ts";
import type { TuiResult } from "./result.ts";
import type { CorrelatedRequestRef } from "./common.ts";
import { timelineReducer } from "../timeline/reducer.ts";

/** 已知 action type 全集（穷举防护：新增 action 必须在此登记）。 */
export const TUI_ACTION_TYPES = [
	"overlay.open",
	"overlay.close",
	"command.submit",
	"timeline.event",
	"query.cancel",
	"query.start",
	"query.result",
	"session.replace",
	"composer.changed",
	"interaction.select",
	"interaction.search-changed",
	"interaction.viewport-clear",
] as const;

export function tuiReducer(state: TuiState, action: TuiAction): TuiState {
	switch (action.type) {
		case "overlay.open":
			return {
				...state,
				interaction: { ...state.interaction, overlay: action.overlay, generation: state.interaction.generation + 1 },
			};
		case "overlay.close":
			if (state.interaction.overlay.state === "closed") return state;
			return {
				...state,
				interaction: {
					...state.interaction,
					overlay: { state: "closed" },
					generation: state.interaction.generation + 1,
				},
			};
		case "composer.changed": {
			const draft = action.draft;
			if (draft.text === state.interaction.composerDraft.text) return state;
			return {
				...state,
				interaction: {
					...state.interaction,
					composerDraft: draft,
					composerEmpty: draft.text.length === 0,
					generation: state.interaction.generation + 1,
				},
			};
		}
		case "interaction.select": {
			if (action.id.length === 0) return state;
			return {
				...state,
				interaction: {
					...state.interaction,
					selectedId: { state: "known", value: action.id },
					generation: state.interaction.generation + 1,
				},
			};
		}
		case "interaction.search-changed": {
			const query = action.query.slice(0, 1024);
			return {
				...state,
				interaction: {
					...state.interaction,
					search: query.length === 0
						? { state: "unknown", reason: "no-active-search" }
						: { state: "known", value: query },
					generation: state.interaction.generation + 1,
				},
			};
		}
		case "interaction.viewport-clear":
			return {
				...state,
				interaction: {
					...state.interaction,
					viewportClearRevision: state.interaction.viewportClearRevision + 1,
					generation: state.interaction.generation + 1,
				},
			};
		case "timeline.event":
			return { ...state, timeline: timelineReducer(state.timeline, action.event) };
		case "command.submit": {
			const commandOrder = [...state.commandOrder];
			if (!commandOrder.includes(action.intent.invocationId)) commandOrder.push(action.intent.invocationId);
			while (commandOrder.length > 512) commandOrder.shift();
			const commandsById: Record<string, TuiState["commandsById"][string]> = {
				...state.commandsById,
				[action.intent.invocationId]: {
					invocationId: action.intent.invocationId,
					createdAt: action.intent.createdAt,
					displayOrder: action.intent.displayOrder,
					canonicalName: action.intent.canonicalName,
					normalizedArgs: action.intent.normalizedArgs,
					execution: { state: "pending" },
				},
			};
			const keys = Object.keys(commandsById);
			if (keys.length > 512) {
				const oldest = keys[0]!;
				delete commandsById[oldest];
			}
			return { ...state, commandsById, commandOrder };
		}
		case "session.replace": {
			if (action.sessionId.length === 0) return state;
			if (action.sessionId === state.bootstrap.session.id) return state;
			return {
				...state,
				bootstrap: {
					...state.bootstrap,
					session: { ...state.bootstrap.session, id: action.sessionId },
				},
				interaction: { ...state.interaction, generation: state.interaction.generation + 1 },
			};
		}
		case "query.cancel":
			// B4:cancel 由 EffectRunner 处理（AbortController registry）；reducer 状态不变。
			return state;
		case "query.start": {
			const key = workflowKeyFor(action.effect);
			if (key === undefined) return state;
			return setWorkflowLoading(state, key, action.effect.correlationId, action.effect.effectId, action.effect.generation);
		}
		case "query.result":
			return applyQueryResult(state, action.result);
		default:
			// 未知 action：稳定 unchanged（穷举防护见 TUI_ACTION_TYPES）
			return state;
	}
}

/** 非法/未知 action 的确定性处理：返回 unchanged 状态。 */
export function safeReduce(state: TuiState, action: TuiAction): TuiState {
	try {
		return tuiReducer(state, action);
	} catch {
		return state;
	}
}

// ===== query workflow 映射（B4） =====

type WorkflowKey =
	| "providerWorkflow" | "authWorkflow" | "modelWorkflow" | "thinkingWorkflow"
	| "promptWorkflow" | "keymapWorkflow" | "queueWorkflow" | "approvalWorkflow"
	| "taskGoalWorkflow" | "planWorkflow" | "agentWorkflow" | "extensionWorkflow"
	| "runtimeSnapshotWorkflow" | "securityModeWorkflow" | "shutdownWorkflow"
	| "workspaceGitWorkflow" | "processWorkflow" | "updateWorkflow";

const WORKFLOW_BY_EFFECT: Record<TuiEffect["type"], WorkflowKey> = {
	"provider.list": "providerWorkflow",
	"auth.inspect": "authWorkflow",
	"auth.login": "authWorkflow",
	"auth.logout": "authWorkflow",
	"model.list": "modelWorkflow",
	"model.select": "modelWorkflow",
	"thinking.inspect": "thinkingWorkflow",
	"thinking.select": "thinkingWorkflow",
	"prompt.list": "promptWorkflow",
	"prompt.submit": "promptWorkflow",
	"keymap.inspect": "keymapWorkflow",
	"queue.inspect": "queueWorkflow",
	"queue.cancel": "queueWorkflow",
	"approval.inspect": "approvalWorkflow",
	"approval.resolve": "approvalWorkflow",
	"task-goal.inspect": "taskGoalWorkflow",
	"plan.inspect": "planWorkflow",
	"agent.inspect": "agentWorkflow",
	"extension.inspect": "extensionWorkflow",
	"runtime-snapshot.inspect": "runtimeSnapshotWorkflow",
	"security-mode.inspect": "securityModeWorkflow",
	"security-mode.set": "securityModeWorkflow",
	"shutdown.request": "shutdownWorkflow",
	"workspace-git.inspect": "workspaceGitWorkflow",
	"process.list": "processWorkflow",
	"process.output": "processWorkflow",
	"update.inspect": "updateWorkflow",
};

function workflowKeyFor(effect: TuiEffect): WorkflowKey | undefined {
	return WORKFLOW_BY_EFFECT[effect.type];
}

function setWorkflowLoading(state: TuiState, key: WorkflowKey, requestId: string, effectId: string, generation: number): TuiState {
	const current = state[key] as { readonly state: string; readonly requestId?: string; readonly effectId?: string };
	if (current.state === "unavailable") return state;
	if (current.state === "loading" && current.requestId === requestId && current.effectId === effectId) return state;
	return {
		...state,
		[key]: { state: "loading", requestId, effectId, generation },
	};
}

/** completed value -> workflow ready/empty；stale/aborted 不落地；failed/uncertain -> error。 */
function applyQueryResult(state: TuiState, result: TuiResult): TuiState {
	// ref 携带 correlationId/effectId/generation；按三重 fence 匹配 loading workflow
	const applied = applyQueryResultByRef(state, result);
	if (applied !== state) return applied;
	return resetLoadingIfFenced(state, result);
}

/** 结果按 correlationId + effectId + generation 三重 fence 匹配 loading workflow。 */
function applyQueryResultByRef(state: TuiState, result: TuiResult): TuiState {
	const keys = Object.keys(WORKFLOW_BY_EFFECT) as TuiEffect["type"][];
	for (const type of keys) {
		const key = WORKFLOW_BY_EFFECT[type]!;
		const current = state[key] as { readonly state: string; readonly requestId?: string; readonly effectId?: string; readonly generation?: number } | undefined;
		const inFlight = current?.state === "loading" || current?.state === "requesting";
		if (inFlight && current.requestId === result.ref.correlationId
			&& (current.effectId === undefined || current.effectId === result.ref.effectId)
			&& (current.generation === undefined || current.generation === result.ref.generation)) {
			return applyQueryResultTo(state, key, result);
		}
	}
	return state;
}

/** stale/aborted 只在该 result 对应当前 loading 查询时退出 loading（避免 waiter 永久等待）。 */
function resetLoadingIfFenced(state: TuiState, result: TuiResult): TuiState {
	if (result.status !== "stale" && result.status !== "aborted") return state;
	const keys = Object.keys(WORKFLOW_BY_EFFECT) as TuiEffect["type"][];
	for (const type of keys) {
		const key = WORKFLOW_BY_EFFECT[type]!;
		const current = state[key] as { readonly state: string; readonly requestId?: string; readonly effectId?: string; readonly generation?: number } | undefined;
		const inFlight = current?.state === "loading" || current?.state === "requesting";
		if (inFlight && current.requestId === result.ref.correlationId
			&& (current.effectId === undefined || current.effectId === result.ref.effectId)) {
			return { ...state, [key]: { state: "idle", generation: current.generation ?? result.ref.generation } };
		}
	}
	return state;
}

function applyQueryResultTo(state: TuiState, key: WorkflowKey, result: TuiResult): TuiState {
	switch (result.status) {
		case "completed":
			return setWorkflowReady(state, key, result.ref.generation, result.value);
		case "failed": {
			const error = result.error;
			return {
				...state,
				[key]: { state: "error", code: error.code, message: error.message, retryable: error.retryable, generation: result.ref.generation },
			};
		}
		case "uncertain":
			return {
				...state,
				recoveryRequired: true,
				[key]: { state: "error", code: result.error.code, message: result.error.message, retryable: result.error.retryable, generation: result.ref.generation },
			};
		default:
			return state;
	}
}

/** completed -> ready/empty；空集合 workflow 落 empty。 */
function setWorkflowReady(state: TuiState, key: WorkflowKey, generation: number, value: unknown): TuiState {
	if (isEmptyWorkflowValue(key, value)) {
		return { ...state, [key]: { state: "empty", generation } };
	}
	return { ...state, [key]: { state: "ready", generation, value } };
}

function isEmptyWorkflowValue(key: WorkflowKey, value: unknown): boolean {
	if (Array.isArray(value)) return value.length === 0;
	if (typeof value !== "object" || value === null) return true;
	const record = value as Record<string, unknown>;
	switch (key) {
		case "providerWorkflow":
			return Array.isArray(record.providers) && record.providers.length === 0;
		case "modelWorkflow":
			return Array.isArray(record.models) && record.models.length === 0;
		case "extensionWorkflow":
			return Array.isArray(record.resources) && record.resources.length === 0;
		case "taskGoalWorkflow":
			return Array.isArray(record.tasks) && record.tasks.length === 0 && Array.isArray(record.goals) && record.goals.length === 0;
		case "agentWorkflow":
			return Array.isArray(record.agents) && record.agents.length === 0;
		case "queueWorkflow":
			return Array.isArray(record.items) && record.items.length === 0;
		case "approvalWorkflow":
			return Array.isArray(record.items) && record.items.length === 0;
		case "promptWorkflow":
			return Array.isArray(record.templates) && record.templates.length === 0;
		case "keymapWorkflow":
			return Array.isArray(record.bindings) && record.bindings.length === 0;
		default:
			return false;
	}
}

export type { CorrelatedRequestRef };
