import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import type { AgentGraphSemanticCommand } from "../../../src/runtime/agents/types.ts";
import {
	artifact,
	key,
	rootRegistration,
	runtimeFakes,
	spawnRequest,
	workspaceReceipt as createWorkspaceReceipt,
} from "./helpers.ts";

const NOW = "2026-07-22T00:00:02.000Z";

describe("durable agent graph", () => {
	it("accepts only an exact monotonic root Workspace revalidation", async () => {
		const runtime = runtimeFakes();
		const baseRoot = rootRegistration();
		const root = {
			...baseRoot,
			workspaceReceipt: createWorkspaceReceipt(baseRoot.sessionId, "root-revalidation", "isolated_lease"),
		};
		expect((await runtime.supervisor.registerRoot(root)).ok).toBe(true);
		const loaded = await runtime.store.load(root.agentId);
		if (!loaded.ok) throw new Error(loaded.error.message);
		const { receiptDigest: _receiptDigest, ...previousBody } = root.workspaceReceipt;
		const nextBody = {
			...previousBody,
			bindingRevision: previousBody.bindingRevision + 1,
			leaseRevision: 2,
			issuedAt: NOW,
		};
		const workspaceReceipt = { ...nextBody, receiptDigest: canonicalDigest(nextBody) };
		const revalidated: AgentGraphSemanticCommand = {
			type: "agent.root_revalidated",
			requestId: createRuntimeId("command", "root-revalidated"),
			idempotencyKey: key("root-revalidated"),
			occurredAt: NOW,
			agentId: root.agentId,
			workspaceReceipt,
			capabilityGrant: root.capabilityGrant,
		};
		const committed = await runtime.store.commit(root.agentId, loaded.value.revision, revalidated);
		expect(committed).toMatchObject({ ok: true, value: { status: "committed" } });
		expect(await runtime.store.commit(root.agentId, loaded.value.revision, revalidated)).toMatchObject({
			ok: true,
			value: { status: "duplicate" },
		});
		const current = await runtime.store.load(root.agentId);
		if (!current.ok) throw new Error(current.error.message);
		expect(await runtime.store.commit(root.agentId, current.value.revision, {
			...revalidated,
			requestId: createRuntimeId("command", "root-revalidated-stale"),
			idempotencyKey: key("root-revalidated-stale"),
		})).toMatchObject({ ok: false, error: { code: "invalid_graph" } });
		const driftedBody = {
			...nextBody,
			repositoryId: createRuntimeId("repository", "root-revalidated-drift"),
			bindingRevision: nextBody.bindingRevision + 1,
			leaseRevision: nextBody.leaseRevision + 1,
		};
		expect(await runtime.store.commit(root.agentId, current.value.revision, {
			...revalidated,
			requestId: createRuntimeId("command", "root-revalidated-drift"),
			idempotencyKey: key("root-revalidated-drift"),
			workspaceReceipt: { ...driftedBody, receiptDigest: canonicalDigest(driftedBody) },
		})).toMatchObject({ ok: false, error: { code: "invalid_graph" } });
	});

	it("loads the canonical projection/head after a supervisor restart", async () => {
		const runtime = runtimeFakes();
		const root = rootRegistration();
		expect((await runtime.supervisor.registerRoot(root)).ok).toBe(true);
		const request = spawnRequest(root.capabilityGrant);
		expect((await runtime.supervisor.spawn(request)).ok).toBe(true);

		const loaded = await runtime.store.load(root.agentId);
		expect(loaded.ok).toBe(true);
		if (!loaded.ok) return;
		expect(loaded.value.projection.nodes.get(request.childAgentId)).toMatchObject({
			parentAgentId: root.agentId,
			sessionId: request.childSessionId,
			state: "running",
		});
		expect(loaded.value.projection.edges).toHaveLength(1);
		expect(loaded.value.projection.revision).toBe(loaded.value.revision);
	});

	it("uses expected revision CAS and semantic-command idempotency", async () => {
		const runtime = runtimeFakes();
		const root = rootRegistration();
		await runtime.supervisor.registerRoot(root);
		const loaded = await runtime.store.load(root.agentId);
		if (!loaded.ok) throw new Error(loaded.error.message);
		const stopped: AgentGraphSemanticCommand = {
			type: "agent.stopped",
			requestId: createRuntimeId("command", "stop-root"),
			idempotencyKey: key("stop-root"),
			occurredAt: NOW,
			agentId: root.agentId,
			from: "running",
			reason: "cancelled",
		};
		const committed = await runtime.store.commit(root.agentId, loaded.value.revision, stopped);
		expect(committed.ok && committed.value.status).toBe("committed");
		const duplicate = await runtime.store.commit(root.agentId, loaded.value.revision, stopped);
		expect(duplicate.ok && duplicate.value.status).toBe("duplicate");

		const stale: AgentGraphSemanticCommand = {
			type: "agent.failed",
			requestId: createRuntimeId("command", "stale-root"),
			idempotencyKey: key("stale-root"),
			occurredAt: NOW,
			agentId: root.agentId,
			from: "running",
			reason: "crash",
			error: {
				code: "crash",
				messageDigest: "0".repeat(64),
				retryable: false,
				outcomeCertain: true,
				effect: "none",
			},
		};
		const conflict = await runtime.store.commit(root.agentId, loaded.value.revision, stale);
		expect(conflict).toMatchObject({ ok: true, value: { status: "conflict" } });
	});

	it("rejects a spawn terminal without a correlated pending intent", async () => {
		const runtime = runtimeFakes();
		const root = rootRegistration();
		await runtime.supervisor.registerRoot(root);
		const request = spawnRequest(root.capabilityGrant);
		const spawned = await runtime.supervisor.spawn(request);
		if (!spawned.ok) throw new Error(spawned.error.message);
		const loaded = await runtime.store.load(root.agentId);
		if (!loaded.ok) throw new Error(loaded.error.message);
		const orphanTerminal: AgentGraphSemanticCommand = {
			type: "agent.spawned",
			requestId: createRuntimeId("command", "orphan-spawn-terminal"),
			idempotencyKey: key("orphan-spawn-terminal"),
			occurredAt: NOW,
			intentRequestId: request.requestId,
			node: spawned.value.node,
			edge: loaded.value.projection.edges[0]!,
		};
		expect(await runtime.store.commit(root.agentId, loaded.value.revision, orphanTerminal)).toMatchObject({
			ok: false,
			error: { code: "invalid_graph" },
		});
	});

	it.each(["unverified", "inconclusive"] as const)(
		"rejects completion with a %s artifact",
		async (verification) => {
			const runtime = runtimeFakes();
			const root = rootRegistration();
			await runtime.supervisor.registerRoot(root);
			const request = spawnRequest(root.capabilityGrant);
			const spawned = await runtime.supervisor.spawn(request);
			if (!spawned.ok) throw new Error(spawned.error.message);
			const child = spawned.value.node;
			expect((await runtime.supervisor.reportArtifact({
				requestId: createRuntimeId("command", `report-${verification}`),
				idempotencyKey: key(`report-${verification}`),
				report: {
					agentId: child.agentId,
					logicalName: "patch",
					artifact: artifact(`replay-${verification}`, child.workspaceReceipt.workspaceId),
					integrity: "valid",
					verification,
					inputSources: child.inputSources,
					declassificationReceipts: child.declassificationReceipts,
					reportedAt: NOW,
				},
			})).ok).toBe(true);
			const loaded = await runtime.store.load(root.agentId);
			if (!loaded.ok) throw new Error(loaded.error.message);
			const terminal: AgentGraphSemanticCommand = {
				type: "agent.finished",
				requestId: createRuntimeId("command", `complete-${verification}`),
				idempotencyKey: key(`complete-${verification}`),
				occurredAt: NOW,
				agentId: child.agentId,
				from: "running",
			};
			expect(await runtime.store.commit(root.agentId, loaded.value.revision, terminal)).toMatchObject({
				ok: false,
				error: { code: "artifact_contract_mismatch" },
			});
		},
	);
});
