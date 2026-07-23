import { describe, expect, it } from "vitest";
import { AgentSupervisor } from "../../../src/runtime/agents/supervisor.ts";
import { createAgentResidencyReceipt } from "../../../src/runtime/agents/residency.ts";
import type {
	AgentGraphCommitOutcome,
	AgentGraphSemanticCommand,
	AgentGraphStoreHead,
	AgentResult,
	DurableAgentGraphStorePort,
} from "../../../src/runtime/agents/types.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId, type AgentId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	digest,
	key,
	rootRegistration,
	runtimeFakes,
	spawnRequest,
	zeroUsage,
} from "./helpers.ts";

class RecordingGraphStore implements DurableAgentGraphStorePort {
	public readonly commands: AgentGraphSemanticCommand[] = [];
	public failOnce: AgentGraphSemanticCommand["type"] | undefined;
	readonly #delegate: DurableAgentGraphStorePort;

	public constructor(delegate: DurableAgentGraphStorePort) {
		this.#delegate = delegate;
	}

	public load(rootAgentId: AgentId): Promise<AgentResult<AgentGraphStoreHead>> {
		return this.#delegate.load(rootAgentId);
	}

	public commit(
		rootAgentId: AgentId,
		expectedRevision: number,
		command: AgentGraphSemanticCommand,
	): Promise<AgentResult<AgentGraphCommitOutcome>> {
		this.commands.push(command);
		if (this.failOnce === command.type) {
			this.failOnce = undefined;
			return Promise.resolve({
				ok: false,
				error: {
					code: "store_unavailable",
					message: `injected ${command.type} append failure`,
					retryable: true,
				},
			});
		}
		return this.#delegate.commit(rootAgentId, expectedRevision, command);
	}
}

async function spawnedRuntime() {
	const runtime = runtimeFakes();
	const root = rootRegistration();
	const store = new RecordingGraphStore(runtime.store);
	const supervisor = new AgentSupervisor({
		rootAgentId: root.agentId,
		ports: { ...runtime.ports, graphStore: store },
		clock: () => new Date("2026-07-22T02:00:00.000Z"),
	});
	expect((await supervisor.registerRoot(root)).ok).toBe(true);
	const spawned = await supervisor.spawn(spawnRequest(root.capabilityGrant));
	if (!spawned.ok) throw new Error(spawned.error.message);
	return { ...runtime, root, store, supervisor, child: spawned.value.node };
}

function terminalRequest(agentId: AgentId, suffix = "") {
	const seed = suffix ? `cleanup-saga-terminal-${suffix}` : "cleanup-saga-terminal";
	return {
		requestId: createRuntimeId("command", seed),
		idempotencyKey: key(seed),
		agentId,
		outcome: "failed" as const,
		reason: "crash" as const,
		usage: zeroUsage(),
	};
}

