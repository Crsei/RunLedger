import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, realpath, readdir, rm, stat, lstat, writeFile, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	createExecutionConstraintReceipt,
	evaluateExecutionConstraints,
	runtimeDigest,
	createRuntimeId,
	type ExecutionConstraintInput,
	type ExecutionConstraintModes,
	type ExecutionConstraintSnapshot,
	type RuntimeDigest,
	type WorkspaceExecutionEnvelope,
} from "../../src/runtime/contracts/public.ts";
import {
	ExecutionGateway,
	gatewayRequestDigest,
	type ExecutionGatewayOpenRequest,
} from "../../src/security/execution-gateway.ts";
import {
	PolicyNetworkClient,
	type NetworkBrokerPort,
} from "../../src/security/policy-network.ts";
import {
	HostProcessFinalLeafAdapter,
	type HostProcessFinalLeafRequest,
} from "../../src/security/integration/runtime-gateway-adapter.ts";
import type { FileSystemBrokerPort } from "../../src/security/policy-filesystem.ts";
import { ApprovalCoordinator, MemoryApprovalStateStore } from "../../src/security/permission/approval-coordinator.ts";
import { PermissionEngine } from "../../src/security/permission/engine.ts";
import { LinuxBwrapBackend } from "../../src/security/sandbox/linux-bwrap.ts";
import type { SandboxBackend, SandboxCapability, SandboxDecisionReceipt, SandboxLaunchPlan, SandboxPrepareRequest } from "../../src/security/sandbox/types.ts";
import type { AuthorizationRequest, AuthorizationResult, SecuritySnapshot } from "../../src/security/types.ts";

const roots: string[] = [];

const broker: FileSystemBrokerPort = {
	readFile,
	writeFile,
	stat: async (path) => {
		const value = await stat(path);
		return { size: value.size, mtimeMs: value.mtimeMs, isFile: value.isFile(), isDirectory: value.isDirectory(), isSymbolicLink: value.isSymbolicLink() };
	},
	lstat: async (path) => {
		const value = await lstat(path);
		return { size: value.size, mtimeMs: value.mtimeMs, isFile: value.isFile(), isDirectory: value.isDirectory(), isSymbolicLink: value.isSymbolicLink() };
	},
	realpath,
	readdir,
	mkdir,
	rm,
	rename,
};

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function envelope(root: string): WorkspaceExecutionEnvelope {
	return {
		authorityId: createRuntimeId("authority", "gateway-test"),
		tenantId: createRuntimeId("tenant", "gateway-test"),
		principalId: createRuntimeId("principal", "gateway-test"),
		sessionId: createRuntimeId("session", "gateway-test"),
		workspaceId: createRuntimeId("workspace", "gateway-test"),
		repositoryId: createRuntimeId("repository", "gateway-test"),
		worktreePath: root,
			worktreePathDigest: runtimeDigest(root),
		branch: "runledger/test",
		baseCommit: "a".repeat(40),
		agentId: createRuntimeId("agent", "gateway-test"),
		toolCallId: createRuntimeId("toolCall", "gateway-test"),
		traceId: createRuntimeId("trace", "gateway-test"),
		cwd: root,
			cwdDigest: runtimeDigest(root),
		ownerRuntimeId: createRuntimeId("runtime", "gateway-test"),
		leaseRevision: 1,
		fencingTokenDigest: runtimeDigest("gateway-fence"),
	};
}

function snapshot(root: string, sandbox: "off" | "workspace-write" = "off"): SecuritySnapshot {
	const body = {
		profile: {
			name: sandbox === "off" ? "danger-full-access" : "workspace-write",
			approvalPolicy: "on-request",
			filesystemMode: "workspace-write",
			network: { mode: "allow", allowedHosts: [] },
			sandbox,
		},
		filesystem: {
			readRoots: [root],
			writeRoots: [root],
			denyRead: [],
			denyWrite: [],
			protectedPaths: [join(root, ".git"), join(root, ".runledger")],
		},
		rules: [],
		sources: ["builtin"],
		workspaceRoot: root,
		tempRoot: join(root, ".tmp"),
		createdAt: "2026-08-04T00:00:00.000Z",
	};
	return { ...body, policyDigest: runtimeDigest(body) };
}

