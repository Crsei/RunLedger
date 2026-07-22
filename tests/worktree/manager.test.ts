import { afterEach, describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createSessionEventStreamRef } from "../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../src/runtime/protocol/v3/ids.ts";
import { workspaceExecutionEnvelopeDigest, type WorkspaceExecutionEnvelope } from "../../src/runtime/protocol/v3/workspace.ts";
import type { WorktreeCreateRequest, WorktreeCreateResult, WorktreeRuntimeContext } from "../../src/worktree/types.ts";
import { createWorktreeHarness, type WorktreeTestHarness } from "./fixtures.ts";

const harnesses: WorktreeTestHarness[] = [];

afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.cleanup();
});

async function createRequest(harness: WorktreeTestHarness, seed = "manager"): Promise<WorktreeCreateRequest> {
	return {
		authorityId: createRuntimeId("authority", seed), tenantId: createRuntimeId("tenant", seed),
		principalId: createRuntimeId("principal", seed), sessionId: createRuntimeId("session", seed),
		repositoryId: createRuntimeId("repository", seed), sourceRepo: harness.sourceRepo, sourceCwd: harness.sourceCwd,
		label: "task", baseRef: "HEAD", branch: `runledger/${seed}`, ownerRuntimeId: createRuntimeId("runtime", `${seed}-one`),
		requestId: createRuntimeId("command", `create-${seed}`),
	};
}

function envelope(result: WorktreeCreateResult): WorkspaceExecutionEnvelope {
	return {
		authorityId: result.record.authorityId, tenantId: result.record.tenantId, principalId: result.record.principalId,
		sessionId: result.record.sessionId, workspaceId: result.record.workspaceId, repositoryId: result.record.repositoryId,
		worktreePath: result.record.worktreePath, branch: result.record.branch, baseCommit: result.record.baseCommit,
		agentId: createRuntimeId("agent", "manager"), toolCallId: createRuntimeId("toolCall", "manager"), traceId: createRuntimeId("trace", "manager"),
		cwd: result.record.effectiveCwd, ownerRuntimeId: result.record.ownerRuntimeId, leaseRevision: result.lease.leaseRevision,
		fencingToken: result.fencingToken,
	};
}

describe("WorktreeManager", () => {
	it("creates one isolated worktree, preserves subdir offset, and replays create idempotently", async () => {
		const harness = await createWorktreeHarness(); harnesses.push(harness);
		const request = await createRequest(harness);
		const first = await harness.manager.create(request);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(first.value.record.effectiveCwd).toBe(join(first.value.record.worktreePath, "packages", "app"));
		expect(first.value.runtimeBinding).toMatchObject({ bindingKind: "managed_worktree", branch: "runledger/manager" });
		await writeFile(join(first.value.record.effectiveCwd, "index.ts"), "export const isolated = true;\n");
		expect(await readFile(join(harness.sourceCwd, "index.ts"), "utf8")).toBe("export const source = true;\n");
		const replay = await harness.manager.create(request);
		expect(replay).toEqual(first);
	});

	it("validates canonical Git identity and exact fencing token", async () => {
		const harness = await createWorktreeHarness(); harnesses.push(harness);
		const created = await harness.manager.create(await createRequest(harness, "validate"));
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const execution = envelope(created.value);
		expect(await harness.manager.validate(execution)).toMatchObject({ ok: true, value: { validation: { outcome: "valid" } } });
		expect(await harness.manager.validate({ ...execution, fencingToken: "wrong-token" })).toMatchObject({ ok: false, error: { code: "lease_conflict" } });
		expect(await harness.manager.validate({ ...execution, cwd: harness.sourceRepo })).toMatchObject({ ok: false });
	});

	it("checkpoints, releases, and resumes with a higher fencing revision", async () => {
		const harness = await createWorktreeHarness(); harnesses.push(harness);
		const request = await createRequest(harness, "resume");
		const created = await harness.manager.create(request);
		if (!created.ok) throw new Error(created.error.message);
		const execution = envelope(created.value);
		const checkpoint = await harness.manager.checkpoint({
			schemaVersion: 1, kind: "checkpoint", requestId: createRuntimeId("command", "checkpoint-resume"),
			authorityId: request.authorityId, tenantId: request.tenantId, principalId: request.principalId,
			sessionId: request.sessionId, agentId: createRuntimeId("agent", "resume"), traceId: createRuntimeId("trace", "resume"),
			envelope: execution, envelopeDigest: workspaceExecutionEnvelopeDigest(execution),
			eventCursor: {
				stream: createSessionEventStreamRef(request, request.sessionId),
				sequence: 1,
				eventId: createRuntimeId("event", "resume"),
				eventHash: "a".repeat(64),
			},
		});
		if (!checkpoint.ok) throw new Error(checkpoint.error.message);
		const released = await harness.manager.release({
			schemaVersion: 1, kind: "release", requestId: createRuntimeId("command", "release-resume"),
			authorityId: request.authorityId, tenantId: request.tenantId, principalId: request.principalId,
			sessionId: request.sessionId, agentId: createRuntimeId("agent", "resume"), traceId: createRuntimeId("trace", "resume"),
			envelope: execution, envelopeDigest: workspaceExecutionEnvelopeDigest(execution), expectedLeaseRevision: 1,
			checkpoint: checkpoint.value.checkpoint,
		});
		expect(released).toMatchObject({ ok: true, value: { record: { state: "retained" } } });
		const context: WorktreeRuntimeContext = {
			authorityId: request.authorityId, tenantId: request.tenantId, principalId: request.principalId,
			sessionId: request.sessionId, agentId: createRuntimeId("agent", "resume-two"), traceId: createRuntimeId("trace", "resume-two"),
		};
		const resumed = await harness.manager.resume(created.value.record.workspaceId, context, createRuntimeId("runtime", "resume-two"));
		expect(resumed).toMatchObject({ ok: true, value: { lease: { leaseRevision: 2, state: "active" } } });
		if (!resumed.ok) return;
		expect(resumed.value.fencingToken).not.toBe(created.value.fencingToken);
	});

	it("does not take over a live or recently accessed lease", async () => {
		const harness = await createWorktreeHarness(); harnesses.push(harness);
		const created = await harness.manager.create(await createRequest(harness, "takeover"));
		if (!created.ok) throw new Error(created.error.message);
		harness.liveness.owners = [created.value.record.ownerRuntimeId];
		expect(await harness.manager.takeoverStale(
			created.value.record.workspaceId,
			createRuntimeId("runtime", "takeover-two"),
			1,
			new Date("2026-07-23T00:00:00.000Z"),
		)).toMatchObject({ ok: false, error: { code: "active" } });
	});
});
