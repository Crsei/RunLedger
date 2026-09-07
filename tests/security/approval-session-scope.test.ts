import { describe, expect, it } from "vitest";
import { createRuntimeId, runtimeDigest } from "../../src/runtime/contracts/public.ts";
import {
	ApprovalCoordinator,
	MemoryApprovalStateStore,
} from "../../src/security/permission/approval-coordinator.ts";
import { PermissionEngine } from "../../src/security/permission/engine.ts";
import { builtinSecurityProfile } from "../../src/security/config/presets.ts";
import type { AuthorizationRequest, PermissionPrompter, SecuritySnapshot } from "../../src/security/types.ts";

const NOW = new Date("2026-08-11T00:00:00.000Z");

function snapshot(): SecuritySnapshot {
	return {
		profile: { name: "workspace-write", approvalPolicy: "on-request", filesystemMode: "workspace-write", network: { mode: "deny", allowedHosts: [] }, sandbox: "workspace-write" },
		filesystem: { readRoots: ["/repo"], writeRoots: ["/repo"], denyRead: [], denyWrite: [], protectedPaths: ["/repo/.git", "/repo/.runledger"] },
		rules: [],
		sources: ["builtin"],
		workspaceRoot: "/repo",
		tempRoot: "/tmp/runledger",
		policyDigest: runtimeDigest("session-approval-policy"),
		createdAt: NOW.toISOString(),
	};
}

function request(suffix: string, command = "printf ok"): AuthorizationRequest {
	const sessionId = createRuntimeId("session", "approval-session");
	const toolCallId = createRuntimeId("toolCall", `approval-session-${suffix}`);
	const workspace = {
		authorityId: createRuntimeId("authority", "approval-session"),
		tenantId: createRuntimeId("tenant", "approval-session"),
		principalId: createRuntimeId("principal", "requester"),
		sessionId,
		workspaceId: createRuntimeId("workspace", "approval-session"),
		repositoryId: createRuntimeId("repository", "approval-session"),
		worktreePath: "/repo",
		worktreePathDigest: runtimeDigest("/repo"),
		branch: "runledger/test",
		baseCommit: "a".repeat(40),
		agentId: createRuntimeId("agent", "approval-session"),
		toolCallId,
		traceId: createRuntimeId("trace", `approval-session-${suffix}`),
		cwd: "/repo",
		cwdDigest: runtimeDigest("/repo"),
		ownerRuntimeId: createRuntimeId("runtime", "approval-session"),
		leaseRevision: 1,
		fencingTokenDigest: runtimeDigest("approval-session-fence"),
	};
	return {
		requestId: createRuntimeId("command", `approval-session-${suffix}`),
		sessionId,
		turnId: createRuntimeId("turn", `approval-session-${suffix}`),
		toolCallId,
		toolName: "bash",
		argumentsDigest: runtimeDigest({ command }),
		cwd: "/repo",
		requests: [{ kind: "shell", command, cwd: "/repo", analysis: "unknown" }],
		workspace,
		snapshot: snapshot(),
	};
}

function evaluation(value: AuthorizationRequest) {
	return new PermissionEngine().evaluate(value.requests, value.snapshot);
}

function revalidate(value: AuthorizationRequest) {
	return { argumentsDigest: value.argumentsDigest, cwd: value.cwd, policyDigest: value.snapshot.policyDigest };
}

