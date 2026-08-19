import { describe, expect, it } from "vitest";
import { resolveSecuritySnapshot } from "../../src/security/config/resolver.ts";
import {
	resolveToolAccessRequests,
	resolveToolAccessRequestsWithBashAnalyzer,
} from "../../src/security/permission/access-resolver.ts";
import { PermissionEngine } from "../../src/security/permission/engine.ts";
import {
	resolveBashSecurityAnalyzerMode,
	type BashSecurityAnalyzerPort,
} from "../../src/security/permission/bash-ast/index.ts";
import type {
	SecurityRule,
	SecuritySnapshot,
} from "../../src/security/types.ts";

const SIMPLE = {
	kind: "simple" as const,
	parserDigest: "a".repeat(64),
	commands: [{
		executable: "git",
		arguments: ["status"],
		assignments: [],
		redirects: [],
	}],
};

function snapshot(
	approvalPolicy: "on-request" | "never" | "untrusted" | "granular",
	options: {
		yolo?: boolean;
		granularRules?: boolean;
		rules?: readonly SecurityRule[];
	} = {},
): SecuritySnapshot {
	const yolo = options.yolo === true;
	return {
		profile: {
			name: yolo ? "danger-full-access" : "workspace-write",
			approvalPolicy: yolo ? "never" : approvalPolicy,
			...(approvalPolicy === "granular" ? {
				granularApproval: {
					sandboxApproval: true,
					rules: options.granularRules ?? true,
					skillApproval: true,
					requestPermissions: true,
					mcpElicitations: true,
				},
			} : {}),
			filesystemMode: yolo ? "unrestricted" : "workspace-write",
			network: { mode: yolo ? "allow" : "deny", allowedHosts: [] },
			sandbox: yolo ? "off" : "workspace-write",
		},
		filesystem: {
			readRoots: yolo ? ["/"] : ["/repo"],
			writeRoots: yolo ? ["/"] : ["/repo"],
			denyRead: [],
			denyWrite: [],
			protectedPaths: ["/repo/.git", "/repo/.runledger"],
		},
		rules: options.rules ?? [],
		sources: ["builtin"],
		workspaceRoot: "/repo",
		tempRoot: "/tmp/session",
		policyDigest: "b".repeat(64),
		createdAt: "2026-07-30T00:00:00.000Z",
		operatingMode: yolo ? "yolo" : "guarded",
		bashAnalyzer: {
			mode: "ast",
			source: "cli",
			configDigest: "c".repeat(64),
		},
	};
}

function analyzer(
	result: Awaited<ReturnType<BashSecurityAnalyzerPort["analyze"]>>,
): BashSecurityAnalyzerPort {
	return { analyze: async () => result };
}

