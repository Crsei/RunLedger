/** Workspace security 只能收紧 user baseline 的统一校验。 */

import { isAbsolute, relative, resolve } from "node:path";
import type { SecurityConfigDocument, SecurityResult, SecuritySnapshot } from "../types.ts";

const RESTRICTIVE_BUILTIN_SELECTIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
	"read-only": Object.freeze(["read-only"]),
	"headless-workspace": Object.freeze(["read-only", "headless-workspace"]),
	"workspace-write": Object.freeze(["read-only", "headless-workspace", "workspace-write", "custom"]),
	"approve-for-me": Object.freeze(["read-only", "headless-workspace", "workspace-write", "approve-for-me", "custom"]),
	"danger-full-access": Object.freeze(["read-only", "headless-workspace", "workspace-write", "approve-for-me", "custom", "danger-full-access"]),
	custom: Object.freeze(["read-only", "headless-workspace", "workspace-write", "custom"]),
});

export function workspaceProfileSelectionRestricts(userProfile: string, candidateProfile: string): boolean {
	const allowed = RESTRICTIVE_BUILTIN_SELECTIONS[userProfile];
	return allowed === undefined
		? candidateProfile === userProfile || candidateProfile === "read-only"
		: allowed.includes(candidateProfile);
}

function failure(message: string): SecurityResult<never> {
	return { ok: false, error: { code: "invalid_config", message, retryable: false } };
}

/**
 * Project scope 只能选择语义上不宽于 user 的 profile，并追加 deny/ask
 * hardening。该校验同时供启动 resolver 和 durable settings port 使用。
 */
export function validateWorkspaceSecurityDocument(
	document: SecurityConfigDocument,
	user: SecurityConfigDocument,
): SecurityResult<void> {
	if (document.profiles !== undefined) return failure("workspace security cannot define permission profiles");
	if (
		document.approvalPolicy !== undefined ||
		document.approvalReviewer !== undefined ||
		document.granularApproval !== undefined ||
		document.sandbox !== undefined ||
		document.network !== undefined ||
		document.bashAnalyzerMode !== undefined
	) return failure("workspace security may only select a profile and add deny-only hardening");
	if (document.filesystem?.readRoots !== undefined || document.filesystem?.writeRoots !== undefined) {
		return failure("workspace security may not add filesystem roots");
	}
	if (document.rules?.some((rule) => rule.action === "allow")) {
		return failure("workspace security may not allow a rule");
	}
	if (document.profile === undefined) return { ok: true, value: undefined };
	const userProfile = user.profile ?? "workspace-write";
	return workspaceProfileSelectionRestricts(userProfile, document.profile)
		? { ok: true, value: undefined }
		: failure(RESTRICTIVE_BUILTIN_SELECTIONS[userProfile] === undefined
			? "workspace security profile would replace an unranked user profile"
			: "workspace security profile would widen the user baseline");
}

const FILESYSTEM_SCOPE = { "read-only": 0, "workspace-write": 1, unrestricted: 2 } as const;
const SANDBOX_STRENGTH = { off: 0, external: 1, "workspace-write": 2, "read-only": 3, strict: 4 } as const;
const BASH_STRENGTH = { legacy: 0, shadow: 1, ast: 2 } as const;

function within(root: string, target: string): boolean {
	const offset = relative(resolve(root), resolve(target));
	return offset === "" || (!offset.startsWith("..") && !isAbsolute(offset));
}

function rootsRestrict(candidate: readonly string[], baseline: readonly string[]): boolean {
	return candidate.every((target) => baseline.some((root) => within(root, target)));
}

function networkRestricts(candidate: SecuritySnapshot["profile"]["network"], baseline: SecuritySnapshot["profile"]["network"]): boolean {
	if (baseline.mode === "allow") return true;
	if (candidate.mode === "deny") return true;
	if (candidate.mode !== baseline.mode) return false;
	return candidate.allowedHosts.every((host) => baseline.allowedHosts.includes(host));
}

