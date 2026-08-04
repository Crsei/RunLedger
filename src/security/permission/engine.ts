/** 无 UI 的最小 PermissionEngine；规则和默认边界均 fail closed。 */

import { isAbsolute, relative, resolve } from "node:path";
import type { AccessRequest, PolicyDecision, SecurityAccessEvaluation, SecuritySnapshot } from "../types.ts";
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

export class PermissionEngine {
	public evaluate(requests: readonly AccessRequest[], snapshot: SecuritySnapshot): SecurityAccessEvaluation {
		const requestDecisions = requests.map((request) => {
			const builtin = builtinDecision(request, snapshot);
			if (builtin.action === "deny") return builtin;
			return strongestRuleDecision(request, snapshot.rules, builtin);
		});
		let aggregate = aggregatePolicyDecisions(requestDecisions);
		if (aggregate.action === "ask" && snapshot.profile.approvalPolicy === "never") {
			aggregate = {
				...aggregate,
				action: "deny",
				reason: `approval policy never converted ask to deny: ${aggregate.reason}`,
			};
		}
		return { decision: aggregate.action, requests, requestDecisions, policyDigest: snapshot.policyDigest, reason: aggregate.reason };
	}
}
