import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildRunledgerLayout, createRuntimeId } from "../../src/runtime/contracts/public.ts";
import { GitOperations } from "../../src/worktree/git-operations.ts";
import { MemoryWorktreeRegistryStore, WorktreeRegistry } from "../../src/worktree/registry.ts";
import { JsonWorkspaceBindingStore } from "../../src/worktree/persisted-binding.ts";
import { JsonlRuntimeEventStore } from "../../src/storage/host/runtime-event-store.ts";
import { RuntimeWorkspaceAuditAdapter } from "../../src/worktree/integration/runtime-workspace-events.ts";
import {
	HostWorkspaceBindingService,
	type WorkspaceBindingAuditPort,
	type WorkspaceBindingServiceResult,
} from "../../src/worktree/host-binding.ts";
import type { GitCommandPort, GitCommandRequest, GitCommandResult } from "../../src/worktree/ports.ts";

const runFile = promisify(execFile);

class RealGitCommandPort implements GitCommandPort {
	public async run(request: GitCommandRequest, signal?: AbortSignal): Promise<GitCommandResult> {
		try {
			const result = await runFile("git", request.arguments as string[], { cwd: request.cwd, input: request.stdin, signal, timeout: request.timeoutMs });
			return { stdout: result.stdout, stderr: result.stderr, exitCode: 0, signaled: false };
		} catch (error) {
			const value = error as { stdout?: string; stderr?: string; code?: number | string; killed?: boolean };
			return { stdout: value.stdout ?? "", stderr: value.stderr ?? "", exitCode: typeof value.code === "number" ? value.code : 1, signaled: value.killed === true };
		}
	}
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
	await runFile("git", args as string[], { cwd });
}

async function fixture(): Promise<{ root: string; source: string; managed: string; layout: ReturnType<typeof buildRunledgerLayout>; workspaceStorageKey: string; service: HostWorkspaceBindingService; registry: WorktreeRegistry; auditEvents: string[] }> {
	const root = await mkdtemp(join(tmpdir(), "runledger-host-binding-"));
	const source = join(root, "source");
	const managed = join(root, "managed");
	const home = join(root, "home");
	await mkdir(source, { recursive: true });
	await mkdir(managed, { recursive: true });
	await git(source, ["init", "--quiet"]);
	await git(source, ["config", "user.name", "RunLedger Test"]);
	await git(source, ["config", "user.email", "runledger@example.invalid"]);
	await writeFile(join(source, "README.md"), "initial\n");
	await git(source, ["add", "README.md"]);
	await git(source, ["commit", "--quiet", "-m", "initial"]);
	const layout = buildRunledgerLayout(home, "posix");
	const workspaceStorageKey = `ws-${"e".repeat(64)}`;
	const registry = new WorktreeRegistry(new MemoryWorktreeRegistryStore());
	const gitOperations = new GitOperations(new RealGitCommandPort(), { managedRoot: managed });
	const auditEvents: string[] = [];
	const audit: WorkspaceBindingAuditPort = {
		bound: async () => { auditEvents.push("workspace.bound"); },
		validationRecorded: async () => { auditEvents.push("workspace.validation_recorded"); },
		released: async () => { auditEvents.push("workspace.released"); },
	};
	const service = new HostWorkspaceBindingService({
		layout,
		workspaceStorageKey,
		managedRoot: managed,
		registry,
		git: gitOperations,
		ownerRuntimeId: createRuntimeId("runtime", "host-binding-test"),
		audit,
	});
	return { root, source, managed, layout, workspaceStorageKey, service, registry, auditEvents };
}

