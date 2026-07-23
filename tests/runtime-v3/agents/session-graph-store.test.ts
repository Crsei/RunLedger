import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionAgentGraphStore } from "../../../src/runtime/agents/session-graph-store.ts";
import { createAgentSemanticTerminalRecord } from "../../../src/runtime/agents/graph-store.ts";
import { AgentSupervisor } from "../../../src/runtime/agents/supervisor.ts";
import type { AgentGraphSemanticCommand } from "../../../src/runtime/agents/types.ts";
import { createEventStreamId, createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { EventWriter, openEventWriter } from "../../../src/runtime/session/event-writer.ts";
import { JsonlV3EventStore } from "../../../src/runtime/session/jsonl-v3-store.ts";
import type { WriterFence } from "../../../src/runtime/session/types.ts";
import { artifact, digest, key, rootRegistration, runtimeFakes, spawnRequest, zeroUsage } from "./helpers.ts";

const NOW = "2026-07-22T00:00:00.000Z";

describe("SessionAgentGraphStore", () => {
	it("replays completed, failed, and cancelled children from canonical v3 agent events after a JSONL restart", async () => {
		const directory = await mkdtemp(join(tmpdir(), "runledger-agent-graph-"));
		const filePath = join(directory, "session.jsonl");
		const root = rootRegistration();
		const authorityId = createRuntimeId("authority", "agent-graph");
		const tenantId = createRuntimeId("tenant", "agent-graph");
		const principalId = createRuntimeId("principal", "agent-graph");
		const runtimeId = createRuntimeId("runtime", "agent-graph");
		const stream = {
			scope: "session" as const,
			streamId: createEventStreamId({ authorityId, tenantId }, root.sessionId),
			sessionId: root.sessionId,
		};
		const fence: WriterFence = {
			authorityId,
			tenantId,
			stream,
			leaseId: createRuntimeId("lease", "agent-graph"),
			ownerRuntimeId: runtimeId,
			writerEpoch: 1,
			fencingToken: "agent-graph-test-fence",
		};
		const storeOptions = {
			filePath,
			authorityId,
			tenantId,
			stream,
			validateFence: (candidate: WriterFence) =>
				candidate.writerEpoch === fence.writerEpoch && candidate.fencingToken === fence.fencingToken,
		};
		let reopenedStore: JsonlV3EventStore | undefined;
		try {
			const created = await JsonlV3EventStore.create(storeOptions);
			if (!created.ok) throw new Error(created.error.message);
			const writer = new EventWriter({
				authorityId,
				tenantId,
				stream,
				store: created.value,
				fence,
				clock: () => new Date(NOW),
			});
			expect((await writer.append({
				type: "session.created",
				principalId,
				traceId: createRuntimeId("trace", "agent-graph-genesis"),
				payload: { origin: "test", runtimeId, featureDigest: digest("0"), initialGoalId: root.goalId, rootAgentId: root.agentId },
			})).ok).toBe(true);
			const beforeGraphBarrier = await created.value.readPage(stream, { limit: 10 });
			expect(beforeGraphBarrier.ok && beforeGraphBarrier.value.events).toEqual([]);

			let traceSequence = 0;
			const graphStore = new SessionAgentGraphStore({
				writer,
				store: created.value,
				principalId,
				traceIdFactory: () => createRuntimeId("trace", `agent-graph-${++traceSequence}`),
			});
			const fakes = runtimeFakes();
			const supervisor = new AgentSupervisor({
				rootAgentId: root.agentId,
				ports: { ...fakes.ports, graphStore },
				clock: () => new Date(NOW),
			});
			expect((await supervisor.registerRoot(root)).ok).toBe(true);

			const completedRequest = spawnRequest(root.capabilityGrant);
			const completed = await supervisor.spawn(completedRequest);
			if (!completed.ok) throw new Error(completed.error.message);
			expect((await supervisor.reportArtifact({
				requestId: createRuntimeId("command", "durable-agent-artifact"),
				idempotencyKey: key("durable-agent-artifact"),
				report: {
					agentId: completed.value.node.agentId,
					logicalName: "patch",
					artifact: artifact("durable-agent", completed.value.node.workspaceReceipt.workspaceId),
					integrity: "valid",
					verification: "verified",
					inputSources: completed.value.node.inputSources,
					declassificationReceipts: completed.value.node.declassificationReceipts,
					reportedAt: "2026-07-22T00:00:01.000Z",
				},
			})).ok).toBe(true);
			expect((await supervisor.finish({
				requestId: createRuntimeId("command", "durable-agent-finish"),
				idempotencyKey: key("durable-agent-finish"),
				agentId: completed.value.node.agentId,
				outcome: "completed",
				usage: { ...zeroUsage(), artifactCount: 1, verifications: 1 },
			})).ok).toBe(true);

			const failedRequest = spawnRequest(root.capabilityGrant);
			const failed = await supervisor.spawn(failedRequest);
			if (!failed.ok) throw new Error(failed.error.message);
			expect((await supervisor.finish({
				requestId: createRuntimeId("command", "durable-agent-failed"),
				idempotencyKey: key("durable-agent-failed"),
				agentId: failed.value.node.agentId,
				outcome: "failed",
				reason: "crash",
				usage: zeroUsage(),
			})).ok).toBe(true);

			const cancelledRequest = spawnRequest(root.capabilityGrant);
			const cancelled = await supervisor.spawn(cancelledRequest);
			if (!cancelled.ok) throw new Error(cancelled.error.message);
			const cancellationReasonEvidenceDigest = digest("8");
			const cancellationRequest = {
				requestId: createRuntimeId("command", "durable-agent-cancelled"),
				idempotencyKey: key("durable-agent-cancelled"),
				agentId: cancelled.value.node.agentId,
			};
			expect((await supervisor.cancel(
				cancellationRequest,
				cancellationReasonEvidenceDigest,
				zeroUsage(),
			)).ok).toBe(true);
			expect((await writer.close()).ok).toBe(true);

			const reopened = await JsonlV3EventStore.open(storeOptions);
			if (!reopened.ok) throw new Error(reopened.error.message);
			reopenedStore = reopened.value;
			const reopenedWriter = await openEventWriter({
				authorityId,
				tenantId,
				stream,
				store: reopenedStore,
				fence,
				clock: () => new Date(NOW),
			});
			if (!reopenedWriter.ok) throw new Error(reopenedWriter.error.message);
			const restartedGraphStore = new SessionAgentGraphStore({
				writer: reopenedWriter.value,
				store: reopenedStore,
				principalId,
			});
			const restarted = await restartedGraphStore.load(root.agentId);
			expect(restarted.ok).toBe(true);
			if (!restarted.ok) return;
			const restartedSupervisor = new AgentSupervisor({
				rootAgentId: root.agentId,
				ports: { ...fakes.ports, graphStore: restartedGraphStore },
			});
			const restartedProjection = await restartedSupervisor.graph();
			expect(restartedProjection.ok).toBe(true);
			if (!restartedProjection.ok) return;
			expect(restartedProjection.value.edges).toHaveLength(3);
			expect(restartedProjection.value.nodes.get(completed.value.node.agentId)).toMatchObject({
				state: "completed",
				sessionId: completedRequest.childSessionId,
				artifacts: [{ verification: "verified", integrity: "valid" }],
				terminal: { outcome: "completed" },
				residency: { state: "nonresident" },
				workspaceReceipt: { status: "released" },
			});
			expect(restartedProjection.value.nodes.get(failed.value.node.agentId)).toMatchObject({
				state: "failed",
				sessionId: failedRequest.childSessionId,
				terminal: { outcome: "failed", reason: "crash" },
				residency: { state: "nonresident" },
				workspaceReceipt: { status: "released" },
			});
			expect(restartedProjection.value.nodes.get(cancelled.value.node.agentId)).toMatchObject({
				state: "stopped",
				sessionId: cancelledRequest.childSessionId,
				terminal: {
					outcome: "stopped",
					reason: "cancelled",
					reasonEvidenceDigest: cancellationReasonEvidenceDigest,
				},
				residency: { state: "nonresident" },
				workspaceReceipt: { status: "released" },
			});
			expect(restartedProjection.value.cleanups.get(completed.value.node.agentId)).toMatchObject({
				terminalDigest: restartedProjection.value.nodes.get(completed.value.node.agentId)?.terminal?.terminalDigest,
				completionReceipt: { agentId: completed.value.node.agentId },
			});
			expect(restartedProjection.value.cleanups.get(failed.value.node.agentId)).toMatchObject({
				terminalDigest: restartedProjection.value.nodes.get(failed.value.node.agentId)?.terminal?.terminalDigest,
				completionReceipt: { agentId: failed.value.node.agentId },
			});
			expect(restartedProjection.value.cleanups.get(cancelled.value.node.agentId)).toMatchObject({
				terminalDigest: restartedProjection.value.nodes.get(cancelled.value.node.agentId)?.terminal?.terminalDigest,
				completionReceipt: {
					agentId: cancelled.value.node.agentId,
					terminalDigest: restartedProjection.value.nodes.get(cancelled.value.node.agentId)?.terminal?.terminalDigest,
				},
			});
			expect(await restartedSupervisor.cancel(
				cancellationRequest,
				cancellationReasonEvidenceDigest,
				zeroUsage(),
			)).toMatchObject({ ok: true });
			expect(await restartedSupervisor.cancel(
				cancellationRequest,
				digest("7"),
				zeroUsage(),
			)).toMatchObject({
				ok: false,
				error: { code: "idempotency_conflict" },
			});
			const stopKey = key("agent-graph-stop");
			const stopped: AgentGraphSemanticCommand = {
				type: "agent.stopped",
				requestId: createRuntimeId("command", "agent-graph-stop"),
				idempotencyKey: stopKey,
				occurredAt: NOW,
				agentId: root.agentId,
				from: "running",
				reason: "cancelled",
				terminal: createAgentSemanticTerminalRecord({
					agentId: root.agentId,
					requestId: createRuntimeId("command", "agent-graph-stop"),
					idempotencyKey: stopKey,
					outcome: "stopped",
					reason: "cancelled",
					partialResults: [],
				}),
			};
			const committed = await restartedGraphStore.commit(root.agentId, restarted.value.revision, stopped);
			expect(committed.ok && committed.value.status).toBe("committed");
			const duplicate = await restartedGraphStore.commit(root.agentId, restarted.value.revision, stopped);
			expect(duplicate.ok && duplicate.value.status).toBe("duplicate");
			const idempotencyConflict = await restartedGraphStore.commit(root.agentId, restarted.value.revision + 1, {
				...stopped,
				requestId: createRuntimeId("command", "agent-graph-stop-conflict"),
				reason: "budget_exhausted",
			});
			expect(idempotencyConflict).toMatchObject({ ok: false, error: { code: "idempotency_conflict" } });
			const staleKey = key("agent-graph-stale");
			const stale: AgentGraphSemanticCommand = {
				type: "agent.failed",
				requestId: createRuntimeId("command", "agent-graph-stale"),
				idempotencyKey: staleKey,
				occurredAt: NOW,
				agentId: root.agentId,
				from: "running",
				reason: "crash",
				terminal: createAgentSemanticTerminalRecord({
					agentId: root.agentId,
					requestId: createRuntimeId("command", "agent-graph-stale"),
					idempotencyKey: staleKey,
					outcome: "failed",
					reason: "crash",
					partialResults: [],
				}),
				error: {
					code: "crash",
					messageDigest: digest("9"),
					retryable: false,
					outcomeCertain: true,
					effect: "none",
				},
			};
			expect(await restartedGraphStore.commit(root.agentId, restarted.value.revision, stale)).toMatchObject({
				ok: true,
				value: { status: "conflict", actualRevision: restarted.value.revision + 1 },
			});

			const page = await reopenedStore.readPage(stream, { limit: 1000 });
			expect(page.ok).toBe(true);
			if (page.ok) {
				const agentTypes = page.value.events.flatMap((event) =>
					event.type.startsWith("agent.") ? [event.type] : [],
				);
				expect(agentTypes).toContain("agent.spawned");
				expect(agentTypes).toContain("agent.transitioned");
				expect(agentTypes).toContain("agent.finished");
				expect(agentTypes).toContain("agent.failed");
				expect(agentTypes).toContain("agent.cleanup_requested");
				expect(agentTypes).toContain("agent.runtime_released");
				expect(agentTypes).toContain("agent.workspace_released");
				expect(agentTypes).toContain("agent.budget_settled");
				expect(agentTypes).toContain("agent.cleanup_completed");
			}
			expect((await reopenedWriter.value.close()).ok).toBe(true);
			reopenedStore = undefined;
		} finally {
			if (reopenedStore) await reopenedStore.close();
			await rm(directory, { recursive: true, force: true });
		}
	}, 15_000);
});
