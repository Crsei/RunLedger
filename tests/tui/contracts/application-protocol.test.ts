import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TuiAction } from "../../../src/tui/application/action.ts";
import type { TuiEffect } from "../../../src/tui/application/effect.ts";
import type { TuiResult, TuiResultStatus } from "../../../src/tui/application/result.ts";
import type { TuiState } from "../../../src/tui/application/state.ts";
import type { CorrelatedRequestRef } from "../../../src/tui/application/common.ts";
import type { TimelineState } from "../../../src/tui/timeline/types.ts";
import type { TuiBootstrapSnapshot } from "../../../src/tui/presentation/types.ts";

const protocolFiles = [
	"src/tui/application/state.ts",
	"src/tui/application/action.ts",
	"src/tui/application/effect.ts",
	"src/tui/application/result.ts",
	"src/tui/application/types.ts",
] as const;

const unavailable = { state: "unavailable", reason: "not assembled" } as const;
const unknown = { state: "unknown", reason: "authority did not report" } as const;

const bootstrap: TuiBootstrapSnapshot = {
	workspaceLabel: "workspace",
	session: { id: "session-1", format: "current-canonical", lifecycle: "active" },
	authorityGeneration: 1,
};

const timeline: TimelineState = {
	generation: 1,
	committedRows: [],
	activeRowsByCorrelationId: {},
	activeOrder: [],
	cursor: { messageIndex: 0 },
};

