import { describe, expect, it } from "vitest";
import { createAgentResidencyReceipt } from "../../../src/runtime/agents/residency.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { artifact, digest, key, rootRegistration, runtimeFakes, spawnRequest, zeroUsage } from "./helpers.ts";

async function handoffWithVerification(verification: "verified" | "unverified") {
	const runtime = runtimeFakes();
	const root = rootRegistration();
	await runtime.supervisor.registerRoot(root);
	const spawned = await runtime.supervisor.spawn(spawnRequest(root.capabilityGrant));
	if (!spawned.ok) throw new Error(spawned.error.message);
	const child = spawned.value.node;
	await runtime.supervisor.reportArtifact({
		requestId: createRuntimeId("command", `report-${verification}`),
		idempotencyKey: key(`report-${verification}`),
		report: {
			agentId: child.agentId,
			logicalName: "patch",
			artifact: artifact(`merge-${verification}`, child.workspaceReceipt.workspaceId),
			integrity: "valid",
			verification,
			inputSources: child.inputSources,
			declassificationReceipts: child.declassificationReceipts,
			reportedAt: "2026-07-22T00:00:01.000Z",
		},
	});
	const receipt = createAgentResidencyReceipt({
		agentId: child.agentId,
		sessionId: child.sessionId,
		runtimeInstanceId: createRuntimeId("runtime", "test"),
		state: "unavailable",
		revision: 2,
		reasonDigest: digest("4"),
	});
	if (!receipt.ok) throw new Error(receipt.error.message);
	await runtime.supervisor.interrupt(
		child.agentId,
		"crash",
		receipt.value,
		key(`crash-${verification}`),
		zeroUsage(),
	);
	const handoffId = createRuntimeId("command", `handoff-${verification}`);
	const handedOff = await runtime.supervisor.handoff({
		requestId: handoffId,
		idempotencyKey: key(`handoff-${verification}`),
		agentId: child.agentId,
		status: "partial",
	});
	if (!handedOff.ok) throw new Error(handedOff.error.message);
	return { runtime, root, child, handoffId };
}

describe("declarative agent merge", () => {
	it("records conflict receipts and preserves source plus conflict Artifacts", async () => {
		const { runtime, root, child, handoffId } = await handoffWithVerification("verified");
		runtime.merge.outcome = "conflict";
		const merged = await runtime.supervisor.merge({
			requestId: createRuntimeId("command", "merge-conflict"),
			idempotencyKey: key("merge-conflict"),
			parentAgentId: root.agentId,
			childAgentId: child.agentId,
			handoffId,
			logicalNames: ["patch"],
		});
		expect(merged.ok).toBe(true);
		if (!merged.ok) return;
		const receipt = merged.value.mergeReceipts.at(-1);
		expect(receipt?.outcome).toBe("conflict");
		expect(receipt?.preservedArtifactRefs).toHaveLength(2);
		expect(merged.value.nodes.get(root.agentId)?.state).toBe("running");
		expect(merged.value.nodes.get(child.agentId)?.state).toBe("partial");
	});

	it("rejects undeclared or unverified child artifacts before calling Workspace merge", async () => {
		const { runtime, root, child, handoffId } = await handoffWithVerification("unverified");
		const merged = await runtime.supervisor.merge({
			requestId: createRuntimeId("command", "merge-unverified"),
			idempotencyKey: key("merge-unverified"),
			parentAgentId: root.agentId,
			childAgentId: child.agentId,
			handoffId,
			logicalNames: ["patch"],
		});
		expect(merged.ok).toBe(false);
		if (!merged.ok) expect(merged.error.code).toBe("merge_invalid");
		expect(runtime.merge.requests).toHaveLength(0);
	});
});
