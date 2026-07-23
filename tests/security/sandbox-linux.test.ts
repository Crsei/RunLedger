import { describe, expect, it } from "vitest";
import { createRuntimeId } from "../../src/runtime/protocol/v3/ids.ts";
import type { WorkspaceExecutionEnvelope } from "../../src/runtime/protocol/v3/workspace.ts";
import { LinuxBwrapBackend } from "../../src/security/sandbox/linux-bwrap.ts";
import type { SandboxPrepareRequest, SandboxProcessPort } from "../../src/security/sandbox/types.ts";

function envelope(): WorkspaceExecutionEnvelope {
	return {
		authorityId: createRuntimeId("authority", "sandbox"), tenantId: createRuntimeId("tenant", "sandbox"),
		principalId: createRuntimeId("principal", "sandbox"), sessionId: createRuntimeId("session", "sandbox"),
		workspaceId: createRuntimeId("workspace", "sandbox"), repositoryId: createRuntimeId("repository", "sandbox"),
		worktreePath: "/repo", branch: "runledger/test", baseCommit: "a".repeat(40), agentId: createRuntimeId("agent", "sandbox"),
		toolCallId: createRuntimeId("toolCall", "sandbox"), traceId: createRuntimeId("trace", "sandbox"), cwd: "/repo",
		ownerRuntimeId: createRuntimeId("runtime", "sandbox"), leaseRevision: 1, fencingToken: "sandbox-fence",
	};
}

function request(): SandboxPrepareRequest {
	return {
		requested: "workspace-write", policyDigest: "b".repeat(64), envelope: envelope(),
		readRoots: ["/repo"], writeRoots: ["/repo", "/tmp/session"], denyRead: ["/secret"],
		denyWrite: ["/repo/readonly"], protectedPaths: ["/repo/.git", "/repo/.runledger"],
		network: "deny", command: "git status", cwd: "/repo", environment: { PATH: "/bin" }, timeoutMs: 1_000,
	};
}

const processPort: SandboxProcessPort = {
	spawn: async () => ({ ok: true, value: { stdout: "", stderr: "", exitCode: 0, signaled: false, denied: false } }),
};

describe("LinuxBwrapBackend", () => {
	it("fails closed when bubblewrap is unavailable", async () => {
		const backend = new LinuxBwrapBackend({ which: async () => undefined }, processPort);
		expect(await backend.prepare(request())).toMatchObject({ ok: false, error: { code: "sandbox_unavailable" } });
	});

	it("does not advertise enforcement when the bounded bubblewrap self-test fails", async () => {
		const backend = new LinuxBwrapBackend(
			{ which: async () => "/usr/bin/bwrap" },
			{ spawn: async () => ({ ok: true, value: { stdout: "", stderr: "denied", exitCode: 1, signaled: false, denied: true } }) },
		);
		expect(await backend.probe()).toMatchObject({ status: "unavailable", supportsFilesystemIsolation: false });
		expect(await backend.prepare(request())).toMatchObject({ ok: false, error: { code: "sandbox_unavailable" } });
	});

	it("builds a network-isolated launch plan and remounts protected paths read-only", async () => {
		const backend = new LinuxBwrapBackend({ which: async () => "/usr/bin/bwrap" }, processPort);
		const result = await backend.prepare(request());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value).toMatchObject({ program: "/usr/bin/bwrap", effectiveEnforcement: "enforced" });
		expect(result.value.arguments).toContain("--unshare-net");
		const joined = result.value.arguments.join(" ");
		expect(joined).toContain("--ro-bind /repo/.git /repo/.git");
		expect(joined).toContain("--tmpfs /secret");
		expect(result.value.arguments.slice(-3)).toEqual(["/bin/sh", "-lc", "git status"]);
		expect(result.value.arguments).not.toContain("--");
	});

	it("only permits raw shell for an explicit off profile", async () => {
		const backend = new LinuxBwrapBackend({ which: async () => undefined }, processPort);
		const result = await backend.prepare({ ...request(), requested: "off" });
		expect(result).toMatchObject({ ok: true, value: { backendId: "linux-off", effectiveEnforcement: "off", arguments: ["-lc", "git status"] } });
	});
});
