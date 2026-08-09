/** Host facade adapter for the OpenTUI process overlay. */

import type { ExecutionId } from "../../runtime/protocol/ids.ts";
import type { RuntimeDigest } from "../../runtime/protocol/foundation.ts";
import type { OutputCursor } from "../../runtime/process/output.ts";
import { processOverlayReducer, createInitialProcessOverlayState } from "./reducer.ts";
import type { ProcessOverlayAction, ProcessOverlayItem, ProcessOverlayState } from "./types.ts";
import type { SessionDomainResult } from "../../runtime/session-runtime/domain-router.ts";

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

export interface SessionProcessOverlayControllerPort {
	supports(operation: string): boolean;
	querySessionDomain(
		operation: string,
		payload: Record<string, unknown>,
		context: { readonly correlationId: string; readonly effectId: string },
	): Promise<SessionDomainResult>;
	commandSessionDomain(
		operation: string,
		payload: Record<string, unknown>,
		context: { readonly correlationId: string; readonly effectId: string; readonly expectedRevision: number },
	): Promise<SessionDomainResult>;
}

/** 精确 operation manifest 驱动的 Session process overlay client。 */
export function createSessionProcessOverlayClient(
	controller: SessionProcessOverlayControllerPort,
): ProcessOverlayHostClient | undefined {
	if (!controller.supports("session.process.list") || !controller.supports("session.process.output")) return undefined;
	let domainRevision = 0;
	let sequence = 0;
	const requestContext = (prefix: string) => {
		sequence += 1;
		return {
			correlationId: `process_overlay_${prefix}_${sequence}`,
			effectId: `process_overlay_effect_${sequence}`,
		};
	};
	const mutation = async (
		operation: string,
		payload: Record<string, unknown>,
	): Promise<ProcessOverlayMutationResult> => {
		const result = await controller.commandSessionDomain(operation, payload, {
			...requestContext("mutate"),
			expectedRevision: domainRevision,
		});
		if (!result.ok) return { ok: false, code: result.code };
		domainRevision = result.domainRevision;
		return {
			ok: true,
			...(isRuntimeDigest(result.value.receiptDigest) ? { receiptDigest: result.value.receiptDigest } : {}),
		};
	};
	return {
		listProcesses: async () => {
			const result = await controller.querySessionDomain("session.process.list", {}, requestContext("list"));
			if (!result.ok) throw new Error(result.code);
			domainRevision = result.domainRevision;
			return processItems(result.value.items);
		},
		processOutput: async (executionId, cursor, maxBytes) => {
			const result = await controller.querySessionDomain("session.process.output", { executionId, cursor, maxBytes }, requestContext("output"));
			if (!result.ok) return { ok: false, code: result.code };
			domainRevision = result.domainRevision;
			const value = result.value;
			if (!isCursor(value.startCursor) || !isCursor(value.endCursor) || !isCursor(value.nextCursor) || !isCursor(value.head) || typeof value.text !== "string" || typeof value.truncated !== "boolean") {
				return { ok: false, code: "invalid_process_output_response" };
			}
			return {
				ok: true,
				text: value.text,
				startCursor: value.startCursor,
				endCursor: value.endCursor,
				nextCursor: value.nextCursor,
				truncated: value.truncated,
				head: value.head,
			};
		},
		...(controller.supports("session.process.stdin")
			? { writeStdin: (executionId: ExecutionId, input: string) => mutation("session.process.stdin", { executionId, input }) }
			: {}),
		...(controller.supports("session.process.resize")
			? { resizeProcess: (executionId: ExecutionId, columns: number, rows: number) => mutation("session.process.resize", { executionId, columns, rows }) }
			: {}),
		...(controller.supports("session.process.stop")
			? { stopProcess: (executionId: ExecutionId, signal?: NodeJS.Signals) => mutation("session.process.stop", { executionId, ...(signal === undefined ? {} : { signal }) }) }
			: {}),
	};
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

function processItems(value: unknown): readonly ProcessOverlayItem[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry): ProcessOverlayItem[] => {
		if (!isRecord(entry) || typeof entry.executionId !== "string" || typeof entry.attemptId !== "string" || typeof entry.state !== "string" || !isCursor(entry.outputCursor) || typeof entry.outputSize !== "number") return [];
		const capabilities = isRecord(entry.capabilities) ? entry.capabilities : entry;
		if (typeof capabilities.canWrite !== "boolean" || typeof capabilities.canResize !== "boolean" || typeof capabilities.canStop !== "boolean") return [];
		return [{
			executionId: entry.executionId as ExecutionId,
			attemptId: entry.attemptId as ProcessOverlayItem["attemptId"],
			state: entry.state,
			outputCursor: entry.outputCursor,
			outputSize: entry.outputSize,
			canWrite: capabilities.canWrite,
			canResize: capabilities.canResize,
			canStop: capabilities.canStop,
		}];
	});
}

function isCursor(value: unknown): value is OutputCursor {
	return isRecord(value) && typeof value.sequence === "number" && Number.isSafeInteger(value.sequence) && value.sequence >= 0 &&
		typeof value.byteOffset === "number" && Number.isSafeInteger(value.byteOffset) && value.byteOffset >= 0;
}

function isRuntimeDigest(value: unknown): value is RuntimeDigest {
	return isRecord(value) && value.algorithm === "sha256" && typeof value.digest === "string" && /^[a-f0-9]{64}$/u.test(value.digest);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
