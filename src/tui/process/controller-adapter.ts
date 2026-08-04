/** Host facade adapter for the OpenTUI process overlay. */

import type { ExecutionId } from "../../runtime/protocol/ids.ts";
import type { RuntimeDigest } from "../../runtime/protocol/foundation.ts";
import type { OutputCursor } from "../../runtime/process/output.ts";
import { processOverlayReducer, createInitialProcessOverlayState } from "./reducer.ts";
import type { ProcessOverlayAction, ProcessOverlayItem, ProcessOverlayState } from "./types.ts";

export type ProcessOverlayMutationResult =
	| { readonly ok: true; readonly receiptDigest?: RuntimeDigest }
	| { readonly ok: false; readonly code: string };

export interface ProcessOverlayHostClient {
	listProcesses(): Promise<readonly ProcessOverlayItem[]>;
	processOutput(
		executionId: ExecutionId,
		cursor: OutputCursor,
		maxBytes: number,
	): Promise<
			| { readonly ok: true; readonly text: string; readonly startCursor: OutputCursor; readonly endCursor: OutputCursor; readonly nextCursor: OutputCursor; readonly truncated: boolean; readonly head: OutputCursor }
			| { readonly ok: false; readonly code: string; readonly earliestCursor?: OutputCursor }
		>;
	writeStdin?(executionId: ExecutionId, input: string): Promise<ProcessOverlayMutationResult>;
	resizeProcess?(executionId: ExecutionId, columns: number, rows: number): Promise<ProcessOverlayMutationResult>;
	stopProcess?(executionId: ExecutionId, signal?: NodeJS.Signals): Promise<ProcessOverlayMutationResult>;
}

export interface ProcessOverlayController {
	snapshot(): ProcessOverlayState;
	dispatch(action: ProcessOverlayAction): ProcessOverlayState;
	refresh(): Promise<ProcessOverlayState>;
	openDetail(executionId: ExecutionId): Promise<ProcessOverlayState>;
	openTerminal(executionId: ExecutionId): Promise<ProcessOverlayState>;
	loadOutput(maxBytes?: number): Promise<ProcessOverlayState>;
	write(input: string): Promise<ProcessOverlayMutationResult>;
	resize(columns: number, rows: number): Promise<ProcessOverlayMutationResult>;
	stop(signal?: NodeJS.Signals): Promise<ProcessOverlayMutationResult>;
	setDriver(driver: boolean): ProcessOverlayState;
	close(): ProcessOverlayState;
}

export function createProcessOverlayController(
	client: ProcessOverlayHostClient,
	options: { readonly driver: boolean },
): ProcessOverlayController {
	let state = createInitialProcessOverlayState({ processes: [], driver: options.driver });
	return {
		snapshot: () => state,
		dispatch: (action) => {
			state = processOverlayReducer(state, action);
			return state;
		},
		refresh: async () => {
			state = { ...state, processes: await client.listProcesses() };
			return state;
		},
		openDetail: async (executionId) => {
			state = processOverlayReducer(state, { type: "open_detail", executionId });
			return state;
		},
		openTerminal: async (executionId) => {
			state = processOverlayReducer(state, { type: "open_terminal", executionId });
			return state;
		},
		loadOutput: async (maxBytes = 64 * 1024) => {
			const executionId = state.selectedExecutionId;
			if (executionId === undefined) return state;
			const result = await client.processOutput(executionId, state.cursor, maxBytes);
			if (result.ok) state = processOverlayReducer(state, { type: "output_page", text: result.text, nextCursor: result.nextCursor, truncated: result.truncated });
			else if (result.earliestCursor !== undefined) state = processOverlayReducer(state, { type: "output_resync", cursor: result.earliestCursor });
			return state;
		},
		write: async (input) => {
			if (!state.driver) return { ok: false, code: "observer_mutation_forbidden" };
			const executionId = state.selectedExecutionId;
			if (executionId === undefined) return { ok: false, code: "process_not_selected" };
			if (!client.writeStdin) return { ok: false, code: "capability_unavailable" };
			return client.writeStdin(executionId, input);
		},
		resize: async (columns, rows) => {
			if (!state.driver) return { ok: false, code: "observer_mutation_forbidden" };
			const executionId = state.selectedExecutionId;
			if (executionId === undefined) return { ok: false, code: "process_not_selected" };
			if (!client.resizeProcess) return { ok: false, code: "capability_unavailable" };
			return client.resizeProcess(executionId, columns, rows);
		},
		stop: async (signal) => {
			if (!state.driver) return { ok: false, code: "observer_mutation_forbidden" };
			const executionId = state.selectedExecutionId;
			if (executionId === undefined) return { ok: false, code: "process_not_selected" };
			if (!client.stopProcess) return { ok: false, code: "capability_unavailable" };
			return client.stopProcess(executionId, signal);
		},
		setDriver: (driver) => {
			state = processOverlayReducer(state, { type: "driver_changed", driver });
			return state;
		},
		close: () => {
			state = processOverlayReducer(state, { type: "close" });
			return state;
		},
	};
}
