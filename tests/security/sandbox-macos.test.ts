import { describe, expect, it } from "vitest";
import { MacOsSeatbeltBackend } from "../../src/security/sandbox/macos-seatbelt.ts";
import type { SandboxPrepareRequest, SandboxProcessPort } from "../../src/security/sandbox/types.ts";
import { createRuntimeId } from "../../src/runtime/protocol/v3/ids.ts";

const processPort: SandboxProcessPort = {
	spawn: async () => ({ ok: true, value: { stdout: "", stderr: "", exitCode: 0, signaled: false, denied: false } }),
};

function request(): SandboxPrepareRequest {
	return {
		requested: "strict", policyDigest: "c".repeat(64),
		envelope: {
			authorityId: createRuntimeId("authority", "seatbelt"), tenantId: createRuntimeId("tenant", "seatbelt"),
			principalId: createRuntimeId("principal", "seatbelt"), sessionId: createRuntimeId("session", "seatbelt"),
			workspaceId: createRuntimeId("workspace", "seatbelt"), repositoryId: createRuntimeId("repository", "seatbelt"),
			worktreePath: "/repo", branch: "runledger/test", baseCommit: "a".repeat(40), agentId: createRuntimeId("agent", "seatbelt"),
			toolCallId: createRuntimeId("toolCall", "seatbelt"), traceId: createRuntimeId("trace", "seatbelt"), cwd: "/repo",
			ownerRuntimeId: createRuntimeId("runtime", "seatbelt"), leaseRevision: 1, fencingToken: "seatbelt-fence",
		},
		readRoots: ["/repo"], writeRoots: ["/repo"], denyRead: ["/repo/private"], denyWrite: ["/repo/locked"],
		protectedPaths: ["/repo/.git"], network: "deny", command: "pwd", cwd: "/repo", environment: {}, timeoutMs: 1_000,
	};
}

describe("MacOsSeatbeltBackend", () => {
	it("does not claim enforcement without sandbox-exec", async () => {
		const backend = new MacOsSeatbeltBackend({ which: async () => undefined }, processPort);
		expect(await backend.prepare(request())).toMatchObject({ ok: false, error: { code: "sandbox_unavailable" } });
	});

	it("emits deny rules for protected paths and leaves network denied", async () => {
		const backend = new MacOsSeatbeltBackend({ which: async () => "/usr/bin/sandbox-exec" }, processPort);
		const result = await backend.prepare(request());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const profile = result.value.arguments[1];
		expect(profile).toContain("(deny file-read* (subpath \"/repo/private\"))");
		expect(profile).toContain("(deny file-write* (subpath \"/repo/.git\"))");
		expect(profile).not.toContain("allow network");
	});
});