function authorizationRequest(root: string, currentSnapshot: SecuritySnapshot): AuthorizationRequest {
	const workspace = envelope(root);
	return {
		requestId: createRuntimeId("command", "gateway-test"),
		sessionId: workspace.sessionId,
		turnId: createRuntimeId("turn", "gateway-test"),
		toolCallId: workspace.toolCallId,
		toolName: "read",
		argumentsDigest: runtimeDigest({ path: "README.md" }),
		cwd: root,
			cwdDigest: runtimeDigest(root),
		requests: [{ kind: "filesystem", operation: "read", path: "README.md" }],
		workspace,
		snapshot: currentSnapshot,
	};
}

function constraintModes(sandbox: ExecutionConstraintModes["sandbox"] = "none"): ExecutionConstraintModes {
	return {
		permission: "policy",
		approval: "required",
		sandbox,
		gateway: "mediated",
		containment: "none",
	};
}

async function constraint(
	request: AuthorizationRequest,
	currentSnapshot: SecuritySnapshot,
	requestDigest: RuntimeDigest,
	modes: ExecutionConstraintModes = constraintModes(),
): Promise<{ input: ExecutionConstraintInput; snapshot: ExecutionConstraintSnapshot }> {
	const input: ExecutionConstraintInput = {
		authorityId: request.workspace.authorityId,
		tenantId: request.workspace.tenantId,
		workspaceId: request.workspace.workspaceId,
		principalId: request.workspace.principalId,
		executionId: createRuntimeId("execution", "gateway-test"),
		attemptId: createRuntimeId("attempt", "gateway-test"),
		commandId: request.requestId,
		requestDigest,
		policyDigest: currentSnapshot.policyDigest,
		modes,
	};
	const result = await evaluateExecutionConstraints(input, {
		permission: { decide: async () => createExecutionConstraintReceipt({ dimension: "permission", mode: modes.permission, decision: "allow", providerId: "test.permission", providerRevision: 1, policyDigest: input.policyDigest, invocationDigest: input.requestDigest }) },
		approval: { decide: async () => createExecutionConstraintReceipt({ dimension: "approval", mode: modes.approval, decision: "allow", providerId: "test.approval", providerRevision: 1, policyDigest: input.policyDigest, invocationDigest: input.requestDigest }) },
		sandbox: { decide: async () => createExecutionConstraintReceipt({ dimension: "sandbox", mode: modes.sandbox, decision: modes.sandbox === "none" ? "not_required" : "allow", enforcement: modes.sandbox === "none" ? "off" : "enforced", providerId: "test.sandbox", providerRevision: 1, policyDigest: input.policyDigest, invocationDigest: input.requestDigest }) },
		gateway: { decide: async () => createExecutionConstraintReceipt({ dimension: "gateway", mode: modes.gateway, decision: "allow", route: "mediated", providerId: "test.gateway", providerRevision: 1, policyDigest: input.policyDigest, invocationDigest: input.requestDigest }) },
		containment: { decide: async () => createExecutionConstraintReceipt({ dimension: "containment", mode: modes.containment, decision: "not_required", settlement: "not_requested", providerId: "test.containment", providerRevision: 1, policyDigest: input.policyDigest, invocationDigest: input.requestDigest }) },
	});
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(`constraint fixture failed: ${result.code}`);
	return { input, snapshot: result.snapshot };
}

function authorization(request: AuthorizationRequest): AuthorizationResult {
	return {
		outcome: "allow",
		decisionSource: "builtin",
		requests: request.requests,
		policyDigest: request.snapshot.policyDigest,
		reason: "test authorization",
	};
}

