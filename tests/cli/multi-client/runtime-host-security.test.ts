import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { runtimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import type { RuntimeHostScope } from "../../../src/runtime/host/types.ts";
import {
	createProductionHostSecurity,
	type HostProcessSecurityRequest,
} from "../../../src/cli/runtime-host-security.ts";
import { ProductionManagedProcessPort } from "../../../src/cli/runtime-host-process.ts";
import type {
	SandboxBackend,
	SandboxCapability,
	SandboxPrepareRequest,
} from "../../../src/security/sandbox/types.ts";
import { createDecisionReceipt, createResolutionState, digestOf } from "../../../src/security/sandbox/common.ts";

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
		workspaceStorageKey: `ws-${"s".repeat(64)}`,
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

describe("production Host Security/ExecutionGateway composition", () => {
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
		await expect(env.fs.writeFile(join(root, "..", "outside.txt"), "must not write")).rejects.toThrow(/allowed roots|protected|path_escape/iu);
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
});
