import { describe, expect, it } from "vitest";
import { createRuntimeId, runtimeDigest, type ApprovalReceiptRef, type ApprovalTicket } from "../../src/runtime/contracts/public.ts";
import { HostSecurityAuditAdapter } from "../../src/security/integration/runtime-security-events.ts";
import type { AuthorizationRequest } from "../../src/security/types.ts";

function request(): AuthorizationRequest {
	const root = "/repo";
	const workspace = {
		authorityId: createRuntimeId("authority", "security-events"),
		tenantId: createRuntimeId("tenant", "security-events"),
		principalId: createRuntimeId("principal", "requester"),
		sessionId: createRuntimeId("session", "security-events"),
		workspaceId: createRuntimeId("workspace", "security-events"),
		repositoryId: createRuntimeId("repository", "security-events"),
		worktreePath: root,
		branch: "runledger/test",
		baseCommit: "a".repeat(40),
		agentId: createRuntimeId("agent", "security-events"),
		toolCallId: createRuntimeId("toolCall", "security-events"),
		traceId: createRuntimeId("trace", "security-events"),
		cwd: root,
		ownerRuntimeId: createRuntimeId("runtime", "security-events"),
		leaseRevision: 1,
		fencingTokenDigest: runtimeDigest("security-events"),
	};
	const body = {
		profile: { name: "workspace-write" as const, approvalPolicy: "on-request" as const, filesystemMode: "workspace-write" as const, network: { mode: "deny" as const, allowedHosts: [] }, sandbox: "workspace-write" as const },
		filesystem: { readRoots: [root], writeRoots: [root], denyRead: [], denyWrite: [], protectedPaths: [] },
		rules: [], sources: ["builtin" as const], workspaceRoot: root, tempRoot: "/tmp/runledger", createdAt: "2026-08-05T00:00:00.000Z",
	};
	return {
		requestId: createRuntimeId("command", "security-events"), sessionId: workspace.sessionId, turnId: createRuntimeId("turn", "security-events"), toolCallId: workspace.toolCallId,
		toolName: "write", argumentsDigest: runtimeDigest({ path: "file" }), cwd: root,
		requests: [{ kind: "filesystem", operation: "write", path: "file" }], workspace, snapshot: { ...body, policyDigest: runtimeDigest(body) },
	};
}

function ticket(value: AuthorizationRequest): ApprovalTicket {
	return {
		approvalId: createRuntimeId("approval", "security-events"),
		requestDigest: runtimeDigest("approval-request"),
		scope: "once",
		status: "pending",
		principalId: value.workspace.principalId,
		createdAt: "2026-08-05T00:00:00.000Z",
		expiresAt: "2026-08-05T00:01:00.000Z",
	};
}

function receipt(value: ApprovalTicket): ApprovalReceiptRef {
	const body = {
		approvalId: value.approvalId,
		requestDigest: value.requestDigest,
		scope: value.scope,
		decision: "allowed" as const,
		decisionRevision: 1,
		principalId: createRuntimeId("principal", "approver"),
		decidedAt: "2026-08-05T00:00:01.000Z",
		expiresAt: value.expiresAt!,
	};
	return { ...body, receiptId: createRuntimeId("receipt", "security-events"), receiptDigest: runtimeDigest(body) };
}

describe("HostSecurityAuditAdapter", () => {
	it("projects approval lifecycle through the canonical Runtime event writer", async () => {
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const adapter = new HostSecurityAuditAdapter({
			authorityId: createRuntimeId("authority", "security-events"),
			tenantId: createRuntimeId("tenant", "security-events"),
			writer: { append: async (input) => { events.push({ type: input.type, payload: input.payload as Record<string, unknown> }); return {} as never; } },
		});
		const value = request();
		const pending = ticket(value);
		await adapter.requested({ request: value, ticket: pending });
		await adapter.decided({ request: value, ticket: pending, receipt: receipt(pending) });

		expect(events.map((event) => event.type)).toEqual(["permission.requested", "permission.decided"]);
		expect(events[0]?.payload).toMatchObject({ effect: "none", transition: { nextStatus: "pending" } });
		expect(events[1]?.payload).toMatchObject({ effect: "committed", transition: { nextStatus: "allowed" }, expectedRevision: 0 });
	});
});