async function openRequest(root: string): Promise<{ request: AuthorizationRequest; input: ExecutionGatewayOpenRequest; currentSnapshot: SecuritySnapshot }> {
	const currentSnapshot = snapshot(root);
	const request = authorizationRequest(root, currentSnapshot);
	const requestDigest = gatewayRequestDigest(request);
	const binding = await constraint(request, currentSnapshot, requestDigest);
	const allowed = authorization(request);
	return {
		request,
		currentSnapshot,
		input: {
			request,
			authorization: allowed,
			authorizationDigest: runtimeDigest(allowed),
			requestDigest,
			constraintInput: binding.input,
			constraintSnapshot: binding.snapshot,
		},
	};
}

function unavailableBackend(): SandboxBackend {
	const capability: SandboxCapability = {
		backendId: "test-unavailable",
		platform: "unknown",
		status: "unavailable",
		supportsFilesystemIsolation: false,
		supportsNetworkDeny: false,
		supportsChildIsolation: false,
		reason: "test backend unavailable",
		capabilityDigest: runtimeDigest("test-unavailable"),
	};
	return {
		backendId: capability.backendId,
		probe: async () => capability,
		prepare: async () => ({ ok: false, error: { code: "sandbox_unavailable", message: "unavailable", retryable: false } }),
		validateFinalLeaf: async () => {
			throw new Error("unavailable backend must not validate a final leaf");
		},
	};
}

