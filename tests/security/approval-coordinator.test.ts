import { describe, expect, it } from "vitest";
import {
	isApprovalReceiptRef,
	runtimeDigest,
	createRuntimeId,
} from "../../src/runtime/contracts/public.ts";
import {
	ApprovalCoordinator,
	type ApprovalAuditPort,
	HeadlessDenyPrompter,
	MemoryApprovalStateStore,
	SYSTEM_APPROVAL_PRINCIPAL_ID,
} from "../../src/security/permission/approval-coordinator.ts";
import { PermissionEngine } from "../../src/security/permission/engine.ts";
import type {
	AuthorizationRequest,
	PermissionPrompter,
	SecuritySnapshot,
} from "../../src/security/types.ts";

const NOW = new Date("2026-08-04T00:00:00.000Z");

function snapshot(): SecuritySnapshot {
	return {
		profile: {
			name: "workspace-write",
			approvalPolicy: "on-request",
			filesystemMode: "workspace-write",
			network: { mode: "deny", allowedHosts: [] },
			sandbox: "workspace-write",
		},
		filesystem: {
			readRoots: ["/repo"],
			writeRoots: ["/repo"],
			denyRead: [],
			denyWrite: [],
			protectedPaths: ["/repo/.git", "/repo/.runledger"],
		},
		rules: [],
		sources: ["builtin"],
		workspaceRoot: "/repo",
		tempRoot: "/tmp/runledger",
		policyDigest: runtimeDigest({ policy: "approval-test" }),
		createdAt: NOW.toISOString(),
	};
}

function request(): AuthorizationRequest {
	const workspace = {
		authorityId: createRuntimeId("authority", "approval-test"),
		tenantId: createRuntimeId("tenant", "approval-test"),
		principalId: createRuntimeId("principal", "requester"),
		sessionId: createRuntimeId("session", "approval-test"),
		workspaceId: createRuntimeId("workspace", "approval-test"),
		repositoryId: createRuntimeId("repository", "approval-test"),
		worktreePath: "/repo",
		branch: "runledger/test",
		baseCommit: "a".repeat(40),
		agentId: createRuntimeId("agent", "approval-test"),
		toolCallId: createRuntimeId("toolCall", "approval-test"),
		traceId: createRuntimeId("trace", "approval-test"),
		cwd: "/repo",
		ownerRuntimeId: createRuntimeId("runtime", "approval-test"),
		leaseRevision: 1,
		fencingTokenDigest: runtimeDigest("approval-fence"),
	};
	return {
		requestId: createRuntimeId("command", "approval-test"),
		sessionId: workspace.sessionId,
		turnId: createRuntimeId("turn", "approval-test"),
		toolCallId: workspace.toolCallId,
		toolName: "write",
		argumentsDigest: runtimeDigest({ path: "file.ts", contentDigest: "x" }),
		cwd: workspace.cwd,
		requests: [{ kind: "filesystem", operation: "write", path: "file.ts" }],
		workspace,
		snapshot: snapshot(),
	};
}

function evaluation(value: AuthorizationRequest) {
	return new PermissionEngine().evaluate(value.requests, value.snapshot);
}

function validRevalidation(value: AuthorizationRequest) {
	return {
		argumentsDigest: value.argumentsDigest,
		cwd: value.cwd,
		policyDigest: value.snapshot.policyDigest,
	};
}

