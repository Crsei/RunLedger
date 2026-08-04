import { describe, expect, it } from "vitest";
import {
	isCapabilityDecisionReceipt,
	runtimeDigest,
	createRuntimeId,
} from "../../src/runtime/contracts/public.ts";
import { RuntimeAuthorizationAdapter } from "../../src/security/integration/runtime-authorization-adapter.ts";
import { ApprovalCoordinator } from "../../src/security/permission/approval-coordinator.ts";
import { PermissionEngine } from "../../src/security/permission/engine.ts";
import type { AuthorizationRequest, SecuritySnapshot } from "../../src/security/types.ts";
import type { CapabilityRequest } from "../../src/runtime/contracts/public.ts";

function fixture(): { request: AuthorizationRequest; capability: CapabilityRequest } {
	const authorityId = createRuntimeId("authority", "adapter-test");
	const tenantId = createRuntimeId("tenant", "adapter-test");
	const principalId = createRuntimeId("principal", "adapter-test");
	const sessionId = createRuntimeId("session", "adapter-test");
	const workspaceId = createRuntimeId("workspace", "adapter-test");
	const repositoryId = createRuntimeId("repository", "adapter-test");
	const toolCallId = createRuntimeId("toolCall", "adapter-test");
	const traceId = createRuntimeId("trace", "adapter-test");
	const requestId = createRuntimeId("command", "adapter-test");
	const policyDigest = runtimeDigest({ policy: "adapter" });
	const argumentsDigest = runtimeDigest({ path: "file.ts" });
	const workspace = {
		authorityId, tenantId, principalId, sessionId, workspaceId, repositoryId,
		worktreePath: "/repo", branch: "main", baseCommit: "a".repeat(40),
		agentId: createRuntimeId("agent", "adapter-test"), toolCallId, traceId, cwd: "/repo",
		ownerRuntimeId: createRuntimeId("runtime", "adapter-test"), leaseRevision: 1,
		fencingTokenDigest: runtimeDigest("fence"),
	};
	const snapshot: SecuritySnapshot = {
		profile: { name: "workspace-write", approvalPolicy: "on-request", filesystemMode: "workspace-write", network: { mode: "deny", allowedHosts: [] }, sandbox: "workspace-write" },
		filesystem: { readRoots: ["/repo"], writeRoots: ["/repo"], denyRead: [], denyWrite: [], protectedPaths: ["/repo/.git", "/repo/.runledger"] },
		rules: [], sources: ["builtin"], workspaceRoot: "/repo", tempRoot: "/tmp/runledger", policyDigest, createdAt: "2026-08-04T00:00:00.000Z",
	};
	const request: AuthorizationRequest = {
		requestId, sessionId, turnId: createRuntimeId("turn", "adapter-test"), toolCallId,
		toolName: "write", argumentsDigest, cwd: "/repo", requests: [{ kind: "filesystem", operation: "write", path: "file.ts" }], workspace, snapshot,
	};
	const capability: CapabilityRequest = {
		requestId,
		identity: { authorityId, tenantId, principalId, principalKind: "local", issuedAt: "2026-08-04T00:00:00.000Z" },
		subject: { sessionId, agentId: workspace.agentId, toolCallId, traceId },
		claim: { name: "workspace_write", resourceKind: "filesystem", resourceDigest: argumentsDigest, constraintsDigest: policyDigest, scope: "invocation" },
		argumentsDigest,
		workspaceEnvelopeDigest: runtimeDigest(workspace),
		policyDigest,
		nonceDigest: runtimeDigest("nonce"),
		issuedAt: "2026-08-04T00:00:00.000Z",
		expiresAt: "2026-08-04T00:05:00.000Z",
		channel: "adapter",
		signatureProofRef: { subjectKind: "attestation", digest: runtimeDigest("proof") },
	};
	return { request, capability };
}

describe("Runtime authorization adapter", () => {
	it("returns a current Runtime CapabilityDecisionReceipt after approval", async () => {
		const value = fixture();
		const approvals = new ApprovalCoordinator({
			prompter: { request: async () => ({ decision: "allow-once", decidedBy: createRuntimeId("principal", "approver") }) },
			clock: () => new Date("2026-08-04T00:00:01.000Z"),
		});
		const adapter = new RuntimeAuthorizationAdapter({
			engine: new PermissionEngine(),
			approvals,
			gateway: { adapterId: "permission-engine", generation: 1, configDigest: runtimeDigest("config") },
			clock: () => new Date("2026-08-04T00:00:01.000Z"),
		});
		const result = await adapter.authorize({ ...value, revalidate: () => ({ argumentsDigest: value.request.argumentsDigest, cwd: value.request.cwd, policyDigest: value.request.snapshot.policyDigest }) });
		expect(result).toMatchObject({ ok: true, value: { authorization: { outcome: "allow" }, receipt: { decision: "allow", requestId: value.capability.requestId, approverPrincipalId: "principal_approver" } } });
		if (!result.ok) return;
		expect(isCapabilityDecisionReceipt(result.value.receipt)).toBe(true);
	});

	it("turns approvalPolicy never into a typed deny without prompting", async () => {
		const value = fixture();
		const denied = { ...value.request, snapshot: { ...value.request.snapshot, profile: { ...value.request.snapshot.profile, approvalPolicy: "never" as const } } };
		let prompted = false;
		const adapter = new RuntimeAuthorizationAdapter({
			engine: new PermissionEngine(),
			approvals: new ApprovalCoordinator({ prompter: { request: async () => { prompted = true; return { decision: "allow-once", decidedBy: createRuntimeId("principal", "bad") }; } } }),
			gateway: { adapterId: "permission-engine", generation: 1, configDigest: runtimeDigest("config") },
		});
		const result = await adapter.authorize({ request: denied, capability: value.capability, revalidate: () => ({ argumentsDigest: denied.argumentsDigest, cwd: denied.cwd, policyDigest: denied.snapshot.policyDigest }) });
		expect(prompted).toBe(false);
		expect(result).toMatchObject({ ok: true, value: { authorization: { outcome: "deny" }, receipt: { decision: "deny" } } });
	});
});