describe("Bash AST authorization", () => {
	it("projects every static redirect into an independent filesystem request", async () => {
		const resolved = await resolveToolAccessRequestsWithBashAnalyzer(
			"bash",
			{ command: "cat < input > output" },
			"/repo",
			"ast",
			analyzer({
				mode: "ast",
				ast: {
					kind: "simple",
					parserDigest: "a".repeat(64),
					commands: [{
						executable: "cat",
						arguments: [],
						assignments: [],
						redirects: [
							{ operation: "read", path: "input" },
							{ operation: "write", path: "output" },
						],
					}],
				},
			}),
		);
		expect(resolved).toMatchObject({
			ok: true,
			value: [
				{ kind: "shell", bashAnalyzerMode: "ast", analysis: "known" },
				{ kind: "filesystem", operation: "read", path: "input" },
				{ kind: "filesystem", operation: "write", path: "output" },
			],
		});
	});

	it("does not project the exact stderr null sink into a filesystem request", async () => {
		const resolved = await resolveToolAccessRequestsWithBashAnalyzer(
			"bash",
			{ command: "typescript-language-server --stdio 2>/dev/null" },
			"/repo",
			"ast",
			analyzer({
				mode: "ast",
				ast: {
					kind: "simple",
					parserDigest: "a".repeat(64),
					commands: [{
						executable: "typescript-language-server",
						arguments: ["--stdio"],
						assignments: [],
						redirects: [{ operation: "write", path: "/dev/null", fd: 2 }],
					}],
				},
			}),
		);
		expect(resolved).toMatchObject({
			ok: true,
			value: [{ kind: "shell", bashAnalyzerMode: "ast", analysis: "known" }],
		});
	});

	it("keeps non-stderr redirects as filesystem requests", async () => {
		const resolved = await resolveToolAccessRequestsWithBashAnalyzer(
			"bash",
			{ command: "typescript-language-server --stdio 1>/tmp/lsp.log" },
			"/repo",
			"ast",
			analyzer({
				mode: "ast",
				ast: {
					kind: "simple",
					parserDigest: "a".repeat(64),
					commands: [{
						executable: "typescript-language-server",
						arguments: ["--stdio"],
						assignments: [],
						redirects: [{ operation: "write", path: "/tmp/lsp.log", fd: 1 }],
					}],
				},
			}),
		);
		expect(resolved).toMatchObject({
			ok: true,
			value: [
				{ kind: "shell", bashAnalyzerMode: "ast", analysis: "known" },
				{ kind: "filesystem", operation: "write", path: "/tmp/lsp.log" },
			],
		});
	});

	it.each([
		["guarded on-request", snapshot("on-request"), "ask"],
		["approval never", snapshot("never"), "deny"],
		["YOLO", snapshot("never", { yolo: true }), "deny"],
	] as const)("fails closed for unavailable AST in %s", async (_name, policy, decision) => {
		const resolved = await resolveToolAccessRequestsWithBashAnalyzer(
			"bash",
			{ command: "git status" },
			"/repo",
			"ast",
			analyzer({
				mode: "ast",
				ast: {
					kind: "parse-unavailable",
					reasonCode: "bash_worker_crash",
				},
			}),
		);
		expect(resolved.ok).toBe(true);
		if (!resolved.ok) return;
		const evaluation = new PermissionEngine().evaluate(resolved.value, policy);
		expect(evaluation.decision).toBe(decision);
		expect(evaluation.requestDecisions[0]?.matchedRuleIds)
			.toContain("builtin-shell-ast-failure");
	});

	it("keeps AST failure conservative under untrusted and granular approval", () => {
		const request = {
			kind: "shell" as const,
			command: "git status",
			cwd: "/repo",
			analysis: "unknown" as const,
			bashAnalyzerMode: "ast" as const,
			bashAst: { kind: "parse-unavailable" as const, reasonCode: "bash_worker_crash" },
		};
		expect(new PermissionEngine().evaluate([request], snapshot("untrusted")).decision).toBe("ask");
		expect(new PermissionEngine().evaluate([request], snapshot("granular", { granularRules: false })).decision).toBe("deny");
	});

	it("keeps hardline and managed deny stronger than AST simple and YOLO", () => {
		const hardline = new PermissionEngine().evaluate([{
			kind: "shell",
			command: "rm -rf /",
			cwd: "/repo",
			analysis: "known",
			bashAnalyzerMode: "ast",
			bashAst: SIMPLE,
		}], snapshot("never", { yolo: true }));
		expect(hardline.decision).toBe("deny");
		expect(hardline.requestDecisions[0]?.matchedRuleIds)
			.toContain("builtin-shell-hardline");

		const managedDeny: SecurityRule = {
			id: "managed-deny-shell",
			action: "deny",
			kind: "shell",
			pattern: "*",
			source: "managed",
		};
		const managed = new PermissionEngine().evaluate([{
			kind: "shell",
			command: "git status",
			cwd: "/repo",
			analysis: "known",
			bashAnalyzerMode: "ast",
			bashAst: SIMPLE,
		}], snapshot("never", { yolo: true, rules: [managedDeny] }));
		expect(managed.decision).toBe("deny");
		expect(managed.requestDecisions[0]?.matchedRuleIds).toEqual([managedDeny.id]);
	});

	it("does not let an allow rule override hardline or AST failure", () => {
		const allow: SecurityRule = {
			id: "project-allow-shell",
			action: "allow",
			kind: "shell",
			pattern: "*",
			source: "project",
		};
		const policy = snapshot("on-request", { rules: [allow] });
		const hardline = new PermissionEngine().evaluate([{
			kind: "shell",
			command: "rm -rf /",
			cwd: "/repo",
			analysis: "known",
			bashAnalyzerMode: "ast",
			bashAst: SIMPLE,
		}], policy);
		expect(hardline.decision).toBe("deny");
		expect(hardline.requestDecisions[0]?.matchedRuleIds)
			.toContain("builtin-shell-hardline");

		const unavailable = new PermissionEngine().evaluate([{
			kind: "shell",
			command: "git status",
			cwd: "/repo",
			analysis: "unknown",
			bashAnalyzerMode: "ast",
			bashAst: {
				kind: "parse-unavailable",
				reasonCode: "bash_wasm_unavailable",
			},
		}], policy);
		expect(unavailable.decision).toBe("ask");
		expect(unavailable.requestDecisions[0]?.matchedRuleIds)
			.toContain("builtin-shell-ast-failure");
	});

	it("keeps a managed deny stronger than an AST failure approval", () => {
		const managedDeny: SecurityRule = {
			id: "managed-deny-unavailable-shell",
			action: "deny",
			kind: "shell",
			pattern: "*",
			source: "managed",
		};
		const evaluation = new PermissionEngine().evaluate([{
			kind: "shell",
			command: "git status",
			cwd: "/repo",
			analysis: "unknown",
			bashAnalyzerMode: "ast",
			bashAst: {
				kind: "parse-unavailable",
				reasonCode: "bash_worker_crash",
			},
		}], snapshot("on-request", { rules: [managedDeny] }));

		expect(evaluation.decision).toBe("deny");
		expect(evaluation.requestDecisions[0]?.matchedRuleIds).toEqual([managedDeny.id]);
	});

	it("keeps shadow authorization byte-for-byte on the legacy access path", async () => {
		const command = "git status";
		const legacy = resolveToolAccessRequests("bash", { command }, "/repo");
		const shadow = await resolveToolAccessRequestsWithBashAnalyzer(
			"bash",
			{ command },
			"/repo",
			"shadow",
			analyzer({
				mode: "shadow",
				legacyKind: "known",
				ast: {
					kind: "parse-unavailable",
					reasonCode: "bash_worker_crash",
				},
			}),
		);
		expect(legacy.ok).toBe(true);
		expect(shadow.ok).toBe(true);
		if (!legacy.ok || !shadow.ok) return;
		const policy = snapshot("on-request");
		policy.bashAnalyzer = {
			mode: "shadow",
			source: "cli",
			configDigest: "d".repeat(64),
		};
		expect(new PermissionEngine().evaluate(shadow.value, policy).decision)
			.toBe(new PermissionEngine().evaluate(legacy.value, policy).decision);
		expect(shadow.value).toHaveLength(1);
	});

	it("resolves user/project/CLI/managed mode without allowing downgrade", () => {
		expect(resolveBashSecurityAnalyzerMode({
			user: "shadow",
			project: "legacy",
			cli: "legacy",
		})).toMatchObject({ mode: "shadow", source: "user" });
		expect(resolveBashSecurityAnalyzerMode({
			user: "legacy",
			project: "shadow",
			cli: "legacy",
		})).toMatchObject({ mode: "shadow", source: "project" });
		expect(resolveBashSecurityAnalyzerMode({
			user: "ast",
			project: "legacy",
			cli: "legacy",
			managedMinimum: "ast",
		})).toMatchObject({ mode: "ast", source: "managed" });

		const resolved = resolveSecuritySnapshot({
			layers: [
				{
					source: "user",
					document: { bashAnalyzerMode: "ast" },
					documentDigest: "1".repeat(64),
				},
				{
					source: "project",
					document: { bashAnalyzerMode: "legacy" },
					documentDigest: "2".repeat(64),
				},
				{
					source: "session",
					document: { bashAnalyzerMode: "shadow" },
					documentDigest: "3".repeat(64),
				},
			],
			workspaceRoot: "/repo",
			tempRoot: "/tmp/session",
			createdAt: "2026-07-30T00:00:00.000Z",
			constraints: {
				allowedProfiles: ["workspace-write"],
				allowedApprovalPolicies: ["on-request"],
				minimumSandbox: "workspace-write",
				forceNetworkDeny: true,
				minimumBashAnalyzerMode: "ast",
			},
		});
		expect(resolved).toMatchObject({
			ok: true,
			value: { bashAnalyzer: { mode: "ast", source: "managed" } },
		});
	});
});