describe("ApprovalCoordinator", () => {
	it("durably revokes an allow-once receipt after the authorized effect completes", async () => {
		const events: string[] = [];
		const value = request();
		const store = new MemoryApprovalStateStore();
		const coordinator = new ApprovalCoordinator({
			prompter: { request: async () => ({ decision: "allow-once", decidedBy: createRuntimeId("principal", "approver") }) },
			store,
			audit: {
				requested: async () => { events.push("requested"); },
				decided: async () => { events.push("decided"); },
				revoked: async () => { events.push("revoked"); },
			},
			clock: () => NOW,
		});
		const authorized = await coordinator.authorize(value, evaluation(value), () => validRevalidation(value));
		expect(authorized).toMatchObject({ ok: true, value: { approval: { decision: "allowed", decisionRevision: 1 } } });
		if (!authorized.ok || authorized.value.approval === undefined) return;
		const candidate = coordinator as ApprovalCoordinator & {
			consumeAllowOnce?: (request: AuthorizationRequest, receipt: typeof authorized.value.approval) => Promise<unknown>;
		};
		expect(candidate.consumeAllowOnce).toBeTypeOf("function");
		const consumed = await candidate.consumeAllowOnce!(value, authorized.value.approval);

		expect(consumed).toMatchObject({ ok: true, value: { decision: "revoked", decisionRevision: 2 } });
		expect(await store.read(authorized.value.approval.approvalId)).toMatchObject({ decision: "revoked", decisionRevision: 2 });
		expect(events).toEqual(["requested", "decided", "revoked"]);
	});

	it("coalesces duplicate prompts and returns a Runtime approval receipt", async () => {
		let calls = 0;
		const value = request();
		const coordinator = new ApprovalCoordinator({
			prompter: { request: async () => {
				calls += 1;
				return { decision: "allow-once", decidedBy: createRuntimeId("principal", "approver") };
			} },
			clock: () => NOW,
			timeoutMs: 1_000,
		});
		const [first, second] = await Promise.all([
			coordinator.authorize(value, evaluation(value), () => validRevalidation(value)),
			coordinator.authorize(value, evaluation(value), () => validRevalidation(value)),
		]);

		expect(calls).toBe(1);
		expect(first).toEqual(second);
		expect(first).toMatchObject({ ok: true, value: { outcome: "allow", approval: { decision: "allowed", principalId: "principal_approver" } } });
		if (!first.ok || !first.value.approval) return;
		expect(isApprovalReceiptRef(first.value.approval)).toBe(true);
	});

	it("requires the Host audit port for requested and decided lifecycle records", async () => {
		const events: string[] = [];
		const audit: ApprovalAuditPort = {
			requested: async () => { events.push("requested"); },
			decided: async () => { events.push("decided"); },
			revoked: async () => { events.push("revoked"); },
		};
		const value = request();
		const coordinator = new ApprovalCoordinator({
			prompter: { request: async () => ({ decision: "allow-once", decidedBy: createRuntimeId("principal", "approver") }) },
			audit,
			clock: () => NOW,
		});
		const result = await coordinator.authorize(value, evaluation(value), () => validRevalidation(value));

		expect(result).toMatchObject({ ok: true, value: { outcome: "allow" } });
		expect(events).toEqual(["requested", "decided"]);
	});

	it("fails closed for deny and cancel responses", async () => {
		const value = request();
		const denied = new ApprovalCoordinator({
			prompter: { request: async () => ({ decision: "deny", decidedBy: createRuntimeId("principal", "approver"), reason: "no" }) },
			clock: () => NOW,
		});
		expect(await denied.authorize(value, evaluation(value), () => validRevalidation(value))).toMatchObject({
			ok: true,
			value: { outcome: "deny", approval: { decision: "denied" } },
		});

		const cancelled = new ApprovalCoordinator({
			prompter: { request: async () => ({ decision: "cancel", decidedBy: createRuntimeId("principal", "approver") }) },
			clock: () => NOW,
		});
		expect(await cancelled.authorize(value, evaluation(value), () => validRevalidation(value))).toMatchObject({
			ok: true,
			value: { outcome: "deny", approval: { decision: "cancelled" } },
		});
	});

	it("turns an aborted prompt into a system cancellation", async () => {
		const value = request();
		const controller = new AbortController();
		controller.abort("interrupt");
		const pending: PermissionPrompter = { request: async () => new Promise(() => undefined) };
		const coordinator = new ApprovalCoordinator({ prompter: pending, clock: () => NOW, timeoutMs: 1_000 });
		const result = await coordinator.authorize(value, evaluation(value), () => validRevalidation(value), controller.signal);
		expect(result).toMatchObject({
			ok: true,
			value: { outcome: "deny", approval: { decision: "cancelled", principalId: SYSTEM_APPROVAL_PRINCIPAL_ID } },
		});
	});

	it("expires a prompt that exceeds its timeout", async () => {
		const value = request();
		const pending: PermissionPrompter = { request: async () => new Promise(() => undefined) };
		const coordinator = new ApprovalCoordinator({ prompter: pending, clock: () => NOW, timeoutMs: 1 });
		const result = await coordinator.authorize(value, evaluation(value), () => validRevalidation(value));
		expect(result).toMatchObject({
			ok: true,
			value: { outcome: "deny", approval: { decision: "expired", principalId: SYSTEM_APPROVAL_PRINCIPAL_ID } },
		});
	});

	it("invalidates allow-once when the execution binding changes", async () => {
		const value = request();
		const coordinator = new ApprovalCoordinator({
			prompter: { request: async () => ({ decision: "allow-once", decidedBy: createRuntimeId("principal", "approver") }) },
			clock: () => NOW,
		});
		const result = await coordinator.authorize(value, evaluation(value), () => ({
			argumentsDigest: runtimeDigest({ changed: true }),
			cwd: value.cwd,
			policyDigest: value.snapshot.policyDigest,
		}));
		expect(result).toMatchObject({ ok: true, value: { outcome: "deny", approval: { decision: "cancelled" } } });
	});

	it("headless approval denies without waiting for a channel", async () => {
		const value = request();
		const coordinator = new ApprovalCoordinator({ prompter: new HeadlessDenyPrompter(), clock: () => NOW });
		const result = await coordinator.authorize(value, evaluation(value), () => validRevalidation(value));
		expect(result).toMatchObject({ ok: true, value: { outcome: "deny", approval: { decision: "denied", principalId: SYSTEM_APPROVAL_PRINCIPAL_ID } } });
	});

	it("replays a durable allow receipt after the original command response is lost", async () => {
		const value = request();
		const store = new MemoryApprovalStateStore();
		let prompts = 0;
		const prompter: PermissionPrompter = {
			request: async () => {
				prompts += 1;
				return { decision: "allow-once", decidedBy: createRuntimeId("principal", "approver") };
			},
		};
		const first = new ApprovalCoordinator({ prompter, store, clock: () => NOW });
		const firstResult = await first.authorize(value, evaluation(value), () => validRevalidation(value));
		const recovered = new ApprovalCoordinator({
			prompter: { request: async () => { throw new Error("recovery must not prompt again"); } },
			store,
			clock: () => NOW,
		});
		const recoveredResult = await recovered.authorize(value, evaluation(value), () => validRevalidation(value));

		expect(prompts).toBe(1);
		expect(recoveredResult).toEqual(firstResult);
	});
});
