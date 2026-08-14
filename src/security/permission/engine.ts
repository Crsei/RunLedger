/** 无 UI 的最小 PermissionEngine；规则和默认边界均 fail closed。 */

import { isAbsolute, relative, resolve } from "node:path";
import { runtimeWorkspacePlatform } from "../../workspace/runtime-platform.ts";
import type { AccessRequest, PolicyDecision, SecurityAccessEvaluation, SecuritySnapshot } from "../types.ts";
import { resolveFilesystemAccess } from "./filesystem-entries.ts";
import { aggregatePolicyDecisions, strongestRuleDecision } from "./rule-matcher.ts";
import { analyzeShellCommand, hardlineShellDenialReason } from "./shell-analyzer.ts";

const DANGEROUS = new Set(["rm", "chmod", "chown", "chgrp", "kill", "pkill", "sudo", "tee"]);

function hasDangerousSegment(command: string): boolean {
	return command.split(/&&|\|\||[;|\n]/u).some((segment) => {
		const executable = segment.trim().split(/\s+/u)[0]?.replace(/^.*[\\/]/u, "") ?? "";
		return DANGEROUS.has(executable) || (/^git$/u.test(executable) && /\bgit\s+push\b/u.test(segment));
	});
}

function within(root: string, target: string): boolean {
	const offset = relative(resolve(root), resolve(target));
	return offset === "" || (!offset.startsWith("..") && !isAbsolute(offset));
}

function builtinDecision(request: AccessRequest, snapshot: SecuritySnapshot): PolicyDecision {
	switch (request.kind) {
		case "filesystem": {
			const target = resolve(snapshot.workspaceRoot, request.path);
			const protectedPath = snapshot.filesystem.protectedPaths.some((path) => within(path, target));
			if (protectedPath) return { action: "deny", reason: "target is a protected control-plane path", matchedRuleIds: ["builtin-protected-path"], source: "builtin" };
			const denied = request.operation === "read" ? snapshot.filesystem.denyRead : snapshot.filesystem.denyWrite;
			if (denied.some((path) => within(path, target))) return { action: "deny", reason: "target matches a denied path", matchedRuleIds: ["builtin-denied-path"], source: "builtin" };
			if (snapshot.filesystem.entriesPolicy !== undefined) {
				const access = resolveFilesystemAccess(snapshot.filesystem.entriesPolicy, {
					path: target,
					cwd: snapshot.workspaceRoot,
					platform: runtimeWorkspacePlatform(),
				});
				if (access === "deny" || (request.operation !== "read" && access !== "write")) {
					return { action: "deny", reason: "compiled filesystem entries denied the requested access", matchedRuleIds: ["builtin-filesystem-entry"], source: "builtin" };
				}
				return request.operation === "read"
					? { action: "allow", reason: "compiled filesystem entries allow read access", matchedRuleIds: ["builtin-filesystem-entry"], source: "builtin" }
					: { action: "ask", reason: "compiled filesystem entries allow mutation after approval", matchedRuleIds: ["builtin-filesystem-entry"], source: "builtin" };
			}
			const roots = request.operation === "read" ? snapshot.filesystem.readRoots : snapshot.filesystem.writeRoots;
			if (snapshot.profile.filesystemMode !== "unrestricted" && !roots.some((root) => within(root, target))) {
				return { action: "deny", reason: "target is outside allowed roots", matchedRuleIds: ["builtin-root-boundary"], source: "builtin" };
			}
			return request.operation === "read"
				? { action: "allow", reason: "read is inside an allowed root", matchedRuleIds: ["builtin-read-root"], source: "builtin" }
				: { action: "ask", reason: "filesystem mutation requires exact approval", matchedRuleIds: ["builtin-write-approval"], source: "builtin" };
		}
		case "shell": {
			const hardlineReason = hardlineShellDenialReason(request.command);
			if (hardlineReason) return { action: "deny", reason: `hardline shell policy denied ${hardlineReason}`, matchedRuleIds: ["builtin-shell-hardline"], source: "builtin" };
			const analyzerMode = request.bashAnalyzerMode ?? snapshot.bashAnalyzer?.mode ?? "legacy";
			if (analyzerMode === "ast") {
				if (request.bashAst?.kind !== "simple") {
					return {
						action: "ask",
						reason: `Bash AST classification failed closed: ${request.bashAst?.reasonCode ?? "bash_ast_result_missing"}`,
						matchedRuleIds: ["builtin-shell-ast-failure"],
						source: "builtin",
					};
				}
				const dangerous = request.bashAst.commands.some((segment) =>
					DANGEROUS.has(segment.executable) ||
					(segment.executable === "git" && segment.arguments[0] === "push")
				);
				if (dangerous) return { action: "ask", reason: "dangerous AST-classified shell command requires exact approval", matchedRuleIds: ["builtin-shell-dangerous"], source: "builtin" };
				return { action: "allow", reason: "AST-classified shell command is structurally understood", matchedRuleIds: ["builtin-shell-known"], source: "builtin" };
			}
			const executable = request.command.trim().split(/\s+/u)[0]?.replace(/^.*[\\/]/u, "") ?? "";
			if (hasDangerousSegment(request.command) || DANGEROUS.has(executable)) {
				return { action: "ask", reason: "dangerous shell command requires exact approval", matchedRuleIds: ["builtin-shell-dangerous"], source: "builtin" };
			}
			if (request.analysis === "unknown" || analyzeShellCommand(request.command).analysis === "unknown") return { action: "ask", reason: "shell syntax could not be safely classified", matchedRuleIds: ["builtin-shell-unknown"], source: "builtin" };
			return { action: "allow", reason: "known shell command requires no additional approval", matchedRuleIds: ["builtin-shell-known"], source: "builtin" };
		}
		case "network":
			if (snapshot.profile.network.mode === "deny") return { action: "deny", reason: "network policy is deny", matchedRuleIds: ["builtin-network-deny"], source: "builtin" };
			if (snapshot.profile.network.mode === "allowlist" && !snapshot.profile.network.allowedHosts.includes(request.host)) return { action: "deny", reason: "host is outside the network allowlist", matchedRuleIds: ["builtin-network-host"], source: "builtin" };
			if (snapshot.profile.network.mode === "review" && !snapshot.profile.network.allowedHosts.includes(request.host)) return { action: "ask", reason: "network allowlist miss requires review", matchedRuleIds: ["builtin-network-review"], source: "builtin" };
			return { action: "allow", reason: "network target is allowed", matchedRuleIds: ["builtin-network-allow"], source: "builtin" };
		case "worktree":
			if (!isAbsolute(request.target) || resolve(request.target) !== request.target || request.target.includes("\0")) {
				return { action: "deny", reason: "worktree target must be a canonical absolute path", matchedRuleIds: ["builtin-worktree-target"], source: "builtin" };
			}
			return { action: "ask", reason: "worktree mutation requires exact approval", matchedRuleIds: ["builtin-worktree-approval"], source: "builtin" };
		case "tool":
			return { action: "ask", reason: "unknown tool capability requires approval", matchedRuleIds: ["builtin-tool-unknown"], source: "fallback" };
	}
}