function approvalRestricts(candidate: SecuritySnapshot["profile"], baseline: SecuritySnapshot["profile"]): boolean {
	const candidatePolicy = candidate.approvalPolicy;
	const baselinePolicy = baseline.approvalPolicy;
	if (candidatePolicy === "never") return true;
	if (baselinePolicy === "never") return false;
	if (baselinePolicy === "on-request") return true;
	if (baselinePolicy === "untrusted") return candidatePolicy === "untrusted";
	if (candidatePolicy !== "granular") return false;
	return granularRestricts(candidate.granularApproval, baseline.granularApproval);
}

function granularRestricts(
	candidate: SecuritySnapshot["profile"]["granularApproval"],
	baseline: SecuritySnapshot["profile"]["granularApproval"],
): boolean {
	if (candidate === undefined || baseline === undefined) return false;
	return approvalFlags().every((key) => !candidate[key] || baseline[key]);
}

function approvalFlags(): readonly (keyof NonNullable<SecuritySnapshot["profile"]["granularApproval"]>)[] {
	return ["sandboxApproval", "rules", "skillApproval", "requestPermissions", "mcpElicitations"];
}

/**
 * 直接编辑 canonical project settings 也必须在启动时重新验证；不能把安全性
 * 寄托在某个写入 UI 曾经执行过校验。
 */
export function validateResolvedWorkspaceSecurity(
	candidate: SecuritySnapshot,
	baseline: SecuritySnapshot,
	document: SecurityConfigDocument,
): SecurityResult<void> {
	if (document.rules?.some((rule) => rule.action === "allow")) return failure("workspace security may not allow a rule");
	const restrictivePresetSelection = document.profile !== undefined &&
		workspaceProfileSelectionRestricts(baseline.profile.name, document.profile);
	if (FILESYSTEM_SCOPE[candidate.profile.filesystemMode] > FILESYSTEM_SCOPE[baseline.profile.filesystemMode]) {
		return failure("workspace security filesystem profile would widen the user baseline");
	}
	if (candidate.profile.sandbox === "external" || baseline.profile.sandbox === "external") {
		if (candidate.profile.sandbox !== baseline.profile.sandbox) return failure("workspace security sandbox profile would widen the user baseline");
	} else if (SANDBOX_STRENGTH[candidate.profile.sandbox] < SANDBOX_STRENGTH[baseline.profile.sandbox]) {
		return failure("workspace security sandbox profile would widen the user baseline");
	}
	if (!networkRestricts(candidate.profile.network, baseline.profile.network)) {
		return failure("workspace security network policy would widen the user baseline");
	}
	if (
		baseline.approvalReviewer !== "auto-review" &&
		candidate.approvalReviewer === "auto-review" &&
		!(restrictivePresetSelection && document.approvalReviewer === undefined)
	) {
		return failure("workspace security reviewer would widen the user baseline");
	}
	if (
		!approvalRestricts(candidate.profile, baseline.profile) &&
		!(restrictivePresetSelection && document.approvalPolicy === undefined && document.granularApproval === undefined)
	) {
		return failure("workspace security approval policy would widen the user baseline");
	}
	if (!rootsRestrict(candidate.filesystem.readRoots, baseline.filesystem.readRoots) || !rootsRestrict(candidate.filesystem.writeRoots, baseline.filesystem.writeRoots)) {
		return failure("workspace security filesystem roots would widen the user baseline");
	}
	const candidateBash = candidate.bashAnalyzer?.mode ?? "legacy";
	const baselineBash = baseline.bashAnalyzer?.mode ?? "legacy";
	if (BASH_STRENGTH[candidateBash] < BASH_STRENGTH[baselineBash]) {
		return failure("workspace security Bash analyzer would widen the user baseline");
	}
	return { ok: true, value: undefined };
}
