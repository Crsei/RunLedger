import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductionAgentWorkspaceAdapter } from "../../../src/runtime/agents/integration/worktree-workspace.ts";
import type {
	AgentWorkspaceAllocateRequest,
	AgentWorkspacePort,
	AgentWorkspaceReleaseReceiptRef,
	AgentWorkspaceReleaseRequest,
} from "../../../src/runtime/agents/types.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import type { WorkspaceReleaseReceiptRef } from "../../../src/runtime/protocol/v3/workspace.ts";
import { createWorktreeHarness, type WorktreeTestHarness } from "../../worktree/fixtures.ts";

const harnesses: WorktreeTestHarness[] = [];
const RELEASED_AT = "2026-07-23T02:03:04.000Z";

afterEach(async () => {
	vi.restoreAllMocks();
	for (const harness of harnesses.splice(0)) await harness.cleanup();
});

async function allocatedWorkspace(seed: string) {
	const harness = await createWorktreeHarness();
	harnesses.push(harness);
	const rootAgentId = createRuntimeId("agent", `${seed}-root`);
	const childAgentId = createRuntimeId("agent", `${seed}-child`);
	const childSessionId = createRuntimeId("session", `${seed}-child`);
	const adapter = new ProductionAgentWorkspaceAdapter({
		manager: harness.manager,
		authorityId: createRuntimeId("authority", seed),
		tenantId: createRuntimeId("tenant", seed),
		principalId: createRuntimeId("principal", seed),
		repositoryId: createRuntimeId("repository", seed),
		sourceRepo: harness.sourceRepo,
		sourceCwd: harness.sourceCwd,
		rootAgentId,
		rootOwnerRuntimeId: createRuntimeId("runtime", `${seed}-root`),
	});
	const strategy = {
		strategyId: createRuntimeId("resource", seed),
		kind: "managed_worktree" as const,
		strategyDigest: canonicalDigest(seed),
	};
	const allocateBody: Omit<AgentWorkspaceAllocateRequest, "requestDigest"> = {
		requestId: createRuntimeId("command", `${seed}-allocate`),
		parentAgentId: rootAgentId,
		parentSessionId: createRuntimeId("session", `${seed}-parent`),
		parentWorkspaceId: createRuntimeId("workspace", `${seed}-parent`),
		childAgentId,
		childSessionId,
		role: "build",
		strategy,
	};
	const allocated = await adapter.allocate({
		...allocateBody,
		requestDigest: canonicalDigest(allocateBody),
	});
	if (!allocated.ok) throw new Error(allocated.error.message);
	return {
		harness,
		adapter,
		childAgentId,
		childSessionId,
		receipt: allocated.value,
	};
}

