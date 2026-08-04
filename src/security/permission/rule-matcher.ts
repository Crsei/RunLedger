/** 规则匹配与全局 deny > ask > allow。 */

import type {
	AccessRequest,
	PolicyDecision,
	SecurityPolicySource,
	SecurityRule,
} from "../types.ts";

const ACTION_STRENGTH = { allow: 0, ask: 1, deny: 2 } as const;

export function accessRequestTarget(request: AccessRequest): string {
	switch (request.kind) {
		case "filesystem": return `${request.operation}:${request.path}`;
		case "shell": return request.command;
		case "network": return `${request.operation}:${request.host}${request.port === undefined ? "" : `:${request.port}`}`;
		case "worktree": return `${request.operation}:${request.target}`;
		case "tool": return `${request.toolName}${request.provider ? `:${request.provider}` : ""}`;
	}
}

function escapeRegExp(value: string): string {
	return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

export function matchesSecurityPattern(pattern: string, value: string): boolean {
	try {
		return new RegExp(`^${escapeRegExp(pattern).replaceAll("*", ".*")}$`, "u").test(value);
	} catch {
		return false;
	}
}

export function matchingRules(request: AccessRequest, rules: readonly SecurityRule[]): readonly SecurityRule[] {
	const target = accessRequestTarget(request);
	return rules.filter((rule) => rule.kind === request.kind && matchesSecurityPattern(rule.pattern, target));
}

export function strongestRuleDecision(
	request: AccessRequest,
	rules: readonly SecurityRule[],
	fallback: PolicyDecision,
): PolicyDecision {
	const matches = matchingRules(request, rules);
	if (matches.length === 0) return fallback;
	const strength = Math.max(...matches.map((rule) => ACTION_STRENGTH[rule.action]));
	const strongest = matches.filter((rule) => ACTION_STRENGTH[rule.action] === strength);
	const source: SecurityPolicySource = strongest[0]?.source ?? fallback.source;
	return {
		action: strongest[0]?.action ?? fallback.action,
		reason: `matched ${strongest.map((rule) => rule.id).join(",")}`,
		matchedRuleIds: strongest.map((rule) => rule.id).sort(),
		source,
	};
}

export function aggregatePolicyDecisions(decisions: readonly PolicyDecision[]): PolicyDecision {
	if (decisions.length === 0) {
		return { action: "ask", reason: "no access request was classified", matchedRuleIds: [], source: "fallback" };
	}
	const strength = Math.max(...decisions.map((decision) => ACTION_STRENGTH[decision.action]));
	const strongest = decisions.filter((decision) => ACTION_STRENGTH[decision.action] === strength);
	return {
		action: strongest[0]?.action ?? "ask",
		reason: strongest.map((decision) => decision.reason).join("; "),
		matchedRuleIds: [...new Set(strongest.flatMap((decision) => decision.matchedRuleIds))].sort(),
		source: strongest[0]?.source ?? "fallback",
	};
}
