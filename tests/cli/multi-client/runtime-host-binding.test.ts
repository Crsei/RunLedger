import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { runtimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import type { RuntimeHostScope } from "../../../src/runtime/host/types.ts";
import { JsonWorkspaceBindingStore, type PersistedWorkspaceBinding } from "../../../src/worktree/persisted-binding.ts";
import { restoreHostWorkspaceBinding } from "../../../src/cli/runtime-host-binding.ts";
import * as hostSession from "../../../src/cli/runtime-host-session.ts";

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function scope(): RuntimeHostScope {
	return {
		authorityId: createRuntimeId("authority", "host-binding"),
		tenantId: createRuntimeId("tenant", "host-binding"),
		workspaceId: createRuntimeId("workspace", "host-binding"),
		repositoryId: createRuntimeId("repository", "host-binding"),
		workspaceStorageKey: `ws-${"b".repeat(64)}`,
		protocolVersion: 1,
		hostBuildDigest: runtimeDigest("host"),
		compositionDigest: runtimeDigest("composition"),
		settingsDigest: runtimeDigest("settings"),
		modelCatalogDigest: runtimeDigest("models"),
		tracePolicyDigest: runtimeDigest("trace"),
		securityAdapterDigest: runtimeDigest("security"),
		extensionProfileDigest: runtimeDigest("extensions"),
		sessionStorageContractVersion: 1,
		peerAttestor: { kind: "test", generation: 1, configDigest: runtimeDigest("attestor") },
	};
}

function binding(root: string, hostScope: RuntimeHostScope): PersistedWorkspaceBinding {
	const worktreePath = join(root, "managed-worktree");
	const effectiveCwd = join(worktreePath, "packages", "app");
	const sourceRepositoryPath = join(root, "source");
	const worktreeId = createRuntimeId("workspace", "host-binding-worktree");
	const baseCommit = "a".repeat(40);
	const body = {
		version: 1 as const,
		binding: {
			workspaceId: hostScope.workspaceId,
			repositoryId: createRuntimeId("repository", runtimeDigest(sourceRepositoryPath).digest.slice(0, 48)),
			bindingKind: "managed_worktree" as const,
			effectiveCwdDigest: runtimeDigest(effectiveCwd),
			baseCommit,
			worktreeRef: { subjectKind: "receipt" as const, digest: runtimeDigest({ worktreeId, worktreePath, baseCommit }) },
		},
		worktreeId,
		sourceRepositoryPath,
		sourceSubdir: ".",
		worktreePath,
		worktreeLocator: { version: 1 as const, platform: "linux" as const, kind: "posix" as const, path: worktreePath },
		effectiveCwd,
		baseCommit,
		headCommit: baseCommit,
		lease: {
			workspaceId: hostScope.workspaceId,
			ownerRuntimeId: createRuntimeId("runtime", "host-binding-owner"),
			leaseRevision: 3,
			fencingTokenDigest: runtimeDigest("fence"),
			state: "active" as const,
			expiresAt: "2099-01-01T00:00:00.000Z",
		},
	};
	return { ...body, bindingDigest: runtimeDigest(body) };
}

describe("resident Host workspace binding cold replay", () => {
	it("forces a rebound session to the canonical effective cwd instead of the source cwd", () => {
		const root = join(tmpdir(), "runledger-host-binding-session-workspace");
		const persisted = binding(root, scope());
		const candidate = hostSession as typeof hostSession & {
			resolveProductionSessionWorkspace?: (input: {
				readonly requestedCwd?: string;
				readonly defaultCwd: string;
				readonly binding?: PersistedWorkspaceBinding;
			}) => { readonly cwd: string; readonly binding?: PersistedWorkspaceBinding };
		};
		expect(candidate.resolveProductionSessionWorkspace).toBeTypeOf("function");
		expect(candidate.resolveProductionSessionWorkspace!({
			requestedCwd: persisted.sourceRepositoryPath,
			defaultCwd: persisted.sourceRepositoryPath,
			binding: persisted,
		})).toEqual({ cwd: persisted.effectiveCwd, binding: persisted });
	});

	it("restores one canonical binding and rejects identity or cwd drift before composition", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-binding-compose-"));
		roots.push(root);
		const hostScope = scope();
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		const persisted = binding(root, hostScope);
		const boundScope = { ...hostScope, repositoryId: persisted.binding.repositoryId };
		const store = new JsonWorkspaceBindingStore({ layout, workspaceStorageKey: boundScope.workspaceStorageKey });
		expect(await store.commit(persisted)).toMatchObject({ ok: true });

		expect(await restoreHostWorkspaceBinding({ store, scope: boundScope, cwd: persisted.effectiveCwd })).toEqual(persisted);
		await expect(restoreHostWorkspaceBinding({ store, scope: { ...boundScope, repositoryId: createRuntimeId("repository", "other") }, cwd: persisted.effectiveCwd })).rejects.toThrow(/identity/iu);
		await expect(restoreHostWorkspaceBinding({ store, scope: boundScope, cwd: join(persisted.worktreePath, "other") })).rejects.toThrow(/drift/iu);
	});

	it("returns no binding only when the canonical store is empty", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-binding-empty-"));
		roots.push(root);
		const hostScope = scope();
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		const store = new JsonWorkspaceBindingStore({ layout, workspaceStorageKey: hostScope.workspaceStorageKey });
		expect(await restoreHostWorkspaceBinding({ store, scope: hostScope, cwd: root })).toBeUndefined();
	});
});
