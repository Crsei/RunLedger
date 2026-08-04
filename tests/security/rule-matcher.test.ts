import { describe, expect, it } from "vitest";
import { runtimeDigest } from "../../src/runtime/contracts/public.ts";
import {
	aggregatePolicyDecisions,
	matchesSecurityPattern,
} from "../../src/security/permission/rule-matcher.ts";
import { PermissionEngine } from "../../src/security/permission/engine.ts";
import type { SecuritySnapshot } from "../../src/security/types.ts";

function snapshot(approvalPolicy: "on-request" | "never" = "on-request"): SecuritySnapshot {
	return {
		profile: {
			name: "workspace-write",
			approvalPolicy,
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
		policyDigest: runtimeDigest({ policy: "test" }),
		createdAt: "2026-08-04T00:00:00.000Z",
	};
}

describe("permission rule matching", () => {
	it("aggregates deny before ask before allow independently of rule order", () => {
		expect(aggregatePolicyDecisions([
			{ action: "allow", reason: "allow", matchedRuleIds: ["allow"], source: "project" },
			{ action: "deny", reason: "deny", matchedRuleIds: ["deny"], source: "managed" },
			{ action: "ask", reason: "ask", matchedRuleIds: ["ask"], source: "user" },
		]).action).toBe("deny");
		expect(aggregatePolicyDecisions([
			{ action: "allow", reason: "allow", matchedRuleIds: ["allow"], source: "project" },
			{ action: "ask", reason: "ask", matchedRuleIds: ["ask"], source: "user" },
		]).action).toBe("ask");
	});

	it("matches exact anchored wildcard targets", () => {
		expect(matchesSecurityPattern("write:/repo/*", "write:/repo/file.ts")).toBe(true);
		expect(matchesSecurityPattern("write:/repo/*", "read:/repo/file.ts")).toBe(false);
		expect(matchesSecurityPattern("write:/repo/*", "write:/repo-other/file.ts")).toBe(false);
	});

	it("checks every shell segment and converts ask to deny in never mode", () => {
		const engine = new PermissionEngine();
		expect(engine.evaluate([
			{ kind: "shell", command: "ls && rm file", cwd: "/repo", analysis: "known" },
		], snapshot()).decision).toBe("ask");
		expect(engine.evaluate([
			{ kind: "filesystem", operation: "write", path: "file.ts" },
		], snapshot("never")).decision).toBe("deny");
	});

	it("requires approval for an executable that is not in the conservative shell allowlist", () => {
		const result = new PermissionEngine().evaluate([
			{ kind: "shell", command: "untrusted-helper --write", cwd: "/repo", analysis: "known" },
		], snapshot());
		expect(result.decision).toBe("ask");
	});

	it("hard-denies catastrophic shell commands even when classified as known", () => {
		const result = new PermissionEngine().evaluate([
			{ kind: "shell", command: "bash -c 'rm -rf /'", cwd: "/repo", analysis: "known" },
		], snapshot());
		expect(result.decision).toBe("deny");
	});

	it("does not let an allow rule override protected metadata", () => {
		const protectedSnapshot = snapshot();
		const result = new PermissionEngine().evaluate([
			{ kind: "filesystem", operation: "write", path: ".git/config" },
		], {
			...protectedSnapshot,
			rules: [{ id: "allow-git", action: "allow", kind: "filesystem", pattern: "write:*/.git/*", source: "project" }],
		});
		expect(result.decision).toBe("deny");
	});

	it("honors an explicit network allowlist while keeping other hosts denied", () => {
		const base = snapshot();
		const allowlist = { ...base, profile: { ...base.profile, network: { mode: "allowlist" as const, allowedHosts: ["example.com"] } } };
		const engine = new PermissionEngine();
		expect(engine.evaluate([{ kind: "network", operation: "fetch", host: "example.com" }], allowlist).decision).toBe("allow");
		expect(engine.evaluate([{ kind: "network", operation: "fetch", host: "other.example" }], allowlist).decision).toBe("deny");
	});
});
