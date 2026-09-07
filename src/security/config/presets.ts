/** 三种系统权限预设及全部内置 profile 的唯一只读 registry。 */

import type { SandboxProfileName } from "../../runtime/contracts/public.ts";
import type { SandboxCapability } from "../sandbox/types.ts";
import type {
	ApprovalReviewerName,
	ManagedSecurityConstraints,
	PermissionProfileName,
	SecurityProfile,
} from "../types.ts";

export type BuiltinPermissionPresetId = "workspace-write" | "approve-for-me" | "danger-full-access";
export type BuiltinPermissionPresetLabel = "ask_for_approval" | "approve_for_me" | "full_access";

export type PresetAvailability =
	| { readonly state: "available" }
	| { readonly state: "unavailable"; readonly reason: string };

export interface BuiltinPermissionPreset {
	readonly id: BuiltinPermissionPresetId;
	readonly label: BuiltinPermissionPresetLabel;
	readonly description: string;
	readonly profile: SecurityProfile;
	readonly reviewer: ApprovalReviewerName;
	readonly requiresExplicitConfirmation: boolean;
	availability(constraints: ManagedSecurityConstraints | undefined, capability: SandboxCapability | undefined): PresetAvailability;
}

const SANDBOX_STRENGTH: Readonly<Record<SandboxProfileName, number>> = {
	off: 0,
	external: 1,
	"workspace-write": 2,
	"read-only": 3,
	strict: 4,
};

function sandboxSatisfies(requested: SandboxProfileName, minimum: SandboxProfileName): boolean {
	if (requested === "external" || minimum === "external") return requested === minimum;
	return SANDBOX_STRENGTH[requested] >= SANDBOX_STRENGTH[minimum];
}

function profileAvailability(profile: SecurityProfile, constraints: ManagedSecurityConstraints | undefined, capability: SandboxCapability | undefined): PresetAvailability {
	if (constraints !== undefined) {
		if (!constraints.allowedProfiles.includes(profile.name)) return { state: "unavailable", reason: "forbidden_by_managed_profile_constraint" };
		if (!constraints.allowedApprovalPolicies.includes(profile.approvalPolicy)) return { state: "unavailable", reason: "forbidden_by_managed_approval_constraint" };
		if (!sandboxSatisfies(profile.sandbox, constraints.minimumSandbox)) return { state: "unavailable", reason: "weaker_than_managed_sandbox_constraint" };
		if (constraints.forceNetworkDeny && profile.network.mode !== "deny") return { state: "unavailable", reason: "managed_network_deny" };
	}
	if (profile.sandbox !== "off" && (
		capability === undefined ||
		capability.status !== "available" ||
		!capability.supportsFilesystemIsolation ||
		!capability.supportsChildIsolation
	)) return { state: "unavailable", reason: "sandbox_capability_unavailable" };
	return { state: "available" };
}

const READ_ONLY: SecurityProfile = Object.freeze({
	name: "read-only",
	approvalPolicy: "on-request",
	filesystemMode: "read-only",
	network: Object.freeze({ mode: "deny", allowedHosts: Object.freeze([]) }),
	sandbox: "read-only",
});

const HEADLESS_WORKSPACE: SecurityProfile = Object.freeze({
	name: "headless-workspace",
	approvalPolicy: "never",
	filesystemMode: "workspace-write",
	network: Object.freeze({ mode: "deny", allowedHosts: Object.freeze([]) }),
	sandbox: "workspace-write",
});

const ASK_FOR_APPROVAL: SecurityProfile = Object.freeze({
	name: "workspace-write",
	approvalPolicy: "on-request",
	filesystemMode: "workspace-write",
	network: Object.freeze({ mode: "review", allowedHosts: Object.freeze([]) }),
	sandbox: "workspace-write",
});

const APPROVE_FOR_ME: SecurityProfile = Object.freeze({
	name: "approve-for-me",
	approvalPolicy: "on-request",
	filesystemMode: "workspace-write",
	network: Object.freeze({ mode: "review", allowedHosts: Object.freeze([]) }),
	sandbox: "workspace-write",
});

const FULL_ACCESS: SecurityProfile = Object.freeze({
	name: "danger-full-access",
	approvalPolicy: "never",
	filesystemMode: "unrestricted",
	network: Object.freeze({ mode: "allow", allowedHosts: Object.freeze([]) }),
	sandbox: "off",
});

const CUSTOM: SecurityProfile = Object.freeze({
	...ASK_FOR_APPROVAL,
	name: "custom",
});

const BUILTIN_PROFILES: Readonly<Record<PermissionProfileName, SecurityProfile>> = Object.freeze({
	"read-only": READ_ONLY,
	"workspace-write": ASK_FOR_APPROVAL,
	"approve-for-me": APPROVE_FOR_ME,
	"headless-workspace": HEADLESS_WORKSPACE,
	"danger-full-access": FULL_ACCESS,
	custom: CUSTOM,
});

const PRESETS: readonly BuiltinPermissionPreset[] = Object.freeze([
	Object.freeze({
		id: "workspace-write",
		label: "ask_for_approval",
		description: "Read and edit the workspace; ask before network access or workspace-external changes.",
		profile: ASK_FOR_APPROVAL,
		reviewer: "user",
		requiresExplicitConfirmation: false,
		availability: (constraints: ManagedSecurityConstraints | undefined, capability: SandboxCapability | undefined) => profileAvailability(ASK_FOR_APPROVAL, constraints, capability),
	}),
	Object.freeze({
		id: "approve-for-me",
		label: "approve_for_me",
		description: "Use deterministic local review for narrowly eligible low-risk requests.",
		profile: APPROVE_FOR_ME,
		reviewer: "auto-review",
		requiresExplicitConfirmation: false,
		availability: (constraints: ManagedSecurityConstraints | undefined, capability: SandboxCapability | undefined) => profileAvailability(APPROVE_FOR_ME, constraints, capability),
	}),
	Object.freeze({
		id: "danger-full-access",
		label: "full_access",
		description: "Allow normal commands, external writes and network access. System-destructive operations still require confirmation.",
		profile: FULL_ACCESS,
		reviewer: "user",
		requiresExplicitConfirmation: true,
		availability: (constraints: ManagedSecurityConstraints | undefined, capability: SandboxCapability | undefined) => profileAvailability(FULL_ACCESS, constraints, capability),
	}),
]);

export function builtinPermissionPresets(): readonly BuiltinPermissionPreset[] {
	return PRESETS;
}

export function builtinPermissionPreset(id: string): BuiltinPermissionPreset | undefined {
	return PRESETS.find((preset) => preset.id === id);
}

export function builtinSecurityProfile(id: string): SecurityProfile | undefined {
	return BUILTIN_PROFILES[id as PermissionProfileName];
}

export function builtinApprovalReviewer(id: string): ApprovalReviewerName | undefined {
	return builtinPermissionPreset(id)?.reviewer ?? (builtinSecurityProfile(id) === undefined ? undefined : "user");
}
