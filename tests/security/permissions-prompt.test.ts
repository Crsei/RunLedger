import { describe, expect, it } from "vitest";
import { runtimeDigest } from "../../src/runtime/contracts/public.ts";
import type { SecuritySnapshot } from "../../src/security/types.ts";

function snapshot(): SecuritySnapshot {
	return {
		profile: { name: "workspace-write", approvalPolicy: "on-request", filesystemMode: "workspace-write", network: { mode: "deny", allowedHosts: [] }, sandbox: "workspace-write" },
		filesystem: { readRoots: ["/repo"], writeRoots: ["/repo"], denyRead: [], denyWrite: [], protectedPaths: [] },
		rules: [], sources: ["builtin"], workspaceRoot: "/repo", tempRoot: "/tmp/runledger",
		policyDigest: runtimeDigest("permissions-prompt"), createdAt: "2026-08-11T00:00:00.000Z",
	};
}

describe("permissions system prompt", () => {
	it("injects approval, sandbox, escalation, justification, and safe prefix-rule guidance", async () => {
		const module = await import("../../src/security/prompts/permissions-prompt.ts").catch(() => undefined);
		const prompt = module?.composePermissionsSystemPrompt("base instructions", snapshot());
		expect(prompt).toContain("base instructions");
		expect(prompt).toContain("approval_policy: on-request");
		expect(prompt).toContain("sandbox_mode: workspace-write");
		expect(prompt).toContain("require_escalated");
		expect(prompt).toContain("justification");
		expect(prompt).toContain("prefix_rule");
		expect(prompt).toContain("heredoc");
		expect(prompt).toContain("rm");
		expect(prompt).toContain("dangerous commands");
	});
});
