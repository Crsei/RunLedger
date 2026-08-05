import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AuthWorkflowState } from "../../../src/tui/auth/types.ts";
import type { AgentActivityWorkflowState } from "../../../src/tui/agents/types.ts";
import type { ApprovalWorkflowState } from "../../../src/tui/approval/types.ts";
import type { ExtensionWorkflowState } from "../../../src/tui/extensions/types.ts";
import type { PlanRenderWorkflowState } from "../../../src/tui/goal-plan/types.ts";
import type { KeymapWorkflowState } from "../../../src/tui/keymap/types.ts";
import type { ModelWorkflowState } from "../../../src/tui/models/types.ts";
import type { PromptWorkflowState } from "../../../src/tui/prompts/types.ts";
import type { ProcessPassiveWorkflowState } from "../../../src/tui/process/types.ts";
import type { ProviderWorkflowState } from "../../../src/tui/providers/types.ts";
import type { DurableQueueWorkflowState } from "../../../src/tui/queue/types.ts";
import type { RuntimeSnapshotWorkflowState } from "../../../src/tui/runtime-snapshot/types.ts";
import type { SecurityModeWorkflowState } from "../../../src/tui/security-mode/types.ts";
import type { ShutdownWorkflowState } from "../../../src/tui/shutdown/types.ts";
import type { TaskGoalWorkflowState } from "../../../src/tui/task-goal/types.ts";
import type { ThinkingWorkflowState } from "../../../src/tui/thinking/types.ts";
import type { UpdateWorkflowState } from "../../../src/tui/update/types.ts";
import type { WorkspaceGitWorkflowState } from "../../../src/tui/workspace/types.ts";

const contractFiles = [
	"src/tui/providers/types.ts",
	"src/tui/auth/types.ts",
	"src/tui/models/types.ts",
	"src/tui/thinking/types.ts",
	"src/tui/prompts/types.ts",
	"src/tui/keymap/types.ts",
	"src/tui/queue/types.ts",
	"src/tui/approval/types.ts",
	"src/tui/task-goal/types.ts",
	"src/tui/goal-plan/types.ts",
	"src/tui/agents/types.ts",
	"src/tui/extensions/types.ts",
	"src/tui/runtime-snapshot/types.ts",
	"src/tui/security-mode/types.ts",
	"src/tui/shutdown/types.ts",
	"src/tui/workspace/types.ts",
	"src/tui/process/types.ts",
	"src/tui/update/types.ts",
] as const;

const unknownField = { state: "unknown", reason: "authority did not report" } as const;
const unavailable = { state: "unavailable", reason: "port not assembled" } as const;

describe("passive runtime workflow contracts", () => {
	it("has one type-only contract module per planned workflow domain", () => {
		for (const relativePath of contractFiles) {
			const path = join(process.cwd(), relativePath);
			expect(existsSync(path)).toBe(true);
			expect(readFileSync(path, "utf8")).toContain("export");
		}
	});

	it("represents unavailable authority explicitly across workflow state unions", () => {
		const states: unknown[] = [
			{ state: "unavailable", reason: unavailable.reason } satisfies ProviderWorkflowState,
			{ state: "unavailable", reason: unavailable.reason } satisfies AuthWorkflowState,
			{ state: "unavailable", reason: unavailable.reason } satisfies ModelWorkflowState,
			{ state: "unavailable", reason: unavailable.reason } satisfies ThinkingWorkflowState,
			{ state: "unavailable", reason: unavailable.reason } satisfies PromptWorkflowState,
			{ state: "unavailable", reason: unavailable.reason } satisfies KeymapWorkflowState,
			{ state: "unavailable", reason: unavailable.reason } satisfies DurableQueueWorkflowState,
			{ state: "unavailable", reason: unavailable.reason } satisfies ApprovalWorkflowState,
			{ state: "unavailable", reason: unavailable.reason } satisfies TaskGoalWorkflowState,
			{ state: "unavailable", reason: unavailable.reason } satisfies PlanRenderWorkflowState,
			{ state: "unavailable", reason: unavailable.reason } satisfies AgentActivityWorkflowState,
			{ state: "unavailable", reason: unavailable.reason } satisfies ExtensionWorkflowState,
			{ state: "unavailable", reason: unavailable.reason } satisfies RuntimeSnapshotWorkflowState,
			{ state: "unavailable", reason: unavailable.reason } satisfies SecurityModeWorkflowState,
			{ state: "unavailable", reason: unavailable.reason } satisfies ShutdownWorkflowState,
			{ state: "unavailable", reason: unavailable.reason } satisfies WorkspaceGitWorkflowState,
			{ state: "unavailable", reason: unavailable.reason } satisfies ProcessPassiveWorkflowState,
			{ state: "unavailable", reason: unavailable.reason } satisfies UpdateWorkflowState,
		];
		expect(states).toHaveLength(18);
		expect(structuredClone(states)).toEqual(states);
	});

	it("keeps authority revisions and unknown quantities instead of zero sentinels", () => {
		const snapshot = {
			authorityGeneration: 4,
			sourceRevision: unknownField,
			counts: {
				queued: unknownField,
				claimed: unknownField,
				tools: unknownField,
				agents: unknownField,
			},
			port: unavailable,
		};
		expect(snapshot.counts.queued.state).toBe("unknown");
		expect(snapshot.counts.tools).not.toEqual({ state: "known", value: 0 });
		expect(structuredClone(snapshot)).toEqual(snapshot);
	});

	it("does not put runtime execution, secret, or renderer dependencies in workflow source", () => {
		const paths = contractFiles.map((relativePath) => join(process.cwd(), relativePath));
		const missing = paths.filter((path) => !existsSync(path));
		expect(missing).toEqual([]);
		if (missing.length > 0) return;
		const sources = paths.map((path) => readFileSync(path, "utf8"));
		for (const source of sources) {
			expect(source).not.toMatch(/from ["']node:/u);
			expect(source).not.toMatch(/@opentui\/core|@earendil-works\/pi-tui|execution-env|controller-adapter/u);
			expect(source).not.toMatch(/\b(?:readFile|writeFile|fetch|spawn|exec|setTimeout)\s*\(/u);
			expect(source).not.toMatch(/\b(?:rawArgs|base64|secretValue|environmentVariables|beforeText|afterText)\b/u);
			expect(source).not.toMatch(/\b(?:class|function|const)\s+[A-Za-z_]/u);
		}
	});
});
