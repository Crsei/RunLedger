/** 对外只传固定诊断，不透传脚本、用户审批文本或底层路径。 */

import type { SecurityResult } from "./types.ts";

export function securityRejectionSummary(error: Extract<SecurityResult<never>, { ok: false }>["error"]): string {
	const reason = error.message;
	if (reason.includes("agent policy configuration")) return "Agent policy configuration is protected. Propose changes through the user-controlled permissions/settings workflow.";
	if (reason.toLowerCase().includes("circuit breaker")) return "A system-level destructive operation requires explicit one-time user confirmation. Session rules and automatic approval cannot authorize it.";
	if (reason.includes("shell syntax could not be safely classified") || reason.includes("Bash AST classification failed closed")) return "Shell syntax could not be safely classified; the current approval policy denied the required approval.";
	if (reason.startsWith("matched ")) return "An explicit permission rule denied the request.";
	if (reason.includes("hardline shell policy")) return "A system safety prohibition denied the request.";
	if (reason.includes("headless")) return "The operation requires user confirmation, but no interactive approval channel is available.";
	if (reason.includes("constraint")) return "An execution constraint denied the request.";
	if (error.code === "protected_path") return "The requested path is protected by policy.";
	if (error.code === "approval_cancelled") return "User confirmation was cancelled or its channel became unavailable.";
	if (error.code === "approval_expired") return "User confirmation expired before execution.";
	if (error.code === "approval_stale") return "User confirmation no longer matches the current request or policy.";
	return "The request was rejected by the current security policy or user approval decision.";
}
