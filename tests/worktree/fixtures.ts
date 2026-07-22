import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRuntimeId, type RuntimeInstanceId } from "../../src/runtime/protocol/v3/ids.ts";
import {
	NodeGitCommandPort,
	NodeWorktreeContentPort,
	nodeWorktreeFileSystem,
} from "../../src/storage/worktree-node-adapter.ts";
import { GitOperations } from "../../src/worktree/git-operations.ts";
import { MemoryWorkspaceLeaseMutationPort } from "../../src/worktree/lease-store.ts";
import { WorktreeManager } from "../../src/worktree/manager.ts";
import type {
	WorktreeLivenessPort,
	WorktreeSnapshotPort,
	WorktreeTokenPort,
} from "../../src/worktree/ports.ts";
import { MemoryWorktreeRegistryMutationPort, WorktreeRegistry } from "../../src/worktree/registry.ts";

class SequentialTokens implements WorktreeTokenPort {
	#counter = 0;
	public async issue(): Promise<string> {
		this.#counter += 1;
		return `test-fencing-token-${this.#counter}`;
	}
}

export class MutableLiveness implements WorktreeLivenessPort {
	owners: readonly RuntimeInstanceId[] = [];
	public async activeOwners(): Promise<readonly RuntimeInstanceId[]> {
		return this.owners;
	}
}

async function git(cwd: string, ...args: string[]): Promise<void> {
	const result = await new NodeGitCommandPort().run({ cwd, arguments: args, timeoutMs: 30_000 });
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

export interface WorktreeTestHarness {
	root: string;
	sourceRepo: string;
	sourceCwd: string;
	managedRoot: string;
	manager: WorktreeManager;
	registry: WorktreeRegistry;
	leases: MemoryWorkspaceLeaseMutationPort;
	liveness: MutableLiveness;
	git: GitOperations;
	content: NodeWorktreeContentPort;
	clock: { now: Date };
	cleanup(): Promise<void>;
}

export async function createWorktreeHarness(options?: { snapshots?: WorktreeSnapshotPort }): Promise<WorktreeTestHarness> {
	const root = await mkdtemp(join(tmpdir(), "runledger-worktree-"));
	const sourceRepo = join(root, "source");
	const sourceCwd = join(sourceRepo, "packages", "app");
	const managedRoot = join(root, "managed");
	await mkdir(sourceCwd, { recursive: true });
	await git(sourceRepo, "init", "-b", "main");
	await git(sourceRepo, "config", "user.name", "RunLedger Test");
	await git(sourceRepo, "config", "user.email", "runledger@example.invalid");
	await writeFile(join(sourceRepo, "README.md"), "source\n");
	await writeFile(join(sourceCwd, "index.ts"), "export const source = true;\n");
	await git(sourceRepo, "add", "README.md", "packages/app/index.ts");
	await git(sourceRepo, "commit", "-m", "initial");
	const registry = new WorktreeRegistry(new MemoryWorktreeRegistryMutationPort());
	const leases = new MemoryWorkspaceLeaseMutationPort();
	const liveness = new MutableLiveness();
	const clock = { now: new Date("2026-07-22T00:00:00.000Z") };
	const gitOperations = new GitOperations(new NodeGitCommandPort());
	const content = new NodeWorktreeContentPort();
	const manager = new WorktreeManager({
		managedRoot,
		filesystem: nodeWorktreeFileSystem,
		git: gitOperations,
		registry,
		leases,
		tokens: new SequentialTokens(),
		liveness,
		...(options?.snapshots ? { snapshots: options.snapshots } : {}),
		validatorPrincipalId: createRuntimeId("principal", "workspace-validator"),
		clock: () => clock.now,
	});
	return {
		root, sourceRepo, sourceCwd, managedRoot, manager, registry, leases, liveness, git: gitOperations, content, clock,
		cleanup: async () => { await rm(root, { recursive: true, force: true }); },
	};
}
