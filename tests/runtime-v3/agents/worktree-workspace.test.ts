import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductionAgentWorkspaceAdapter } from "../../../src/runtime/agents/integration/worktree-workspace.ts";
import type {
	AgentWorkspaceAllocateRequest,
	AgentWorkspaceReleaseRequest,
} from "../../../src/runtime/agents/types.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { createWorktreeHarness, type WorktreeTestHarness } from "../../worktree/fixtures.ts";

const harnesses: WorktreeTestHarness[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const harness of harnesses.splice(0)) await harness.cleanup();
});

describe("production Agent Workspace release", () => {
	it("replays an exact completed release before rejecting an aborted retry", async () => {
		const harness = await createWorktreeHarness();
		harnesses.push(harness);
		const rootAgentId = createRuntimeId("agent", "workspace-release-root");
		const parentSessionId = createRuntimeId("session", "workspace-release-parent");
		const childAgentId = createRuntimeId("agent", "workspace-release-child");
		const childSessionId = createRuntimeId("session", "workspace-release-child");
		const adapter = new ProductionAgentWorkspaceAdapter({
			manager: harness.manager,
			authorityId: createRuntimeId("authority", "workspace-release"),
			tenantId: createRuntimeId("tenant", "workspace-release"),
			principalId: createRuntimeId("principal", "workspace-release"),
			repositoryId: createRuntimeId("repository", "workspace-release"),
			sourceRepo: harness.sourceRepo,
			sourceCwd: harness.sourceCwd,
			rootAgentId,
			rootOwnerRuntimeId: createRuntimeId("runtime", "workspace-release-root"),
		});
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

		const first = await adapter.release(release);
		expect(first).toMatchObject({ ok: true, value: { status: "released" } });
		const controller = new AbortController();
		controller.abort("parent graph append failed after external release");
		expect(await adapter.release(release, controller.signal)).toEqual(first);
		expect(managerRelease).toHaveBeenCalledTimes(1);

		const conflictBody = { ...releaseBody, reason: "failed" as const };
		expect(await adapter.release({
			...conflictBody,
			requestDigest: canonicalDigest(conflictBody),
		}, controller.signal)).toMatchObject({
			ok: false,
			error: { code: "idempotency_conflict", retryable: false },
		});
		expect(managerRelease).toHaveBeenCalledTimes(1);
	});
});
