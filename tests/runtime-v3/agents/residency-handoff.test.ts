import { describe, expect, it } from "vitest";
import { createAgentResidencyReceipt } from "../../../src/runtime/agents/residency.ts";
import { validateAgentHandoffManifest } from "../../../src/runtime/agents/handoff.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	artifact,
	declassificationReceipt,
	digest,
	inputSource,
	key,
	rootRegistration,
	runtimeFakes,
	spawnRequest,
	zeroUsage,
} from "./helpers.ts";

describe("agent residency and handoff", () => {
	it("preserves tainted source and declassification lineage in durable handoff", async () => {
		const runtime = runtimeFakes();
		const source = inputSource("handoff-repository");
		const receipt = declassificationReceipt(source, "publication");
		const root = rootRegistration();
		root.inputSources = [source];
		root.declassificationReceipts = [receipt];
		await runtime.supervisor.registerRoot(root);
		const spawned = await runtime.supervisor.spawn(
			spawnRequest(root.capabilityGrant, {
				inputSources: [source],
				declassificationReceipts: [receipt],
			}),
		);
		if (!spawned.ok) throw new Error(spawned.error.message);
		const child = spawned.value.node;
		await runtime.supervisor.reportArtifact({
			requestId: createRuntimeId("command", "report-lineage"),
			idempotencyKey: key("report-lineage"),
			report: {
				agentId: child.agentId,
				logicalName: "patch",
				artifact: artifact("lineage", child.workspaceReceipt.workspaceId),
				integrity: "valid",
				verification: "verified",
				inputSources: child.inputSources,
				declassificationReceipts: child.declassificationReceipts,
				reportedAt: "2026-07-22T00:00:01.000Z",
			},
		});
		await runtime.supervisor.finish({
			requestId: createRuntimeId("command", "finish-lineage"),
			idempotencyKey: key("finish-lineage"),
			agentId: child.agentId,
			outcome: "completed",
			usage: { ...zeroUsage(), artifactCount: 1, verifications: 1 },
		});
		const handoffId = createRuntimeId("command", "handoff-lineage");
		const result = await runtime.supervisor.handoff({
			requestId: handoffId,
			idempotencyKey: key("handoff-lineage"),
			agentId: child.agentId,
			status: "complete",
		});
		if (!result.ok) throw new Error(result.error.message);
		const handoff = result.value.handoffs.get(handoffId);
		expect(handoff?.inputSources).toEqual([source]);
		expect(handoff?.declassificationReceipts).toEqual([receipt]);
		if (!handoff) throw new Error("handoff missing");
		expect(validateAgentHandoffManifest({ ...handoff, inputSources: [] }, child).ok).toBe(false);
	});

	it("maps a crash with a reported ArtifactRef to partial without completing the parent", async () => {
		const runtime = runtimeFakes();
		const root = rootRegistration();
		await runtime.supervisor.registerRoot(root);
		const spawned = await runtime.supervisor.spawn(spawnRequest(root.capabilityGrant));
		if (!spawned.ok) throw new Error(spawned.error.message);
		const child = spawned.value.node;
		const reported = await runtime.supervisor.reportArtifact({
			requestId: createRuntimeId("command", "report-partial"),
			idempotencyKey: key("report-partial"),
			report: {
				agentId: child.agentId,
				logicalName: "patch",
				artifact: artifact("partial", child.workspaceReceipt.workspaceId),
				integrity: "valid",
				verification: "verified",
				inputSources: child.inputSources,
				declassificationReceipts: child.declassificationReceipts,
				reportedAt: "2026-07-22T00:00:01.000Z",
			},
		});
		expect(reported.ok).toBe(true);
		const residency = createAgentResidencyReceipt({
			agentId: child.agentId,
			sessionId: child.sessionId,
			runtimeInstanceId: createRuntimeId("runtime", "test"),
			state: "unavailable",
			revision: 2,
			observedAt: "2026-07-22T00:00:02.000Z",
			reasonDigest: digest("4"),
		});
		if (!residency.ok) throw new Error(residency.error.message);
		const interrupted = await runtime.supervisor.interrupt(
			child.agentId,
			"crash",
			residency.value,
			key("crash"),
			zeroUsage(),
		);
		expect(interrupted.ok).toBe(true);
		if (!interrupted.ok) return;
		expect(interrupted.value.nodes.get(child.agentId)?.state).toBe("partial");
		expect(interrupted.value.nodes.get(root.agentId)?.state).toBe("running");

		const handedOff = await runtime.supervisor.handoff({
			requestId: createRuntimeId("command", "partial-handoff"),
			idempotencyKey: key("partial-handoff"),
			agentId: child.agentId,
			status: "partial",
		});
		expect(handedOff.ok).toBe(true);
		if (!handedOff.ok) return;
		const handoff = handedOff.value.handoffs.get(createRuntimeId("command", "partial-handoff"));
		expect(handoff).toMatchObject({ status: "partial", integrity: "partial" });
		expect(handoff?.artifacts[0]?.artifact.artifactId).toBe(createRuntimeId("artifact", "partial"));
	});

	it("maps eviction without artifacts to paused and timeout without artifacts to failed", async () => {
		const runtime = runtimeFakes();
		const root = rootRegistration();
		await runtime.supervisor.registerRoot(root);
		const first = await runtime.supervisor.spawn(spawnRequest(root.capabilityGrant));
		if (!first.ok) throw new Error(first.error.message);
		const evicted = createAgentResidencyReceipt({
			agentId: first.value.node.agentId,
			sessionId: first.value.node.sessionId,
			runtimeInstanceId: createRuntimeId("runtime", "test"),
			state: "evicted",
			revision: 2,
			reasonDigest: digest("5"),
		});
		if (!evicted.ok) throw new Error(evicted.error.message);
		const paused = await runtime.supervisor.interrupt(
			first.value.node.agentId,
			"residency_evicted",
			evicted.value,
			key("evicted"),
			zeroUsage(),
		);
		expect(paused.ok && paused.value.nodes.get(first.value.node.agentId)?.state).toBe("paused");

		const second = await runtime.supervisor.spawn(spawnRequest(root.capabilityGrant));
		if (!second.ok) throw new Error(second.error.message);
		const unavailable = createAgentResidencyReceipt({
			agentId: second.value.node.agentId,
			sessionId: second.value.node.sessionId,
			runtimeInstanceId: createRuntimeId("runtime", "test"),
			state: "unavailable",
			revision: 2,
			reasonDigest: digest("6"),
		});
		if (!unavailable.ok) throw new Error(unavailable.error.message);
		const failed = await runtime.supervisor.interrupt(
			second.value.node.agentId,
			"timeout",
			unavailable.value,
			key("timeout"),
			zeroUsage(),
		);
		expect(failed.ok && failed.value.nodes.get(second.value.node.agentId)?.state).toBe("failed");
	});

	it("requires declared artifacts before completion and emits a complete handoff afterward", async () => {
		const runtime = runtimeFakes();
		const root = rootRegistration();
		await runtime.supervisor.registerRoot(root);
		const spawned = await runtime.supervisor.spawn(spawnRequest(root.capabilityGrant));
		if (!spawned.ok) throw new Error(spawned.error.message);
		const child = spawned.value.node;
		const premature = await runtime.supervisor.finish({
			requestId: createRuntimeId("command", "premature"),
			idempotencyKey: key("premature"),
			agentId: child.agentId,
			outcome: "completed",
			usage: zeroUsage(),
		});
		expect(premature.ok).toBe(false);
		if (!premature.ok) expect(premature.error.code).toBe("artifact_contract_mismatch");

		await runtime.supervisor.reportArtifact({
			requestId: createRuntimeId("command", "report-complete"),
			idempotencyKey: key("report-complete"),
			report: {
				agentId: child.agentId,
				logicalName: "patch",
				artifact: artifact("complete", child.workspaceReceipt.workspaceId),
				integrity: "valid",
				verification: "verified",
				inputSources: child.inputSources,
				declassificationReceipts: child.declassificationReceipts,
				reportedAt: "2026-07-22T00:00:01.000Z",
			},
		});
		const finished = await runtime.supervisor.finish({
			requestId: createRuntimeId("command", "finish"),
			idempotencyKey: key("finish"),
			agentId: child.agentId,
			outcome: "completed",
			usage: { ...zeroUsage(), artifactCount: 1, verifications: 1 },
		});
		expect(finished.ok && finished.value.nodes.get(child.agentId)?.state).toBe("completed");
		const handoff = await runtime.supervisor.handoff({
			requestId: createRuntimeId("command", "complete-handoff"),
			idempotencyKey: key("complete-handoff"),
			agentId: child.agentId,
			status: "complete",
		});
		expect(handoff.ok).toBe(true);
	});

	it.each(["unverified", "inconclusive"] as const)(
		"refuses to complete a child whose declared artifact is %s",
		async (verification) => {
			const runtime = runtimeFakes();
			const root = rootRegistration();
			await runtime.supervisor.registerRoot(root);
			const spawned = await runtime.supervisor.spawn(spawnRequest(root.capabilityGrant));
			if (!spawned.ok) throw new Error(spawned.error.message);
			const child = spawned.value.node;
			expect((await runtime.supervisor.reportArtifact({
				requestId: createRuntimeId("command", `report-${verification}`),
				idempotencyKey: key(`report-${verification}`),
				report: {
					agentId: child.agentId,
					logicalName: "patch",
					artifact: artifact(`terminal-${verification}`, child.workspaceReceipt.workspaceId),
					integrity: "valid",
					verification,
					inputSources: child.inputSources,
					declassificationReceipts: child.declassificationReceipts,
					reportedAt: "2026-07-22T00:00:01.000Z",
				},
			})).ok).toBe(true);
			const finished = await runtime.supervisor.finish({
				requestId: createRuntimeId("command", `finish-${verification}`),
				idempotencyKey: key(`finish-${verification}`),
				agentId: child.agentId,
				outcome: "completed",
				usage: zeroUsage(),
			});
			expect(finished).toMatchObject({
				ok: false,
				error: { code: "artifact_contract_mismatch" },
			});
			const graph = await runtime.supervisor.graph();
			expect(graph.ok && graph.value.nodes.get(child.agentId)?.state).toBe("running");
			expect(graph.ok && graph.value.nodes.get(root.agentId)?.state).toBe("running");
		},
	);

	it("keeps the parent running when a child reaches failed terminal state", async () => {
		const runtime = runtimeFakes();
		const root = rootRegistration();
		await runtime.supervisor.registerRoot(root);
		const spawned = await runtime.supervisor.spawn(spawnRequest(root.capabilityGrant));
		if (!spawned.ok) throw new Error(spawned.error.message);
		const failed = await runtime.supervisor.finish({
			requestId: createRuntimeId("command", "failed-child"),
			idempotencyKey: key("failed-child"),
			agentId: spawned.value.node.agentId,
			outcome: "failed",
			reason: "crash",
			usage: zeroUsage(),
		});
		expect(failed.ok && failed.value.nodes.get(spawned.value.node.agentId)?.state).toBe("failed");
		expect(failed.ok && failed.value.nodes.get(root.agentId)?.state).toBe("running");
	});
});
