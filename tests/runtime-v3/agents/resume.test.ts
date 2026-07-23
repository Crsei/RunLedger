import { describe, expect, it } from "vitest";
import { createAgentResidencyReceipt } from "../../../src/runtime/agents/residency.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { digest, key, rootRegistration, runtimeFakes, spawnRequest, zeroUsage } from "./helpers.ts";

async function pausedChild() {
	const runtime = runtimeFakes();
	const root = rootRegistration();
	await runtime.supervisor.registerRoot(root);
	const spawned = await runtime.supervisor.spawn(spawnRequest(root.capabilityGrant));
	if (!spawned.ok) throw new Error(spawned.error.message);
	const receipt = createAgentResidencyReceipt({
		agentId: spawned.value.node.agentId,
		sessionId: spawned.value.node.sessionId,
		runtimeInstanceId: createRuntimeId("runtime", "test"),
		state: "evicted",
		revision: 2,
		reasonDigest: digest("4"),
	});
	if (!receipt.ok) throw new Error(receipt.error.message);
	const interrupted = await runtime.supervisor.interrupt(
		spawned.value.node.agentId,
		"residency_evicted",
		receipt.value,
		key("pause"),
		zeroUsage(),
	);
	if (!interrupted.ok) throw new Error(interrupted.error.message);
	return { runtime, child: interrupted.value.nodes.get(spawned.value.node.agentId)! };
}

describe("agent resume revalidation", () => {
	it("revalidates delegation, denied-agent, workspace, and root budget before launch", async () => {
		const { runtime, child } = await pausedChild();
		const oldReservation = child.budgetReservation?.reservationId;
		const resumed = await runtime.supervisor.resume({
			requestId: createRuntimeId("command", "resume"),
			idempotencyKey: key("resume"),
			agentId: child.agentId,
		});
		expect(resumed.ok).toBe(true);
		if (!resumed.ok) return;
		expect(resumed.value.node.state).toBe("running");
		expect(resumed.value.node.workspaceReceipt.workspaceId).toBe(child.workspaceReceipt.workspaceId);
		expect(resumed.value.node.budgetReservation?.reservationId).not.toBe(oldReservation);
		expect(runtime.capability.revalidations).toHaveLength(1);
		expect(runtime.denied.checks).toHaveLength(1);
		expect(runtime.workspace.validations).toHaveLength(1);
		expect(runtime.launcher.resumes).toHaveLength(1);
		expect(runtime.budget.reservations).toHaveLength(2);
	});

	it("fails closed when the denied-agent receipt denies the child", async () => {
		const { runtime, child } = await pausedChild();
		runtime.denied.status = "denied";
		const resumed = await runtime.supervisor.resume({
			requestId: createRuntimeId("command", "resume-denied"),
			idempotencyKey: key("resume-denied"),
			agentId: child.agentId,
		});
		expect(resumed.ok).toBe(false);
		if (!resumed.ok) expect(resumed.error.code).toBe("resume_denied");
		expect(runtime.workspace.validations).toHaveLength(0);
		expect(runtime.launcher.resumes).toHaveLength(0);
	});

	it("does not fall back when the original workspace receipt is stale", async () => {
		const { runtime, child } = await pausedChild();
		runtime.workspace.validationStatus = "stale";
		const resumed = await runtime.supervisor.resume({
			requestId: createRuntimeId("command", "resume-stale"),
			idempotencyKey: key("resume-stale"),
			agentId: child.agentId,
		});
		expect(resumed.ok).toBe(false);
		if (!resumed.ok) expect(resumed.error.code).toBe("resume_denied");
		expect(runtime.launcher.resumes).toHaveLength(0);
		const graph = await runtime.supervisor.graph();
		expect(graph.ok && graph.value.nodes.get(child.agentId)?.state).toBe("paused");
	});

	it("fails closed when delegation is revoked during resume", async () => {
		const { runtime, child } = await pausedChild();
		runtime.capability.decision = "denied";
		const resumed = await runtime.supervisor.resume({
			requestId: createRuntimeId("command", "resume-revoked"),
			idempotencyKey: key("resume-revoked"),
			agentId: child.agentId,
		});
		expect(resumed.ok).toBe(false);
		if (!resumed.ok) expect(resumed.error.code).toBe("resume_denied");
		expect(runtime.denied.checks).toHaveLength(0);
	});
});
