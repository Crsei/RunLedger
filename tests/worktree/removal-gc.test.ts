import { afterEach, describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalDigest } from "../../src/runtime/protocol/v3/canonical-json.ts";
import { createSessionEventStreamRef } from "../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../src/runtime/protocol/v3/ids.ts";
import { workspaceExecutionEnvelopeDigest, type WorkspaceExecutionEnvelope } from "../../src/runtime/protocol/v3/workspace.ts";
import { WorktreeGarbageCollector } from "../../src/worktree/gc.ts";
import type { WorktreeCreateRequest, WorktreeCreateResult } from "../../src/worktree/types.ts";
import { createWorktreeHarness, type WorktreeTestHarness } from "./fixtures.ts";

const harnesses: WorktreeTestHarness[] = [];
afterEach(async () => { for (const harness of harnesses.splice(0)) await harness.cleanup(); });

async function setup(seed: string): Promise<{ harness: WorktreeTestHarness; request: WorktreeCreateRequest; created: WorktreeCreateResult; execution: WorkspaceExecutionEnvelope }> {
	const harness = await createWorktreeHarness(); harnesses.push(harness);
	const request: WorktreeCreateRequest = {
		authorityId: createRuntimeId("authority", seed), tenantId: createRuntimeId("tenant", seed), principalId: createRuntimeId("principal", seed),
		sessionId: createRuntimeId("session", seed), repositoryId: createRuntimeId("repository", seed), sourceRepo: harness.sourceRepo,
		sourceCwd: harness.sourceCwd, label: "cleanup", branch: `runledger/${seed}`, ownerRuntimeId: createRuntimeId("runtime", seed),
		requestId: createRuntimeId("command", `create-${seed}`),
	};
	const result = await harness.manager.create(request);
	if (!result.ok) throw new Error(result.error.message);
	const created = result.value;
	const execution: WorkspaceExecutionEnvelope = {
		authorityId: request.authorityId, tenantId: request.tenantId, principalId: request.principalId, sessionId: request.sessionId,
		workspaceId: created.record.workspaceId, repositoryId: request.repositoryId, worktreePath: created.record.worktreePath,
		branch: created.record.branch, baseCommit: created.record.baseCommit, agentId: createRuntimeId("agent", seed),
		toolCallId: createRuntimeId("toolCall", seed), traceId: createRuntimeId("trace", seed), cwd: created.record.effectiveCwd,
		ownerRuntimeId: created.record.ownerRuntimeId, leaseRevision: 1, fencingToken: created.fencingToken,
	};
	return { harness, request, created, execution };
}

async function checkpointAndRelease(setupValue: Awaited<ReturnType<typeof setup>>) {
	const { harness, request, execution } = setupValue;
	const checkpoint = await harness.manager.checkpoint({
		schemaVersion: 1, kind: "checkpoint", requestId: createRuntimeId("command", `checkpoint-${request.sessionId.split("_").at(-1)}`),
		authorityId: request.authorityId, tenantId: request.tenantId, principalId: request.principalId, sessionId: request.sessionId,
		agentId: execution.agentId, traceId: execution.traceId, envelope: execution, envelopeDigest: workspaceExecutionEnvelopeDigest(execution),
		eventCursor: {
			stream: createSessionEventStreamRef(request, request.sessionId),
			sequence: 1,
			eventId: createRuntimeId("event", "cleanup"),
			eventHash: "a".repeat(64),
		},
	});
	if (!checkpoint.ok) throw new Error(checkpoint.error.message);
	const released = await harness.manager.release({
		schemaVersion: 1, kind: "release", requestId: createRuntimeId("command", `release-${request.sessionId.split("_").at(-1)}`),
		authorityId: request.authorityId, tenantId: request.tenantId, principalId: request.principalId, sessionId: request.sessionId,
		agentId: execution.agentId, traceId: execution.traceId, envelope: execution, envelopeDigest: workspaceExecutionEnvelopeDigest(execution),
		callerRequestDigest: canonicalDigest({ kind: "removal_gc_release", workspaceId: execution.workspaceId }),
		expectedLeaseId: setupValue.created.lease.leaseId, expectedLeaseRevision: 1,
		checkpoint: checkpoint.value.checkpoint,
	});
	if (!released.ok) throw new Error(released.error.message);
	return checkpoint.value.checkpoint;
}

describe("worktree removal and GC", () => {
	it("removes only after a current checkpoint and a second fresh preview", async () => {
		const value = await setup("remove-clean");
		const checkpoint = await checkpointAndRelease(value);
		const request = {
			authorityId: value.request.authorityId, tenantId: value.request.tenantId, principalId: value.request.principalId,
			workspaceId: value.created.record.workspaceId, dryRun: false, force: false, expectedLeaseRevision: 1,
			requestId: createRuntimeId("command", "remove-clean"), checkpoint,
		};
		expect(await value.harness.manager.removePreview(request)).toMatchObject({ ok: true, value: { removable: true } });
		expect(await value.harness.manager.remove(request)).toMatchObject({ ok: true });
		expect(await value.harness.manager.list()).toEqual({ ok: true, value: [] });
	});

	it("keeps dirty worktrees even when a checkpoint describes the dirt", async () => {
		const value = await setup("remove-dirty");
		await writeFile(join(value.created.record.effectiveCwd, "dirty.txt"), "dirty\n");
		const checkpoint = await checkpointAndRelease(value);
		const request = {
			authorityId: value.request.authorityId, tenantId: value.request.tenantId, principalId: value.request.principalId,
			workspaceId: value.created.record.workspaceId, dryRun: false, force: false, expectedLeaseRevision: 1,
			requestId: createRuntimeId("command", "remove-dirty"), checkpoint,
		};
		expect(await value.harness.manager.removePreview(request)).toMatchObject({ ok: true, value: { removable: false, reasonCodes: ["dirty"] } });
		expect(await value.harness.manager.remove(request)).toMatchObject({ ok: false, error: { code: "approval_required" } });
	});

	it("reports TTL candidates before cleanup and then removes only safe retained records", async () => {
		const value = await setup("gc-clean");
		await checkpointAndRelease(value);
		value.harness.clock.now = new Date("2026-07-24T00:00:00.000Z");
		const gc = new WorktreeGarbageCollector(value.harness.manager, 24 * 60 * 60 * 1_000);
		const preview = await gc.run(value.harness.clock.now, true);
		expect(preview).toMatchObject({ ok: true, value: { dryRun: true, candidates: [{ reason: "ttl-expired" }], removedWorkspaceIds: [] } });
		const applied = await gc.run(value.harness.clock.now, false);
		expect(applied).toMatchObject({ ok: true, value: { removedWorkspaceIds: [value.created.record.workspaceId] } });
	});
});