describe("ExecutionGateway", () => {
	it("uses PermissionEngine and ApprovalCoordinator before returning a write-capable port", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-gateway-"));
		roots.push(root);
		const currentSnapshot = snapshot(root);
		const base = authorizationRequest(root, currentSnapshot);
		const request: AuthorizationRequest = {
			...base,
			toolName: "write",
			argumentsDigest: runtimeDigest({ path: "created.txt" }),
			requests: [{ kind: "filesystem", operation: "write", path: "created.txt" }],
		};
		const requestDigest = gatewayRequestDigest(request);
		const binding = await constraint(request, currentSnapshot, requestDigest);
		let prompts = 0;
		const gateway = new ExecutionGateway({
			snapshot: currentSnapshot,
			workspace: request.workspace,
			filesystemBroker: broker,
			networkBroker: { request: async () => ({ status: 200, headers: {}, body: Buffer.from("ok"), finalUrl: "https://example.com" }) },
			permissionEngine: new PermissionEngine(),
			approvalCoordinator: new ApprovalCoordinator({ prompter: { request: async () => { prompts += 1; return { decision: "allow-once", decidedBy: createRuntimeId("principal", "approver") }; } } }),
			finalLeaf: new HostProcessFinalLeafAdapter({ sandboxBackend: unavailableBackend() }),
		});

		const result = await gateway.authorize({ request, requestDigest, constraintInput: binding.input, constraintSnapshot: binding.snapshot });

		expect(result).toMatchObject({ ok: true, value: { authorization: { outcome: "allow", decisionSource: "approval" } } });
		expect(prompts).toBe(1);
	});

	it("durably completes an allow-once authorization exactly once", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-gateway-completion-"));
		roots.push(root);
		const currentSnapshot = snapshot(root);
		const base = authorizationRequest(root, currentSnapshot);
		const request: AuthorizationRequest = {
			...base,
			toolName: "write",
			argumentsDigest: runtimeDigest({ path: "created.txt" }),
			requests: [{ kind: "filesystem", operation: "write", path: "created.txt" }],
		};
		const requestDigest = gatewayRequestDigest(request);
		const binding = await constraint(request, currentSnapshot, requestDigest);
		const store = new MemoryApprovalStateStore();
		const events: string[] = [];
		const gateway = new ExecutionGateway({
			snapshot: currentSnapshot,
			workspace: request.workspace,
			filesystemBroker: broker,
			networkBroker: { request: async () => ({ status: 200, headers: {}, body: Buffer.from("ok"), finalUrl: "https://example.com" }) },
			permissionEngine: new PermissionEngine(),
			approvalCoordinator: new ApprovalCoordinator({
				prompter: { request: async () => ({ decision: "allow-once", decidedBy: createRuntimeId("principal", "approver") }) },
				store,
				audit: {
					requested: async () => { events.push("requested"); },
					decided: async () => { events.push("decided"); },
					revoked: async () => { events.push("revoked"); },
				},
			}),
			finalLeaf: new HostProcessFinalLeafAdapter({ sandboxBackend: unavailableBackend() }),
		});

		const opened = await gateway.authorize({ request, requestDigest, constraintInput: binding.input, constraintSnapshot: binding.snapshot });
		expect(opened.ok).toBe(true);
		if (!opened.ok || opened.value.authorization.approval === undefined) return;
		const first = await opened.value.complete();
		const second = await opened.value.complete();

		expect(first).toMatchObject({ ok: true });
		expect(second).toEqual(first);
		expect(await store.read(opened.value.authorization.approval.approvalId)).toMatchObject({ decision: "revoked", decisionRevision: 2 });
		expect(events).toEqual(["requested", "decided", "revoked"]);
	});

	it("rejects stale authorization or constraint digests before exposing fs or network ports", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-gateway-"));
		roots.push(root);
		await writeFile(join(root, "README.md"), "ok");
		const opened = await openRequest(root);
		let networkCalls = 0;
		const gateway = new ExecutionGateway({
			snapshot: opened.currentSnapshot,
			workspace: opened.request.workspace,
			filesystemBroker: broker,
			networkBroker: { request: async () => { networkCalls += 1; return { status: 200, headers: {}, body: Buffer.from("ok"), finalUrl: "https://example.com" }; } },
			permissionEngine: new PermissionEngine(),
			approvalCoordinator: new ApprovalCoordinator({ prompter: { request: async () => ({ decision: "deny", decidedBy: createRuntimeId("principal", "deny") }) } }),
			finalLeaf: new HostProcessFinalLeafAdapter({ sandboxBackend: unavailableBackend() }),
		});

		const result = await gateway.open({ ...opened.input, authorizationDigest: runtimeDigest("stale") });

		expect(result).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		expect(networkCalls).toBe(0);
	});

	it("returns only the PolicyFileSystem and PolicyNetworkClient ports after validation", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-gateway-"));
		roots.push(root);
		await writeFile(join(root, "README.md"), "ok");
		const opened = await openRequest(root);
		let networkCalls = 0;
		const networkBroker: NetworkBrokerPort = {
			request: async (request) => {
				networkCalls += 1;
				return { status: 200, headers: { "content-type": "text/plain" }, body: Buffer.from(request.url), finalUrl: request.url };
			},
		};
		const gateway = new ExecutionGateway({
			snapshot: opened.currentSnapshot,
			workspace: opened.request.workspace,
			filesystemBroker: broker,
			networkBroker,
			permissionEngine: new PermissionEngine(),
			approvalCoordinator: new ApprovalCoordinator({ prompter: { request: async () => ({ decision: "deny", decidedBy: createRuntimeId("principal", "deny") }) } }),
			finalLeaf: new HostProcessFinalLeafAdapter({ sandboxBackend: unavailableBackend() }),
		});

		const result = await gateway.open(opened.input);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(await result.value.fs.readFile("README.md")).toMatchObject({ ok: true });
		expect(await result.value.network.request({ url: "https://example.com/data", method: "GET", headers: {}, maxBytes: 1024 })).toMatchObject({ ok: true });
		expect(networkCalls).toBe(1);
	});
});

describe("PolicyNetworkClient", () => {
	it("fails closed for unknown network policy without calling its broker", async () => {
		let calls = 0;
		const client = new PolicyNetworkClient({
			request: async () => {
				calls += 1;
				return { status: 200, headers: {}, body: Buffer.from("unexpected"), finalUrl: "https://example.com" };
			},
		}, { mode: "unknown" as never, allowedHosts: [] });

		expect(await client.request({ url: "https://example.com", method: "GET", headers: {}, maxBytes: 1024 })).toMatchObject({ ok: false, error: { code: "network_denied" } });
		expect(calls).toBe(0);
	});

	it("rejects cross-host redirects and oversized responses after the broker boundary", async () => {
		const client = new PolicyNetworkClient({
			request: async (request) => ({ status: 200, headers: {}, body: Buffer.from("too large"), finalUrl: request.url.replace("example.com", "other.example") }),
		}, { mode: "allow", allowedHosts: [] });

		expect(await client.request({ url: "https://example.com", method: "GET", headers: {}, maxBytes: 2 })).toMatchObject({ ok: false, error: { code: "network_denied" } });
	});
});