describe("session-scoped approvals", () => {
	it("never delegates a circuit-breaker confirmation to the automatic reviewer", async () => {
		const base = request("circuit-auto", "reboot");
		const value = { ...base, snapshot: { ...base.snapshot, approvalReviewer: "auto-review" as const } };
		const evaluated = evaluation(value);
		let reviews = 0;
		let prompts = 0;
		const result = await new ApprovalCoordinator({
			clock: () => NOW,
			autoReviewer: { review: async () => { reviews += 1; return { decision: "allow-once", classificationVersion: "test", reason: "test" }; } },
			prompter: { request: async () => { prompts += 1; return { decision: "deny", decidedBy: createRuntimeId("principal", "approver") }; } },
		}).authorize(value, evaluated, () => revalidate(value), undefined, {
			request: value, evaluation: evaluated, canonicalTarget: "/repo", sessionGeneration: 1, inputDigest: runtimeDigest("auto-input"),
		});
		expect(result).toMatchObject({ ok: true, value: { outcome: "deny" } });
		expect(reviews).toBe(0);
		expect(prompts).toBe(1);
	});
	it("requires a new exact confirmation for each circuit-breaker command under Full Access", async () => {
		const first = request("circuit-first", "reboot");
		const policy = { ...first.snapshot, profile: builtinSecurityProfile("danger-full-access")! };
		const value = { ...first, snapshot: policy };
		let prompts = 0;
		const coordinator = new ApprovalCoordinator({
			clock: () => NOW,
			prompter: { request: async (prompt) => {
				prompts += 1;
				expect(prompt.requiresExplicitConfirmation).toBe(true);
				expect(prompt.summary).toContain("system_shutdown");
				return { decision: "allow-once", decidedBy: createRuntimeId("principal", "approver") };
			} },
		});
		const result = await coordinator.authorize(value, evaluation(value), () => revalidate(value));
		expect(result).toMatchObject({ ok: true, value: { outcome: "allow", approval: { scope: "once" } } });
		if (!result.ok || result.value.approval === undefined) throw new Error("expected exact receipt");
		expect((await coordinator.consumeAllowOnce(value, result.value.approval)).ok).toBe(true);
		const second = { ...request("circuit-second", "reboot"), snapshot: policy };
		await coordinator.authorize(second, evaluation(second), () => revalidate(second));
		expect(prompts).toBe(2);
	});

	it.each(["allow-session", "allow-with-prefix-rule"] as const)("rejects %s instead of silently accepting a persistent circuit approval", async (decision) => {
		const value = request("circuit-persistent", "reboot");
		const result = await new ApprovalCoordinator({
			clock: () => NOW,
			prompter: { request: async () => ({ decision, prefixRule: ["reboot"], decidedBy: createRuntimeId("principal", "approver") }) },
		}).authorize(value, evaluation(value), () => revalidate(value));
		expect(result).toMatchObject({ ok: true, value: { outcome: "deny" } });
	});

	it("rejects a circuit confirmation after the policy binding changes", async () => {
		const value = request("circuit-stale", "reboot");
		const result = await new ApprovalCoordinator({
			clock: () => NOW,
			prompter: { request: async () => ({ decision: "allow-once", decidedBy: createRuntimeId("principal", "approver") }) },
		}).authorize(value, evaluation(value), () => ({ ...revalidate(value), policyDigest: runtimeDigest("changed-policy") }));
		expect(result).toMatchObject({ ok: true, value: { outcome: "deny" } });
	});
	it("replays the exact normalized request across request and tool-call ids after coordinator restart", async () => {
		const store = new MemoryApprovalStateStore();
		let prompts = 0;
		const prompter: PermissionPrompter = {
			request: async () => {
				prompts += 1;
				return { decision: "allow-session", decidedBy: createRuntimeId("principal", "approver") };
			},
		};
		const firstRequest = request("first");
		const first = await new ApprovalCoordinator({ prompter, store, clock: () => NOW })
			.authorize(firstRequest, evaluation(firstRequest), () => revalidate(firstRequest));
		const secondRequest = request("second");
		const second = await new ApprovalCoordinator({
			prompter: { request: async () => { throw new Error("exact session approval must replay"); } },
			store,
			clock: () => NOW,
		}).authorize(secondRequest, evaluation(secondRequest), () => revalidate(secondRequest));

		expect(prompts).toBe(1);
		expect(first).toMatchObject({ ok: true, value: { outcome: "allow", approval: { scope: "session" } } });
		expect(second).toMatchObject({ ok: true, value: { outcome: "allow", approval: { scope: "session" } } });
	});

	it("does not prefix-match session approvals", async () => {
		const store = new MemoryApprovalStateStore();
		let prompts = 0;
		const prompter: PermissionPrompter = {
			request: async () => {
				prompts += 1;
				return { decision: "allow-session", decidedBy: createRuntimeId("principal", "approver") };
			},
		};
		const first = request("exact", "printf ok");
		const prefixed = request("different", "printf ok extra");
		const coordinator = new ApprovalCoordinator({ prompter, store, clock: () => NOW });
		await coordinator.authorize(first, evaluation(first), () => revalidate(first));
		await coordinator.authorize(prefixed, evaluation(prefixed), () => revalidate(prefixed));
		expect(prompts).toBe(2);
	});

	it("revalidates an exact session approval before replay", async () => {
		const store = new MemoryApprovalStateStore();
		const first = request("revalidate-first");
		await new ApprovalCoordinator({
			prompter: { request: async () => ({ decision: "allow-session", decidedBy: createRuntimeId("principal", "approver") }) },
			store,
			clock: () => NOW,
		}).authorize(first, evaluation(first), () => revalidate(first));
		const replay = request("revalidate-second");
		const result = await new ApprovalCoordinator({
			prompter: { request: async () => { throw new Error("durable approval should be found before prompting"); } },
			store,
			clock: () => NOW,
		}).authorize(replay, evaluation(replay), () => ({
			argumentsDigest: runtimeDigest("changed-at-revalidation"),
			cwd: replay.cwd,
			policyDigest: replay.snapshot.policyDigest,
		}));
		expect(result).toMatchObject({ ok: false, error: { code: "approval_stale" } });
	});

	it("downgrades dangerous commands to allow-once instead of caching them for the session", async () => {
		const store = new MemoryApprovalStateStore();
		let prompts = 0;
		const prompter: PermissionPrompter = {
			request: async () => {
				prompts += 1;
				return { decision: "allow-session", decidedBy: createRuntimeId("principal", "approver") };
			},
		};
		const first = request("danger-first", "rm file");
		const second = request("danger-second", "rm file");
		const coordinator = new ApprovalCoordinator({ prompter, store, clock: () => NOW });
		const firstResult = await coordinator.authorize(first, evaluation(first), () => revalidate(first));
		await coordinator.authorize(second, evaluation(second), () => revalidate(second));
		expect(prompts).toBe(2);
		expect(firstResult).toMatchObject({ ok: true, value: { approval: { scope: "once" } } });
	});
});
