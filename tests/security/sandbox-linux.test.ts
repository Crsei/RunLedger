import { describe, expect, it } from "vitest";
import { createRuntimeId } from "../../src/runtime/protocol/ids.ts";
import { runtimeDigest, type RuntimeDigest } from "../../src/runtime/protocol/foundation.ts";
import type { WorkspaceExecutionEnvelope } from "../../src/runtime/contracts/public.ts";
import { LinuxBwrapBackend } from "../../src/security/sandbox/linux-bwrap.ts";
import type { SandboxPrepareRequest, SandboxProbe } from "../../src/security/sandbox/types.ts";

function digest(value: string): RuntimeDigest {
	return runtimeDigest(value);
}

function envelope(): WorkspaceExecutionEnvelope {
	return {
		authorityId: createRuntimeId("authority", "sandbox-linux"),
		tenantId: createRuntimeId("tenant", "sandbox-linux"),
		principalId: createRuntimeId("principal", "sandbox-linux"),
		sessionId: createRuntimeId("session", "sandbox-linux"),
		workspaceId: createRuntimeId("workspace", "sandbox-linux"),
		repositoryId: createRuntimeId("repository", "sandbox-linux"),
		worktreePath: "/repo",
		branch: "runledger/test",
		baseCommit: "a".repeat(40),
		agentId: createRuntimeId("agent", "sandbox-linux"),
		toolCallId: createRuntimeId("toolCall", "sandbox-linux"),
		traceId: createRuntimeId("trace", "sandbox-linux"),
		cwd: "/repo",
		ownerRuntimeId: createRuntimeId("runtime", "sandbox-linux"),
		leaseRevision: 1,
		fencingTokenDigest: digest("linux-fence"),
	};
}

function request(overrides: Partial<SandboxPrepareRequest> = {}): SandboxPrepareRequest {
	return {
		requested: "workspace-write",
		policyDigest: digest("linux-policy"),
		requestDigest: digest("linux-request"),
		workspace: envelope(),
		readRoots: ["/repo"],
		writeRoots: ["/repo"],
		denyRead: ["/repo/private"],
		denyWrite: ["/repo/readonly"],
		protectedPaths: ["/repo/.git", "/repo/.runledger"],
		network: "deny",
		command: "printf ok",
		cwd: "/repo",
		environment: { Z_LAST: "last", PATH: "/usr/bin" },
		timeoutMs: 1_000,
		...overrides,
	};
}

function probe(path: string | undefined): SandboxProbe {
	return { which: async () => path };
}

describe("LinuxBwrapBackend", () => {
	it("fails closed for restrictive profiles when bwrap is unavailable without spawning", async () => {
		const backend = new LinuxBwrapBackend(probe(undefined));

		expect(await backend.probe()).toMatchObject({
			backendId: "linux-bwrap",
			status: "unavailable",
			supportsFilesystemIsolation: false,
			supportsNetworkDeny: false,
		});
		expect(await backend.prepare(request())).toMatchObject({ ok: false, error: { code: "sandbox_unavailable" } });
	});

	it("creates an explicit builtin-none off plan even when the restrictive backend is unavailable", async () => {
		let probeCalls = 0;
		const backend = new LinuxBwrapBackend({
			which: async () => {
				probeCalls += 1;
				return undefined;
			},
		});

		const result = await backend.prepare(request({ requested: "off" }));

		expect(result).toMatchObject({
			ok: true,
			value: {
				backendId: "builtin-none",
				requested: "off",
				resolved: "off",
				effective: "off",
				enforcement: "off",
				program: "/bin/sh",
				arguments: ["-lc", "printf ok"],
			},
		});
		expect(probeCalls).toBe(0);
	});

	it("generates a deterministic network-denying plan with workspace containment and protected paths", async () => {
		const backend = new LinuxBwrapBackend(probe("/opt/bwrap"));
		const first = await backend.prepare(request());
		const second = await backend.prepare(request());

		expect(first).toEqual(second);
		expect(first).toMatchObject({
			ok: true,
			value: {
				program: "/opt/bwrap",
				requested: "workspace-write",
				resolved: "workspace-write",
				effective: "workspace-write",
				enforcement: "enforced",
				requestDigest: digest("linux-request"),
			},
		});
		if (!first.ok) return;

		expect(first.value.arguments).toContain("--unshare-net");
		expect(first.value.arguments).toContain("--ro-bind");
		expect(first.value.arguments).toEqual(expect.arrayContaining([
			"/repo", "/repo/private", "/repo/readonly", "/repo/.git", "/repo/.runledger",
		]));
		expect(first.value.arguments.slice(-3)).toEqual(["/bin/sh", "-lc", "printf ok"]);
		expect(first.value.planDigest.algorithm).toBe("sha256");
	});

	it("does not synthesize missing protected mount sources into a launch plan", async () => {
		const backend = new LinuxBwrapBackend(probe("/opt/bwrap"));
		const result = await backend.prepare(request({ protectedPaths: [] }));

		expect(result).toMatchObject({ ok: true });
		if (!result.ok) return;
		expect(result.value.arguments).not.toContain("/repo/.git");
		expect(result.value.arguments).not.toContain("/repo/.runledger");
	});

	it("rejects an outside cwd or writable root before producing a launch plan", async () => {
		const backend = new LinuxBwrapBackend(probe("/opt/bwrap"));

		expect(await backend.prepare(request({ cwd: "/outside" }))).toMatchObject({ ok: false, error: { code: "path_escape" } });
		expect(await backend.prepare(request({ writeRoots: ["/outside"] }))).toMatchObject({ ok: false, error: { code: "path_escape" } });
	});
});