describe("HostProcessFinalLeafAdapter", () => {
	it("does not permit a final leaf when the constraint snapshot is missing or stale", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-final-leaf-"));
		roots.push(root);
		const currentSnapshot = snapshot(root, "workspace-write");
		const request = authorizationRequest(root, currentSnapshot);
		const requestDigest = gatewayRequestDigest(request);
		const binding = await constraint(request, currentSnapshot, requestDigest, constraintModes("profile"));
		let spawnCount = 0;
		const adapter = new HostProcessFinalLeafAdapter({ sandboxBackend: unavailableBackend() });
		const call = async (input: HostProcessFinalLeafRequest) => {
			const decision = await adapter.decide(input);
			if (decision.ok) spawnCount += 1;
			return decision;
		};

		expect(await call({ constraintInput: binding.input, requestDigest, policyDigest: currentSnapshot.policyDigest })).toMatchObject({ ok: false });
		expect(await call({ constraintInput: binding.input, constraintSnapshot: { ...binding.snapshot, requestDigest: runtimeDigest("stale") }, requestDigest, policyDigest: currentSnapshot.policyDigest })).toMatchObject({ ok: false });
		expect(spawnCount).toBe(0);
	});

	it("fails closed when a restrictive sandbox backend is unavailable", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-final-leaf-"));
		roots.push(root);
		const currentSnapshot = snapshot(root, "workspace-write");
		const request = authorizationRequest(root, currentSnapshot);
		const requestDigest = gatewayRequestDigest(request);
		const binding = await constraint(request, currentSnapshot, requestDigest, constraintModes("profile"));
		const adapter = new HostProcessFinalLeafAdapter({ sandboxBackend: unavailableBackend() });
		const result = await adapter.decide({
			constraintInput: binding.input,
			constraintSnapshot: binding.snapshot,
			requestDigest,
			policyDigest: currentSnapshot.policyDigest,
		});

		expect(result).toMatchObject({ ok: false, error: { code: "policy_denied" } });
	});

	it("accepts a valid request-bound restrictive sandbox plan without spawning a process", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-final-leaf-"));
		roots.push(root);
		const currentSnapshot = snapshot(root, "workspace-write");
		const request = authorizationRequest(root, currentSnapshot);
		const requestDigest = gatewayRequestDigest(request);
		const binding = await constraint(request, currentSnapshot, requestDigest, constraintModes("profile"));
		const backend = new LinuxBwrapBackend({ which: async () => "/opt/bwrap" });
		const planResult = await backend.prepare({
			requested: "workspace-write",
			resolved: "workspace-write",
			policyDigest: currentSnapshot.policyDigest,
			requestDigest,
			workspace: request.workspace,
			readRoots: [root],
			writeRoots: [root],
			denyRead: [],
			denyWrite: [],
			protectedPaths: [join(root, ".git"), join(root, ".runledger")],
			network: "deny",
			command: "printf ok",
			cwd: root,
				cwdDigest: runtimeDigest(root),
			environment: {},
			timeoutMs: 1_000,
		} satisfies SandboxPrepareRequest);
		expect(planResult.ok).toBe(true);
		if (!planResult.ok) return;

		const adapter = new HostProcessFinalLeafAdapter({ sandboxBackend: backend });
		const result = await adapter.decide({
			constraintInput: binding.input,
			constraintSnapshot: binding.snapshot,
			requestDigest,
			policyDigest: currentSnapshot.policyDigest,
			sandboxPlan: planResult.value,
		});

		expect(result).toMatchObject({ ok: true, value: { decision: "allow", requestDigest, policyDigest: currentSnapshot.policyDigest } });
	});
});
