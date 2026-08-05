import { describe, expect, it } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildRunledgerLayout, createRuntimeId, runtimeDigest } from "../../src/runtime/contracts/public.ts";
import type { WorktreeLeaseRecord, WorktreeRecord } from "../../src/worktree/types.ts";
import {
	JsonWorkspaceBindingStore,
	createPersistedWorkspaceBinding,
	validatePersistedWorkspaceBinding,
} from "../../src/worktree/persisted-binding.ts";
import { validateHostWorkspaceBinding } from "../../src/cli/runtime-host-session.ts";

function record(root: string): WorktreeRecord {
	return {
		id: createRuntimeId("workspace", "persisted-binding-worktree"),
		sessionId: createRuntimeId("session", "persisted-binding-session"),
		workspaceId: createRuntimeId("workspace", "persisted-binding-workspace"),
		sourceRepositoryRef: {
			repositoryId: createRuntimeId("repository", runtimeDigest(root).digest.slice(0, 48)),
			rootDigest: runtimeDigest(root),
			displayName: "repository",
		},
		sourceRepositoryPath: root,
		sourceSubdir: "packages/app",
		worktreeLocator: join(root, ".managed", "worktree"),
		effectiveSubdir: "packages/app",
		baseRef: "main",
		baseCommit: "a".repeat(40),
		label: "task",
		state: "ready",
		createdAt: 1,
		lastAccessedAt: 1,
	};
}

function lease(workspaceId: WorktreeRecord["workspaceId"]): WorktreeLeaseRecord {
	return {
		workspaceId,
		ownerRuntimeId: createRuntimeId("runtime", "persisted-binding-owner"),
		leaseRevision: 4,
		fencingTokenDigest: runtimeDigest("persisted-binding-fence"),
		state: "active",
		expiresAt: "2026-08-05T01:00:00.000Z",
	};
}

describe("persisted workspace binding", () => {
	it("persists one exact binding below canonical home and validates it after host reconstruction", async () => {
		const home = await mkdtemp(join(tmpdir(), "runledger-persisted-binding-"));
		try {
			const layout = buildRunledgerLayout(home, "posix");
			const worktree = record(join(home, "source"));
			const binding = createPersistedWorkspaceBinding({
				record: worktree,
				lease: lease(worktree.workspaceId),
				effectiveCwd: join(worktree.worktreeLocator, "packages/app"),
		});
			expect(binding.ok).toBe(true);
			if (!binding.ok) return;

			const first = new JsonWorkspaceBindingStore({ layout, workspaceStorageKey: `ws-${"c".repeat(64)}` });
			expect(await first.commit(binding.value)).toMatchObject({ ok: true });
			expect((await stat(first.filePath)).mode & 0o777).toBe(0o600);

			const second = new JsonWorkspaceBindingStore({ layout, workspaceStorageKey: `ws-${"c".repeat(64)}` });
			expect(await second.read()).toEqual(binding.value);
			expect(await second.validate({
				workspaceId: worktree.workspaceId,
				repositoryId: worktree.sourceRepositoryRef.repositoryId,
				worktreeId: worktree.id,
				sourceSubdir: worktree.sourceSubdir,
				worktreePath: worktree.worktreeLocator,
				effectiveCwd: join(worktree.worktreeLocator, "packages/app"),
				baseCommit: worktree.baseCommit,
			})).toMatchObject({ ok: true, value: binding.value });
			expect(await second.validate({
				workspaceId: worktree.workspaceId,
				repositoryId: worktree.sourceRepositoryRef.repositoryId,
				worktreeId: worktree.id,
				sourceSubdir: worktree.sourceSubdir,
				worktreePath: worktree.worktreeLocator,
				effectiveCwd: join(worktree.worktreeLocator, "other"),
				baseCommit: worktree.baseCommit,
			})).toMatchObject({ ok: false, error: { code: "binding_drift" } });
			expect(validateHostWorkspaceBinding({ binding: binding.value, cwd: join(worktree.worktreeLocator, "packages/app") })).toMatchObject({ ok: true });
			expect(validateHostWorkspaceBinding({ binding: binding.value, cwd: join(worktree.worktreeLocator, "other") })).toMatchObject({ ok: false, error: { code: "binding_drift" } });
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	it("rejects stale CAS writes and malformed binding inputs", async () => {
		const home = await mkdtemp(join(tmpdir(), "runledger-persisted-binding-cas-"));
		try {
			const layout = buildRunledgerLayout(home, "posix");
			const worktree = record(join(home, "source"));
			const binding = createPersistedWorkspaceBinding({ record: worktree, lease: lease(worktree.workspaceId), effectiveCwd: worktree.worktreeLocator });
			expect(binding.ok).toBe(true);
			if (!binding.ok) return;
			const store = new JsonWorkspaceBindingStore({ layout, workspaceStorageKey: `ws-${"d".repeat(64)}` });
			expect(await store.commit(binding.value)).toMatchObject({ ok: true });
			const next = createPersistedWorkspaceBinding({ record: { ...worktree, baseCommit: "b".repeat(40) }, lease: lease(worktree.workspaceId), effectiveCwd: worktree.worktreeLocator });
			expect(next.ok).toBe(true);
			if (!next.ok) return;
			expect(await store.commit(next.value)).toMatchObject({ ok: false, error: { code: "binding_stale" } });
			expect(validatePersistedWorkspaceBinding({ ...binding.value, sourceSubdir: "../escape" })).toMatchObject({ ok: false, error: { code: "binding_invalid" } });
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	it("embeds a versioned worktree locator and classifies legacy records as migration_required", () => {
		const worktree = record(join("/", "home", "source"));
		const binding = createPersistedWorkspaceBinding({ record: worktree, lease: lease(worktree.workspaceId), effectiveCwd: worktree.worktreeLocator });
		expect(binding.ok).toBe(true);
		if (!binding.ok) return;
		expect(binding.value.worktreeLocator).toEqual({ version: 1, platform: "linux", kind: "posix", path: binding.value.worktreePath });
		// 结构合法的 version 1 记录仍可读。
		expect(validatePersistedWorkspaceBinding(binding.value)).toEqual({ ok: true, value: binding.value });
		// legacy：无 worktreeLocator 字段 → typed migration_required（不猜测转换）。
		const { worktreeLocator: _legacyLocator, ...legacy } = binding.value;
		const checked = validatePersistedWorkspaceBinding({ ...legacy, bindingDigest: runtimeDigest({ ...legacy, binding: legacy.binding }) });
		expect(checked).toMatchObject({ ok: false, error: { code: "binding_migration_required" } });
		// locator 与 worktreePath 不一致 → invalid。
		expect(validatePersistedWorkspaceBinding({ ...binding.value, worktreeLocator: { version: 1, platform: "linux", kind: "posix", path: "/other/path" } })).toMatchObject({ ok: false, error: { code: "binding_invalid" } });
	});
});