describe("passive TUI application protocol", () => {
	it("has only the planned type-only application modules", () => {
		for (const relativePath of protocolFiles) {
			const path = join(process.cwd(), relativePath);
			expect(existsSync(path)).toBe(true);
			expect(readFileSync(path, "utf8")).toContain("export");
		}
	});

	it("aggregates workflow state without introducing a second authority", () => {
		const state: TuiState = {
			bootstrap,
			authorityGeneration: 1,
			capabilities: {
				sessionCatalog: unavailable,
				sessionMutation: unavailable,
				provider: unavailable,
				auth: unavailable,
				model: unavailable,
				thinking: unavailable,
				prompt: unavailable,
				keymap: unavailable,
				queue: unavailable,
				approval: unavailable,
				taskGoal: unavailable,
				plan: unavailable,
				agents: unavailable,
				extensions: unavailable,
				runtimeSnapshot: unavailable,
				securityMode: unavailable,
				shutdown: unavailable,
				workspaceGit: unavailable,
				process: unavailable,
				update: unavailable,
			},
			queryGuard: { state: "idle" },
			commandsById: {},
			commandOrder: [],
			transientInputQueue: [],
			timeline,
			sessionWorkflow: { state: "unavailable", reason: "not assembled" },
			providerWorkflow: { state: "unavailable", reason: "not assembled" },
			authWorkflow: { state: "unavailable", reason: "not assembled" },
			modelWorkflow: { state: "unavailable", reason: "not assembled" },
			thinkingWorkflow: { state: "unavailable", reason: "not assembled" },
			promptWorkflow: { state: "unavailable", reason: "not assembled" },
			keymapWorkflow: { state: "unavailable", reason: "not assembled" },
			queueWorkflow: { state: "unavailable", reason: "not assembled" },
			approvalWorkflow: { state: "unavailable", reason: "not assembled" },
			taskGoalWorkflow: { state: "unavailable", reason: "not assembled" },
			planWorkflow: { state: "unavailable", reason: "not assembled" },
			agentWorkflow: { state: "unavailable", reason: "not assembled" },
			extensionWorkflow: { state: "unavailable", reason: "not assembled" },
			runtimeSnapshotWorkflow: { state: "unavailable", reason: "not assembled" },
			securityModeWorkflow: { state: "unavailable", reason: "not assembled" },
			shutdownWorkflow: { state: "unavailable", reason: "not assembled" },
			workspaceGitWorkflow: { state: "unavailable", reason: "not assembled" },
			processWorkflow: { state: "unavailable", reason: "not assembled" },
			updateWorkflow: { state: "unavailable", reason: "not assembled" },
			interaction: {
				overlay: { state: "closed" },
				search: unknown,
				selectedId: unknown,
				generation: 1,
				viewportClearRevision: 0,
				transcriptScrollbarVisible: false,
				toolDetailsExpanded: false,
				composerEmpty: true,
				transitionFrozen: false,
			},
			activeTurn: unknown,
			steeringCount: unknown,
			followUpCount: unknown,
			claimedQueueCount: unknown,
			pendingApprovalCount: unknown,
			transitionFrozen: false,
			recoveryRequired: false,
		};
		expect(structuredClone(state)).toEqual(state);
		expect(state).not.toHaveProperty("renderer");
		expect(state).not.toHaveProperty("controller");
		expect(state).not.toHaveProperty("storage");
	});

	it("keeps actions pure and effects correlated with expected revisions", () => {
		const ref: CorrelatedRequestRef = { generation: 2, effectId: "effect-1", correlationId: "correlation-1" };
		const actions: TuiAction[] = [
			{ type: "overlay.open", overlay: { state: "command", requestId: "request-1" } },
			{ type: "overlay.close" },
			{ type: "command.submit", intent: { invocationId: "invocation-1", displayOrder: 1, canonicalName: "help", normalizedArgs: [], catalogGeneration: 1, createdAt: "2026-08-05T00:00:00.000Z" } },
			{ type: "timeline.event", event: { type: "cleanup", generation: 2, correlationId: ref.correlationId, reason: "abort" } },
			{ type: "query.cancel", ref },
			{ type: "session.replace", generation: 3, sessionId: "session-2" },
			{ type: "composer.changed", draft: { text: "hello", truncated: false, byteLength: 5 } },
		];
		const effects: TuiEffect[] = [
			{ type: "provider.list", ...ref },
			{ type: "approval.resolve", ...ref, approvalId: "approval-1", expectedDecisionRevision: 4, decision: "denied" },
			{ type: "queue.cancel", ...ref, itemId: "queue-1", expectedQueueRevision: 4, reason: "user" },
			{ type: "process.output", ...ref, executionId: "execution-1", cursor: "cursor-1" },
			{ type: "shutdown.request", ...ref, trigger: "user" },
		];
		expect(structuredClone({ actions, effects })).toEqual({ actions, effects });
	});

	it("represents completed, stale, aborted, and uncertain result outcomes explicitly", () => {
		const ref: CorrelatedRequestRef = { generation: 2, effectId: "effect-1", correlationId: "correlation-1" };
		const statuses: TuiResultStatus[] = ["completed", "failed", "stale", "aborted", "uncertain"];
		const results: TuiResult[] = [
			{ status: "completed", ref, value: { accepted: true } },
			{ status: "failed", ref, error: { code: "failed", message: "failed", retryable: true } },
			{ status: "stale", ref, currentGeneration: 3 },
			{ status: "aborted", ref, reason: "superseded" },
			{ status: "uncertain", ref, error: { code: "unknown_completion", message: "reconcile", retryable: false, recoveryRequired: true }, recoveryRequired: true },
		];
		expect(statuses).toHaveLength(5);
		expect(structuredClone(results)).toEqual(results);
	});

	it("keeps application contracts free of executable/runtime members", () => {
		const paths = protocolFiles.map((relativePath) => join(process.cwd(), relativePath));
		const missing = paths.filter((path) => !existsSync(path));
		expect(missing).toEqual([]);
		if (missing.length > 0) return;
		for (const path of paths) {
			const source = readFileSync(path, "utf8");
			expect(source).not.toMatch(/\b(?:Renderable|Component|Theme|Controller|Storage|AbortController|Promise|Map|setTimeout|fetch|spawn)\b/u);
			expect(source).not.toMatch(/\b(?:class|function|const)\s+[A-Za-z_]/u);
			expect(source).not.toMatch(/\brawArgs\b|\bcredential\b|\bbase64\b/u);
		}
	});
});
