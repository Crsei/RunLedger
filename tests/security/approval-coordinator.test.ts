import { describe, expect, it } from "vitest";
import {
	approvalReceiptMatchesTicket,
	isApprovalReceiptRef,
} from "../../src/runtime/protocol/v3/capability.ts";
import { createRuntimeId } from "../../src/runtime/protocol/v3/ids.ts";
import type { WorkspaceExecutionEnvelope } from "../../src/runtime/protocol/v3/workspace.ts";
import {
	ApprovalCoordinator,
	createApprovalSupersessionReceipt,
	HeadlessDenyPrompter,
	SYSTEM_APPROVAL_PRINCIPAL_ID,
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
		expect(first.value.approval.decidedBy).toBe(createRuntimeId("principal", "approver"));
	});

	it("binds the terminal actor into the receipt identity and digest", async () => {
		const requester = request();
		const evaluation = new PermissionEngine().evaluate(requester.requests, requester.snapshot);
		const first = await coordinator({
			request: async () => ({ decision: "allow-once", decidedBy: createRuntimeId("principal", "approver-a") }),
		}).authorize(requester, evaluation, () => ({
			argumentsDigest: requester.argumentsDigest,
			cwd: requester.cwd,
			policyDigest: requester.snapshot.policyDigest,
		}));
		const second = await coordinator({
			request: async () => ({ decision: "allow-once", decidedBy: createRuntimeId("principal", "approver-b") }),
		}).authorize(requester, evaluation, () => ({
			argumentsDigest: requester.argumentsDigest,
			cwd: requester.cwd,
			policyDigest: requester.snapshot.policyDigest,
		}));
		if (!first.ok || !first.value.approval || !second.ok || !second.value.approval) {
			throw new Error("approval fixture did not produce receipts");
		}

		expect(first.value.approval.decidedBy).toBe(createRuntimeId("principal", "approver-a"));
		expect(second.value.approval.decidedBy).toBe(createRuntimeId("principal", "approver-b"));
		expect(first.value.approval.receiptId).not.toBe(second.value.approval.receiptId);
		expect(first.value.approval.receiptDigest).not.toBe(second.value.approval.receiptDigest);
		expect(isApprovalReceiptRef({ ...first.value.approval, receiptDigest: "f".repeat(64) })).toBe(false);
		expect(isApprovalReceiptRef({ ...first.value.approval, decisionRevision: 0 })).toBe(false);
	});

	it("binds a supersession actor into the receipt identity and digest", async () => {
		const requester = request();
		const evaluation = new PermissionEngine().evaluate(requester.requests, requester.snapshot);
		const allowed = await coordinator({
			request: async () => ({ decision: "allow-once", decidedBy: createRuntimeId("principal", "approver") }),
		}).authorize(requester, evaluation, () => ({
			argumentsDigest: requester.argumentsDigest,
			cwd: requester.cwd,
			policyDigest: requester.snapshot.policyDigest,
		}));
		if (!allowed.ok || !allowed.value.approval) {
			throw new Error("approval fixture did not produce an allowed receipt");
		}
		const decidedAt = "2026-07-22T00:01:00.000Z";
		const first = createApprovalSupersessionReceipt(
			allowed.value.approval,
			"revoked",
			decidedAt,
			createRuntimeId("principal", "revoker-a"),
		);
		const second = createApprovalSupersessionReceipt(
			allowed.value.approval,
			"revoked",
			decidedAt,
			createRuntimeId("principal", "revoker-b"),
		);

		expect(first.receiptId).not.toBe(second.receiptId);
		expect(first.receiptDigest).not.toBe(second.receiptDigest);
	});

	it("cancels an allow response when args, cwd, or policy changed while prompting", async () => {
		const requester = request();
		const evaluation = new PermissionEngine().evaluate(requester.requests, requester.snapshot);
		const approval = coordinator({ request: async () => ({ decision: "allow-once", decidedBy: createRuntimeId("principal", "approver") }) });
		const result = await approval.authorize(requester, evaluation, () => ({
			argumentsDigest: "d".repeat(64), cwd: requester.cwd, policyDigest: requester.snapshot.policyDigest,
		}));
		expect(result).toMatchObject({ ok: true, value: { outcome: "deny", approval: { decision: "cancelled" } } });
		expect(result).toMatchObject({ ok: true, value: { approval: { decidedBy: SYSTEM_APPROVAL_PRINCIPAL_ID } } });
	});

	it.each(["pre-abort", "channel-failure"] as const)("attributes automatic %s to the stable system actor", async (kind) => {
		const requester = request();
		const evaluation = new PermissionEngine().evaluate(requester.requests, requester.snapshot);
		const controller = new AbortController();
		if (kind === "pre-abort") controller.abort("test");
		const approval = coordinator({
			request: async () => {
				throw new Error("approval channel unavailable");
			},
		});
		const result = await approval.authorize(requester, evaluation, () => ({
			argumentsDigest: requester.argumentsDigest,
			cwd: requester.cwd,
			policyDigest: requester.snapshot.policyDigest,
		}), kind === "pre-abort" ? controller.signal : undefined);

		expect(result).toMatchObject({
			ok: true,
			value: {
				outcome: "deny",
				approval: {
					decision: kind === "pre-abort" ? "cancelled" : "channel_failed",
					decidedBy: SYSTEM_APPROVAL_PRINCIPAL_ID,
				},
			},
		});
	});

	it("attributes an approval timeout to the stable system actor", async () => {
		const requester = request();
		const evaluation = new PermissionEngine().evaluate(requester.requests, requester.snapshot);
		const approval = coordinator({
			request: async () => new Promise(() => undefined),
		}, { timeoutMs: 1 });
		const result = await approval.authorize(requester, evaluation, () => ({
			argumentsDigest: requester.argumentsDigest,
			cwd: requester.cwd,
			policyDigest: requester.snapshot.policyDigest,
		}));

		expect(result).toMatchObject({
			ok: true,
			value: {
				outcome: "deny",
				approval: { decision: "cancelled", decidedBy: SYSTEM_APPROVAL_PRINCIPAL_ID },
			},
		});
	});

	it("headless prompting fails closed", async () => {
		const requester = request();
		const evaluation = new PermissionEngine().evaluate(requester.requests, requester.snapshot);
		const approval = coordinator(new HeadlessDenyPrompter());
		const result = await approval.authorize(requester, evaluation, () => ({ argumentsDigest: requester.argumentsDigest, cwd: requester.cwd, policyDigest: requester.snapshot.policyDigest }));
		expect(result).toMatchObject({
			ok: true,
			value: { outcome: "deny", approval: { decision: "denied", decidedBy: SYSTEM_APPROVAL_PRINCIPAL_ID } },
		});
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
