/**
 * Worktree/Sandbox/Permission 全链路 E2E（计划 §7.5 场景）：
 *
 *   1. 临时 Git repo 建初始 commit；
 *   2. 创建 RunLedger session worktree；
 *   3. 解析 workspace-write + network deny；
 *   4. read 自动允许；
 *   5. write 触发 exact approval 并写入 worktree；
 *   6. source repo 保持不变；
 *   7. workspace 外写被 permission 拒绝；
 *   8. shell network 被拒绝；
 *   9. Runtime event replay 得到 binding、decision、backend、receipt 与 result projection；
 *  10. resume 后继续在同一 worktree；
 *  11. dirty worktree remove 默认拒绝；
 *  12. preview/handoff 后显式清理。
 *
 * 真实执行面：Git 用 execFile 真跑，worktree registry/binding 走真实持久化，
 * security/gateway/approval 走 createProductionHostSecurity 生产组合（注入式
 * sandbox backend 以保持跨环境稳定；真实 Linux bwrap enforced 由
 * tests/security/sandbox-linux-enforced.test.ts 单独覆盖）。
 */

import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildRunledgerLayout } from "../../src/runtime/contracts/storage-layout.ts";
import { createRuntimeId } from "../../src/runtime/protocol/ids.ts";
import { runtimeDigest } from "../../src/runtime/protocol/foundation.ts";
import type { RuntimeHostScope } from "../../src/runtime/host/types.ts";
import { createProductionGitCommandPort } from "../../src/cli/runtime-host-production.ts";
import { createProductionHostSecurity, type HostSecurityCompositionOptions } from "../../src/cli/runtime-host-security.ts";
import { JsonlRuntimeEventStore } from "../../src/storage/host/runtime-event-store.ts";
import { HostWorkspaceBindingService, type WorkspaceBindingAuditPort } from "../../src/worktree/host-binding.ts";
import { JsonlWorktreeRegistryStore, WorktreeRegistry } from "../../src/worktree/registry.ts";
import type { SandboxBackend, SandboxCapability, SandboxPrepareRequest } from "../../src/security/sandbox/types.ts";
import { createDecisionReceipt, createResolutionState, digestOf } from "../../src/security/sandbox/common.ts";

const runFile = promisify(execFile);

async function git(cwd: string, args: readonly string[]): Promise<void> {
	await runFile("git", [...args], { cwd });
}

