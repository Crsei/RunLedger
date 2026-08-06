/**
 * B3：client-local store 验收。
 *
 *   - dispatch/getState/subscribe；无领域 authority；
 *   - unchanged action 不通知订阅者；
 *   - AbortController 不进入 state。
 */

import { describe, expect, it } from "vitest";
import { createInitialTuiState } from "../../../src/tui/application/initial-state.ts";
import { createTuiStore } from "../../../src/tui/application/store.ts";
import type { TuiBootstrapSnapshot } from "../../../src/tui/presentation/types.ts";

const bootstrap: TuiBootstrapSnapshot = {
	workspaceLabel: "acme/runledger",
	session: { id: "session-1", format: "current-canonical", lifecycle: "active" },
	authorityGeneration: 1,
};

describe("B3 tui store", () => {
	it("dispatches through the pure reducer and notifies subscribers on change", () => {
		const store = createTuiStore(createInitialTuiState({ bootstrap }));
		const seen: number[] = [];
		store.subscribe((state) => seen.push(state.interaction.generation));
		store.dispatch({ type: "overlay.open", overlay: { state: "command", requestId: "r-1" } });
		expect(seen).toEqual([1]);
		expect(store.getState().interaction.overlay.state).toBe("command");
	});

	it("does not notify when the reducer returns unchanged state", () => {
		const store = createTuiStore(createInitialTuiState({ bootstrap }));
		let notifications = 0;
		store.subscribe(() => { notifications += 1; });
		store.dispatch({ type: "overlay.close" }); // 已 closed → unchanged
		store.dispatch({ type: "composer.changed", draft: { text: "", truncated: false, byteLength: 0 } }); // identical
		expect(notifications).toBe(0);
	});

	it("unsubscribe stops notifications", () => {
		const store = createTuiStore(createInitialTuiState({ bootstrap }));
		let notifications = 0;
		const unsubscribe = store.subscribe(() => { notifications += 1; });
		unsubscribe();
		store.dispatch({ type: "overlay.open", overlay: { state: "session", requestId: "r-2" } });
		expect(notifications).toBe(0);
	});

	it("never holds AbortController or domain objects in state", () => {
		const store = createTuiStore(createInitialTuiState({ bootstrap }));
		const serialized = JSON.stringify(store.getState());
		expect(serialized).not.toContain("AbortController");
		expect(serialized).not.toContain("signal");
	});
});