describe("production Agent Workspace release", () => {
	it("replays an exact completed release before rejecting an aborted retry", async () => {
		const harness = await createWorktreeHarness();
		harnesses.push(harness);
		const rootAgentId = createRuntimeId("agent", "workspace-release-root");
		const parentSessionId = createRuntimeId("session", "workspace-release-parent");
		const childAgentId = createRuntimeId("agent", "workspace-release-child");
		const childSessionId = createRuntimeId("session", "workspace-release-child");
		const authorityId = createRuntimeId("authority", "workspace-release");
		const tenantId = createRuntimeId("tenant", "workspace-release");
		const principalId = createRuntimeId("principal", "workspace-release");
		const repositoryId = createRuntimeId("repository", "workspace-release");
		harness.clock.now = new Date(RELEASED_AT);
		const adapterOptions = {
			manager: harness.manager,
			authorityId,
			tenantId,
			principalId,
			repositoryId,
			sourceRepo: harness.sourceRepo,
			sourceCwd: harness.sourceCwd,
			rootAgentId,
			rootOwnerRuntimeId: createRuntimeId("runtime", "workspace-release-root"),
			clock: () => new Date(RELEASED_AT),
		};
		const adapter = new ProductionAgentWorkspaceAdapter(adapterOptions);
		const workspace: AgentWorkspacePort = adapter;
		const strategy = {
			strategyId: createRuntimeId("resource", "workspace-release"),
			kind: "managed_worktree" as const,
			strategyDigest: canonicalDigest("workspace release strategy"),
		};
		const allocateBody: Omit<AgentWorkspaceAllocateRequest, "requestDigest"> = {
			requestId: createRuntimeId("command", "workspace-release-allocate"),
			parentAgentId: rootAgentId,
			parentSessionId,
			parentWorkspaceId: createRuntimeId("workspace", "workspace-release-parent"),
			childAgentId,
			childSessionId,
			role: "build",
			strategy,
		};
		const allocated = await adapter.allocate({
			...allocateBody,
			requestDigest: canonicalDigest(allocateBody),
		});
		if (!allocated.ok) throw new Error(allocated.error.message);
		const releaseBody: Omit<AgentWorkspaceReleaseRequest, "requestDigest"> = {
			requestId: createRuntimeId("command", "workspace-release-exact-retry"),
			agentId: childAgentId,
			sessionId: childSessionId,
			previousReceipt: allocated.value,
			reason: "completed",
		};
		const release = { ...releaseBody, requestDigest: canonicalDigest(releaseBody) };
		const managerRelease = vi.spyOn(harness.manager, "release");

		const first = await workspace.release(release);
		if (!first.ok) throw new Error(first.error.message);
		const typedRelease: AgentWorkspaceReleaseReceiptRef = first.value;
		const managerRequest = managerRelease.mock.calls[0]?.[0];
		const managerResultPromise = managerRelease.mock.results[0]?.value;
		if (!managerRequest || !managerResultPromise) throw new Error("manager release was not called");
		const managerResult = await managerResultPromise;
		if (!managerResult.ok || !managerResult.value.receipt || !managerResult.value.record.lease) {
			throw new Error("manager release did not return retained Workspace evidence");
		}
		const authorityReceipt: WorkspaceReleaseReceiptRef = managerResult.value.receipt;
		const releasedWorkspaceBody = {
			...allocated.value,
			receiptId: authorityReceipt.receiptId,
			status: "released" as const,
			issuedAt: RELEASED_AT,
		};
		const { receiptDigest: _allocatedDigest, ...releasedWorkspaceBodyWithoutDigest } = releasedWorkspaceBody;
		const releasedWorkspaceReceipt = {
			...releasedWorkspaceBodyWithoutDigest,
			receiptDigest: canonicalDigest(releasedWorkspaceBodyWithoutDigest),
		};
		const expectedAuthorityReceiptBody: Omit<WorkspaceReleaseReceiptRef, "receiptDigest"> = {
			schemaVersion: 1,
			kind: "workspace_release_receipt",
			receiptId: authorityReceipt.receiptId,
			requestId: managerRequest.requestId,
			requestDigest: canonicalDigest(managerRequest),
			callerRequestDigest: release.requestDigest,
			authorityId,
			tenantId,
			principalId,
			sessionId: childSessionId,
			agentId: childAgentId,
			workspaceId: allocated.value.workspaceId,
			repositoryId,
			envelopeDigest: managerRequest.envelopeDigest,
			leaseId: allocated.value.leaseId,
			leaseRevision: allocated.value.leaseRevision,
			releasedLeaseDigest: canonicalDigest(managerResult.value.record.lease),
			retainedRecordDigest: canonicalDigest(managerResult.value.record),
			releasedAt: RELEASED_AT,
		};
		expect(authorityReceipt).toEqual({
			...expectedAuthorityReceiptBody,
			receiptDigest: canonicalDigest(expectedAuthorityReceiptBody),
		});
		const releaseReceiptBody: Omit<AgentWorkspaceReleaseReceiptRef, "receiptDigest"> = {
			schemaVersion: 1,
			kind: "agent_workspace_release_receipt",
			receiptId: authorityReceipt.receiptId,
			requestId: release.requestId,
			requestDigest: release.requestDigest,
			agentId: childAgentId,
			sessionId: childSessionId,
			workspaceId: allocated.value.workspaceId,
			repositoryId,
			previousReceiptId: allocated.value.receiptId,
			previousReceiptDigest: allocated.value.receiptDigest,
			bindingDigest: allocated.value.bindingDigest,
			leaseId: allocated.value.leaseId,
			leaseRevision: allocated.value.leaseRevision,
			releasedWorkspaceReceipt,
			authorityReceipt,
			releasedAt: RELEASED_AT,
		};
		expect(typedRelease).toEqual({
			...releaseReceiptBody,
			receiptDigest: canonicalDigest(releaseReceiptBody),
		});
		expect(typedRelease.receiptId).toBe(authorityReceipt.receiptId);
		expect(typedRelease.receiptId).not.toBe(allocated.value.receiptId);
		expect(typedRelease.releasedWorkspaceReceipt.issuedAt).toBe(RELEASED_AT);
		expect(typedRelease.authorityReceipt.retainedRecordDigest).toBe(canonicalDigest(managerResult.value.record));
		const controller = new AbortController();
		controller.abort("parent graph append failed after external release");
		expect(await workspace.release(release, controller.signal)).toEqual(first);
		expect(managerRelease).toHaveBeenCalledTimes(1);

		const coldAdapter = new ProductionAgentWorkspaceAdapter(adapterOptions);
		expect(await coldAdapter.release(release)).toEqual(first);
		expect(managerRelease).toHaveBeenCalledTimes(1);

		const conflictBody = { ...releaseBody, reason: "failed" as const };
		const coldConflictAdapter = new ProductionAgentWorkspaceAdapter(adapterOptions);
		expect(await coldConflictAdapter.release({
			...conflictBody,
			requestDigest: canonicalDigest(conflictBody),
		})).toMatchObject({
			ok: false,
			error: { code: "idempotency_conflict", retryable: false },
		});
		expect(managerRelease).toHaveBeenCalledTimes(1);
	});

	it("keeps the request digest claimed after a non-retryable release failure", async () => {
		const fixture = await allocatedWorkspace("release-nonretryable-claim");
		const managerRelease = vi.spyOn(fixture.harness.manager, "release");
		const requestId = createRuntimeId("command", "release-nonretryable-claim");
		const invalidBody: Omit<AgentWorkspaceReleaseRequest, "requestDigest"> = {
			requestId,
			agentId: createRuntimeId("agent", "release-nonretryable-wrong"),
			sessionId: fixture.childSessionId,
			previousReceipt: fixture.receipt,
			reason: "completed",
		};
		const invalid = {
			...invalidBody,
			requestDigest: canonicalDigest(invalidBody),
		};
		expect(await fixture.adapter.release(invalid)).toMatchObject({
			ok: false,
			error: { code: "workspace_invalid", retryable: false },
		});

		const changedBody: Omit<AgentWorkspaceReleaseRequest, "requestDigest"> = {
			...invalidBody,
			agentId: fixture.childAgentId,
		};
		expect(await fixture.adapter.release({
			...changedBody,
			requestDigest: canonicalDigest(changedBody),
		})).toMatchObject({
			ok: false,
			error: { code: "idempotency_conflict", retryable: false },
		});
		expect(managerRelease).not.toHaveBeenCalled();
	});

	it("re-enters an exact retryable release without allowing its request identity to change", async () => {
		const fixture = await allocatedWorkspace("release-retryable-claim");
		const release = fixture.harness.manager.release.bind(fixture.harness.manager);
		const managerRelease = vi.spyOn(fixture.harness.manager, "release")
			.mockResolvedValueOnce({
				ok: false,
				error: {
					code: "uncertain",
					message: "injected retryable release failure",
					retryable: true,
				},
			})
			.mockImplementation((request) => release(request));
		const requestBody: Omit<AgentWorkspaceReleaseRequest, "requestDigest"> = {
			requestId: createRuntimeId("command", "release-retryable-claim"),
			agentId: fixture.childAgentId,
			sessionId: fixture.childSessionId,
			previousReceipt: fixture.receipt,
			reason: "completed",
		};
		const request = {
			...requestBody,
			requestDigest: canonicalDigest(requestBody),
		};
		expect(await fixture.adapter.release(request)).toMatchObject({
			ok: false,
			error: { code: "workspace_invalid", retryable: true },
		});

		const changedBody: Omit<AgentWorkspaceReleaseRequest, "requestDigest"> = {
			...requestBody,
			reason: "failed",
		};
		expect(await fixture.adapter.release({
			...changedBody,
			requestDigest: canonicalDigest(changedBody),
		})).toMatchObject({
			ok: false,
			error: { code: "idempotency_conflict", retryable: false },
		});

		const retried = await fixture.adapter.release(request);
		expect(retried).toMatchObject({ ok: true });
		expect(await fixture.adapter.release(request)).toEqual(retried);
		expect(managerRelease).toHaveBeenCalledTimes(2);
	});
});