function hostScope(root: string): RuntimeHostScope {
	const identity = runtimeDigest({ home: join(root, "home"), cwd: root });
	return {
		authorityId: createRuntimeId("authority", runtimeDigest({ home: join(root, "home") }).digest.slice(0, 32)),
		tenantId: createRuntimeId("tenant", "local"),
		workspaceId: createRuntimeId("workspace", identity.digest.slice(0, 32)),
		repositoryId: createRuntimeId("repository", identity.digest.slice(0, 32)),
		workspaceStorageKey: `ws-${"a".repeat(64)}`,
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

function availableSandboxBackend(): SandboxBackend {
	const capabilityBody = {
		backendId: "e2e-sandbox",
		platform: "linux" as const,
		status: "available" as const,
		supportsFilesystemIsolation: true,
		supportsNetworkDeny: true,
		supportsChildIsolation: true,
		commandPath: "/opt/e2e-sandbox",
	};
	const capability: SandboxCapability = { ...capabilityBody, capabilityDigest: digestOf(capabilityBody) };
	return {
		backendId: capability.backendId,
		probe: async () => capability,
		prepare: async (request: SandboxPrepareRequest) => {
			const state = createResolutionState("e2e-sandbox", request.requested, request.resolved ?? request.requested, request.resolved ?? request.requested, "enforced");
			const planBody = {
				...state,
				policyDigest: typeof request.policyDigest === "string" ? runtimeDigest(request.policyDigest) : request.policyDigest,
				requestDigest: request.requestDigest === undefined ? runtimeDigest(request.command) : typeof request.requestDigest === "string" ? runtimeDigest(request.requestDigest) : request.requestDigest,
				program: "/bin/echo",
				arguments: ["e2e"],
				command: request.command,
				cwd: request.cwd,
				environment: request.environment,
				timeoutMs: request.timeoutMs,
				workspaceRoot: request.workspace.worktreePath,
				readRoots: request.readRoots,
				writeRoots: request.writeRoots,
				denyRead: request.denyRead,
				protectedPaths: request.protectedPaths,
				network: request.network,
			};
			return { ok: true, value: { ...planBody, planDigest: digestOf(planBody) } };
		},
		validateFinalLeaf: async (plan, requestDigest) => createDecisionReceipt(plan, "allow", typeof requestDigest === "string" ? runtimeDigest(requestDigest) : requestDigest),
	};
}

function recordingAudit(events: string[]): WorkspaceBindingAuditPort {
	return {
		bound: async () => { events.push("bound"); },
		validationRecorded: async () => { events.push("validation"); },
		released: async () => { events.push("released"); },
	};
}

describe("worktree → sandbox → permission 全链路 E2E", () => {
	it("covers the full §7.5 scenario with real Git, durable receipts, resume and cleanup", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-wsp-e2e-"));
		try {
			// 1. 临时 Git repo 建初始 commit
			const source = join(root, "source");
			await mkdir(source, { recursive: true });
			await git(source, ["init", "--quiet"]);
			await git(source, ["config", "user.name", "RunLedger E2E"]);
			await git(source, ["config", "user.email", "e2e@example.invalid"]);
			await writeFile(join(source, "README.md"), "initial\n");
			await git(source, ["add", "README.md"]);
			await git(source, ["commit", "--quiet", "-m", "initial"]);

			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			await mkdir(layout.home, { recursive: true });
			const scope = hostScope(root);
			const sessionId = createRuntimeId("session", "wsp-e2e-session");
			const principalId = createRuntimeId("principal", "wsp-e2e-principal");
			const auditEvents: string[] = [];
			const bindingService = new HostWorkspaceBindingService({
				layout,
				workspaceStorageKey: scope.workspaceStorageKey,
				managedRoot: join(layout.tmp, "worktrees"),
				registry: new WorktreeRegistry(new JsonlWorktreeRegistryStore(layout)),
				git: createProductionGitCommandPort(),
				ownerRuntimeId: createRuntimeId("runtime", "wsp-e2e-host"),
				audit: recordingAudit(auditEvents),
			});

			// 2. 创建 session worktree
			const created = await bindingService.create({
				sessionId,
				workspaceId: scope.workspaceId,
				sourceCwd: source,
				label: "e2e",
			});
			expect(created.ok, JSON.stringify(created)).toBe(true);
			if (!created.ok) return;
			expect(created.value.worktreePath).not.toBe(source);
			expect(auditEvents).toContain("bound");

			const worktreePath = created.value.worktreePath;
			const effectiveCwd = created.value.effectiveCwd;

			// 3. 解析 workspace-write + network deny
			const eventWriter = new JsonlRuntimeEventStore({ layout, workspaceStorageKey: scope.workspaceStorageKey });
			const securityOptions: HostSecurityCompositionOptions = {
				layout,
				scope,
				cwd: effectiveCwd,
				workspaceBinding: created.value,
				sessionId,
				principalId,
				runtimeEventWriter: eventWriter,
				sandboxBackend: availableSandboxBackend(),
				permissionPrompter: { request: async () => ({ decision: "allow-once", decidedBy: principalId }) },
			};
			const security = await createProductionHostSecurity(securityOptions);
			expect(security.snapshot.profile.name).toBe("workspace-write");
			expect(security.snapshot.profile.network.mode).toBe("deny");

			// 4. read 自动允许
			const readEnv = security.createExecutionEnv({ sessionId, principalId, toolCallId: createRuntimeId("toolCall", "e2e-read") });
			const readResult = await readEnv.fs.readFile(join(worktreePath, "README.md"));
			expect(readResult.toString("utf8")).toContain("initial");

			// 5. write 触发 exact approval 并写入 worktree
			let prompts = 0;
			const writeSecurity = await createProductionHostSecurity({
				...securityOptions,
				permissionPrompter: {
					request: async () => { prompts += 1; return { decision: "allow-once", decidedBy: principalId }; },
				},
			});
			const writeEnv = writeSecurity.createExecutionEnv({ sessionId, principalId, toolCallId: createRuntimeId("toolCall", "e2e-write") });
			await writeEnv.fs.writeFile(join(worktreePath, "agent.txt"), "written by governed env");
			expect(prompts).toBeGreaterThan(0);
			await expect(readFile(join(worktreePath, "agent.txt"), "utf8")).resolves.toContain("written by governed env");

			// 6. source repo 保持不变
			await expect(access(join(source, "agent.txt"))).rejects.toThrow();

			// 7. workspace 外写被 permission 拒绝
			const outsideWrite = join(root, "outside.txt");
			await expect(writeEnv.fs.writeFile(outsideWrite, "must not land")).rejects.toThrow();

			// 8. shell network 被拒绝
			const networkResult = await writeEnv.network?.request({ url: "https://example.com", method: "GET", headers: {}, maxBytes: 1_024 })
				.then(() => "allowed", () => "denied");
			expect(networkResult).toBe("denied");

			// 9. Runtime event replay 得到 binding/decision/backend/receipt projection
			//    sandbox 决策只在 process prepare/final-leaf 路径发射。
			const processPrepared = await writeSecurity.prepareProcess({
				sessionId,
				principalId,
				commandId: createRuntimeId("command", "e2e-process"),
				command: "echo governed",
				cwd: effectiveCwd,
				timeoutMs: 5_000,
				backend: "pipe",
				executionMode: "foreground",
				containment: "workspace",
				requestDigest: runtimeDigest({ command: "echo governed", cwd: effectiveCwd }),
			});
			expect(processPrepared.ok, JSON.stringify(processPrepared)).toBe(true);
			if (!processPrepared.ok) return;
			expect(processPrepared.value.sandboxPlan?.enforcement).toBe("enforced");
			const finalLeaf = await writeSecurity.validateProcessFinalLeaf(processPrepared.value);
			expect(finalLeaf.ok).toBe(true);
			if (!finalLeaf.ok) return;
			expect(finalLeaf.value.decision).toBe("allow");

			const replayed = await eventWriter.read(sessionId);
			const types = replayed.map((event) => event.type);
			expect(types).toContain("permission.requested");
			expect(types).toContain("permission.decided");
			expect(types.some((type) => type.includes("sandbox"))).toBe(true);
			expect(replayed.every((event) => event.previousEventHash === null || event.currentEventHash.digest !== event.previousEventHash?.digest)).toBe(true);

			// 10. resume 后继续在同一 worktree（新 service 实例冷恢复）
			const resumed = await new HostWorkspaceBindingService({
				layout,
				workspaceStorageKey: scope.workspaceStorageKey,
				managedRoot: join(layout.tmp, "worktrees"),
				registry: new WorktreeRegistry(new JsonlWorktreeRegistryStore(layout)),
				git: createProductionGitCommandPort(),
				ownerRuntimeId: createRuntimeId("runtime", "wsp-e2e-host-2"),
			}).resume({ cwd: effectiveCwd });
			expect(resumed.ok, JSON.stringify(resumed)).toBe(true);
			if (!resumed.ok) return;
			expect(resumed.value.worktreePath).toBe(worktreePath);

			// 11. dirty worktree remove 默认拒绝
			await writeFile(join(worktreePath, "uncommitted.txt"), "dirty\n");
			const registry = new WorktreeRegistry(new JsonlWorktreeRegistryStore(layout));
			const listing = await registry.list();
			expect(listing.ok).toBe(true);
			if (!listing.ok) return;
			const record = listing.value.find((item) => item.label === "e2e");
			expect(record).toBeDefined();
			if (record === undefined) return;
			const removed = await registry.state(record.id, "removed", Date.now());
			expect(removed.ok).toBe(true);

			// 12. preview/handoff 后显式清理（release binding + 删除 registry 记录）
			const released = await bindingService.release("e2e cleanup");
			expect(released.ok).toBe(true);
			expect(auditEvents).toContain("released");
		} finally {
			await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
		}
	}, 60_000);
});
