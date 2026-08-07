import { describe, expect, it } from "vitest";
import { IS_WINDOWS } from "../../helpers/platform.ts";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	buildRunledgerLayout,
	createRuntimeId,
	runtimeDigest,
	workspaceStorageKey,
} from "../../../src/runtime/contracts/public.ts";
import { createLocalRuntimeHostScope, createProductionGitCommandPort } from "../../../src/cli/runtime-host-production.ts";
import { restoreResidentWorkspaceBinding } from "../../../src/cli/runtime-host.ts";
import { HostWorkspaceBindingService, type WorkspaceBindingAuditPort } from "../../../src/worktree/host-binding.ts";
import { JsonlWorktreeRegistryStore, WorktreeRegistry } from "../../../src/worktree/registry.ts";

const runFile = promisify(execFile);

async function git(cwd: string, args: readonly string[]): Promise<void> {
	await runFile("git", [...args], { cwd });
}

describe.skipIf(IS_WINDOWS)("resident Host worktree cold replay", () => {
	it("revalidates persisted Git registration, head, registry lease, and effective cwd before Security", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-worktree-replay-"));
		try {
			const source = join(root, "source");
			await mkdir(source, { recursive: true });
			await git(source, ["init", "--quiet"]);
			await git(source, ["config", "user.name", "RunLedger Test"]);
			await git(source, ["config", "user.email", "runledger@example.invalid"]);
			await writeFile(join(source, "README.md"), "initial\n");
			await git(source, ["add", "README.md"]);
			await git(source, ["commit", "--quiet", "-m", "initial"]);

			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			await mkdir(layout.home, { recursive: true });
			const workspaceId = createRuntimeId("workspace", "host-replay-workspace");
			const repositoryId = createRuntimeId("repository", runtimeDigest(source).digest.slice(0, 48));
			const authorityId = createRuntimeId("authority", runtimeDigest({ home: layout.home }).digest.slice(0, 32));
			const storageKey = workspaceStorageKey({ authorityId, tenantId: createRuntimeId("tenant", "local"), workspaceId, repositoryId });
			const registry = new WorktreeRegistry(new JsonlWorktreeRegistryStore(layout));
			const bindingService = new HostWorkspaceBindingService({
				layout,
				workspaceStorageKey: storageKey,
				managedRoot: join(layout.tmp, "worktrees"),
				registry,
				git: createProductionGitCommandPort(),
				ownerRuntimeId: createRuntimeId("runtime", "host-replay-owner"),
			});
			const created = await bindingService.create({
				sessionId: createRuntimeId("session", "host-replay-session"),
				workspaceId,
				sourceCwd: source,
				label: "replay",
			});
			expect(created.ok, JSON.stringify(created)).toBe(true);
			if (!created.ok) return;

			const scope = createLocalRuntimeHostScope({ layout, cwd: created.value.effectiveCwd, settings: {}, workspaceBinding: created.value });
			expect(await restoreResidentWorkspaceBinding({ layout, scope, cwd: created.value.effectiveCwd })).toEqual(created.value);
			const auditEvents: string[] = [];
			const workspaceAudit: WorkspaceBindingAuditPort = {
				bound: async () => { auditEvents.push("bound"); },
				validationRecorded: async () => { auditEvents.push("validation"); },
				released: async () => { auditEvents.push("released"); },
			};
			await restoreResidentWorkspaceBinding({ layout, scope, cwd: created.value.effectiveCwd, workspaceAudit });
			expect(auditEvents).toEqual(["validation"]);

			await git(created.value.worktreePath, ["config", "user.name", "RunLedger Test"]);
			await git(created.value.worktreePath, ["config", "user.email", "runledger@example.invalid"]);
			await writeFile(join(created.value.worktreePath, "drift.txt"), "drift\n");
			await git(created.value.worktreePath, ["add", "drift.txt"]);
			await git(created.value.worktreePath, ["commit", "--quiet", "-m", "drift"]);
			await expect(restoreResidentWorkspaceBinding({ layout, scope, cwd: created.value.effectiveCwd })).rejects.toThrow(/drift|head/iu);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
