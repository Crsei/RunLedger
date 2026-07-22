/** Security/Permission 专项内部合同；Runtime envelope/ref/receipt 直接复用 v3 公共类型。 */

import type {
	ApprovalReceiptRef,
	CapabilityDecision,
	CapabilityName,
	SandboxProfileName,
} from "../runtime/protocol/v3/capability.ts";
import type {
	CommandId,
	PrincipalId,
	SessionId,
	ToolCallId,
	TurnId,
} from "../runtime/protocol/v3/ids.ts";
import type { WorkspaceExecutionEnvelope } from "../runtime/protocol/v3/workspace.ts";

export const SECURITY_POLICY_SOURCES = [
	"native-managed",
	"organization",
	"managed",
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
export type BrowserAccessOperation = "navigate" | "dom" | "script" | "download" | "upload" | "cookie" | "unknown";

export type AccessRequest =
	| {
			kind: "filesystem";
			operation: FilesystemAccessOperation;
			path: string;
	  }
	| {
			kind: "shell";
			command: string;
			cwd: string;
			analysis: "known" | "unknown";
	  }
	| {
			kind: "network";
			operation: "connect" | "fetch";
			host: string;
			port?: number;
	  }
	| {
			kind: "worktree";
			operation: "create" | "remove" | "apply" | "gc";
			target: string;
	  }
	| {
			kind: "credential";
			operation: "resolve" | "inject" | "revoke";
			credentialKind: string;
			audience: string;
	  }
	| {
			kind: "browser";
			operation: BrowserAccessOperation;
			resourceDigest: string;
	  }
	| {
			kind: "tool";
			toolName: string;
			provider?: string;
	  };

export interface SecurityRule {
	id: string;
	action: CapabilityDecision;
	kind: AccessRequest["kind"];
	pattern: string;
	source: SecurityPolicySource;
}

export interface FilesystemPolicy {
	readRoots: readonly string[];
	writeRoots: readonly string[];
	denyRead: readonly string[];
	denyWrite: readonly string[];
	protectedPaths: readonly string[];
}

export interface NetworkPolicy {
	mode: NetworkPolicyMode;
	allowedHosts: readonly string[];
}

export interface SecurityProfile {
	name: PermissionProfileName;
	approvalPolicy: ApprovalPolicyName;
	filesystemMode: "read-only" | "workspace-write" | "unrestricted";
	network: NetworkPolicy;
	sandbox: SandboxProfileName;
}

export interface SecurityConfigDocument {
	profile?: PermissionProfileName;
	approvalPolicy?: ApprovalPolicyName;
	sandbox?: SandboxProfileName;
	network?: NetworkPolicy;
	filesystem?: Partial<FilesystemPolicy>;
	rules?: readonly Omit<SecurityRule, "source">[];
}

export interface ManagedSecurityConstraints {
	allowedProfiles: readonly PermissionProfileName[];
	allowedApprovalPolicies: readonly ApprovalPolicyName[];
	minimumSandbox: SandboxProfileName;
	forceNetworkDeny: boolean;
}

export interface SecurityConfigLayer {
	source: SecurityPolicySource;
	document: SecurityConfigDocument;
	documentDigest: string;
}

export interface SecuritySnapshot {
	profile: SecurityProfile;
	filesystem: FilesystemPolicy;
	rules: readonly SecurityRule[];
	sources: readonly SecurityPolicySource[];
	workspaceRoot: string;
	tempRoot: string;
	policyDigest: string;
	createdAt: string;
}

export interface PolicyDecision {
	action: CapabilityDecision;
	reason: string;
	matchedRuleIds: readonly string[];
	source: SecurityPolicySource;
}

export interface SecurityAccessEvaluation {
	decision: CapabilityDecision;
	capability?: CapabilityName;
	requests: readonly AccessRequest[];
	requestDecisions: readonly PolicyDecision[];
	policyDigest: string;
	reason: string;
	workspace?: WorkspaceExecutionEnvelope;
}

export interface PermissionPrompt {
	requestId: CommandId;
	sessionId: SessionId;
	toolCallId: ToolCallId;
	toolName: string;
	summary: string;
	requests: readonly AccessRequest[];
	argumentsDigest: string;
	cwd: string;
	policyDigest: string;
	createdAt: string;
	expiresAt: string;
}

export type PermissionPromptResponse =
	| { decision: "allow-once"; decidedBy: PrincipalId }
	| { decision: "deny"; decidedBy: PrincipalId; reason?: string }
	| { decision: "cancel"; decidedBy: PrincipalId }
	| { decision: "follow-up-replacement"; decidedBy: PrincipalId; replacementDigest: string }
	| { decision: "channel-failure"; decidedBy: PrincipalId };

export interface PermissionPrompter {
	request(prompt: PermissionPrompt, signal?: AbortSignal): Promise<PermissionPromptResponse>;
}

export interface AuthorizationRequest {
	requestId: CommandId;
	sessionId: SessionId;
	turnId: TurnId;
	toolCallId: ToolCallId;
	toolName: string;
	arguments: unknown;
	argumentsDigest: string;
	cwd: string;
	requests: readonly AccessRequest[];
	workspace: WorkspaceExecutionEnvelope;
	snapshot: SecuritySnapshot;
}

export interface AuthorizationResult {
	outcome: "allow" | "deny";
	decisionSource: SecurityPolicySource | "approval";
	requests: readonly AccessRequest[];
	policyDigest: string;
	approval?: ApprovalReceiptRef;
	reason: string;
}

export interface SessionGrant {
	grantId: string;
	sessionId: SessionId;
	projectIdentityDigest: string;
	requestDigest: string;
	policyDigest: string;
	scope: "once" | "session" | "project";
	createdAt: string;
	expiresAt?: string;
	revokedAt?: string;
}

export interface BoundaryViolation {
	path: string;
	kind: "raw-fs" | "raw-process" | "raw-network" | "path-escape" | "protected-path";
	message: string;
}

export type SecurityErrorCode =
	| "invalid_config"
	| "invalid_request"
	| "policy_denied"
	| "approval_required"
	| "approval_cancelled"
	| "approval_expired"
	| "approval_stale"
	| "path_escape"
	| "protected_path"
	| "network_denied"
	| "authentication_failed"
	| "rate_limited"
	| "taint_denied"
	| "sandbox_unavailable"
	| "credential_unavailable"
	| "remote_unavailable";

export interface SecurityError {
	code: SecurityErrorCode;
	message: string;
	retryable: boolean;
}

export type SecurityResult<T> = { ok: true; value: T } | { ok: false; error: SecurityError };
