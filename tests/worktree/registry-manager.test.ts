import { describe, expect, it } from "vitest";
import { createRuntimeId } from "../../src/runtime/contracts/public.ts";
import { WorktreeLeaseManager } from "../../src/worktree/lease.ts";
import { WorktreeManager } from "../../src/worktree/manager.ts";
import { MemoryWorktreeRegistryStore, WorktreeRegistry } from "../../src/worktree/registry.ts";
import type { GitCommandPort, GitCommandRequest, GitCommandResult } from "../../src/worktree/ports.ts";

const sessionId = createRuntimeId("session", "worktree-manager");
const workspaceId = createRuntimeId("workspace", "worktree-manager");

class FakeGit implements GitCommandPort {
	public readonly calls: GitCommandRequest[] = [];
	public readonly roots = new Map<string, { readonly head: string; readonly branch?: string }>();
	public dirty = false;

	public async run(request: GitCommandRequest): Promise<GitCommandResult> {
		this.calls.push(request);
		const args = request.arguments;
		if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return this.ok("/source");
		if (args[0] === "rev-parse" && args[1] === "--show-prefix") return this.ok("packages/app/");
		if (args[0] === "rev-parse" && args[1] === "--verify") return this.ok("a".repeat(40));
		if (args[0] === "symbolic-ref") return this.ok("main");
		if (args[0] === "worktree" && args[1] === "add") {
			const target = args.includes("--detach") ? args[args.indexOf("--detach") + 1] : args[args.indexOf("-b") + 2];
			if (target) this.roots.set(target, { head: "a".repeat(40), branch: args.includes("-b") ? args[args.indexOf("-b") + 1] : undefined });
			return this.ok("");
		}
		if (args[0] === "worktree" && args[1] === "list") {
			return this.ok([...this.roots.entries()].map(([path, value]) => `worktree ${path}\nHEAD ${value.head}${value.branch ? `\nbranch refs/heads/${value.branch}` : ""}\n`).join("\n"));
		}
		if (args[0] === "status") return this.ok(this.dirty ? " M file.ts\n" : "");
		if (args[0] === "worktree" && args[1] === "remove") {
			const target = args.at(-1);
			if (target) this.roots.delete(target);
			return this.ok("");
		}
		return this.ok("");
	}

	private ok(stdout: string): GitCommandResult {
		return { stdout, stderr: "", exitCode: 0, signaled: false };
	}
}

describe("managed worktree lifecycle", () => {
	it("replays append-only records and makes concurrent same-session create idempotent", async () => {
		const git = new FakeGit();
		const registry = new WorktreeRegistry(new MemoryWorktreeRegistryStore());
		const manager = new WorktreeManager({ registry, git, managedRoot: "/managed" });
		const [first, second] = await Promise.all([
			manager.create({ sessionId, workspaceId, sourceCwd: "/source/packages/app", label: "task" }),
			manager.create({ sessionId, workspaceId, sourceCwd: "/source/packages/app", label: "task" }),
		]);
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		expect(git.calls.filter((call) => call.arguments[0] === "worktree" && call.arguments[1] === "add")).toHaveLength(1);
		const listed = await registry.list();
		expect(listed.ok && listed.value).toHaveLength(1);
		if (listed.ok) expect(listed.value[0]?.state).toBe("ready");
	});

	it("rejects dirty removal unless an exact force approval is supplied", async () => {
		const git = new FakeGit();
		const registry = new WorktreeRegistry(new MemoryWorktreeRegistryStore());
		const manager = new WorktreeManager({ registry, git, managedRoot: "/managed" });
		const created = await manager.create({ sessionId, workspaceId, sourceCwd: "/source", label: "dirty" });
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		git.dirty = true;
		expect(await manager.remove(created.value.id, { dryRun: false })).toMatchObject({ ok: false, error: { code: "dirty_worktree" } });
		expect(await manager.remove(created.value.id, { dryRun: false, force: true })).toMatchObject({ ok: false, error: { code: "approval_required" } });
		expect(await manager.remove(created.value.id, { dryRun: false, force: true, approval: { requestId: "approval" } })).toMatchObject({ ok: true });
	});

	it("fences worktree leases with monotonic revisions and digests", async () => {
		const registry = new WorktreeRegistry(new MemoryWorktreeRegistryStore());
		const lease = new WorktreeLeaseManager(registry, { clock: () => new Date("2026-08-04T00:00:00.000Z") });
		const owner = createRuntimeId("runtime", "lease-owner");
		const other = createRuntimeId("runtime", "lease-other");
		const first = await lease.acquire(workspaceId, owner, 1_000);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(await lease.acquire(workspaceId, other, 1_000)).toMatchObject({ ok: false, error: { code: "lease_conflict" } });
		expect(await lease.release(first.value)).toMatchObject({ ok: true });
		const taken = await lease.acquire(workspaceId, other, 1_000);
		expect(taken.ok).toBe(true);
		if (taken.ok) expect(taken.value.leaseRevision).toBe(2);
	});
});
