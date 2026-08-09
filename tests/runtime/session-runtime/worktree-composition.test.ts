import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import { createRuntimeId, type SessionId } from "../../../src/runtime/protocol/ids.ts";
import type { OwnerFence } from "../../../src/runtime/session-owner/types.ts";
import { openSessionDatabase } from "../../../src/storage/session-store/database.ts";
import { installSessionStoreSchema } from "../../../src/storage/session-store/schema.ts";
import { SessionStore } from "../../../src/storage/session-store/session-store.ts";
import { MemoryWorktreeRegistryStore, WorktreeRegistry } from "../../../src/worktree/registry.ts";
import type { GitCommandPort, GitCommandRequest, GitCommandResult } from "../../../src/worktree/ports.ts";
import { createNativeWorkspaceAdapters } from "../../../src/workspace/native/adapters.ts";

const runFile = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class RealGitCommandPort implements GitCommandPort {
	public async run(request: GitCommandRequest, signal?: AbortSignal): Promise<GitCommandResult> {
		try {
			const result = await runFile("git", request.arguments as string[], {
				cwd: request.cwd,
				input: request.stdin,
				signal,
				timeout: request.timeoutMs,
			});
			return { stdout: result.stdout, stderr: result.stderr, exitCode: 0, signaled: false };
		} catch (error) {
			const value = error as { readonly stdout?: string; readonly stderr?: string; readonly code?: number | string; readonly killed?: boolean };
			return { stdout: value.stdout ?? "", stderr: value.stderr ?? "", exitCode: typeof value.code === "number" ? value.code : 1, signaled: value.killed === true };
		}
	}
}

interface SessionWorkspaceFactoryModule {
	createSessionWorkspaceFactory(options: {
		readonly layout: ReturnType<typeof buildRunledgerLayout>;
		readonly sourceCwd: string;
		readonly mode: "auto" | "create" | "disabled";
		readonly label?: string;
		readonly git: GitCommandPort;
		readonly registry: WorktreeRegistry;
		readonly workspace: ReturnType<typeof createNativeWorkspaceAdapters>;
	}): {
		open(input: { readonly sessionId: SessionId; readonly store: SessionStore; readonly fence: OwnerFence }): Promise<{
			readonly effectiveCwd: string;
			release(reason: "paused" | "detached" | "error" | "fenced"): Promise<void>;
		}>;
	};
}

async function loadComposition(): Promise<SessionWorkspaceFactoryModule | undefined> {
	const sourcePath = join(process.cwd(), "src/runtime/session-runtime/worktree-composition.ts");
	expect(existsSync(sourcePath), "S3 Session worktree composition module must exist").toBe(true);
	if (!existsSync(sourcePath)) return undefined;
	const specifier = "../../../src/runtime/session-runtime/worktree-composition.ts";
	return await import(specifier) as SessionWorkspaceFactoryModule;
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
	await runFile("git", args as string[], { cwd });
}

describe.skipIf(process.platform === "win32")("Session worktree production composition", () => {
	it("creates the canonical Session locator, cold-resumes it, and fails closed on drift or disable", async () => {
		const module = await loadComposition();
		if (module === undefined) return;
		const root = await mkdtemp(join(tmpdir(), "runledger-session-worktree-"));
		roots.push(root);
		const source = join(root, "source");
		const home = join(root, "home");
		await mkdir(source, { recursive: true });
		await git(source, ["init", "--quiet"]);
		await git(source, ["config", "user.name", "RunLedger Test"]);
		await git(source, ["config", "user.email", "runledger@example.invalid"]);
		await writeFile(join(source, "README.md"), "initial\n");
		await git(source, ["add", "README.md"]);
		await git(source, ["commit", "--quiet", "-m", "initial"]);

		const layout = buildRunledgerLayout(home, "posix");
		await mkdir(layout.worktrees, { recursive: true });
		const db = openSessionDatabase(layout.database);
		installSessionStoreSchema(db);
		const store = new SessionStore(db);
		const sessionId = createRuntimeId("session", "worktree-composition") as SessionId;
		store.createSession({
			sessionId,
			workspaceId: createRuntimeId("workspace", "worktree-composition"),
			repositoryId: createRuntimeId("repository", "placeholder"),
			settingsDigest: "d".repeat(64),
		});
		const registry = new WorktreeRegistry(new MemoryWorktreeRegistryStore());
		const gitPort = new RealGitCommandPort();
		const workspace = createNativeWorkspaceAdapters("linux", { git: gitPort, managedRoot: layout.worktrees });
		const firstFence: OwnerFence = {
			sessionId,
			runtimeId: createRuntimeId("runtime", "worktree-first"),
			generation: 1,
		};
		store.database().runSync(
			"INSERT INTO session_owners (session_id, runtime_id, generation, state, updated_at_ms) VALUES (?, ?, ?, 'running', 1)",
			[sessionId, firstFence.runtimeId, firstFence.generation],
		);
		const createFactory = module.createSessionWorkspaceFactory({
			layout,
			sourceCwd: source,
			mode: "create",
			label: "task",
			git: gitPort,
			registry,
			workspace,
		});
		const first = await createFactory.open({ sessionId, store, fence: firstFence });
		expect(first.effectiveCwd).toBe(join(layout.worktrees, sessionId));
		expect(JSON.parse(store.getSession(sessionId)?.worktreeLocator ?? "null")).toMatchObject({
			version: 1,
			worktreeLocator: { version: 1, platform: "linux", path: join(layout.worktrees, sessionId) },
		});
		expect(store.replaySessionEvents(sessionId).at(-1)?.eventType).toBe("workspace.bound");
		await first.release("paused");

		const secondFence: OwnerFence = { ...firstFence, runtimeId: createRuntimeId("runtime", "worktree-second"), generation: 2 };
		store.database().runSync("UPDATE session_owners SET runtime_id = ?, generation = ?, state = 'running' WHERE session_id = ?", [secondFence.runtimeId, 2, sessionId]);
		const autoFactory = module.createSessionWorkspaceFactory({ layout, sourceCwd: source, mode: "auto", git: gitPort, registry, workspace });
		const resumed = await autoFactory.open({ sessionId, store, fence: secondFence });
		expect(resumed.effectiveCwd).toBe(join(layout.worktrees, sessionId));
		expect(store.replaySessionEvents(sessionId).at(-1)?.eventType).toBe("workspace.validation_recorded");
		await resumed.release("paused");

		await writeFile(join(resumed.effectiveCwd, "drift.txt"), "drift\n");
		await git(resumed.effectiveCwd, ["add", "drift.txt"]);
		await git(resumed.effectiveCwd, ["commit", "--quiet", "-m", "drift"]);
		const thirdFence: OwnerFence = { ...firstFence, runtimeId: createRuntimeId("runtime", "worktree-third"), generation: 3 };
		store.database().runSync("UPDATE session_owners SET runtime_id = ?, generation = ?, state = 'running' WHERE session_id = ?", [thirdFence.runtimeId, 3, sessionId]);
		await expect(autoFactory.open({ sessionId, store, fence: thirdFence })).rejects.toThrow(/base|drift|HEAD/u);
		const disabledFactory = module.createSessionWorkspaceFactory({ layout, sourceCwd: source, mode: "disabled", git: gitPort, registry, workspace });
		await expect(disabledFactory.open({ sessionId, store, fence: thirdFence })).rejects.toThrow(/disabled|bound/u);
		db.close();
	});
});
