/** 无 UI 的 PermissionEngine。 */

import { isAbsolute, relative, resolve } from "node:path";
import type {
	AccessRequest,
	PolicyDecision,
	SecurityAccessEvaluation,
	SecuritySnapshot,
} from "../types.ts";
import { aggregatePolicyDecisions, strongestRuleDecision } from "./rule-matcher.ts";
import { analyzeShellCommand } from "./shell-analyzer.ts";

const SAFE_SHELL_COMMANDS = new Set(["pwd", "ls", "find", "grep", "rg", "fd", "git", "npm", "node", "npx", "tsx"]);
const DANGEROUS_SHELL_COMMANDS = new Set(["rm", "chmod", "chown", "chgrp", "kill", "pkill", "sudo", "tee"]);

function within(root: string, target: string): boolean {
	const offset = relative(root, target);
	return offset === "" || (!offset.startsWith("..") && !isAbsolute(offset));
}

function pathMatches(pattern: string, target: string): boolean {
	const normalized = resolve(target);
	const normalizedPattern = resolve(pattern);
	return within(normalizedPattern, normalized) || normalized === normalizedPattern;
}

function builtinDecision(request: AccessRequest, snapshot: SecuritySnapshot): PolicyDecision {
	switch (request.kind) {
		case "filesystem": {
			const target = resolve(snapshot.workspaceRoot, request.path);
			if (snapshot.filesystem.protectedPaths.some((path) => pathMatches(path, target))) {
				return { action: "deny", reason: "target is a protected control-plane path", matchedRuleIds: ["builtin-protected-path"], source: "builtin" };
			}
			const denied = request.operation === "read" ? snapshot.filesystem.denyRead : snapshot.filesystem.denyWrite;
			if (denied.some((path) => pathMatches(path, target))) {
				return { action: "deny", reason: "target matches a denied path", matchedRuleIds: ["builtin-denied-path"], source: "builtin" };
			}
			const roots = request.operation === "read" ? snapshot.filesystem.readRoots : snapshot.filesystem.writeRoots;
			if (!roots.some((root) => within(root, target))) {
				return { action: "deny", reason: "target is outside allowed roots", matchedRuleIds: ["builtin-root-boundary"], source: "builtin" };
			}
			return request.operation === "read"
				? { action: "allow", reason: "read is inside an allowed root", matchedRuleIds: ["builtin-read-root"], source: "builtin" }
				: { action: "ask", reason: "workspace mutation requires exact approval", matchedRuleIds: ["builtin-write-approval"], source: "builtin" };
		}
		case "shell": {
			const analysis = analyzeShellCommand(request.command);
			if (request.analysis === "unknown" || analysis.analysis === "unknown") {
				return { action: "ask", reason: "shell syntax could not be safely classified", matchedRuleIds: ["builtin-shell-unknown"], source: "builtin" };
			}
			const dangerous = analysis.segments.find((segment) =>
				DANGEROUS_SHELL_COMMANDS.has(segment.executable)
				|| (segment.executable === "git" && segment.arguments[0] === "push"),
			);
			if (dangerous) {
				return { action: "ask", reason: "dangerous shell command requires exact approval", matchedRuleIds: ["builtin-shell-dangerous"], source: "builtin" };
			}
			return analysis.segments.every((segment) => SAFE_SHELL_COMMANDS.has(segment.executable))
				? { action: "allow", reason: "known shell command is eligible for sandboxed execution", matchedRuleIds: ["builtin-shell-known"], source: "builtin" }
				: { action: "ask", reason: "shell executable is not in the known set", matchedRuleIds: ["builtin-shell-fallback"], source: "builtin" };
		}
		case "network": {
			if (snapshot.profile.network.mode === "deny") return { action: "deny", reason: "network policy is deny", matchedRuleIds: ["builtin-network-deny"], source: "builtin" };
			if (snapshot.profile.network.mode === "allowlist" && !snapshot.profile.network.allowedHosts.includes(request.host)) {
				return { action: "deny", reason: "host is outside the network allowlist", matchedRuleIds: ["builtin-network-host"], source: "builtin" };
			}
			return { action: "allow", reason: "network target is allowed", matchedRuleIds: ["builtin-network-allow"], source: "builtin" };
		}
		case "worktree":
			return { action: "ask", reason: "worktree mutation requires exact approval", matchedRuleIds: ["builtin-worktree-approval"], source: "builtin" };
		case "credential":
			return { action: "ask", reason: "credential use requires a scoped grant", matchedRuleIds: ["builtin-credential-approval"], source: "builtin" };
		case "browser":
			return {
				action: "ask",
				reason: `browser ${request.operation} requires an operation-scoped decision`,
				matchedRuleIds: [`builtin-browser-${request.operation}`],
				source: "builtin",
			};
		case "tool":
			return { action: "ask", reason: "unknown tool capability requires approval", matchedRuleIds: ["builtin-tool-unknown"], source: "fallback" };
	}
}

export class PermissionEngine {
	public evaluate(requests: readonly AccessRequest[], snapshot: SecuritySnapshot): SecurityAccessEvaluation {
		const requestDecisions = requests.map((request) =>
			strongestRuleDecision(request, snapshot.rules, builtinDecision(request, snapshot)),
		);
		let aggregate = aggregatePolicyDecisions(requestDecisions);
		if (aggregate.action === "ask" && snapshot.profile.approvalPolicy === "never") {
			aggregate = {
			...aggregate,
			action: "deny",
			reason: `approval policy never converted ask to deny: ${aggregate.reason}`,
		};
		}
		return {
			decision: aggregate.action,
			requests,
			requestDecisions,
			policyDigest: snapshot.policyDigest,
			reason: aggregate.reason,
		};
	}
}
