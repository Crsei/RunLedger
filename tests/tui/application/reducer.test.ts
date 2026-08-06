/**
 * B3：application 纯 reducer 验收。
 *
 *   - overlay open/close、composer change、selection、search、viewport clear、
 *     session replace 都是纯状态转换；
 *   - reducer 不 import OpenTUI、Node IO、controller、timer 或 storage；
 *   - 非法 transition 返回稳定 unchanged/error state，不 throw。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createInitialTuiState } from "../../../src/tui/application/initial-state.ts";
import { safeReduce, tuiReducer } from "../../../src/tui/application/reducer.ts";
import type { TuiBootstrapSnapshot } from "../../../src/tui/presentation/types.ts";

const root = process.cwd();
const reducerSource = readFileSync(join(root, "src/tui/application/reducer.ts"), "utf8");

const bootstrap: TuiBootstrapSnapshot = {
	workspaceLabel: "acme/runledger",
	session: { id: "session-1", format: "current-canonical", lifecycle: "active" },
	authorityGeneration: 1,
};

function initialState(): ReturnType<typeof createInitialTuiState> {
	return createInitialTuiState({ bootstrap });
}

const draft = (text: string) => ({ text, truncated: false, byteLength: new TextEncoder().encode(text).byteLength });

describe("B3 application reducer", () => {
	it("is pure: no OpenTUI, Node IO, controller, timer or storage imports", () => {
		const imports = reducerSource.split("\n").filter((line) => line.trim().startsWith("import"));
		for (const forbidden of ["@opentui", "node:", "AbortController", "storage"]) {
			for (const line of imports) {
				expect(line, `forbidden ${forbidden}`).not.toContain(forbidden);
			}
		}
		expect(reducerSource).toContain("timelineReducer");
	});

	it("overlay open/close are pure state transitions with generation bump", () => {
		let state = initialState();
		const before = state.interaction.generation;
		state = tuiReducer(state, { type: "overlay.open", overlay: { state: "command", requestId: "r-1" } });
		expect(state.interaction.overlay).toEqual({ state: "command", requestId: "r-1" });
		expect(state.interaction.generation).toBe(before + 1);
		state = tuiReducer(state, { type: "overlay.close" });
		expect(state.interaction.overlay).toEqual({ state: "closed" });
		// 已关闭时再 close 是稳定 unchanged
		const closed = state;
		expect(tuiReducer(state, { type: "overlay.close" })).toBe(closed);
	});

	it("composer change derives composerEmpty; identical draft is unchanged", () => {
		let state = initialState();
		state = tuiReducer(state, { type: "composer.changed", draft: draft("hello") });
		expect(state.interaction.composerDraft.text).toBe("hello");
		expect(state.interaction.composerEmpty).toBe(false);
		state = tuiReducer(state, { type: "composer.changed", draft: draft("") });
		expect(state.interaction.composerEmpty).toBe(true);
		const before = state;
		expect(tuiReducer(state, { type: "composer.changed", draft: draft("") })).toBe(before);
	});

	it("selection / search / viewport-clear are pure transitions", () => {
		let state = initialState();
		state = tuiReducer(state, { type: "interaction.select", id: "item-1" });
		expect(state.interaction.selectedId).toEqual({ state: "known", value: "item-1" });
		expect(tuiReducer(state, { type: "interaction.select", id: "" })).toBe(state);
		state = tuiReducer(state, { type: "interaction.search-changed", query: "gro" });
		expect(state.interaction.search).toEqual({ state: "known", value: "gro" });
		state = tuiReducer(state, { type: "interaction.search-changed", query: "" });
		expect(state.interaction.search.state).toBe("unknown");
		const revision = state.interaction.viewportClearRevision;
		state = tuiReducer(state, { type: "interaction.viewport-clear" });
		expect(state.interaction.viewportClearRevision).toBe(revision + 1);
	});

	it("session.replace validates non-empty id and bumps interaction generation", () => {
		const state = initialState();
		expect(tuiReducer(state, { type: "session.replace", generation: 1, sessionId: "" })).toBe(state);
		expect(tuiReducer(state, { type: "session.replace", generation: 1, sessionId: "session-1" })).toBe(state);
		const replaced = tuiReducer(state, { type: "session.replace", generation: 1, sessionId: "session-2" });
		expect(replaced.bootstrap.session.id).toBe("session-2");
		expect(replaced.bootstrap.session.format).toBe("current-canonical");
		expect(replaced.interaction.generation).toBe(state.interaction.generation + 1);
	});

	it("command.submit records bounded history (cap 512)", () => {
		let state = initialState();
		for (let index = 0; index < 600; index += 1) {
			state = tuiReducer(state, {
				type: "command.submit",
				intent: {
					invocationId: `inv-${index}`,
					displayOrder: index,
					canonicalName: "cmd",
					normalizedArgs: [],
					catalogGeneration: 1,
					createdAt: "2026-08-06T00:00:00.000Z",
				},
			});
		}
		expect(state.commandOrder.length).toBe(512);
		expect(Object.keys(state.commandsById).length).toBe(512);
	});

	it("timeline.event delegates to the timeline reducer", () => {
		const state = initialState();
		const next = tuiReducer(state, {
			type: "timeline.event",
			event: { type: "notice", generation: 1, correlationId: "n-1", severity: "info", message: draft("note") },
		});
		expect(next.timeline.committedRows).toHaveLength(1);
		expect(next.timeline.committedRows[0]).toMatchObject({ kind: "notice" });
	});

	it("unknown action types return unchanged via safeReduce and never throw", () => {
		const state = initialState();
		expect(safeReduce(state, { type: "query.cancel", ref: { generation: 1, effectId: "e", correlationId: "c" } })).toBe(state);
		// 未知 action：reducer 默认分支返回 unchanged（穷举防护见 TUI_ACTION_TYPES）
		expect(tuiReducer(state, { type: "no.such-action" } as never)).toBe(state);
		expect(safeReduce(state, { type: "no.such-action" } as never)).toBe(state);
	});

	// ===== B5：provider/auth/model/thinking/prompt workflow =====

	function initialState(): ReturnType<typeof createInitialTuiState> {
		return createInitialTuiState({ bootstrap });
	}

	function workflowState() {
		return createInitialTuiState({
			bootstrap,
			capabilities: {
				auth: { state: "available" },
				model: { state: "available" },
				thinking: { state: "available" },
			},
		});
	}

	function start(state: ReturnType<typeof createInitialTuiState>, type: "auth.inspect" | "model.list" | "thinking.select", correlationId: string) {
		return tuiReducer(state, {
			type: "query.start",
			effect: { type, generation: 1, effectId: "e-1", correlationId } as never,
		});
	}

	it("B5: query.start moves provider/auth/model/thinking into loading with requestId", () => {
		let state = workflowState();
		state = start(state, "auth.inspect", "corr-auth");
		expect(state.authWorkflow).toMatchObject({ state: "loading", requestId: "corr-auth" });
		state = start(state, "model.list", "corr-model");
		expect(state.modelWorkflow).toMatchObject({ state: "loading", requestId: "corr-model" });
		state = start(state, "thinking.select", "corr-thinking");
		expect(state.thinkingWorkflow).toMatchObject({ state: "loading", requestId: "corr-thinking" });
	});

	it("B5: completed mutation result commits only when correlation matches", () => {
		let state = workflowState();
		state = start(state, "model.list", "corr-model");
		const wrong = tuiReducer(state, {
			type: "query.result",
			result: { status: "completed", ref: { generation: 1, effectId: "e-1", correlationId: "corr-other" }, value: { providerId: "p", modelId: "m", generation: 1 } },
		});
		expect(wrong.modelWorkflow.state).toBe("loading");
		const right = tuiReducer(state, {
			type: "query.result",
			result: { status: "completed", ref: { generation: 1, effectId: "e-1", correlationId: "corr-model" }, value: { providerId: "p", modelId: "m", generation: 1 } },
		});
		expect(right.modelWorkflow.state).toBe("ready");
	});

	it("B5: stale/aborted results exit loading to idle (waiter never hangs); failed keeps prior selection", () => {
		let state = workflowState();
		state = start(state, "auth.inspect", "corr-auth");
		state = tuiReducer(state, { type: "query.result", result: { status: "stale", ref: { generation: 1, effectId: "e-1", correlationId: "corr-auth" }, currentGeneration: 2 } });
		expect(state.authWorkflow.state).toBe("idle");
		state = start(state, "auth.inspect", "corr-auth2");
		state = tuiReducer(state, { type: "query.result", result: { status: "aborted", ref: { generation: 1, effectId: "e-1", correlationId: "corr-auth2" }, reason: "cancelled" } });
		expect(state.authWorkflow.state).toBe("idle");
		state = start(state, "auth.inspect", "corr-auth3");
		state = tuiReducer(state, { type: "query.result", result: { status: "failed", ref: { generation: 1, effectId: "e-1", correlationId: "corr-auth3" }, error: { code: "boom", message: "x", retryable: true } } });
		expect(state.authWorkflow.state).toBe("error");
		expect((state.authWorkflow as { code: string }).code).toBe("boom");
	});

	it("B5: stale/aborted results for an UNKNOWN correlation do not touch the current loading", () => {
		let state = workflowState();
		state = start(state, "auth.inspect", "corr-current");
		state = tuiReducer(state, { type: "query.result", result: { status: "stale", ref: { generation: 1, effectId: "e-old", correlationId: "corr-old" }, currentGeneration: 2 } });
		expect(state.authWorkflow.state).toBe("loading");
	});

	it("P2: stale/aborted results from an older generation do not reset a reused request fence", () => {
		let state = workflowState();
		state = tuiReducer(state, {
			type: "query.start",
			effect: { type: "auth.inspect", generation: 2, effectId: "same-effect", correlationId: "same-corr" },
		});
		const next = tuiReducer(state, {
			type: "query.result",
			result: { status: "aborted", ref: { generation: 1, effectId: "same-effect", correlationId: "same-corr" }, reason: "old cancellation" },
		});
		expect(next.authWorkflow).toMatchObject({ state: "loading", generation: 2 });
	});

	it("P1-1: result with matching correlationId but old effectId/generation cannot land", () => {
		let state = workflowState();
		state = start(state, "model.list", "corr-m");
		expect(state.modelWorkflow).toMatchObject({ state: "loading", effectId: "e-1" });
		// 同 correlationId、旧 generation/effectId 的 completed 结果不得覆盖
		const stale = tuiReducer(state, {
			type: "query.result",
			result: { status: "completed", ref: { generation: 1, effectId: "e-0", correlationId: "corr-m" }, value: { providerId: "old", modelId: "old", generation: 1 } },
		});
		expect(stale.modelWorkflow.state).toBe("loading");
		// 正确 effectId + generation 才落地
		const landed = tuiReducer(state, {
			type: "query.result",
			result: { status: "completed", ref: { generation: 1, effectId: "e-1", correlationId: "corr-m" }, value: { providerId: "p", modelId: "m", generation: 1 } },
		});
		expect(landed.modelWorkflow.state).toBe("ready");
	});

	it("B5: uncertain mutation sets recoveryRequired and freezes conflicting operations", () => {
		let state = workflowState();
		state = start(state, "thinking.select", "corr-t");
		state = tuiReducer(state, {
			type: "query.result",
			result: {
				status: "uncertain",
				ref: { generation: 1, effectId: "e-1", correlationId: "corr-t" },
				error: { code: "unknown", message: "unclear", retryable: false, recoveryRequired: true },
				recoveryRequired: true,
			},
		});
		expect(state.recoveryRequired).toBe(true);
		expect(state.thinkingWorkflow.state).toBe("error");
	});

	it("B5: prompt workflow stays unavailable when the capability is missing", () => {
		const state = initialState();
		expect(state.promptWorkflow.state).toBe("unavailable");
		expect(state.capabilities.prompt.state).toBe("unavailable");
	});
});
