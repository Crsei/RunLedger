import { describe, expect, it, vi } from "vitest";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { validateTaskDag } from "../../../src/runtime/orchestrator/task-dag.ts";
import type { OrchestratorTask, TaskDag } from "../../../src/runtime/orchestrator/types.ts";
import { digest } from "./helpers.ts";

function task(taskId: string, dependsOn: readonly string[] = []): OrchestratorTask {
	return {
		taskId,
		owner: { kind: "agent", id: createRuntimeId("agent", `owner-${taskId}`) },
		dependsOn,
		expectedArtifacts: [{ kind: "test_report", mediaType: "application/json", logicalName: `${taskId}-report` }],
		workspace: {
			workspaceId: createRuntimeId("workspace", "dag"),
			bindingRevision: 4,
			bindingDigest: digest("a"),
		},
		capabilities: [
			{
				receiptId: createRuntimeId("receipt", `cap-${taskId}`),
				capability: "workspace_write",
				decisionRevision: 2,
				receiptDigest: digest("b"),
			},
		],
	};
}

function dag(tasks: readonly OrchestratorTask[]): TaskDag {
	return { goalId: createRuntimeId("goal", "dag"), revision: 1, tasks };
}

const validPorts = () => ({
	workspace: { validate: vi.fn(async () => ({ status: "valid" as const })) },
	capability: { validate: vi.fn(async () => ({ status: "valid" as const })) },
});

describe("Task DAG validation", () => {
	it("returns a deterministic topological order and validates opaque refs through injected ports", async () => {
		const ports = validPorts();
		const result = await validateTaskDag(dag([task("test", ["build"]), task("plan"), task("build", ["plan"])]), ports);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.topologicalOrder).toEqual(["plan", "build", "test"]);
		expect(result.value.workspaceReferenceCount).toBe(1);
		expect(result.value.capabilityReferenceCount).toBe(3);
		expect(ports.workspace.validate).toHaveBeenCalledTimes(1);
		expect(ports.capability.validate).toHaveBeenCalledTimes(3);
	});

	it.each([
		["missing dependency", [task("a", ["missing"])]],
		["self dependency", [task("a", ["a"])]],
		["cycle", [task("a", ["b"]), task("b", ["a"])]],
		["duplicate task", [task("a"), task("a")]],
		["missing expected artifact", [{ ...task("a"), expectedArtifacts: [] }]],
		["missing capability", [{ ...task("a"), capabilities: [] }]],
	] as const)("rejects %s before external validation", async (_name, tasks) => {
		const ports = validPorts();
		const result = await validateTaskDag(dag(tasks), ports);
		expect(result.ok).toBe(false);
		expect(ports.workspace.validate).not.toHaveBeenCalled();
		expect(ports.capability.validate).not.toHaveBeenCalled();
	});

	it("rejects inconsistent workspace versions across tasks", async () => {
		const first = task("a");
		const second = task("b");
		const result = await validateTaskDag(
			dag([{ ...first }, { ...second, workspace: { ...second.workspace, bindingRevision: 5 } }]),
			validPorts(),
		);
		expect(result.ok).toBe(false);
	});

	it("fails closed for stale, missing or throwing external references", async () => {
		const stale = await validateTaskDag(dag([task("a")]), {
			workspace: { validate: async () => ({ status: "stale", reasonDigest: digest("c") }) },
			capability: { validate: async () => ({ status: "valid" }) },
		});
		expect(stale.ok).toBe(false);
		if (!stale.ok) expect(stale.error.code).toBe("reference_unavailable");

		const unavailable = await validateTaskDag(dag([task("a")]), {
			workspace: { validate: async () => ({ status: "valid" }) },
			capability: {
				validate: async () => {
					throw new Error("adapter down");
				},
			},
		});
		expect(unavailable.ok).toBe(false);
		if (!unavailable.ok) expect(unavailable.error.retryable).toBe(true);
	});
});
