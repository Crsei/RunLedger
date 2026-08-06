/**
 * Timeline 纯 reducer：TimelineEvent -> TimelineState。
 *
 * 规则：
 *   - 同一 correlationId 的 start-update-end 从 active row 单调进入 committed row；
 *   - stale generation（event.generation < state.generation）不落地；
 *   - orphan end / 重复 end / 无对应 active row 的 update 均为 no-op（不 throw）；
 *   - cleanup 按 correlationId 清 active 行并落为 cancelled/aborted；
 *   - generation 单调取事件最大值。
 */

import type { TimelineEvent, TimelineRow, TimelineState, TimelineStatus } from "./types.ts";

export function createInitialTimelineState(): TimelineState {
	return {
		generation: 0,
		committedRows: [],
		activeRowsByCorrelationId: {},
		activeOrder: [],
		cursor: { messageIndex: 0 },
	};
}

export function timelineReducer(state: TimelineState, event: TimelineEvent): TimelineState {
	if (event.generation < state.generation) return state;
	const generation = Math.max(state.generation, event.generation);
	switch (event.type) {
		case "message_start":
		case "tool_start": {
			if (state.activeRowsByCorrelationId[event.correlationId] !== undefined) return state;
			if (event.type === "message_start" && event.row.kind !== "user" && event.row.kind !== "assistant") return state;
			if (event.type === "tool_start" && event.row.kind !== "tool") return state;
			const next = nextDisplayOrder(state);
			const row = { ...event.row, displayOrder: next };
			return {
				...state,
				generation,
				activeRowsByCorrelationId: {
					...state.activeRowsByCorrelationId,
					[event.correlationId]: row,
				},
				activeOrder: [...state.activeOrder, event.correlationId],
				cursor: {
					...state.cursor,
					messageIndex: event.type === "message_start" ? state.cursor.messageIndex + 1 : state.cursor.messageIndex,
					activeMessageId: event.type === "message_start" ? event.row.id : state.cursor.activeMessageId,
				},
			};
		}
		case "message_update": {
			const row = state.activeRowsByCorrelationId[event.correlationId];
			if (row === undefined || row.kind !== "assistant") return state;
			return {
				...state,
				generation,
				activeRowsByCorrelationId: {
					...state.activeRowsByCorrelationId,
					[event.correlationId]: {
						...row,
						text: event.text,
						...(event.thinking === undefined ? {} : { thinking: event.thinking }),
						streaming: true,
					},
				},
			};
		}
		case "tool_update": {
			const row = state.activeRowsByCorrelationId[event.correlationId];
			if (row === undefined || row.kind !== "tool") return state;
			return {
				...state,
				generation,
				activeRowsByCorrelationId: {
					...state.activeRowsByCorrelationId,
					[event.correlationId]: { ...row, presentation: event.presentation },
				},
			};
		}
		case "message_end":
		case "tool_end": {
			const row = state.activeRowsByCorrelationId[event.correlationId];
			if (row === undefined) return state;
			return commit(state, event.correlationId, event.status, generation);
		}
		case "usage": {
			const row = state.activeRowsByCorrelationId[event.correlationId];
			if (row === undefined || row.kind !== "assistant") return state;
			return {
				...state,
				generation,
				activeRowsByCorrelationId: {
					...state.activeRowsByCorrelationId,
					[event.correlationId]: { ...row, usage: event.usage },
				},
			};
		}
		case "notice": {
			const row: TimelineRow = {
				kind: "notice",
				id: `notice:${event.correlationId}`,
				timestamp: new Date().toISOString(),
				displayOrder: nextDisplayOrder(state),
				status: "succeeded",
				severity: event.severity,
				message: event.message,
			};
			return { ...state, generation, committedRows: [...state.committedRows, row] };
		}
		case "goal_lifecycle":
		case "agent_lifecycle": {
			const kind = event.type === "goal_lifecycle" ? "goal" : "agent";
			const existing = state.committedRows.find((row) => row.id === `${kind}:${event.correlationId}`);
			if (existing !== undefined) {
				const updated = { ...existing, status: event.status as TimelineStatus };
				return {
					...state,
					generation,
					committedRows: state.committedRows.map((row) => (row.id === updated.id ? updated : row)),
				};
			}
			const row: TimelineRow = event.type === "goal_lifecycle"
				? {
						kind: "goal",
						id: `goal:${event.correlationId}`,
						timestamp: new Date().toISOString(),
						displayOrder: nextDisplayOrder(state),
						status: event.status,
						goalId: event.goalId,
						label: { text: "goal", truncated: false, byteLength: 4 },
						phase: { text: event.status, truncated: false, byteLength: event.status.length },
					}
				: {
						kind: "agent",
						id: `agent:${event.correlationId}`,
						timestamp: new Date().toISOString(),
						displayOrder: nextDisplayOrder(state),
						status: event.status,
						agentId: event.agentId,
						label: { text: "agent", truncated: false, byteLength: 5 },
						phase: { text: event.status, truncated: false, byteLength: event.status.length },
					};
			return { ...state, generation, committedRows: [...state.committedRows, row] };
		}
		case "cleanup": {
			const affected = state.activeOrder.filter((id) => event.correlationId === undefined || id === event.correlationId);
			if (affected.length === 0) return state;
			const status: TimelineStatus = event.reason === "abort" ? "aborted" : "cancelled";
			const nextCommitted = [...state.committedRows];
			for (const id of affected) {
				const row = state.activeRowsByCorrelationId[id];
				if (row !== undefined) nextCommitted.push({ ...row, status });
			}
			const activeRowsByCorrelationId = { ...state.activeRowsByCorrelationId };
			for (const id of affected) delete activeRowsByCorrelationId[id];
			return {
				...state,
				generation,
				committedRows: nextCommitted,
				activeRowsByCorrelationId,
				activeOrder: state.activeOrder.filter((id) => !affected.includes(id)),
				cursor: {
					...state.cursor,
					activeMessageId:
						state.cursor.activeMessageId !== undefined && affected.includes(state.cursor.activeMessageId)
							? undefined
							: state.cursor.activeMessageId,
				},
			};
		}
	}
}

function commit(state: TimelineState, correlationId: string, status: TimelineStatus, generation: number): TimelineState {
	const row = state.activeRowsByCorrelationId[correlationId]!;
	const committed = row.kind === "assistant" ? { ...row, status, streaming: false } : { ...row, status };
	const activeRowsByCorrelationId = { ...state.activeRowsByCorrelationId };
	delete activeRowsByCorrelationId[correlationId];
	return {
		...state,
		generation,
		committedRows: [...state.committedRows, committed],
		activeRowsByCorrelationId,
		activeOrder: state.activeOrder.filter((id) => id !== correlationId),
		cursor: {
			...state.cursor,
			activeMessageId:
				state.cursor.activeMessageId === row.id ? undefined : state.cursor.activeMessageId,
		},
	};
}

function nextDisplayOrder(state: TimelineState): number {
	let max = -1;
	for (const row of state.committedRows) {
		if (row.displayOrder > max) max = row.displayOrder;
	}
	for (const id of state.activeOrder) {
		const row = state.activeRowsByCorrelationId[id];
		if (row !== undefined && row.displayOrder > max) max = row.displayOrder;
	}
	return max + 1;
}