describe("Host workspace binding composition", () => {
	it("creates a real Git worktree, leases it, persists the binding, and resumes only from its observed head", async () => {
		const value = await fixture();
		try {
			const created = await value.service.create({
				sessionId: createRuntimeId("session", "host-binding-session"),
				workspaceId: createRuntimeId("workspace", "host-binding-workspace"),
				sourceCwd: value.source,
				label: "task",
			});
			expect(created.ok, JSON.stringify(created)).toBe(true);
			if (!created.ok) return;
			expect(created.value.binding.bindingKind).toBe("managed_worktree");
			expect(created.value.lease.state).toBe("active");
			expect(created.value.headCommit).toMatch(/^[a-f0-9]{40}$/u);
			expect(await value.service.read()).toMatchObject({ ok: true, value: created.value });
			expect(await value.service.resume({ cwd: created.value.effectiveCwd })).toMatchObject({ ok: true, value: created.value });
			expect(value.auditEvents).toEqual(["workspace.bound", "workspace.validation_recorded"]);
		} finally {
			await rm(value.root, { recursive: true, force: true });
		}
	});

	it("fails closed on resume when the worktree head or effective path drifts", async () => {
		const value = await fixture();
		try {
			const created = await value.service.create({
				sessionId: createRuntimeId("session", "host-binding-drift-session"),
				workspaceId: createRuntimeId("workspace", "host-binding-drift-workspace"),
				sourceCwd: value.source,
				label: "drift",
			});
			expect(created.ok).toBe(true);
			if (!created.ok) return;
			await git(created.value.worktreePath, ["config", "user.name", "RunLedger Test"]);
			await writeFile(join(created.value.worktreePath, "drift.txt"), "drift\n");
			const drift = await value.service.resume({ cwd: join(created.value.worktreePath, "missing") });
			expect(drift.ok).toBe(false);
			expect((drift as WorkspaceBindingServiceResult<never> & { ok: false }).error.code).toBe("binding_drift");
		} finally {
			await rm(value.root, { recursive: true, force: true });
		}
	});

	it("writes workspace lifecycle events through the canonical Runtime event store", async () => {
		const value = await fixture();
		try {
			const created = await value.service.create({
				sessionId: createRuntimeId("session", "host-binding-audit-session"),
				workspaceId: createRuntimeId("workspace", "host-binding-audit-workspace"),
				sourceCwd: value.source,
				label: "audit",
			});
			expect(created.ok, JSON.stringify(created)).toBe(true);
			if (!created.ok) return;
			const sessionId = createRuntimeId("session", "host-binding-audit-events");
			const writer = new JsonlRuntimeEventStore({ layout: value.layout, workspaceStorageKey: value.workspaceStorageKey });
			const audit = new RuntimeWorkspaceAuditAdapter({
				authorityId: createRuntimeId("authority", "host-binding-audit"),
				tenantId: createRuntimeId("tenant", "host-binding-audit"),
				sessionId,
				principalId: createRuntimeId("principal", "host-binding-audit"),
				writer,
			});
			await audit.bound(created.value);
			await audit.validationRecorded(created.value);
			const events = await writer.read(sessionId);
			expect(events.map((event) => event.type)).toEqual(["workspace.bound", "workspace.validation_recorded"]);
			expect(events.every((event) => event.payload.subject.kind === "workspace")).toBe(true);
		} finally {
			await rm(value.root, { recursive: true, force: true });
		}
	});

	it("fails closed when a resumed worktree has a different Git head", async () => {
		const value = await fixture();
		try {
			const created = await value.service.create({
				sessionId: createRuntimeId("session", "host-binding-head-session"),
				workspaceId: createRuntimeId("workspace", "host-binding-head-workspace"),
				sourceCwd: value.source,
				label: "head",
			});
			expect(created.ok).toBe(true);
			if (!created.ok) return;
			await git(created.value.worktreePath, ["config", "user.name", "RunLedger Test"]);
			await git(created.value.worktreePath, ["config", "user.email", "runledger@example.invalid"]);
			await writeFile(join(created.value.worktreePath, "head-drift.txt"), "head drift\n");
			await git(created.value.worktreePath, ["add", "head-drift.txt"]);
			await git(created.value.worktreePath, ["commit", "--quiet", "-m", "head drift"]);
			expect(await value.service.resume({ cwd: created.value.effectiveCwd })).toMatchObject({ ok: false, error: { code: "binding_drift" } });
		} finally {
			await rm(value.root, { recursive: true, force: true });
		}
	});

	it("releases the Host-owned lease and binding exactly once with a canonical audit", async () => {
		const value = await fixture();
		try {
			const created = await value.service.create({
				sessionId: createRuntimeId("session", "host-binding-release-session"),
				workspaceId: createRuntimeId("workspace", "host-binding-release-workspace"),
				sourceCwd: value.source,
				label: "release",
			});
			expect(created.ok, JSON.stringify(created)).toBe(true);
			if (!created.ok) return;

			expect(await value.service.release("host_shutdown")).toMatchObject({ ok: true, value: created.value });
			expect(await value.service.read()).toEqual({ ok: true, value: undefined });
			expect(await value.service.release("host_shutdown")).toEqual({ ok: true, value: undefined });
			expect(value.auditEvents).toEqual(["workspace.bound", "workspace.released"]);
			expect(await value.service.resume({ cwd: created.value.effectiveCwd })).toMatchObject({ ok: false, error: { code: "binding_not_found" } });
			const lease = await value.registry.lease(created.value.binding.workspaceId);
			expect(lease).toMatchObject({ ok: true, value: { state: "released" } });
		} finally {
			await rm(value.root, { recursive: true, force: true });
		}
	});
});
