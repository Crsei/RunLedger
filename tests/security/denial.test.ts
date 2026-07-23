import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../../src/runtime/protocol/v3/canonical-json.ts";
import type { SandboxExecutorRequest } from "../../src/runtime/protocol/v3/capability.ts";
import { createRuntimeId } from "../../src/runtime/protocol/v3/ids.ts";
import type { WorkspaceExecutionEnvelope } from "../../src/runtime/protocol/v3/workspace.ts";
import { RuntimeSandboxExecutorAdapter } from "../../src/security/integration/runtime-sandbox-adapter.ts";
import { isSandboxDenial, sandboxDenialReason } from "../../src/security/sandbox/denial.ts";
import type { SandboxBackend } from "../../src/security/sandbox/types.ts";
import type { SecuritySnapshot } from "../../src/security/types.ts";

function envelope(): WorkspaceExecutionEnvelope {
	return {
		authorityId: createRuntimeId("authority", "adapter"), tenantId: createRuntimeId("tenant", "adapter"),
		principalId: createRuntimeId("principal", "adapter"), sessionId: createRuntimeId("session", "adapter"),
		workspaceId: createRuntimeId("workspace", "adapter"), repositoryId: createRuntimeId("repository", "adapter"),
		worktreePath: "/repo", branch: "runledger/test", baseCommit: "a".repeat(40), agentId: createRuntimeId("agent", "adapter"),
		toolCallId: createRuntimeId("toolCall", "adapter"), traceId: createRuntimeId("trace", "adapter"), cwd: "/repo",
		ownerRuntimeId: createRuntimeId("runtime", "adapter"), leaseRevision: 1, fencingToken: "adapter-fence",
	};
}

function snapshot(): SecuritySnapshot {
	return {
		profile: { name: "workspace-write", approvalPolicy: "on-request", filesystemMode: "workspace-write", network: { mode: "deny", allowedHosts: [] }, sandbox: "workspace-write" },
		filesystem: { readRoots: ["/repo"], writeRoots: ["/repo"], denyRead: [], denyWrite: [], protectedPaths: ["/repo/.git", "/repo/.runledger"] },
		rules: [], sources: ["builtin"], workspaceRoot: "/repo", tempRoot: "/tmp/session", policyDigest: "d".repeat(64), createdAt: "2026-07-22T00:00:00.000Z",
	};
}

function request(opaqueInvocation: unknown): SandboxExecutorRequest {
	const security = snapshot();
	const identity = envelope();
	return {
		authorityId: identity.authorityId, tenantId: identity.tenantId, principalId: identity.principalId,
		requestId: createRuntimeId("command", "sandbox-adapter"),
		profile: { authorityId: identity.authorityId, tenantId: identity.tenantId, profileId: createRuntimeId("resource", "sandbox-adapter"), requested: "workspace-write", policyDigest: security.policyDigest },
		invocationDigest: canonicalDigest(opaqueInvocation), resolutionDigest: "e".repeat(64), idempotencyKey: createRuntimeId("command", "sandbox-idempotency"), opaqueInvocation,
	};
}

describe("sandbox denial and runtime adapter", () => {
	it("classifies bounded denial text", () => {
		expect(isSandboxDenial("bwrap: Permission denied while opening file", 1)).toBe(true);
		expect(sandboxDenialReason("network socket operation not permitted")).toBe("network");
		expect(isSandboxDenial("normal stderr", 1)).toBe(false);
	});

	it("returns an unavailable receipt and never spawns on request correlation failure", async () => {
		let spawned = 0;
		const backend: SandboxBackend = {
			probe: async () => ({ backendId: "fake", platform: "linux", status: "available", supportsFilesystemIsolation: true, supportsNetworkDeny: true, supportsChildIsolation: true }),
			prepare: async (value) => ({ ok: true, value: { backendId: "fake", requested: value.requested, resolved: value.requested, effectiveEnforcement: "enforced", policyDigest: value.policyDigest, program: "/bin/sh", arguments: ["-lc", value.command], cwd: value.cwd, environment: value.environment, timeoutMs: value.timeoutMs } }),
			spawn: async () => { spawned += 1; return { ok: true, value: { stdout: "", stderr: "", exitCode: 0, signaled: false, denied: false } }; },
		};
		const identity = envelope();
		const security = snapshot();
		const adapter = new RuntimeSandboxExecutorAdapter(backend, {
			resolveEnvelope: async () => identity,
			resolveSnapshot: async () => security,
		});
		const invocation = { command: "pwd", cwd: "/outside", environment: {}, timeoutMs: 1_000 };
		const result = await adapter.execute(request(invocation));
		expect(result.executionReceipt).toMatchObject({ effectiveEnforcement: "unavailable", backendId: "correlation-rejected" });
		expect(spawned).toBe(0);
	});

	it("replays one terminal result without repeating spawn", async () => {
		let spawned = 0;
		const backend: SandboxBackend = {
			probe: async () => ({ backendId: "fake", platform: "linux", status: "available", supportsFilesystemIsolation: true, supportsNetworkDeny: true, supportsChildIsolation: true }),
			prepare: async (value) => ({ ok: true, value: { backendId: "fake", requested: value.requested, resolved: value.requested, effectiveEnforcement: "enforced", policyDigest: value.policyDigest, program: "/bin/sh", arguments: ["-lc", value.command], cwd: value.cwd, environment: value.environment, timeoutMs: value.timeoutMs } }),
			spawn: async () => { spawned += 1; return { ok: true, value: { stdout: "ok", stderr: "", exitCode: 0, signaled: false, denied: false } }; },
		};
		const identity = envelope();
		const security = snapshot();
		const adapter = new RuntimeSandboxExecutorAdapter(backend, { resolveEnvelope: async () => identity, resolveSnapshot: async () => security });
		const invocation = { command: "pwd", cwd: "/repo", environment: {}, timeoutMs: 1_000 };
		const input = request(invocation);
		const first = await adapter.execute(input);
		const second = await adapter.execute(input);
		expect(second).toEqual(first);
		expect(spawned).toBe(1);
	});
});
