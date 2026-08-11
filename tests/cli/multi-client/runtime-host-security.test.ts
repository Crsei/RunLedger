import { afterEach, describe, expect, it } from "vitest";
import { IS_WINDOWS } from "../../helpers/platform.ts";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { runtimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import type { RuntimeHostScope } from "../../../src/runtime/host/types.ts";
import {
	createProductionHostSecurity as composeProductionHostSecurity,
	type HostSecurityCompositionOptions,
	type HostProcessSecurityRequest,
} from "../../../src/cli/runtime-host-security.ts";
import { ProductionManagedProcessPort } from "../../../src/cli/runtime-host-process.ts";
import { JsonlRuntimeEventStore } from "../../../src/storage/host/runtime-event-store.ts";
import type {
	SandboxBackend,
	SandboxCapability,
	SandboxPrepareRequest,
} from "../../../src/security/sandbox/types.ts";
import { createDecisionReceipt, createResolutionState, digestOf } from "../../../src/security/sandbox/common.ts";
import type { PersistedWorkspaceBinding } from "../../../src/worktree/persisted-binding.ts";
import type { ToolAuthorizationPolicy } from "../../../src/runtime/types.ts";
import { createStdlibTools } from "../../../src/runtime/tools/index.ts";

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function scope(): RuntimeHostScope {
	return {
		authorityId: createRuntimeId("authority", "host-security"),
		tenantId: createRuntimeId("tenant", "host-security"),
		workspaceId: createRuntimeId("workspace", "host-security"),
		repositoryId: createRuntimeId("repository", "host-security"),
		workspaceStorageKey: `ws-${"c".repeat(64)}`,
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
		backendId: "test-sandbox",
		platform: "linux" as const,
		status: "available" as const,
		supportsFilesystemIsolation: true,
		supportsNetworkDeny: true,
		supportsChildIsolation: true,
		commandPath: "/opt/test-sandbox",
	};
	const capability: SandboxCapability = { ...capabilityBody, capabilityDigest: digestOf(capabilityBody) };
	return {
		backendId: capability.backendId,
		probe: async () => capability,
		prepare: async (request: SandboxPrepareRequest) => {
			const state = createResolutionState("test-sandbox", request.requested, request.resolved ?? request.requested, request.resolved ?? request.requested, "enforced");
			const planBody = {
				...state,
				policyDigest: typeof request.policyDigest === "string" ? runtimeDigest(request.policyDigest) : request.policyDigest,
				requestDigest: request.requestDigest === undefined ? runtimeDigest(request.command) : typeof request.requestDigest === "string" ? runtimeDigest(request.requestDigest) : request.requestDigest,
				program: "/opt/test-sandbox",
				arguments: ["--", request.command],
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

function degradedSandboxBackend(): SandboxBackend {
	const backend = availableSandboxBackend();
	return {
		...backend,
		prepare: async (request) => {
			const prepared = await backend.prepare(request);
			if (!prepared.ok) return prepared;
			const { planDigest: _planDigest, ...body } = prepared.value;
			const degradedBody = { ...body, enforcement: "degraded" as const };
			return { ok: true, value: { ...degradedBody, planDigest: digestOf(degradedBody) } };
		},
	};
}

function processRequest(root: string, sessionId: string): HostProcessSecurityRequest {
	return {
		sessionId,
		principalId: createRuntimeId("principal", "host-security-process"),
		commandId: createRuntimeId("command", "host-security-process"),
		command: "printf governed",
		cwd: root,
		timeoutMs: 1_000,
		backend: "pipe",
		executionMode: "foreground",
		containment: "none",
		requestDigest: runtimeDigest({ command: "printf governed", cwd: root }),
	};
}

function createProductionHostSecurity(options: HostSecurityCompositionOptions): ReturnType<typeof composeProductionHostSecurity> {
	if (Object.prototype.hasOwnProperty.call(options, "runtimeEventWriter")) return composeProductionHostSecurity(options);
	return composeProductionHostSecurity({
		...options,
		runtimeEventWriter: new JsonlRuntimeEventStore({ layout: options.layout, workspaceStorageKey: options.scope.workspaceStorageKey }),
	});
}

function spawnableSandboxBackend(): SandboxBackend {
	const capabilityBody = {
		backendId: "test-spawnable-sandbox",
		platform: "linux" as const,
		status: "available" as const,
		supportsFilesystemIsolation: true,
		supportsNetworkDeny: true,
		supportsChildIsolation: true,
		commandPath: process.execPath,
	};
	const capability: SandboxCapability = { ...capabilityBody, capabilityDigest: digestOf(capabilityBody) };
	return {
		backendId: capability.backendId,
		probe: async () => capability,
		prepare: async (request: SandboxPrepareRequest) => {
			const state = createResolutionState("test-spawnable-sandbox", request.requested, request.resolved ?? request.requested, request.resolved ?? request.requested, "enforced");
			const planBody = {
				...state,
				policyDigest: typeof request.policyDigest === "string" ? runtimeDigest(request.policyDigest) : request.policyDigest,
				requestDigest: request.requestDigest === undefined ? runtimeDigest(request.command) : typeof request.requestDigest === "string" ? runtimeDigest(request.requestDigest) : request.requestDigest,
				program: process.execPath,
				arguments: ["-e", "process.stdout.write('spawned-through-final-leaf\\n')"],
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

function workspaceBinding(root: string): PersistedWorkspaceBinding {
	const worktreePath = join(root, "managed-worktree");
	const effectiveCwd = join(worktreePath, "packages", "app");
	const sourceRepositoryPath = join(root, "source");
	const worktreeId = createRuntimeId("workspace", "bound-worktree");
	const worktreeRef = { subjectKind: "receipt" as const, digest: runtimeDigest({ worktreeId, worktreePath, baseCommit: "a".repeat(40) }) };
	const lease = {
		workspaceId: scope().workspaceId,
		ownerRuntimeId: createRuntimeId("runtime", "bound-host"),
		leaseRevision: 7,
		fencingTokenDigest: runtimeDigest("bound-fence"),
		state: "active" as const,
		expiresAt: "2099-01-01T00:00:00.000Z",
	};
	const base = {
		version: 1 as const,
		binding: {
			workspaceId: scope().workspaceId,
			repositoryId: createRuntimeId("repository", runtimeDigest(sourceRepositoryPath).digest.slice(0, 48)),
			bindingKind: "managed_worktree" as const,
			effectiveCwdDigest: runtimeDigest(effectiveCwd),
			baseCommit: "a".repeat(40),
			worktreeRef,
		},
		worktreeId,
		sourceRepositoryPath,
		sourceSubdir: ".",
		worktreePath,
		worktreeLocator: { version: 1 as const, platform: "linux" as const, kind: "posix" as const, path: worktreePath },
		effectiveCwd,
		baseCommit: "a".repeat(40),
		headCommit: "a".repeat(40),
		lease,
	};
	return { ...base, bindingDigest: runtimeDigest(base) };
}

describe.skipIf(IS_WINDOWS)("production Host Security/ExecutionGateway composition", () => {
	it("exposes a Host-owned tool admission policy instead of the local AllowAll fallback", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-security-tool-policy-"));
		roots.push(root);
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		const security = await createProductionHostSecurity({
			layout,
			scope: scope(),
			cwd: root,
			sandboxBackend: availableSandboxBackend(),
		});

		expect(security).toHaveProperty("toolAuthorizationPolicy");
		expect(security).toHaveProperty("permissionRequester");
		const policy = (security as unknown as { readonly toolAuthorizationPolicy: ToolAuthorizationPolicy }).toolAuthorizationPolicy;
		expect(policy).toBeDefined();
		const governed = security as typeof security & { readonly permissionRequester: Parameters<typeof createStdlibTools>[1]["permissionRequester"] };
		expect(createStdlibTools(root, {
			requireExecutionEnv: true,
			executionEnv: security.createExecutionEnv(),
			permissionRequester: governed.permissionRequester,
		}).has("request_permissions")).toBe(true);
	});

	it("requires the canonical Runtime event writer from Host composition", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-security-writer-"));
		roots.push(root);
		const layout = buildRunledgerLayout(join(root, "home"), "posix");

		await expect(createProductionHostSecurity({
			layout,
			scope: scope(),
			cwd: root,
			sandboxBackend: availableSandboxBackend(),
			runtimeEventWriter: undefined,
		})).rejects.toThrow(/Runtime event writer|event writer/iu);
	});

	it("uses the canonical default snapshot and denies workspace-external writes before raw IO", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-security-"));
		roots.push(root);
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		const security = await createProductionHostSecurity({
			layout,
			scope: scope(),
			cwd: root,
			sessionId: createRuntimeId("session", "host-security-default"),
			sandboxBackend: availableSandboxBackend(),
		});

		expect(security.snapshot.profile.name).toBe("workspace-write");
		expect(security.snapshot.profile.network.mode).toBe("deny");
		expect(security.snapshot.policyDigest).toMatchObject({ algorithm: "sha256" });

		const env = security.createExecutionEnv({ toolCallId: createRuntimeId("toolCall", "host-security-write") });
		await writeFile(join(root, "inside.txt"), "governed read");
		await expect(env.fs.readFile(join(root, "inside.txt"))).resolves.toEqual(Buffer.from("governed read"));
		await expect(env.fs.writeFile(join(root, "..", "outside.txt"), "must not write")).rejects.toThrow(/allowed roots|protected|path_escape/iu);
	});

	it("revokes an allow-once receipt after a governed filesystem effect settles", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-security-revocation-"));
		roots.push(root);
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		const events: string[] = [];
		const security = await createProductionHostSecurity({
			layout,
			scope: scope(),
			cwd: root,
			sandboxBackend: availableSandboxBackend(),
			permissionPrompter: { request: async () => ({ decision: "allow-once", decidedBy: createRuntimeId("principal", "host-security-revocation") }) },
			runtimeEventWriter: {
				append: async (input) => {
					events.push(input.type);
					return {} as never;
				},
			},
		});
		const env = security.createExecutionEnv({ toolCallId: createRuntimeId("toolCall", "host-security-revocation") });

		await env.fs.writeFile(join(root, "created.txt"), "governed");

		expect(events).toEqual(["permission.requested", "permission.decided", "permission.revoked"]);
	});

	it("does not expose a raw network fallback when the canonical policy denies network", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-security-network-"));
		roots.push(root);
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		let brokerCalls = 0;
		const security = await createProductionHostSecurity({
			layout,
			scope: scope(),
			cwd: root,
			sessionId: createRuntimeId("session", "host-security-network"),
			sandboxBackend: availableSandboxBackend(),
			networkBroker: { request: async () => { brokerCalls += 1; throw new Error("must not call broker"); } },
		});

		const env = security.createExecutionEnv({ toolCallId: createRuntimeId("toolCall", "host-security-network-call") });
		await expect(env.network?.request({ url: "https://example.com", method: "GET", headers: {}, maxBytes: 1_024 })).rejects.toThrow(/network/iu);
		expect(brokerCalls).toBe(0);
	});

	it("authorizes extension resources through the Host Gateway before invocation", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-security-resource-"));
		roots.push(root);
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		const security = await createProductionHostSecurity({
			layout,
			scope: scope(),
			cwd: root,
			sessionId: createRuntimeId("session", "host-security-resource"),
			sandboxBackend: availableSandboxBackend(),
			permissionPrompter: { request: async (prompt) => ({ decision: "allow-once", decidedBy: createRuntimeId("principal", `approver-${prompt.requestId}`) }) },
		});

		const result = await security.authorizeResource({
			sessionId: createRuntimeId("session", "host-security-resource"),
			principalId: createRuntimeId("principal", "host-security-resource"),
			requestId: createRuntimeId("command", "host-security-resource-call"),
			traceId: createRuntimeId("trace", "host-security-resource-call"),
			toolName: "mcp",
			cwd: root,
			argumentsDigest: runtimeDigest({ value: "fixture" }),
		});

		expect(result).toMatchObject({ ok: true, value: { authorization: { outcome: "allow" } } });
	});

	it("fails closed when a restrictive sandbox backend reports degraded enforcement", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-security-degraded-sandbox-"));
		roots.push(root);
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		const security = await createProductionHostSecurity({
			layout,
			scope: scope(),
			cwd: root,
			sandboxBackend: degradedSandboxBackend(),
		});

		await expect(security.prepareProcess(processRequest(root, createRuntimeId("session", "host-security-degraded-sandbox")))).resolves.toMatchObject({ ok: false });
	});

	it("prepares a request-bound constraint snapshot and requires the final leaf for process execution", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-security-process-"));
		roots.push(root);
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		const security = await createProductionHostSecurity({
			layout,
			scope: scope(),
			cwd: root,
			sessionId: createRuntimeId("session", "host-security-process"),
			sandboxBackend: availableSandboxBackend(),
		});

		const prepared = await security.prepareProcess(processRequest(root, createRuntimeId("session", "host-security-process")));
		expect(prepared.ok).toBe(true);
		if (!prepared.ok) return;
		expect(prepared.value.constraintSnapshot.snapshotDigest.algorithm).toBe("sha256");
		expect(prepared.value.constraintSnapshot.gateway.route).toBe("mediated");
		expect(prepared.value.sandboxPlan?.enforcement).toBe("enforced");

		const stale = await security.validateProcessFinalLeaf({
			...prepared.value,
			constraintSnapshot: { ...prepared.value.constraintSnapshot, requestDigest: runtimeDigest("stale") },
		});
		expect(stale).toMatchObject({ ok: false });

		const accepted = await security.validateProcessFinalLeaf(prepared.value);
		expect(accepted).toMatchObject({ ok: true, value: { decision: "allow" } });
	});

	it("routes a Host-managed process through the prepared sandbox launch plan and final leaf", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-security-managed-process-"));
		roots.push(root);
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		const hostScope = scope();
		const security = await createProductionHostSecurity({
			layout,
			scope: hostScope,
			cwd: root,
			sessionId: createRuntimeId("session", "host-security-managed-process"),
			sandboxBackend: spawnableSandboxBackend(),
		});
		const port = new ProductionManagedProcessPort({ layout, scope: hostScope, hostGeneration: 1, security });
		const created = await port.create({
			sessionId: createRuntimeId("session", "host-security-managed-process"),
			sessionGeneration: 1,
			commandId: "host-security-managed-process-command",
			command: "printf raw-command-must-not-be-used",
			cwd: root,
			timeoutMs: 5_000,
			backend: "pipe",
			executionMode: "foreground",
			principalId: "principal_host-security-managed-process",
		});
		expect(created.ok, JSON.stringify(created)).toBe(true);
		if (!created.ok) return;
		const waited = await port.toolClient("session_host-security-managed-process", 1, "principal_host-security-managed-process").processWait(created.handle, 5_000, "driver");
		expect(waited).toMatchObject({ ok: true, outcome: "terminal" });
		const output = await port.output("session_host-security-managed-process", created.handle.executionId, { sequence: 0, byteOffset: 0 }, 1_024);
		expect(output.page).toContain("spawned-through-final-leaf");
		expect(output.page).not.toContain("raw-command-must-not-be-used");
	});

	it("projects the persisted worktree binding into the Host execution envelope", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-security-binding-"));
		roots.push(root);
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		const binding = workspaceBinding(root);
		const security = await createProductionHostSecurity({
			layout,
			scope: scope(),
			cwd: binding.effectiveCwd,
			workspaceBinding: binding,
			sandboxBackend: availableSandboxBackend(),
		});
		const prepared = await security.prepareProcess({
			...processRequest(binding.effectiveCwd, createRuntimeId("session", "host-security-binding")),
			cwd: binding.effectiveCwd,
		});
		expect(prepared.ok).toBe(true);
		if (!prepared.ok) return;
		expect(prepared.value.sandboxPlan?.workspaceRoot).toBe(binding.worktreePath);
		expect(prepared.value.constraintInput.workspaceId).toBe(binding.binding.workspaceId);
	});

	it("applies a CLI security override as the highest-priority layer", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-security-cli-override-"));
		roots.push(root);
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		// 用户层提供 canonical settings(默认 workspace-write);CLI 层应覆盖为 read-only。
		await mkdir(join(root, "home"), { recursive: true });
		await writeFile(layout.settings, JSON.stringify({ security: { profile: "workspace-write" } }), "utf8");
		const security = await createProductionHostSecurity({
			layout,
			scope: scope(),
			cwd: root,
			sandboxBackend: availableSandboxBackend(),
			securitySources: [{
				source: "cli",
				read: async () => ({
					status: "available",
					text: JSON.stringify({ profile: "read-only", network: { mode: "deny", allowedHosts: [] } }),
				}),
			}],
		});

		expect(security.snapshot.profile.name).toBe("read-only");
		expect(security.snapshot.sources).toContain("cli");
		// cli 层与默认 canonical sources 合并,而不是替换。
		expect(security.snapshot.sources).toContain("user");
	});

	it("keeps the canonical default profile when no CLI override is supplied", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-security-no-override-"));
		roots.push(root);
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		const security = await createProductionHostSecurity({
			layout,
			scope: scope(),
			cwd: root,
			sandboxBackend: availableSandboxBackend(),
		});

		expect(security.snapshot.profile.name).toBe("workspace-write");
		expect(security.snapshot.sources).not.toContain("cli");
	});

	it("fails closed when the CLI override does not match the exact security schema", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-security-bad-override-"));
		roots.push(root);
		const layout = buildRunledgerLayout(join(root, "home"), "posix");

		await expect(createProductionHostSecurity({
			layout,
			scope: scope(),
			cwd: root,
			sandboxBackend: availableSandboxBackend(),
			securitySources: [{
				source: "cli",
				read: async () => ({ status: "available", text: JSON.stringify({ profile: "allow-everything" }) }),
			}],
		})).rejects.toThrow(/exact schema|invalid_config/iu);
	});
});
