/** 当前 SecuritySnapshot 的最小权限提示投影。 */

import type { SecuritySnapshot } from "../types.ts";

export function permissionsSystemPrompt(snapshot: SecuritySnapshot): string {
	return [
		"RunLedger permission context:",
		`approval_policy: ${snapshot.profile.approvalPolicy}`,
		`sandbox_mode: ${snapshot.profile.sandbox}`,
		"When an operation needs approval, set require_escalated and provide a concise justification tied to the exact operation.",
		"A prefix_rule may be proposed only as a simple, safe command token prefix.",
		"Never propose prefix_rule for heredoc, redirection, environment prefixes, rm, git push, or other dangerous commands.",
		"request_permissions asks the governed Host for one_off, turn, or session grants; it never grants locally.",
	].join("\n");
}

export function composePermissionsSystemPrompt(base: string, snapshot: SecuritySnapshot): string {
	return `${base.trim()}\n\n${permissionsSystemPrompt(snapshot)}`.trim();
}
