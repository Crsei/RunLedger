import { describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildRunledgerLayout } from "../../src/runtime/contracts/storage-layout.ts";
import { createRuntimeId } from "../../src/runtime/protocol/ids.ts";
import { runtimeDigest } from "../../src/runtime/protocol/foundation.ts";
import type { RuntimeHostScope } from "../../src/runtime/host/types.ts";
import { createProductionHostSecurity } from "../../src/cli/runtime-host-security.ts";
import { ProductionManagedProcessPort } from "../../src/cli/runtime-host-process.ts";
import { JsonlRuntimeEventStore } from "../../src/storage/host/runtime-event-store.ts";

function scope(): RuntimeHostScope {
	const digest = (seed: string) => runtimeDigest(seed);
	return {
		authorityId: createRuntimeId("authority", "sandbox-enforced"),
		tenantId: createRuntimeId("tenant", "sandbox-enforced"),
		workspaceId: createRuntimeId("workspace", "sandbox-enforced"),
		repositoryId: createRuntimeId("repository", "sandbox-enforced"),
		workspaceStorageKey: `ws-${"e".repeat(64)}`,
		protocolVersion: 1,
		hostBuildDigest: digest("host"),
		compositionDigest: digest("composition"),
		settingsDigest: digest("settings"),
		modelCatalogDigest: digest("models"),
		tracePolicyDigest: digest("trace"),
		securityAdapterDigest: digest("security"),
		extensionProfileDigest: digest("extension"),
		sessionStorageContractVersion: 1,
		peerAttestor: { kind: "test", generation: 1, configDigest: digest("attestor") },
	};
}

describe("Linux bwrap enforced process", () => {
	it("prevents a Host-managed command from reading an unbound host path", async () => {
		if (process.platform !== "linux") return;
		const root = await mkdtemp(join(tmpdir(), "runledger-bwrap-enforced-"));
		try {
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const hostScope = scope();
			const principal = createRuntimeId("principal", "sandbox-enforced");
			const security = await createProductionHostSecurity({
				layout,
				scope: hostScope,
				cwd: root,
				principalId: principal,
				runtimeEventWriter: new JsonlRuntimeEventStore({ layout, workspaceStorageKey: hostScope.workspaceStorageKey }),
				permissionPrompter: { request: async () => ({ decision: "allow-once", decidedBy: principal }) },
			});
			const port = new ProductionManagedProcessPort({ layout, scope: hostScope, hostGeneration: 1, security });
			const sessionId = createRuntimeId("session", "sandbox-enforced");
			const created = await port.create({
				sessionId,
				sessionGeneration: 1,
				commandId: "sandbox-enforced-command",
				command: "cat /etc/passwd",
				cwd: root,
				timeoutMs: 5_000,
				backend: "pipe",
				executionMode: "foreground",
				principalId: principal,
			});
			expect(created.ok).toBe(true);
			if (!created.ok) return;
			const waited = await port.toolClient(sessionId, 1, principal).processWait(created.handle, 5_000, "driver");
			expect(waited).toMatchObject({ ok: true, outcome: "terminal", summary: { terminal: { state: "failed" } } });
			const output = await port.output(sessionId, created.handle.executionId, { sequence: 0, byteOffset: 0 }, 8_192);
			expect(output.page).toMatch(/(?:No such file|cannot open)/iu);
		} finally {
			await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
		}
	});

	it("keeps temporary writes inside the sandbox and protects the workspace control path", async () => {
		if (process.platform !== "linux") return;
		const root = await mkdtemp(join(tmpdir(), "runledger-bwrap-write-enforced-"));
		const hostTmpPath = join(tmpdir(), `runledger-bwrap-host-${process.pid}-${Date.now()}.txt`);
		const protectedPath = join(root, ".git");
		const protectedWrite = join(protectedPath, "should-not-exist");
		try {
			await mkdir(protectedPath);
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const hostScope = scope();
			const principal = createRuntimeId("principal", "sandbox-write-enforced");
			const security = await createProductionHostSecurity({
				layout,
				scope: hostScope,
				cwd: root,
				runtimeEventWriter: new JsonlRuntimeEventStore({ layout, workspaceStorageKey: hostScope.workspaceStorageKey }),
				permissionPrompter: { request: async () => ({ decision: "allow-once", decidedBy: principal }) },
			});
			const port = new ProductionManagedProcessPort({ layout, scope: hostScope, hostGeneration: 1, security });
			const sessionId = createRuntimeId("session", "sandbox-write-enforced");
			const created = await port.create({
				sessionId,
				sessionGeneration: 1,
				commandId: "sandbox-write-enforced-command",
				command: `printf sandbox-only > ${hostTmpPath} && printf protected > ${protectedWrite}`,
				cwd: root,
				timeoutMs: 5_000,
				backend: "pipe",
				executionMode: "foreground",
				principalId: principal,
			});
			expect(created.ok).toBe(true);
			if (!created.ok) return;
			const waited = await port.toolClient(sessionId, 1, principal).processWait(created.handle, 5_000, "driver");
			expect(waited).toMatchObject({ ok: true, outcome: "terminal", summary: { terminal: { state: "failed" } } });
			await expect(access(hostTmpPath)).rejects.toMatchObject({ code: "ENOENT" });
			await expect(access(protectedWrite)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await rm(hostTmpPath, { force: true }).catch(() => undefined);
			await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
		}
	});

	it("removes the default route from a network-denied managed process", async () => {
		if (process.platform !== "linux") return;
		const root = await mkdtemp(join(tmpdir(), "runledger-bwrap-network-enforced-"));
		try {
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const hostScope = scope();
			const principal = createRuntimeId("principal", "sandbox-network-enforced");
			const security = await createProductionHostSecurity({
				layout,
				scope: hostScope,
				cwd: root,
				runtimeEventWriter: new JsonlRuntimeEventStore({ layout, workspaceStorageKey: hostScope.workspaceStorageKey }),
				permissionPrompter: { request: async () => ({ decision: "allow-once", decidedBy: principal }) },
			});
			const port = new ProductionManagedProcessPort({ layout, scope: hostScope, hostGeneration: 1, security });
			const sessionId = createRuntimeId("session", "sandbox-network-enforced");
			const created = await port.create({
				sessionId,
				sessionGeneration: 1,
				commandId: "sandbox-network-enforced-command",
				command: "grep -q '^00000000' /proc/net/route",
				cwd: root,
				timeoutMs: 5_000,
				backend: "pipe",
				executionMode: "foreground",
				principalId: principal,
			});
			expect(created.ok).toBe(true);
			if (!created.ok) return;
			const waited = await port.toolClient(sessionId, 1, principal).processWait(created.handle, 5_000, "driver");
			expect(waited).toMatchObject({ ok: true, outcome: "terminal", summary: { terminal: { state: "failed" } } });
		} finally {
			await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
		}
	});
});
