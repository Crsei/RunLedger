import { describe, expect, it } from "vitest";
import { createRuntimeId } from "../../src/runtime/protocol/ids.ts";
import { runtimeDigest, type RuntimeDigest } from "../../src/runtime/protocol/foundation.ts";
import type { WorkspaceExecutionEnvelope } from "../../src/runtime/contracts/public.ts";
import { MacOsSeatbeltBackend } from "../../src/security/sandbox/macos-seatbelt.ts";
import type { SandboxPrepareRequest, SandboxProbe } from "../../src/security/sandbox/types.ts";

function digest(value: string): RuntimeDigest {
	return runtimeDigest(value);
}

function request(overrides: Partial<SandboxPrepareRequest> = {}): SandboxPrepareRequest {
	const workspace: WorkspaceExecutionEnvelope = {
		authorityId: createRuntimeId("authority", "sandbox-macos"),
		tenantId: createRuntimeId("tenant", "sandbox-macos"),
		principalId: createRuntimeId("principal", "sandbox-macos"),
		sessionId: createRuntimeId("session", "sandbox-macos"),
		workspaceId: createRuntimeId("workspace", "sandbox-macos"),
		repositoryId: createRuntimeId("repository", "sandbox-macos"),
		worktreePath: "/repo",
			worktreePathDigest: runtimeDigest("/repo"),
		branch: "runledger/test",
		baseCommit: "b".repeat(40),
		agentId: createRuntimeId("agent", "sandbox-macos"),
		toolCallId: createRuntimeId("toolCall", "sandbox-macos"),
		traceId: createRuntimeId("trace", "sandbox-macos"),
		cwd: "/repo",
			cwdDigest: runtimeDigest("/repo"),
		ownerRuntimeId: createRuntimeId("runtime", "sandbox-macos"),
		leaseRevision: 2,
		fencingTokenDigest: digest("macos-fence"),
	};
	return {
		requested: "strict",
		policyDigest: digest("macos-policy"),
		requestDigest: digest("macos-request"),
		workspace,
		readRoots: ["/repo"],
		writeRoots: ["/repo/out"],
		denyRead: ["/repo/private"],
		denyWrite: ["/repo/readonly"],
		protectedPaths: ["/repo/.git"],
		network: "deny",
		command: "pwd",
		cwd: "/repo",
			cwdDigest: runtimeDigest("/repo"),
		environment: {},
		timeoutMs: 1_000,
		...overrides,
	};
}

function probe(path: string | undefined): SandboxProbe {
	return { which: async () => path };
}

describe("MacOsSeatbeltBackend", () => {
	it("reports Seatbelt unavailable without claiming degraded enforcement", async () => {
		const backend = new MacOsSeatbeltBackend(probe(undefined));

		expect(await backend.probe()).toMatchObject({
			backendId: "macos-seatbelt",
			status: "unavailable",
			deprecated: true,
		});
		expect(await backend.prepare(request())).toMatchObject({ ok: false, error: { code: "sandbox_unavailable" } });
	});

	it("generates a deterministic Seatbelt profile with write, deny-read, protected, and network rules", async () => {
		const backend = new MacOsSeatbeltBackend(probe("/usr/bin/sandbox-exec"));
		const result = await backend.prepare(request());

		expect(result).toMatchObject({ ok: true, value: { program: "/usr/bin/sandbox-exec", enforcement: "enforced" } });
		if (!result.ok) return;

		const profile = result.value.arguments[1];
		expect(profile).toContain('(deny file-read* (subpath "/repo/private"))');
		expect(profile).toContain('(deny file-write* (subpath "/repo/.git"))');
		expect(profile).toContain('(allow file-write* (subpath "/repo/out"))');
		expect(profile).not.toContain("(allow network*)");
		expect(result.value.arguments.slice(-4)).toEqual(["--", "/bin/sh", "-lc", "pwd"]);
	});

	it("only allows network when the request explicitly resolves to allow", async () => {
		const backend = new MacOsSeatbeltBackend(probe("/usr/bin/sandbox-exec"));
		const result = await backend.prepare(request({ network: "allow" }));

		expect(result).toMatchObject({ ok: true });
		if (result.ok) expect(result.value.arguments[1]).toContain("(allow network*)");
	});
});
