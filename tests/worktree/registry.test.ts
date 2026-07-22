import { describe, expect, it } from "vitest";
import { createRuntimeId } from "../../src/runtime/protocol/v3/ids.ts";
import type { WorktreeRegistryMutationPort } from "../../src/worktree/ports.ts";
import { MemoryWorktreeRegistryMutationPort, WorktreeRegistry } from "../../src/worktree/registry.ts";
import type { WorktreeRecord } from "../../src/worktree/types.ts";

function record(): WorktreeRecord {
	return {
		authorityId: createRuntimeId("authority", "registry"), tenantId: createRuntimeId("tenant", "registry"),
		principalId: createRuntimeId("principal", "registry"), workspaceId: createRuntimeId("workspace", "registry"),
		repositoryId: createRuntimeId("repository", "registry"), sessionId: createRuntimeId("session", "registry"),
		createRequestId: createRuntimeId("command", "registry"), createRequestDigest: "d".repeat(64), bindingKind: "managed_worktree",
		sourceRepo: "/source", sourceCwd: "/source", worktreePath: "/managed/repo/task", effectiveCwd: "/managed/repo/task",
		worktreeId: "worktree_registry", subdirOffset: ".", label: "task", baseRef: "HEAD", baseCommit: "a".repeat(40),
		headCommit: "a".repeat(40), branch: "runledger/task", state: "creating", createdAt: "2026-07-22T00:00:00.000Z",
		lastAccessedAt: "2026-07-22T00:00:00.000Z", ownerRuntimeId: createRuntimeId("runtime", "registry"), leaseRevision: 1,
	};
}

describe("WorktreeRegistry", () => {
	it("replays append-only updates and tombstones", async () => {
		const registry = new WorktreeRegistry(new MemoryWorktreeRegistryMutationPort());
		const creating = record();
		expect((await registry.append("upsert", creating)).ok).toBe(true);
		expect((await registry.append("upsert", { ...creating, state: "active" })).ok).toBe(true);
		expect(await registry.get(creating.workspaceId)).toMatchObject({ ok: true, value: { state: "active" } });
		expect((await registry.append("remove", { ...creating, state: "removed" })).ok).toBe(true);
		expect(await registry.list()).toEqual({ ok: true, value: [] });
		expect(await registry.list(true)).toMatchObject({ ok: true, value: [{ state: "removed" }] });
	});

	it("fails closed on a sequence or digest break", async () => {
		const broken: WorktreeRegistryMutationPort = {
			read: async () => [{ revision: 2, operation: "upsert", record: record(), entryDigest: "bad" }],
			append: async () => "conflict",
		};
		expect(await new WorktreeRegistry(broken).list()).toMatchObject({ ok: false, error: { code: "registry_failed" } });
	});

	it("does not accept a stale storage CAS", async () => {
		const storage = new MemoryWorktreeRegistryMutationPort();
		const value = record();
		expect(await storage.append({ revision: 2, operation: "upsert", record: value, entryDigest: "x" }, 1)).toBe("conflict");
	});
});
