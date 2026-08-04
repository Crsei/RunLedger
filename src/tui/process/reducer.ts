/** Pure managed-process overlay reducer. */

import { clipUtf8Output, PROCESS_OUTPUT_BOUNDS } from "../../runtime/process/output.ts";
import type { ExecutionId } from "../../runtime/protocol/ids.ts";
import type { ProcessOverlayAction, ProcessOverlaySeed, ProcessOverlayState } from "./types.ts";

const MAX_OVERLAY_OUTPUT_BYTES = Math.min(256 * 1024, PROCESS_OUTPUT_BOUNDS.maxPageBytes * 4);

export function createInitialProcessOverlayState(seed: ProcessOverlaySeed): ProcessOverlayState {
	return {
		open: false,
		mode: "list",
		processes: seed.processes,
		output: "",
		cursor: { sequence: 0, byteOffset: 0 },
		truncated: false,
		driver: seed.driver,
		editorFocusRestored: true,
		terminalSize: { columns: 80, rows: 24 },
	};
}

export function processOverlayReducer(state: ProcessOverlayState, action: ProcessOverlayAction): ProcessOverlayState {
	switch (action.type) {
		case "open_list":
			return { ...state, open: true, mode: "list", editorFocusRestored: false, pendingAction: undefined };
		case "open_detail":
			return select(state, action.executionId, "detail");
		case "open_terminal":
			return select(state, action.executionId, "terminal");
		case "output_resync":
			return { ...state, output: "", cursor: action.cursor, truncated: false };
		case "output_page": {
			const clipped = clipUtf8Output(action.text, MAX_OVERLAY_OUTPUT_BYTES);
			return {
				...state,
				output: clipped.text,
				cursor: action.nextCursor,
				truncated: action.truncated || clipped.truncated,
			};
		}
		case "driver_changed":
			return { ...state, driver: action.driver, pendingAction: undefined };
		case "request_write":
			return state.driver ? { ...state, pendingAction: "write" } : state;
		case "request_resize":
			return state.driver ? { ...state, pendingAction: "resize" } : state;
		case "request_stop":
			return state.driver ? { ...state, pendingAction: "stop" } : state;
		case "resize":
			return {
				...state,
				terminalSize: {
					columns: clamp(action.columns, 1, 512),
					rows: clamp(action.rows, 1, 256),
				},
			};
		case "close":
			return { ...state, open: false, mode: "list", selectedExecutionId: undefined, pendingAction: undefined, editorFocusRestored: true };
	}
}

function select(state: ProcessOverlayState, executionId: ExecutionId, mode: "detail" | "terminal"): ProcessOverlayState {
	if (!state.processes.some((process) => process.executionId === executionId)) return state;
	return { ...state, open: true, mode, selectedExecutionId: executionId, output: "", cursor: { sequence: 0, byteOffset: 0 }, truncated: false, pendingAction: undefined, editorFocusRestored: false };
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.floor(value))) : minimum;
}
