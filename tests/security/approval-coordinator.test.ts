import { describe, expect, it } from "vitest";
import { approvalReceiptMatchesTicket } from "../../src/runtime/protocol/v3/capability.ts";
import { createRuntimeId } from "../../src/runtime/protocol/v3/ids.ts";
import type { WorkspaceExecutionEnvelope } from "../../src/runtime/protocol/v3/workspace.ts";
import {
	ApprovalCoordinator,
	HeadlessDenyPrompter,
	type ApprovalCoordinatorOptions,
} from "../../src/security/permission/approval-coordinator.ts";
import { PermissionEngine } from "../../src/security/permission/engine.ts";
import type { AuthorizationRequest, PermissionPrompter, SecuritySnapshot } from "../../src/security/types.ts";

const NOW = new Date("2026-07-22T00:00:00.000Z");

function workspace(): WorkspaceExecutionEnvelope {
	return {
		authorityId: createRuntimeId("authority", "approval-test"), tenantId: createRuntimeId("tenant", "approval-test"),
		principalId: createRuntimeId("principal", "requester"), sessionId: createRuntimeId("session", "approval-test"),
		workspaceId: createRuntimeId("workspace", "approval-test"), repositoryId: createRuntimeId("repository", "approval-test"),
		worktreePath: "/repo", branch: "runledger/test", baseCommit: "a".repeat(40),
		agentId: createRuntimeId("agent", "approval-test"), toolCallId: createRuntimeId("toolCall", "approval-test"),
		traceId: createRuntimeId("trace", "approval-test"), cwd: "/repo",
		ownerRuntimeId: createRuntimeId("runtime", "approval-test"), leaseRevision: 1, fencingToken: "approval-fence",
	};
}

function snapshot(): SecuritySnapshot {
	return {
		profile: { name: "workspace-write", approvalPolicy: "on-request", filesystemMode: "workspace-write", network: { mode: "deny", allowedHosts: [] }, sandbox: "workspace-write" },
		filesystem: { readRoots: ["/repo"], writeRoots: ["/repo"], denyRead: [], denyWrite: [], protectedPaths: ["/repo/.git", "/repo/.runledger"] },
		rules: [], sources: ["builtin"], workspaceRoot: "/repo", tempRoot: "/tmp/session", policyDigest: "b".repeat(64), createdAt: NOW.toISOString(),
	};
}

function request(): AuthorizationRequest {
	const envelope = workspace();
	return {
		requestId: createRuntimeId("command", "approval-test"), sessionId: envelope.sessionId,
		turnId: createRuntimeId("turn", "approval-test"), toolCallId: envelope.toolCallId,
		toolName: "write", arguments: { path: "file.ts", content: "x" }, argumentsDigest: "c".repeat(64), cwd: envelope.cwd,
		requests: [{ kind: "filesystem", operation: "write", path: "file.ts" }], workspace: envelope, snapshot: snapshot(),
	};
}

function coordinator(prompter: PermissionPrompter, overrides: Partial<ApprovalCoordinatorOptions> = {}): ApprovalCoordinator {
	return new ApprovalCoordinator({
		prompter, clock: () => NOW, timeoutMs: 1_000,
		fallbackPrincipalId: createRuntimeId("principal", "fallback"), ...overrides,
	});
}

describe("ApprovalCoordinator", () => {
	it("coalesces duplicate prompts and emits a request-bound receipt", async () => {
		let calls = 0;
		const requester = request();
		const evaluation = new PermissionEngine().evaluate(requester.requests, requester.snapshot);
		const approval = coordinator({ request: async () => { calls += 1; return { decision: "allow-once", decidedBy: createRuntimeId("principal", "approver") }; } });

		const [first, second] = await Promise.all([
			approval.authorize(requester, evaluation, () => ({ argumentsDigest: requester.argumentsDigest, cwd: requester.cwd, policyDigest: requester.snapshot.policyDigest })),
			approval.authorize(requester, evaluation, () => ({ argumentsDigest: requester.argumentsDigest, cwd: requester.cwd, policyDigest: requester.snapshot.policyDigest })),
		]);

		expect(calls).toBe(1);
		expect(first).toEqual(second);
		expect(first).toMatchObject({ ok: true, value: { outcome: "allow", approval: { decision: "allowed" } } });
		if (!first.ok || !first.value.approval) return;
		expect(first.value.approval.requestDigest).toHaveLength(64);
	});

	it("cancels an allow response when args, cwd, or policy changed while prompting", async () => {
		const requester = request();
		const evaluation = new PermissionEngine().evaluate(requester.requests, requester.snapshot);
		const approval = coordinator({ request: async () => ({ decision: "allow-once", decidedBy: createRuntimeId("principal", "approver") }) });
		const result = await approval.authorize(requester, evaluation, () => ({
			argumentsDigest: "d".repeat(64), cwd: requester.cwd, policyDigest: requester.snapshot.policyDigest,
		}));
		expect(result).toMatchObject({ ok: true, value: { outcome: "deny", approval: { decision: "cancelled" } } });
	});

	it("headless prompting fails closed", async () => {
		const requester = request();
		const evaluation = new PermissionEngine().evaluate(requester.requests, requester.snapshot);
		const approval = coordinator(new HeadlessDenyPrompter(createRuntimeId("principal", "headless")));
		const result = await approval.authorize(requester, evaluation, () => ({ argumentsDigest: requester.argumentsDigest, cwd: requester.cwd, policyDigest: requester.snapshot.policyDigest }));
		expect(result).toMatchObject({ ok: true, value: { outcome: "deny", approval: { decision: "denied" } } });
	});

	it("the runtime receipt validator rejects cross-ticket replay", async () => {
		const requester = request();
		const evaluation = new PermissionEngine().evaluate(requester.requests, requester.snapshot);
		const approval = coordinator({ request: async () => ({ decision: "allow-once", decidedBy: createRuntimeId("principal", "approver") }) });
		const first = await approval.authorize(requester, evaluation, () => ({ argumentsDigest: requester.argumentsDigest, cwd: requester.cwd, policyDigest: requester.snapshot.policyDigest }));
		expect(first.ok && first.value.approval).toBeTruthy();
		if (!first.ok || !first.value.approval) return;
		const ticket = {
			authorityId: requester.workspace.authorityId, tenantId: requester.workspace.tenantId, principalId: requester.workspace.principalId,
			approvalId: first.value.approval.approvalId, request: { ...first.value.approval, capability: "workspace_write" as const },
			scope: "once" as const, createdAt: NOW.toISOString(),
		};
		expect(approvalReceiptMatchesTicket(first.value.approval, ticket)).toBe(false);
	});
});
