import { describe, expect, it } from "vitest";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	artifact,
	declassificationReceipt,
	inputSource,
	key,
	rootRegistration,
	runtimeFakes,
	spawnRequest,
} from "./helpers.ts";

describe("bounded agent supervisor", () => {
	it("rejects a root Workspace receipt whose body does not match its digest", async () => {
		const runtime = runtimeFakes();
		const root = rootRegistration();
		const result = await runtime.supervisor.registerRoot({
			...root,
			workspaceReceipt: {
				...root.workspaceReceipt,
				receiptDigest: "f".repeat(64),
			},
		});

		expect(result).toMatchObject({ ok: false, error: { code: "invalid_request" } });
	});

	it("rejects a root registration retry whose opaque grant fields drift behind the same digest", async () => {
		const runtime = runtimeFakes();
		const root = rootRegistration();
		expect((await runtime.supervisor.registerRoot(root)).ok).toBe(true);

		const drifted = await runtime.supervisor.registerRoot({
			...root,
			requestId: createRuntimeId("command", "register-root-drifted-grant"),
			idempotencyKey: key("register-root-drifted-grant"),
			capabilityGrant: {
				...root.capabilityGrant,
				decisionRevision: root.capabilityGrant.decisionRevision + 1,
			},
		});

		expect(drifted).toMatchObject({ ok: false, error: { code: "agent_exists" } });
	});

	it("spawns a child with independent session/workspace and durable receipts", async () => {
		const runtime = runtimeFakes();
		const root = rootRegistration();
		await runtime.supervisor.registerRoot(root);
		const request = spawnRequest(root.capabilityGrant);
		const result = await runtime.supervisor.spawn(request);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.node).toMatchObject({
			parentAgentId: root.agentId,
			sessionId: request.childSessionId,
			depth: 1,
			state: "running",
		});
		expect(result.value.node.workspaceReceipt.workspaceId).not.toBe(root.workspaceReceipt.workspaceId);
		expect(result.value.node.delegationReceipt?.receiptId).toBeDefined();
		expect(result.value.node.budgetReservation?.reservationId).toBeDefined();
		expect(runtime.launcher.launches).toHaveLength(1);
	});

	it("keeps a child pending when a started launcher response cannot prove its runtime receipts", async () => {
		const runtime = runtimeFakes();
		const root = rootRegistration();
		expect((await runtime.supervisor.registerRoot(root)).ok).toBe(true);
		const originalLaunch = runtime.launcher.launch.bind(runtime.launcher);
		runtime.launcher.launch = async (request) => {
			const launched = await originalLaunch(request);
			if (!launched.ok || launched.value.status !== "started") return launched;
			return {
				ok: true,
				value: {
					...launched.value,
					launchReceipt: {
						...launched.value.launchReceipt,
						receiptDigest: "f".repeat(64),
					},
				},
			};
		};

		const spawned = await runtime.supervisor.spawn(spawnRequest(root.capabilityGrant));
		expect(spawned).toMatchObject({
			ok: false,
			error: { code: "launch_failed", retryable: true },
		});
		const graph = await runtime.supervisor.graph();
		const child = graph.ok
			? [...graph.value.nodes.values()].find((node) => node.parentAgentId === root.agentId)
			: undefined;
		expect(child).toMatchObject({ state: "pending" });
		expect(child?.launchReceipt).toBeUndefined();
		expect(runtime.workspace.releases).toHaveLength(0);
		expect(runtime.budget.settlementExecutions).toBe(0);
	});

	it("does not run not-started cleanup while a retryable launcher failure may have created a runtime", async () => {
		const runtime = runtimeFakes();
		const root = rootRegistration();
		expect((await runtime.supervisor.registerRoot(root)).ok).toBe(true);
		runtime.launcher.launch = async () => ({
			ok: false,
			error: {
				code: "reference_unavailable",
				message: "child create outcome is uncertain",
				retryable: true,
			},
		});

		const spawned = await runtime.supervisor.spawn(
			spawnRequest(root.capabilityGrant),
		);
		expect(spawned).toMatchObject({
			ok: false,
			error: { code: "reference_unavailable", retryable: true },
		});
		const graph = await runtime.supervisor.graph();
		const child = graph.ok
			? [...graph.value.nodes.values()].find(
					(node) => node.parentAgentId === root.agentId,
				)
			: undefined;
		expect(child).toMatchObject({ state: "pending" });
		expect(runtime.workspace.releases).toHaveLength(0);
		expect(runtime.budget.settlementExecutions).toBe(0);
	});

	it("makes an identical retry idempotent without another evaluator or launch", async () => {
		const runtime = runtimeFakes();
		const root = rootRegistration();
		await runtime.supervisor.registerRoot(root);
		const request = spawnRequest(root.capabilityGrant);
		expect((await runtime.supervisor.spawn(request)).ok).toBe(true);
		expect((await runtime.supervisor.spawn(request)).ok).toBe(true);
		expect(runtime.capability.evaluations).toHaveLength(1);
		expect(runtime.workspace.allocations).toHaveLength(1);
		expect(runtime.launcher.launches).toHaveLength(1);
	});

	it("rejects a child that drops parent taint and forwards exact lineage to the launcher", async () => {
		const runtime = runtimeFakes();
		const source = inputSource("root-repository");
		const receipt = declassificationReceipt(source);
		const root = rootRegistration();
		root.inputSources = [source];
		root.declassificationReceipts = [receipt];
		expect((await runtime.supervisor.registerRoot(root)).ok).toBe(true);

		const dropped = await runtime.supervisor.spawn(spawnRequest(root.capabilityGrant));
		expect(dropped).toMatchObject({ ok: false, error: { code: "spawn_denied" } });

		const propagated = await runtime.supervisor.spawn(
			spawnRequest(root.capabilityGrant, {
				inputSources: [source],
				declassificationReceipts: [receipt],
			}),
		);
		expect(propagated.ok).toBe(true);
		expect(runtime.launcher.launches[0]).toMatchObject({
			inputSources: [{ sourceId: source.sourceId, taintLabels: source.taintLabels }],
			declassificationReceipts: [{ receiptId: receipt.receiptId }],
		});
		if (!propagated.ok) return;
		const droppedArtifactLineage = await runtime.supervisor.reportArtifact({
			requestId: createRuntimeId("command", "drop-artifact-lineage"),
			idempotencyKey: key("drop-artifact-lineage"),
			report: {
				agentId: propagated.value.node.agentId,
				logicalName: "patch",
				artifact: artifact("drop-lineage", propagated.value.node.workspaceReceipt.workspaceId),
				integrity: "valid",
				verification: "verified",
				inputSources: [],
				declassificationReceipts: [],
				reportedAt: "2026-07-22T00:00:01.000Z",
			},
		});
		expect(droppedArtifactLineage.ok).toBe(false);
	});

	it("blocks shared workspace identity and compensates the external allocation", async () => {
		const runtime = runtimeFakes();
		const root = rootRegistration();
		await runtime.supervisor.registerRoot(root);
		runtime.workspace.sharedWorkspaceId = root.workspaceReceipt.workspaceId;
		const result = await runtime.supervisor.spawn(spawnRequest(root.capabilityGrant));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("workspace_shared");
		expect(runtime.workspace.releases).toHaveLength(1);
		expect(runtime.launcher.launches).toHaveLength(0);
	});

	it("enforces three children and eight total agents as hard upper bounds", async () => {
		const runtime = runtimeFakes();
		const root = rootRegistration();
		await runtime.supervisor.registerRoot(root);
		for (let index = 0; index < 3; index += 1) {
			expect((await runtime.supervisor.spawn(spawnRequest(root.capabilityGrant))).ok).toBe(true);
		}
		const fourth = await runtime.supervisor.spawn(spawnRequest(root.capabilityGrant));
		expect(fourth.ok).toBe(false);
		if (!fourth.ok) expect(fourth.error.code).toBe("children_limit");
	});

	it("denies nested spawn by default and rejects a depth supplied by the caller", async () => {
		const runtime = runtimeFakes();
		const root = rootRegistration();
		await runtime.supervisor.registerRoot(root);
		const first = await runtime.supervisor.spawn(spawnRequest(root.capabilityGrant));
		if (!first.ok || !first.value.node.capabilityGrant) throw new Error("first child did not spawn");
		const nested = spawnRequest(first.value.node.capabilityGrant, {
			parentAgentId: first.value.node.agentId,
			depth: 2,
		});
		const denied = await runtime.supervisor.spawn(nested);
		expect(denied.ok).toBe(false);
		if (!denied.ok) expect(denied.error.code).toBe("spawn_denied");

		const wrongDepth = await runtime.supervisor.spawn(
			spawnRequest(root.capabilityGrant, { depth: 2, childAgentId: createRuntimeId("agent", "wrong-depth") }),
		);
		expect(wrongDepth.ok).toBe(false);
	});

	it("fails closed on root budget denial and releases the allocated workspace", async () => {
		const runtime = runtimeFakes();
		const root = rootRegistration();
		await runtime.supervisor.registerRoot(root);
		runtime.budget.deny = true;
		const result = await runtime.supervisor.spawn(spawnRequest(root.capabilityGrant));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("budget_denied");
		expect(runtime.workspace.releases).toHaveLength(1);
		expect(runtime.launcher.launches).toHaveLength(0);
	});

	it("persists and enforces each child maxTurns bound", async () => {
		const runtime = runtimeFakes();
		const root = rootRegistration();
		await runtime.supervisor.registerRoot(root);
		const request = spawnRequest(root.capabilityGrant);
		const spawned = await runtime.supervisor.spawn({
			...request,
			budget: { ...request.budget, maxTurns: 1 },
		});
		if (!spawned.ok) throw new Error(spawned.error.message);
		const first = await runtime.supervisor.recordTurn({
			requestId: createRuntimeId("command", "record-turn-one"),
			idempotencyKey: key("record-turn-one"),
			agentId: spawned.value.node.agentId,
			turnId: createRuntimeId("turn", "one"),
		});
		expect(first.ok && first.value.nodes.get(spawned.value.node.agentId)?.turnsUsed).toBe(1);
		const second = await runtime.supervisor.recordTurn({
			requestId: createRuntimeId("command", "record-turn-two"),
			idempotencyKey: key("record-turn-two"),
			agentId: spawned.value.node.agentId,
			turnId: createRuntimeId("turn", "two"),
		});
		expect(second.ok).toBe(false);
		if (!second.ok) expect(second.error.code).toBe("budget_denied");
	});
});
