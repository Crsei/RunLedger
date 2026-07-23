import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeId } from "../../src/runtime/protocol/v3/ids.ts";
import type { WorkspaceBindRequest } from "../../src/runtime/protocol/v3/workspace.ts";
import { RuntimeWorkspaceServiceAdapter } from "../../src/worktree/integration/runtime-workspace-adapter.ts";
import { createWorktreeHarness, type WorktreeTestHarness } from "./fixtures.ts";

const harnesses: WorktreeTestHarness[] = [];
afterEach(async () => { for (const harness of harnesses.splice(0)) await harness.cleanup(); });

describe("RuntimeWorkspaceServiceAdapter", () => {
	it("binds a managed worktree and replays the exact request without a second side effect", async () => {
		const harness = await createWorktreeHarness(); harnesses.push(harness);
		const info = await harness.git.inspectRepository(harness.sourceCwd);
		if (!info.ok) throw new Error(info.error.message);
		const request: WorkspaceBindRequest = {
			schemaVersion: 1, kind: "bind", requestId: createRuntimeId("command", "adapter-bind"),
			authorityId: createRuntimeId("authority", "adapter-bind"), tenantId: createRuntimeId("tenant", "adapter-bind"),
			principalId: createRuntimeId("principal", "adapter-bind"), sessionId: createRuntimeId("session", "adapter-bind"),
			agentId: createRuntimeId("agent", "adapter-bind"), traceId: createRuntimeId("trace", "adapter-bind"),
			repositoryId: createRuntimeId("repository", "adapter-bind"), bindingKind: "managed_worktree",
			requestedCwd: harness.sourceCwd, branch: "runledger/adapter-bind", baseCommit: info.value.headCommit,
			ownerRuntimeId: createRuntimeId("runtime", "adapter-bind"),
		};
		const adapter = new RuntimeWorkspaceServiceAdapter(harness.manager);
		const first = await adapter.request(request);
		const second = await adapter.request(request);
		expect(first).toMatchObject({ kind: "bound", binding: { bindingKind: "managed_worktree" }, lease: { state: "active" } });
		expect(second).toEqual(first);
		const listed = await harness.manager.list();
		expect(listed.ok && listed.value).toHaveLength(1);
	});

	it("rejects request-id collision and stale source binding commit", async () => {
		const harness = await createWorktreeHarness(); harnesses.push(harness);
		const info = await harness.git.inspectRepository(harness.sourceCwd);
		if (!info.ok) throw new Error(info.error.message);
		const request: WorkspaceBindRequest = {
			schemaVersion: 1, kind: "bind", requestId: createRuntimeId("command", "adapter-source"),
			authorityId: createRuntimeId("authority", "adapter-source"), tenantId: createRuntimeId("tenant", "adapter-source"),
			principalId: createRuntimeId("principal", "adapter-source"), sessionId: createRuntimeId("session", "adapter-source"),
			agentId: createRuntimeId("agent", "adapter-source"), traceId: createRuntimeId("trace", "adapter-source"),
			repositoryId: createRuntimeId("repository", "adapter-source"), bindingKind: "source",
			requestedCwd: harness.sourceCwd, branch: info.value.branch, baseCommit: "0".repeat(40),
			ownerRuntimeId: createRuntimeId("runtime", "adapter-source"),
		};
		const adapter = new RuntimeWorkspaceServiceAdapter(harness.manager);
		expect(await adapter.request(request)).toMatchObject({ kind: "rejected", code: "stale" });
		const changed = { ...request, baseCommit: info.value.headCommit };
		expect(await adapter.request(changed)).toMatchObject({ kind: "rejected", code: "idempotency_conflict" });
	});
});
