import { describe, expect, it } from "vitest";
import { PermissionEngine } from "../../src/security/permission/engine.ts";
import { aggregatePolicyDecisions, matchesSecurityPattern } from "../../src/security/permission/rule-matcher.ts";
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
			readRoots: ["/repo"], writeRoots: ["/repo"], denyRead: [], denyWrite: [],
			protectedPaths: ["/repo/.git", "/repo/.runledger"],
		},
		rules: [], sources: ["builtin"], workspaceRoot: "/repo", tempRoot: "/tmp/session",
		policyDigest: "a".repeat(64), createdAt: "2026-07-22T00:00:00.000Z",
	};
}

describe("permission rules", () => {
	it("aggregates deny before ask before allow independent of order", () => {
		const allow = { action: "allow", reason: "a", matchedRuleIds: ["a"], source: "project" } as const;
		const ask = { action: "ask", reason: "b", matchedRuleIds: ["b"], source: "managed" } as const;
		const deny = { action: "deny", reason: "c", matchedRuleIds: ["c"], source: "user" } as const;
		expect(aggregatePolicyDecisions([allow, deny, ask]).action).toBe("deny");
		expect(aggregatePolicyDecisions([allow, ask]).action).toBe("ask");
	});

	it("uses anchored wildcard matching", () => {
		expect(matchesSecurityPattern("write:/repo/*", "write:/repo/a.ts")).toBe(true);
		expect(matchesSecurityPattern("write:/repo/*", "read:/repo/a.ts")).toBe(false);
	});

	it("checks every shell segment so a safe prefix cannot hide rm", () => {
		const engine = new PermissionEngine();
		const result = engine.evaluate([{ kind: "shell", command: "ls && rm file", cwd: "/repo", analysis: "known" }], snapshot());
		expect(result.decision).toBe("ask");
		expect(result.requestDecisions[0]?.matchedRuleIds).toContain("builtin-shell-dangerous");
	});

	it("converts ask to deny under approvalPolicy never", () => {
		const engine = new PermissionEngine();
		const result = engine.evaluate([{ kind: "filesystem", operation: "write", path: "file.ts" }], snapshot("never"));
		expect(result.decision).toBe("deny");
		expect(result.reason).toContain("converted ask to deny");
	});

	it("keeps browser operations independently matchable", () => {
		const engine = new PermissionEngine();
		const result = engine.evaluate([{ kind: "browser", operation: "cookie", resourceDigest: "b".repeat(64) }], snapshot());
		expect(result.decision).toBe("ask");
		expect(result.requestDecisions[0]?.matchedRuleIds).toEqual(["builtin-browser-cookie"]);
	});
});
