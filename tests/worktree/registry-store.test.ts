import { lstat, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildRunledgerLayout, createRuntimeId, runtimeDigest } from "../../src/runtime/contracts/public.ts";
import { JsonlWorktreeRegistryStore, WorktreeRegistry } from "../../src/worktree/registry.ts";
import type { WorktreeRecord } from "../../src/worktree/types.ts";

const cleanup: string[] = [];

afterEach(async () => {
	await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function record(): WorktreeRecord {
	const repositoryId = createRuntimeId("repository", "registry-store-repository");
	return {
		id: createRuntimeId("workspace", "registry-store-worktree"),
		sessionId: createRuntimeId("session", "registry-store-session"),
		workspaceId: createRuntimeId("workspace", "registry-store-workspace"),
		sourceRepositoryRef: {
			repositoryId,
			rootDigest: runtimeDigest("/source"),
			displayName: "source",
		},
		sourceRepositoryPath: "/source",
		sourceSubdir: "",
		worktreeLocator: "/managed/worktree",
		effectiveSubdir: "",
		baseRef: "main",
		baseCommit: "a".repeat(40),
		label: "task",
		state: "ready",
		createdAt: 1,
		lastAccessedAt: 1,
	};
}

async function fixture(): Promise<ReturnType<typeof buildRunledgerLayout>> {
	const home = await mkdtemp(join(tmpdir(), "runledger-worktree-store-"));
	cleanup.push(home);
	return buildRunledgerLayout(home, "posix");
}

describe("JSONL WorktreeRegistryStore", () => {
	it("writes only below the injected canonical home with 0700 directories and a 0600 JSONL file", async () => {
		const layout = await fixture();
		const store = new JsonlWorktreeRegistryStore(layout, { retries: 20, retryDelayMs: 5 });
		const registry = new WorktreeRegistry(store);

		expect(store.filePath).toBe(join(layout.home, "state", "worktrees", "registry.jsonl"));
		await expect(registry.create(record())).resolves.toMatchObject({ ok: true, value: { inserted: true } });

		expect((await stat(join(layout.home, "state"))).mode & 0o777).toBe(0o700);
		expect((await stat(join(layout.home, "state", "worktrees"))).mode & 0o777).toBe(0o700);
		expect((await lstat(store.filePath)).mode & 0o777).toBe(0o600);
		expect((await readFile(store.filePath, "utf8")).trim().split("\n")).toHaveLength(1);
	});

	it("serializes transactions across two store instances with proper-lockfile", async () => {
		const layout = await fixture();
		const firstStore = new JsonlWorktreeRegistryStore(layout, { retries: 100, retryDelayMs: 5 });
		const secondStore = new JsonlWorktreeRegistryStore(layout, { retries: 100, retryDelayMs: 5 });
		let entered = false;
		let releaseGate!: () => void;
		const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
		let firstStarted!: () => void;
		const started = new Promise<void>((resolve) => { firstStarted = resolve; });

		const first = firstStore.withLock(async () => {
			entered = true;
			firstStarted();
			await gate;
			return "first";
		});
		await started;
		const second = secondStore.withLock(async () => "second");
		await new Promise<void>((resolve) => setTimeout(resolve, 25));

		expect(entered).toBe(true);
		expect(await Promise.race([second.then(() => true), Promise.resolve(false)])).toBe(false);
		releaseGate();
		expect(await Promise.all([first, second])).toEqual(["first", "second"]);
	});
});