describe("Agent child cleanup saga", () => {
	it("rejects a terminal child without exact usage before semantic state mutation", async () => {
		const runtime = await spawnedRuntime();
		const request = {
			requestId: createRuntimeId("command", "cleanup-saga-missing-usage"),
			idempotencyKey: key("cleanup-saga-missing-usage"),
			agentId: runtime.child.agentId,
			outcome: "failed" as const,
			reason: "crash" as const,
		};

		expect(await runtime.supervisor.finish(request)).toMatchObject({
			ok: false,
			error: { code: "invalid_request" },
		});
		const graph = await runtime.supervisor.graph();
		expect(graph.ok && graph.value.nodes.get(runtime.child.agentId)).toMatchObject({
			state: "running",
			residency: { state: "resident" },
		});
		expect(graph.ok && graph.value.nodes.get(runtime.child.agentId)?.terminal).toBeUndefined();
		expect(graph.ok && graph.value.cleanups.has(runtime.child.agentId)).toBe(false);
		expect(runtime.launcher.releases).toHaveLength(0);
		expect(runtime.workspace.releases).toHaveLength(0);
		expect(runtime.budget.settlements).toHaveLength(0);
	});

	it.each([
		["completed", "crash"],
		["stopped", "crash"],
		["failed", "cancelled"],
	] as const)("rejects contradictory terminal outcome %s and reason %s", async (outcome, reason) => {
		const runtime = await spawnedRuntime();
		expect(await runtime.supervisor.finish({
			requestId: createRuntimeId("command", `cleanup-saga-invalid-${outcome}-${reason}`),
			idempotencyKey: key(`cleanup-saga-invalid-${outcome}-${reason}`),
			agentId: runtime.child.agentId,
			outcome,
			reason,
			usage: zeroUsage(),
		})).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		const graph = await runtime.supervisor.graph();
		expect(graph.ok && graph.value.nodes.get(runtime.child.agentId)?.state).toBe("running");
		expect(graph.ok && graph.value.cleanups.has(runtime.child.agentId)).toBe(false);
	});

	it("rejects an interrupted child without exact usage before residency mutation", async () => {
		const runtime = await spawnedRuntime();
		if (!runtime.child.residency) throw new Error("spawned child lacks residency");
		const unavailable = createAgentResidencyReceipt({
			agentId: runtime.child.agentId,
			sessionId: runtime.child.sessionId,
			runtimeInstanceId: runtime.child.residency.runtimeInstanceId,
			state: "unavailable",
			revision: runtime.child.residency.revision + 1,
			observedAt: "2026-07-22T01:59:59.000Z",
			reasonDigest: digest("6"),
		});
		if (!unavailable.ok) throw new Error(unavailable.error.message);

		expect(await runtime.supervisor.interrupt(
			runtime.child.agentId,
			"timeout",
			unavailable.value,
			key("cleanup-saga-missing-usage"),
		)).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		const graph = await runtime.supervisor.graph();
		expect(graph.ok && graph.value.nodes.get(runtime.child.agentId)).toMatchObject({
			state: "running",
			residency: runtime.child.residency,
		});
		expect(runtime.launcher.releases).toHaveLength(0);
		expect(runtime.workspace.releases).toHaveLength(0);
		expect(runtime.budget.settlements).toHaveLength(0);
	});

	it("durably orders semantic terminal, runtime release, Workspace release, budget settlement, and completion", async () => {
		const runtime = await spawnedRuntime();
		const order: string[] = [];
		const originalCommit = runtime.store.commit.bind(runtime.store);
		runtime.store.commit = async (...args) => {
			order.push(`graph:${args[2].type}`);
			return originalCommit(...args);
		};
		const originalRuntimeRelease = runtime.launcher.release.bind(runtime.launcher);
		runtime.launcher.release = async (...args) => {
			order.push("external:runtime");
			return originalRuntimeRelease(...args);
		};
		const originalWorkspaceRelease = runtime.workspace.release.bind(runtime.workspace);
		runtime.workspace.release = async (...args) => {
			order.push("external:workspace");
			return originalWorkspaceRelease(...args);
		};
		const originalBudgetSettle = runtime.budget.settle.bind(runtime.budget);
		runtime.budget.settle = async (...args) => {
			order.push("external:budget");
			return originalBudgetSettle(...args);
		};

		const request = terminalRequest(runtime.child.agentId);
		const finished = await runtime.supervisor.finish(request);
		expect(finished.ok).toBe(true);
		if (!finished.ok) return;
		expect(order).toEqual([
			"graph:agent.failed",
			"graph:agent.cleanup_requested",
			"external:runtime",
			"graph:agent.runtime_released",
			"external:workspace",
			"graph:agent.workspace_released",
			"external:budget",
			"graph:agent.budget_settled",
			"graph:agent.cleanup_completed",
		]);
		expect(finished.value.nodes.get(runtime.child.agentId)).toMatchObject({
			state: "failed",
			residency: { state: "nonresident" },
			workspaceReceipt: { status: "released" },
		});
		expect(finished.value.cleanups.get(runtime.child.agentId)).toMatchObject({
			runtimeRelease: { receipt: { receiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) } },
			workspaceRelease: { receipt: { status: "released" } },
			budgetSettlement: { receipt: { outcome: "failed" } },
			completionReceipt: { receiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) },
		});

		expect((await runtime.supervisor.finish(request)).ok).toBe(true);
		expect(runtime.launcher.releaseExecutions).toBe(1);
		expect(runtime.workspace.releaseExecutions).toBe(1);
		expect(runtime.budget.settlementExecutions).toBe(1);
		expect(await runtime.supervisor.finish({
			...request,
			idempotencyKey: "short" as typeof request.idempotencyKey,
		})).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		expect(await runtime.supervisor.finish({
			...request,
			idempotencyKey: key("cleanup-saga-terminal-drift"),
		})).toMatchObject({ ok: false, error: { code: "invalid_transition" } });
	});

	it("stops before Workspace and budget when runtime release is uncertain, then resumes the exact missing stage", async () => {
		const runtime = await spawnedRuntime();
		runtime.launcher.releaseError = {
			code: "reference_unavailable",
			message: "injected runtime release uncertainty",
			retryable: true,
		};
		const request = terminalRequest(runtime.child.agentId);
		expect(await runtime.supervisor.finish(request)).toMatchObject({
			ok: false,
			error: { code: "reference_unavailable" },
		});
		const pending = await runtime.supervisor.graph();
		expect(pending.ok && pending.value.nodes.get(runtime.child.agentId)?.state).toBe("failed");
		expect(pending.ok && pending.value.nodes.get(runtime.child.agentId)?.residency?.state).toBe("resident");
		expect(pending.ok && pending.value.cleanups.get(runtime.child.agentId)?.reconciliationRequired).toMatchObject({
			stage: "runtime_release",
			error: { outcomeCertain: false, effect: "uncertain" },
		});
		expect(runtime.workspace.releases).toHaveLength(0);
		expect(runtime.budget.settlements).toHaveLength(0);

		runtime.launcher.releaseError = undefined;
		const reconciled = await runtime.supervisor.reconcilePendingCleanups();
		expect(reconciled.ok && reconciled.value.cleanups.get(runtime.child.agentId)?.completionReceipt).toBeDefined();
	});

	it("continues reconciling independent terminal children after an earlier runtime release failure", async () => {
		const runtime = runtimeFakes();
		const root = rootRegistration();
		expect((await runtime.supervisor.registerRoot(root)).ok).toBe(true);
		const first = await runtime.supervisor.spawn(spawnRequest(root.capabilityGrant));
		const second = await runtime.supervisor.spawn(spawnRequest(root.capabilityGrant));
		if (!first.ok) throw new Error(first.error.message);
		if (!second.ok) throw new Error(second.error.message);

		const originalRelease = runtime.launcher.release.bind(runtime.launcher);
		let failEveryRelease = true;
		runtime.launcher.release = (request) => {
			if (failEveryRelease || request.agentId === first.value.node.agentId) {
				return Promise.resolve({
					ok: false,
					error: {
						code: "reference_unavailable",
						message: "injected first-child runtime release failure",
						retryable: true,
					},
				});
			}
			return originalRelease(request);
		};

		expect(await runtime.supervisor.finish(
			terminalRequest(first.value.node.agentId, "first"),
		)).toMatchObject({ ok: false, error: { code: "reference_unavailable" } });
		expect(await runtime.supervisor.finish(
			terminalRequest(second.value.node.agentId, "second"),
		)).toMatchObject({ ok: false, error: { code: "reference_unavailable" } });

		failEveryRelease = false;
		expect(await runtime.supervisor.reconcilePendingCleanups()).toMatchObject({
			ok: false,
			error: { code: "reference_unavailable" },
		});
		const graph = await runtime.supervisor.graph();
		expect(graph.ok && graph.value.cleanups.get(first.value.node.agentId)?.completionReceipt).toBeUndefined();
		expect(graph.ok && graph.value.cleanups.get(second.value.node.agentId)?.completionReceipt).toBeDefined();
		expect(runtime.launcher.releaseExecutions).toBe(1);
	});

	it("stops before budget when Workspace release is uncertain", async () => {
		const runtime = await spawnedRuntime();
		runtime.workspace.releaseError = {
			code: "workspace_invalid",
			message: "injected Workspace release uncertainty",
			retryable: true,
		};
		expect(await runtime.supervisor.finish(terminalRequest(runtime.child.agentId))).toMatchObject({ ok: false });
		const pending = await runtime.supervisor.graph();
		expect(pending.ok && pending.value.nodes.get(runtime.child.agentId)?.residency?.state).toBe("nonresident");
		expect(pending.ok && pending.value.nodes.get(runtime.child.agentId)?.workspaceReceipt.status).toBe("active");
		expect(pending.ok && pending.value.cleanups.get(runtime.child.agentId)?.reconciliationRequired?.stage).toBe("workspace_release");
		expect(runtime.budget.settlements).toHaveLength(0);
	});

	it("keeps cleanup incomplete when budget settlement is uncertain", async () => {
		const runtime = await spawnedRuntime();
		runtime.budget.settlementError = {
			code: "store_unavailable",
			message: "injected budget settlement uncertainty",
			retryable: true,
		};
		expect(await runtime.supervisor.finish(terminalRequest(runtime.child.agentId))).toMatchObject({ ok: false });
		const pending = await runtime.supervisor.graph();
		expect(pending.ok && pending.value.cleanups.get(runtime.child.agentId)).toMatchObject({
			runtimeRelease: expect.any(Object),
			workspaceRelease: expect.any(Object),
			reconciliationRequired: { stage: "budget_settlement" },
		});
		expect(pending.ok && pending.value.cleanups.get(runtime.child.agentId)?.completionReceipt).toBeUndefined();
	});

	it("routes parent cancellation through semantic stopped and the same typed release saga", async () => {
		const runtime = await spawnedRuntime();
		const request = {
			requestId: createRuntimeId("command", "cleanup-saga-cancel"),
			idempotencyKey: key("cleanup-saga-cancel"),
			agentId: runtime.child.agentId,
		};
		const reasonEvidenceDigest = digest("9");
		const cancelled = await runtime.supervisor.cancel(
			request,
			reasonEvidenceDigest,
			zeroUsage(),
		);
		expect(cancelled.ok && cancelled.value.nodes.get(runtime.child.agentId)).toMatchObject({
			state: "stopped",
			residency: { state: "nonresident" },
			workspaceReceipt: { status: "released" },
		});
		expect(cancelled.ok && cancelled.value.cleanups.get(runtime.child.agentId)?.completionReceipt).toBeDefined();
		expect(runtime.launcher.cancelCalls).toBe(0);
		expect(runtime.launcher.releaseExecutions).toBe(1);
	});

	it("binds cancellation reason evidence into the semantic terminal and cleanup identity", async () => {
		const runtime = await spawnedRuntime();
		const request = {
			requestId: createRuntimeId("command", "cleanup-saga-cancel-evidence"),
			idempotencyKey: key("cleanup-saga-cancel-evidence"),
			agentId: runtime.child.agentId,
		};
		const reasonEvidenceDigest = digest("8");
		const usage = zeroUsage();
		const cancelled = await runtime.supervisor.cancel(request, reasonEvidenceDigest, usage);
		expect(cancelled.ok).toBe(true);
		if (!cancelled.ok) return;

		const expectedRequestDigest = canonicalDigest({
			...request,
			outcome: "stopped",
			reason: "cancelled",
			reasonEvidenceDigest,
			usage,
			partialResults: [],
		});
		const expectedTerminalDigest = canonicalDigest({
			requestId: request.requestId,
			requestDigest: expectedRequestDigest,
			outcome: "stopped",
			reason: "cancelled",
			reasonEvidenceDigest,
			usage,
			partialResults: [],
		});
		const node = cancelled.value.nodes.get(runtime.child.agentId);
		const cleanup = cancelled.value.cleanups.get(runtime.child.agentId);
		expect(node?.terminal).toMatchObject({
			reasonEvidenceDigest,
			requestDigest: expectedRequestDigest,
			terminalDigest: expectedTerminalDigest,
		});
		expect(cleanup).toMatchObject({
			terminalDigest: expectedTerminalDigest,
			completionReceipt: { terminalDigest: expectedTerminalDigest },
		});
	});

	it("rejects an exact cancellation retry when its reason evidence digest drifts", async () => {
		const runtime = await spawnedRuntime();
		const request = {
			requestId: createRuntimeId("command", "cleanup-saga-cancel-reason-drift"),
			idempotencyKey: key("cleanup-saga-cancel-reason-drift"),
			agentId: runtime.child.agentId,
		};
		const usage = zeroUsage();
		expect(await runtime.supervisor.cancel(request, digest("7"), usage)).toMatchObject({ ok: true });
		expect(await runtime.supervisor.cancel(request, digest("7"), usage)).toMatchObject({ ok: true });
		expect(await runtime.supervisor.cancel(request, digest("6"), usage)).toMatchObject({
			ok: false,
			error: { code: "idempotency_conflict" },
		});
	});

	it("routes a terminal interruption through cleanup after durably recording unavailable residency", async () => {
		const runtime = await spawnedRuntime();
		if (!runtime.child.residency) throw new Error("spawned child lacks residency");
		const unavailable = createAgentResidencyReceipt({
			agentId: runtime.child.agentId,
			sessionId: runtime.child.sessionId,
			runtimeInstanceId: runtime.child.residency.runtimeInstanceId,
			state: "unavailable",
			revision: runtime.child.residency.revision + 1,
			observedAt: "2026-07-22T01:59:59.000Z",
			reasonDigest: digest("7"),
		});
		if (!unavailable.ok) throw new Error(unavailable.error.message);
		const interrupted = await runtime.supervisor.interrupt(
			runtime.child.agentId,
			"timeout",
			unavailable.value,
			key("cleanup-saga-timeout"),
			zeroUsage(),
		);
		expect(interrupted.ok && interrupted.value.nodes.get(runtime.child.agentId)).toMatchObject({
			state: "failed",
			residency: { state: "nonresident", revision: unavailable.value.revision + 1 },
		});
		expect(interrupted.ok && interrupted.value.cleanups.get(runtime.child.agentId)?.completionReceipt).toBeDefined();
		expect(runtime.launcher.releases[0]?.previousResidencyReceipt).toEqual(unavailable.value);
	});

	it.each([
		["timeout", "agent.failed", "failed"],
		["cancelled", "agent.stopped", "stopped"],
	] as const)(
		"retries an exact %s interruption after the residency commit wins but terminal append fails",
		async (cause, terminalType, terminalState) => {
			const runtime = await spawnedRuntime();
			if (!runtime.child.residency) throw new Error("spawned child lacks residency");
			const unavailable = createAgentResidencyReceipt({
				agentId: runtime.child.agentId,
				sessionId: runtime.child.sessionId,
				runtimeInstanceId: runtime.child.residency.runtimeInstanceId,
				state: "unavailable",
				revision: runtime.child.residency.revision + 1,
				observedAt: "2026-07-22T01:59:59.000Z",
				reasonDigest: digest(cause === "timeout" ? "4" : "5"),
			});
			if (!unavailable.ok) throw new Error(unavailable.error.message);
			const interruptionKey = key(`cleanup-saga-${cause}-append-retry`);
			runtime.store.failOnce = terminalType;

			expect(await runtime.supervisor.interrupt(
				runtime.child.agentId,
				cause,
				unavailable.value,
				interruptionKey,
				zeroUsage(),
			)).toMatchObject({ ok: false, error: { code: "store_unavailable" } });
			const halfCommitted = await runtime.supervisor.graph();
			expect(halfCommitted.ok && halfCommitted.value.nodes.get(runtime.child.agentId)).toMatchObject({
				state: "running",
				residency: unavailable.value,
			});

			const retried = await runtime.supervisor.interrupt(
				runtime.child.agentId,
				cause,
				unavailable.value,
				interruptionKey,
				zeroUsage(),
			);
			expect(retried.ok && retried.value.nodes.get(runtime.child.agentId)?.state).toBe(terminalState);
			expect(retried.ok && retried.value.cleanups.get(runtime.child.agentId)?.completionReceipt).toBeDefined();

			expect((await runtime.supervisor.interrupt(
				runtime.child.agentId,
				cause,
				unavailable.value,
				interruptionKey,
				zeroUsage(),
			)).ok).toBe(true);
			expect(runtime.store.commands.filter((command) => command.type === "agent.residency_changed")).toHaveLength(1);
			expect(runtime.launcher.releaseExecutions).toBe(1);
			expect(runtime.workspace.releaseExecutions).toBe(1);
			expect(runtime.budget.settlementExecutions).toBe(1);
		},
	);

	it.each([
		["agent.cleanup_requested", 0, 0, 0],
		["agent.runtime_released", 1, 0, 0],
		["agent.workspace_released", 1, 1, 0],
		["agent.budget_settled", 1, 1, 1],
	] as const)(
		"replays exact external receipts after a one-shot %s append failure",
		async (failedType, runtimeExecutions, workspaceExecutions, budgetExecutions) => {
			const runtime = await spawnedRuntime();
			runtime.store.failOnce = failedType;
			const request = terminalRequest(runtime.child.agentId);
			expect(await runtime.supervisor.finish(request)).toMatchObject({
				ok: false,
				error: { code: "store_unavailable" },
			});
			expect(runtime.launcher.releaseExecutions).toBe(runtimeExecutions);
			expect(runtime.workspace.releaseExecutions).toBe(workspaceExecutions);
			expect(runtime.budget.settlementExecutions).toBe(budgetExecutions);

			const retried = await runtime.supervisor.finish(request);
			expect(retried.ok && retried.value.cleanups.get(runtime.child.agentId)?.completionReceipt).toBeDefined();
			expect(runtime.launcher.releaseExecutions).toBe(1);
			expect(runtime.workspace.releaseExecutions).toBe(1);
			expect(runtime.budget.settlementExecutions).toBe(1);
		},
	);
});