function isBuiltinSkippableOnRequest(request: AccessRequest, decision: PolicyDecision, snapshot: SecuritySnapshot): boolean {
	if (snapshot.profile.filesystemMode !== "unrestricted" || request.kind !== "filesystem" || request.operation === "read") return false;
	return decision.action === "ask" && decision.source === "builtin" &&
		decision.matchedRuleIds.every((id) => id === "builtin-write-approval" || id === "builtin-filesystem-entry");
}

function granularCategoryEnabled(request: AccessRequest, decision: PolicyDecision, snapshot: SecuritySnapshot): boolean {
	const granular = snapshot.profile.granularApproval;
	if (granular === undefined) return false;
	if (request.kind === "tool") {
		if (request.toolName === "Skill") return granular.skillApproval;
		if (request.toolName === "request_permissions") return granular.requestPermissions;
		if (request.toolName === "mcp_elicitation" || request.provider === "mcp") return granular.mcpElicitations;
	}
	if (request.kind === "shell" || decision.matchedRuleIds.some((id) => !id.startsWith("builtin-"))) return granular.rules;
	return granular.sandboxApproval;
}

function applyApprovalPolicy(
	request: AccessRequest,
	decision: PolicyDecision,
	snapshot: SecuritySnapshot,
): PolicyDecision {
	if (decision.action === "deny") return decision;
	switch (snapshot.profile.approvalPolicy) {
		case "never":
			return decision.action === "ask"
				? { ...decision, action: "deny", reason: `approval policy never converted ask to deny: ${decision.reason}` }
				: decision;
		case "on-request":
			return isBuiltinSkippableOnRequest(request, decision, snapshot)
				? { ...decision, action: "allow", reason: `unrestricted on-request skipped ordinary mutation approval: ${decision.reason}` }
				: decision;
		case "untrusted":
			return request.kind === "filesystem" && request.operation === "read"
				? decision
				: { ...decision, action: "ask", reason: `untrusted policy requires approval: ${decision.reason}` };
		case "granular":
			if (decision.action !== "ask") return decision;
			return granularCategoryEnabled(request, decision, snapshot)
				? decision
				: { ...decision, action: "deny", reason: `granular approval category is disabled: ${decision.reason}` };
	}
}

export class PermissionEngine {
	public evaluate(requests: readonly AccessRequest[], snapshot: SecuritySnapshot): SecurityAccessEvaluation {
		const requestDecisions = requests.map((request) => {
			const builtin = builtinDecision(request, snapshot);
			if (builtin.action === "deny") return builtin;
			const ruleDecision = strongestRuleDecision(request, snapshot.rules, builtin);
			// AST failure is a fail-closed approval boundary: an allow rule cannot
			// turn an unknown parse into allow, while a matching deny still wins.
			const selected = builtin.matchedRuleIds.includes("builtin-shell-ast-failure") &&
				ruleDecision.action === "allow"
				? builtin
				: ruleDecision;
			return applyApprovalPolicy(request, selected, snapshot);
		});
		const aggregate = aggregatePolicyDecisions(requestDecisions);
		return { decision: aggregate.action, requests, requestDecisions, policyDigest: snapshot.policyDigest, reason: aggregate.reason };
	}
}
