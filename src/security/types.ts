/**
 * Security/Permission 专项 Phase 0 的内部类型。
 *
 * TODO(security-phase-1): 实现 config loader、deny > ask > allow、shell analyzer、
 * approval coordinator 和 receipt 持久化。本文件不得重新定义 Runtime envelope、
 * capability decision 或 Runtime event union。
 */

import type { CapabilityDecision, CapabilityName } from "../runtime/protocol/capability.ts";
import type { WorkspaceExecutionEnvelope } from "../runtime/protocol/workspace.ts";

export type AccessRequest =
	| { kind: "filesystem"; operation: "read" | "write" | "delete"; path: string }
	| { kind: "shell"; command: string; cwd: string; analysis: "known" | "unknown" }
	| { kind: "network"; operation: "connect" | "fetch"; host: string; port?: number }
	| { kind: "worktree"; operation: "create" | "remove" | "apply" | "gc"; target: string }
	| { kind: "tool"; toolName: string; provider?: string };

export interface SecurityRule {
	id: string;
	action: CapabilityDecision;
	kind: AccessRequest["kind"];
	pattern: string;
	source: "managed" | "project" | "user" | "session" | "builtin";
}

export interface SecurityProfile {
	profileId: string;
	approvalPolicy: "on-request" | "never";
	filesystem: "read-only" | "workspace-write" | "unrestricted";
	network: "deny" | "allow";
	sandbox: "off" | "read-only" | "workspace-write" | "strict" | "external";
}

export interface SecuritySnapshot {
	profile: SecurityProfile;
	rules: readonly SecurityRule[];
	policyDigest: string;
	createdAt: string;
}

export interface SecurityAccessEvaluation {
	decision: CapabilityDecision;
	capability?: CapabilityName;
	requests: readonly AccessRequest[];
	policyDigest: string;
	reason: string;
	workspace?: WorkspaceExecutionEnvelope;
}

export interface BoundaryViolation {
	path: string;
	kind: "raw-fs" | "raw-process" | "raw-network" | "path-escape" | "protected-path";
	message: string;
}
