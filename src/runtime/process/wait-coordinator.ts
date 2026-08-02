/** Managed process wait 的纯 reducer。
 *
 * waiter 是可丢弃的观察者；terminal summary 才是 process truth。注册顺序、
 * timeout 和 cancel 都不能改变 terminal truth，也不能让同一个 waiter 得到
 * 两次 terminal resolution。
 */

import { RUNTIME_HOST_BOUNDS } from "../host/types.ts";
import type { ExecutionHandleRef, ManagedProcessSummary } from "./types.ts";

export type WaiterStatus = "waiting" | "terminal" | "timed_out" | "cancelled";

export interface WaiterRecord {
	readonly waiterId: string;
	readonly processKey: string;
	readonly summary: ManagedProcessSummary;
	readonly status: WaiterStatus;
	readonly resolution?: WaitCoordinatorResolution;
}

export interface TerminalRecord {
	readonly processKey: string;
	readonly summary: ManagedProcessSummary;
}

export interface WaitCoordinatorState {
	readonly maxWaiters: number;
	readonly terminals: readonly TerminalRecord[];
	readonly waiters: readonly WaiterRecord[];
}

export type WaitCoordinatorAction =
	| { readonly type: "register"; readonly waiterId: string; readonly summary: ManagedProcessSummary }
	| { readonly type: "terminal"; readonly summary: ManagedProcessSummary }
	| { readonly type: "timeout" | "cancel"; readonly waiterId: string };

export type WaitCoordinatorResolution = {
	readonly waiterId: string;
	readonly outcome: "terminal" | "timed_out" | "cancelled";
	readonly summary: ManagedProcessSummary;
};

export type WaitCoordinatorErrorCode = "waiter_capacity_exceeded" | "waiter_not_found";

export interface WaitCoordinatorResult {
	readonly state: WaitCoordinatorState;
	readonly resolutions: readonly WaitCoordinatorResolution[];
	readonly error?: WaitCoordinatorErrorCode;
}

export function createWaitCoordinatorState(
	maxWaiters: number = RUNTIME_HOST_BOUNDS.maxReverseRequestWaiters,
): WaitCoordinatorState {
	if (!Number.isSafeInteger(maxWaiters) || maxWaiters < 1) throw new Error("maxWaiters must be a positive safe integer");
	return { maxWaiters, terminals: [], waiters: [] };
}

export function applyWaitCoordinator(state: WaitCoordinatorState, action: WaitCoordinatorAction): WaitCoordinatorResult {
	switch (action.type) {
		case "register":
			return register(state, action.waiterId, action.summary);
		case "terminal":
			return settleTerminal(state, action.summary);
		case "timeout":
			return settleWaiter(state, action.waiterId, "timed_out");
		case "cancel":
			return settleWaiter(state, action.waiterId, "cancelled");
	}
}

function register(state: WaitCoordinatorState, waiterId: string, summary: ManagedProcessSummary): WaitCoordinatorResult {
	if (state.waiters.some((waiter) => waiter.waiterId === waiterId)) {
		return { state, resolutions: [] };
	}
	const processKey = key(summary.handle);
	const existingTerminal = state.terminals.find((terminal) => terminal.processKey === processKey);
	if (!existingTerminal && state.waiters.filter((waiter) => waiter.status === "waiting").length >= state.maxWaiters) {
		return { state, resolutions: [], error: "waiter_capacity_exceeded" };
	}
	if (existingTerminal) {
		const resolution: WaitCoordinatorResolution = { waiterId, outcome: "terminal", summary: existingTerminal.summary };
		return {
			state: {
				...state,
				waiters: [...state.waiters, { waiterId, processKey, summary, status: "terminal", resolution }],
			},
			resolutions: [resolution],
		};
	}
	return {
		state: { ...state, waiters: [...state.waiters, { waiterId, processKey, summary, status: "waiting" }] },
		resolutions: [],
	};
}

function settleTerminal(state: WaitCoordinatorState, summary: ManagedProcessSummary): WaitCoordinatorResult {
	const processKey = key(summary.handle);
	if (state.terminals.some((terminal) => terminal.processKey === processKey)) return { state, resolutions: [] };
	const terminal: TerminalRecord = { processKey, summary };
	const resolutions: WaitCoordinatorResolution[] = [];
	const waiters = state.waiters.map((waiter) => {
		if (waiter.processKey !== processKey || waiter.status !== "waiting") return waiter;
		const resolution: WaitCoordinatorResolution = { waiterId: waiter.waiterId, outcome: "terminal", summary };
		resolutions.push(resolution);
		return { ...waiter, status: "terminal" as const, resolution };
	});
	return { state: { ...state, terminals: [...state.terminals, terminal], waiters }, resolutions };
}

function settleWaiter(
	state: WaitCoordinatorState,
	waiterId: string,
	outcome: "timed_out" | "cancelled",
): WaitCoordinatorResult {
	const index = state.waiters.findIndex((waiter) => waiter.waiterId === waiterId);
	if (index < 0) return { state, resolutions: [], error: "waiter_not_found" };
	const waiter = state.waiters[index];
	if (!waiter) return { state, resolutions: [], error: "waiter_not_found" };
	if (waiter.status !== "waiting") return { state, resolutions: [] };
	const resolution: WaitCoordinatorResolution = { waiterId, outcome, summary: waiter.summary };
	const waiters = [...state.waiters];
	waiters[index] = { ...waiter, status: outcome, resolution };
	return { state: { ...state, waiters }, resolutions: [resolution] };
}

function key(handle: ExecutionHandleRef): string {
	return `${handle.executionId}:${handle.attemptId}`;
}
