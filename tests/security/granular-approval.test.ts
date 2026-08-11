import { describe, expect, it } from "vitest";
import { runtimeDigest } from "../../src/runtime/contracts/public.ts";
import { PermissionEngine } from "../../src/security/permission/engine.ts";
import type { AccessRequest, SecuritySnapshot } from "../../src/security/types.ts";

function snapshot(overrides: Partial<SecuritySnapshot["profile"]> = {}): SecuritySnapshot {
	return {
		profile: {
			name: "workspace-write",
			approvalPolicy: "on-request",
			filesystemMode: "workspace-write",
			network: { mode: "deny", allowedHosts: [] },
			sandbox: "workspace-write",
			...overrides,
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
		policyDigest: runtimeDigest("granular-test"),
		createdAt: "2026-08-11T00:00:00.000Z",
	};
}

function evaluate(request: AccessRequest, value: SecuritySnapshot) {
	return new PermissionEngine().evaluate([request], value);
}

describe("Codex approval policy adaptation", () => {
	it("skips ordinary mutation approval in unrestricted on-request mode but keeps dangerous shell approval", () => {
		const value = snapshot({ filesystemMode: "unrestricted" });
		expect(evaluate({ kind: "filesystem", operation: "write", path: "/outside/file" }, value).decision).toBe("allow");
		expect(evaluate({ kind: "shell", command: "rm file", cwd: "/repo", analysis: "known" }, value).decision).toBe("ask");
	});

	it("makes every non-read fast path ask under untrusted", () => {
		const value = snapshot({ approvalPolicy: "untrusted" as never, network: { mode: "allow", allowedHosts: [] } });
		expect(evaluate({ kind: "filesystem", operation: "read", path: "README.md" }, value).decision).toBe("allow");
		expect(evaluate({ kind: "shell", command: "ls", cwd: "/repo", analysis: "known" }, value).decision).toBe("ask");
		expect(evaluate({ kind: "network", operation: "fetch", host: "example.com" }, value).decision).toBe("ask");
	});

	it("forbids disabled granular approval categories without weakening policy deny", () => {
		const value = snapshot({
			approvalPolicy: "granular" as never,
			granularApproval: {
				sandboxApproval: false,
				rules: false,
				skillApproval: false,
				requestPermissions: false,
				mcpElicitations: false,
			},
		} as never);
		expect(evaluate({ kind: "filesystem", operation: "write", path: "file.ts" }, value).decision).toBe("deny");
		expect(evaluate({ kind: "shell", command: "rm file", cwd: "/repo", analysis: "known" }, value).decision).toBe("deny");
		expect(evaluate({ kind: "tool", toolName: "Skill" }, value).decision).toBe("deny");
		expect(evaluate({ kind: "tool", toolName: "request_permissions" }, value).decision).toBe("deny");
		expect(evaluate({ kind: "tool", toolName: "mcp_elicitation", provider: "mcp" }, value).decision).toBe("deny");
	});

	it("uses compiled filesystem entries before legacy root defaults", () => {
		const value = snapshot();
		const withEntries = {
			...value,
			filesystem: {
				...value.filesystem,
				entriesPolicy: {
					kind: "restricted" as const,
					entries: [
						{ path: { kind: "path" as const, path: "/repo" }, access: "read" as const },
						{ path: { kind: "path" as const, path: "/repo/private" }, access: "deny" as const },
					],
				},
			},
		};
		expect(evaluate({ kind: "filesystem", operation: "read", path: "private/secret" }, withEntries).decision).toBe("deny");
	});
});
