import { describe, expect, it } from "vitest";
import { createRuntimeId } from "../../src/runtime/protocol/ids.ts";
import { runtimeDigest, type RuntimeDigest } from "../../src/runtime/protocol/foundation.ts";
import type { WorkspaceExecutionEnvelope } from "../../src/runtime/contracts/public.ts";
import { LinuxBwrapBackend } from "../../src/security/sandbox/linux-bwrap.ts";
import { classifySandboxDenial, isSandboxDenial, sandboxDenialReason } from "../../src/security/sandbox/denial.ts";
import type { SandboxPrepareRequest } from "../../src/security/sandbox/types.ts";

function digest(value: string): RuntimeDigest {
	return runtimeDigest(value);
}

function request(): SandboxPrepareRequest {
	const workspace: WorkspaceExecutionEnvelope = {
		authorityId: createRuntimeId("authority", "sandbox-denial"),
		tenantId: createRuntimeId("tenant", "sandbox-denial"),
		principalId: createRuntimeId("principal", "sandbox-denial"),
		sessionId: createRuntimeId("session", "sandbox-denial"),
		workspaceId: createRuntimeId("workspace", "sandbox-denial"),
		repositoryId: createRuntimeId("repository", "sandbox-denial"),
		worktreePath: "/repo",
			worktreePathDigest: runtimeDigest("/repo"),
		branch: "test",
		baseCommit: "d".repeat(40),
		agentId: createRuntimeId("agent", "sandbox-denial"),
		toolCallId: createRuntimeId("toolCall", "sandbox-denial"),
		traceId: createRuntimeId("trace", "sandbox-denial"),
		cwd: "/repo",
			cwdDigest: runtimeDigest("/repo"),
		ownerRuntimeId: createRuntimeId("runtime", "sandbox-denial"),
		leaseRevision: 1,
		fencingTokenDigest: digest("denial-fence"),
	};
	return {
		requested: "workspace-write",
		policyDigest: digest("denial-policy"),
		requestDigest: digest("denial-request"),
		workspace,
		readRoots: ["/repo"],
		writeRoots: ["/repo"],
		denyRead: [],
		denyWrite: [],
		protectedPaths: ["/repo/.git"],
		network: "deny",
		command: "true",
		cwd: "/repo",
			cwdDigest: runtimeDigest("/repo"),
		environment: {},
		timeoutMs: 1_000,
	};
}

describe("sandbox denial and final-leaf validation", () => {
	it("classifies bounded platform denial text structurally", () => {
		expect(isSandboxDenial("bwrap: Permission denied while opening file", 1)).toBe(true);
		expect(sandboxDenialReason("network socket operation not permitted")).toBe("network");
		expect(classifySandboxDenial("sandbox-exec: deny file-read", 1)).toMatchObject({ code: "sandbox_denied", kind: "filesystem" });
		expect(isSandboxDenial("ordinary stderr", 1)).toBe(false);
	});

	it("binds a valid final leaf receipt to the request and rejects a changed plan", async () => {
		const backend = new LinuxBwrapBackend({ which: async () => "/opt/bwrap" });
		const prepared = await backend.prepare(request());
		expect(prepared.ok).toBe(true);
		if (!prepared.ok) return;

		const valid = await backend.validateFinalLeaf(prepared.value, digest("denial-request"));
		expect(valid).toMatchObject({
			decision: "allow",
			effective: "workspace-write",
			enforcement: "enforced",
			requestDigest: digest("denial-request"),
		});

		const tampered = { ...prepared.value, command: "outside mutation" };
		const rejected = await backend.validateFinalLeaf(tampered, digest("denial-request"));
		expect(rejected).toMatchObject({ decision: "deny", error: { code: "plan_tampered" } });

		const stale = await backend.validateFinalLeaf(prepared.value, digest("different-request"));
		expect(stale).toMatchObject({ decision: "deny", error: { code: "request_digest_mismatch" } });
	});
});
