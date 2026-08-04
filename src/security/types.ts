/** Security/Permission 专项内部合同；Runtime 公共 envelope/ref/receipt 直接复用。 */

import type {
	ApprovalReceiptRef,
	CapabilityDecision,
	CapabilityName,
	CommandId,
	PrincipalId,
	RuntimeDigest,
	SessionId,
	ToolCallId,
	TurnId,
	WorkspaceExecutionEnvelope,
} from "../runtime/contracts/public.ts";
import type { SandboxProfileName } from "../runtime/contracts/public.ts";

export const SECURITY_POLICY_SOURCES = [
	"managed",
	"organization",
	"project",
	"user",
	"session",
	"builtin",
	"fallback",
] as const;
export type SecurityPolicySource = (typeof SECURITY_POLICY_SOURCES)[number];

export const PERMISSION_PROFILE_NAMES = [
	"read-only",
	"workspace-write",
	"headless-workspace",
	"danger-full-access",
	"custom",
] as const;
export type PermissionProfileName = (typeof PERMISSION_PROFILE_NAMES)[number];
export type ApprovalPolicyName = "on-request" | "never";
export type NetworkPolicyMode = "deny" | "allow" | "allowlist";
export type FilesystemAccessOperation = "read" | "write" | "delete";

export type AccessRequest =
	| { readonly kind: "filesystem"; readonly operation: FilesystemAccessOperation; readonly path: string }
	| { readonly kind: "shell"; readonly command: string; readonly cwd: string; readonly analysis: "known" | "unknown" }
	| { readonly kind: "network"; readonly operation: "connect" | "fetch"; readonly host: string; readonly port?: number }
	| { readonly kind: "worktree"; readonly operation: "create" | "remove" | "apply" | "gc"; readonly target: string }
	| { readonly kind: "tool"; readonly toolName: string; readonly provider?: string };

export interface SecurityRule {
	readonly id: string;
	readonly action: CapabilityDecision;
	readonly kind: AccessRequest["kind"];
	readonly pattern: string;
	readonly source: SecurityPolicySource;
}

export interface FilesystemPolicy {
	readonly readRoots: readonly string[];
	readonly writeRoots: readonly string[];
	readonly denyRead: readonly string[];
	readonly denyWrite: readonly string[];
	readonly protectedPaths: readonly string[];
}

export interface NetworkPolicy {
	readonly mode: NetworkPolicyMode;
	readonly allowedHosts: readonly string[];
}

export interface SecurityProfile {
	readonly name: PermissionProfileName;
	readonly approvalPolicy: ApprovalPolicyName;
	readonly filesystemMode: "read-only" | "workspace-write" | "unrestricted";
	readonly network: NetworkPolicy;
	readonly sandbox: SandboxProfileName;
}

export interface SecurityConfigDocument {
	readonly profile?: PermissionProfileName;
	readonly approvalPolicy?: ApprovalPolicyName;
	readonly sandbox?: SandboxProfileName;
	readonly network?: NetworkPolicy;
	readonly filesystem?: Partial<FilesystemPolicy>;
	readonly rules?: readonly Omit<SecurityRule, "source">[];
}

export interface ManagedSecurityConstraints {
	readonly allowedProfiles: readonly PermissionProfileName[];
	readonly allowedApprovalPolicies: readonly ApprovalPolicyName[];
	readonly minimumSandbox: SandboxProfileName;
	readonly forceNetworkDeny: boolean;
}

export interface SecurityConfigLayer {
	readonly source: SecurityPolicySource;
	readonly document: SecurityConfigDocument;
	readonly documentDigest: RuntimeDigest;
}

export interface SecuritySnapshot {
	readonly profile: SecurityProfile;
	readonly filesystem: FilesystemPolicy;
	readonly rules: readonly SecurityRule[];
	readonly sources: readonly SecurityPolicySource[];
	readonly workspaceRoot: string;
	readonly tempRoot: string;
	readonly policyDigest: RuntimeDigest;
	readonly createdAt: string;
}

export interface PolicyDecision {
	readonly action: CapabilityDecision;
	readonly reason: string;
	readonly matchedRuleIds: readonly string[];
	readonly source: SecurityPolicySource;
}

export interface SecurityAccessEvaluation {
	readonly decision: CapabilityDecision;
	readonly requests: readonly AccessRequest[];
	readonly requestDecisions: readonly PolicyDecision[];
	readonly policyDigest: RuntimeDigest;
	readonly reason: string;
}

export interface PermissionPrompt {
	readonly requestId: CommandId;
	readonly sessionId: SessionId;
	readonly toolCallId: ToolCallId;
	readonly toolName: string;
	readonly summary: string;
	readonly requests: readonly AccessRequest[];
	readonly argumentsDigest: RuntimeDigest;
	readonly cwd: string;
	readonly policyDigest: RuntimeDigest;
	readonly createdAt: string;
	readonly expiresAt: string;
}

export type PermissionPromptResponse =
	| { readonly decision: "allow-once"; readonly decidedBy: PrincipalId }
	| { readonly decision: "deny"; readonly decidedBy: PrincipalId; readonly reason?: string }
	| { readonly decision: "cancel"; readonly decidedBy: PrincipalId };

export interface PermissionPrompter {
	request(prompt: PermissionPrompt, signal?: AbortSignal): Promise<PermissionPromptResponse>;
}

export interface AuthorizationRequest {
	readonly requestId: CommandId;
	readonly sessionId: SessionId;
	readonly turnId: TurnId;
	readonly toolCallId: ToolCallId;
	readonly toolName: string;
	readonly argumentsDigest: RuntimeDigest;
	readonly cwd: string;
	readonly requests: readonly AccessRequest[];
	readonly workspace: WorkspaceExecutionEnvelope;
	readonly snapshot: SecuritySnapshot;
}

export interface AuthorizationResult {
	readonly outcome: "allow" | "deny";
	readonly decisionSource: SecurityPolicySource | "approval" | "fallback";
	readonly requests: readonly AccessRequest[];
	readonly policyDigest: RuntimeDigest;
	readonly approval?: ApprovalReceiptRef;
	readonly reason: string;
	readonly capability?: CapabilityName;
}

export type SecurityErrorCode =
	| "invalid_config"
	| "invalid_request"
	| "policy_denied"
	| "approval_cancelled"
	| "approval_expired"
	| "approval_stale"
	| "path_escape"
	| "protected_path"
	| "network_denied"
	| "registry_failed"
	| "git_failed"
	| "cleanup_failed";

export interface SecurityError {
	readonly code: SecurityErrorCode;
	readonly message: string;
	readonly retryable: boolean;
}

export type SecurityResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: SecurityError };
