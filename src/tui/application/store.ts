/**
 * TUI client-local store：dispatch / getState / subscribe。
 *
 * 无领域 authority：不直接读写 session/settings/auth/ledger/workspace/Git；
 * 只把 TuiAction 交给纯 reducer 并通知订阅者。AbortController 不进入 state。
 */

import type { TuiAction } from "./action.ts";
import type { TuiState } from "./state.ts";
import { tuiReducer } from "./reducer.ts";

export interface TuiStore {
	getState(): TuiState;
	dispatch(action: TuiAction): void;
	subscribe(listener: (state: TuiState) => void): () => void;
}

export function createTuiStore(initial: TuiState): TuiStore {
	let state = initial;
	const listeners = new Set<(state: TuiState) => void>();
	return {
		getState: () => state,
		dispatch: (action) => {
			const next = tuiReducer(state, action);
			if (next === state) return;
			state = next;
			for (const listener of listeners) listener(state);
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}
