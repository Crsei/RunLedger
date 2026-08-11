import { describe, expect, it } from "vitest";
import { createRuntimeId, runtimeDigest } from "../../src/runtime/contracts/public.ts";
import { ApprovalCoordinator, MemoryApprovalStateStore } from "../../src/security/permission/approval-coordinator.ts";
import { PermissionEngine } from "../../src/security/permission/engine.ts";
import type { AuthorizationRequest, PermissionPrompter, SecuritySnapshot } from "../../src/security/types.ts";

function request(suffix: string, command: string): AuthorizationRequest {
	const sessionId = createRuntimeId("session", "prefix-rule");
	const toolCallId = createRuntimeId("toolCall", `prefix-rule-${suffix}`);
	const snapshot: SecuritySnapshot = {
		profile: { name: "workspace-write", approvalPolicy: "on-request", filesystemMode: "workspace-write", network: { mode: "deny", allowedHosts: [] }, sandbox: "workspace-write" },
		filesystem: { readRoots: ["/repo"], writeRoots: ["/repo"], denyRead: [], denyWrite: [], protectedPaths: [] },
		rules: [], sources: ["builtin"], workspaceRoot: "/repo", tempRoot: "/tmp/runledger",
		policyDigest: runtimeDigest("prefix-policy"), createdAt: "2026-08-11T00:00:00.000Z",
	};
	return {
		requestId: createRuntimeId("command", `prefix-rule-${suffix}`), sessionId,
		turnId: createRuntimeId("turn", `prefix-rule-${suffix}`), toolCallId, toolName: "bash",
		argumentsDigest: runtimeDigest({ command }), cwd: "/repo",
		requests: [{ kind: "shell", command, cwd: "/repo", analysis: "unknown" }],
		workspace: {
			authorityId: createRuntimeId("authority", "prefix-rule"), tenantId: createRuntimeId("tenant", "prefix-rule"),
			principalId: createRuntimeId("principal", "requester"), sessionId,
			workspaceId: createRuntimeId("workspace", "prefix-rule"), repositoryId: createRuntimeId("repository", "prefix-rule"),
			worktreePath: "/repo", worktreePathDigest: runtimeDigest("/repo"), branch: "runledger/test", baseCommit: "a".repeat(40),
			agentId: createRuntimeId("agent", "prefix-rule"), toolCallId, traceId: createRuntimeId("trace", `prefix-rule-${suffix}`),
			cwd: "/repo", cwdDigest: runtimeDigest("/repo"), ownerRuntimeId: createRuntimeId("runtime", "prefix-rule"),
			leaseRevision: 1, fencingTokenDigest: runtimeDigest("prefix-fence"),
		},
		snapshot,
	};
}

function evaluation(value: AuthorizationRequest) {
	return new PermissionEngine().evaluate(value.requests, value.snapshot);
}

function revalidate(value: AuthorizationRequest) {
	return { argumentsDigest: value.argumentsDigest, cwd: value.cwd, policyDigest: value.snapshot.policyDigest };
}

describe("exec prefix approval amendments", () => {
	it("atomically installs a safe token prefix and reuses it for a matching command", async () => {
		const store = new MemoryApprovalStateStore();
		let prompts = 0;
		const prompter: PermissionPrompter = { request: async () => {
			prompts += 1;
			return { decision: "allow-with-prefix-rule", prefixRule: ["npm", "run", "test"], decidedBy: createRuntimeId("principal", "approver") };
		} };
		const first = request("first", "npm run test -- security");
		const matching = request("matching", "npm run test -- unit");
		const coordinator = new ApprovalCoordinator({ prompter, store });
		const approved = await coordinator.authorize(first, evaluation(first), () => revalidate(first));
		const replayed = await coordinator.authorize(matching, evaluation(matching), () => revalidate(matching));

		expect(prompts).toBe(1);
		expect(approved).toMatchObject({ ok: true, value: { outcome: "allow" } });
		expect(replayed).toMatchObject({ ok: true, value: { outcome: "allow" } });
	});

	it.each([
		["heredoc", "node <<EOF\ncode\nEOF", ["node"]],
		["redirection", "printf ok > out", ["printf"]],
		["environment prefix", "CI=1 npm test", ["npm", "test"]],
		["dangerous command", "rm file", ["rm"]],
	])("rejects %s prefix amendments", async (_name, command, prefixRule) => {
		const value = request(`unsafe-${_name}`, command);
		const coordinator = new ApprovalCoordinator({
			prompter: { request: async () => ({ decision: "allow-with-prefix-rule", prefixRule, decidedBy: createRuntimeId("principal", "approver") }) },
			store: new MemoryApprovalStateStore(),
		});
		const result = await coordinator.authorize(value, evaluation(value), () => revalidate(value));
		expect(result).toMatchObject({ ok: true, value: { outcome: "deny" } });
	});
});
