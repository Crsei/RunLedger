/**
 * Capability/approval/sandbox 的 Runtime 中立合同。
 *
 * TODO(runtime-phase-3): 冻结 claim 的资源约束、approval revocation、credential
 * receipt 和 sandbox enforcement 的 schema。这里不实现 deny > ask > allow，
 * 也不实现实际的文件、网络或进程执行。
 */

import type { ApprovalId, PrincipalId, WorkspaceId } from "./ids.ts";

export type CapabilityName =
	| "repository_read"
	| "workspace_write"
	| "dependency_install"
	| "network"
	| "process"
	| "credential"
	| "deploy"
	| "cross_workspace";

export type CapabilityDecision = "allow" | "ask" | "deny";

export interface CapabilityClaim {
	name: CapabilityName;
	resourceKind: "filesystem" | "network" | "process" | "credential" | "workspace" | "tool";
	resourceDigest: string;
	constraintsDigest: string;
}

export interface CapabilityRequestRef {
	requestId: string;
	capability: CapabilityName;
	argumentsDigest: string;
	workspaceEnvelopeDigest: string;
	policyDigest: string;
}

export interface ApprovalTicket {
	approvalId: ApprovalId;
	request: CapabilityRequestRef;
	principalId: PrincipalId;
	scope: "once" | "session" | "project";
	createdAt: string;
	expiresAt?: string;
}

export interface ApprovalReceiptRef {
	approvalId: ApprovalId;
	decision: "allowed" | "denied" | "cancelled" | "expired" | "revoked";
	decisionRevision: number;
	receiptDigest: string;
}

export interface CredentialGrantRef {
	grantId: string;
	credentialKind: string;
	audienceDigest: string;
	scopeDigest: string;
	expiresAt: string;
	receiptDigest: string;
}

export interface SandboxProfileRef {
	profileId: string;
	requested: "off" | "read-only" | "workspace-write" | "strict" | "external";
	policyDigest: string;
}

export interface SandboxExecutionReceiptRef {
	receiptId: string;
	profileId: string;
	backendId: string;
	enforcement: "enforced" | "degraded" | "unavailable" | "off";
	invocationDigest: string;
}

export interface ArtifactRef {
	authorityId: string;
	tenantId: string;
	storedDigest: string;
	kind: "diff" | "tool_output" | "log" | "test_report" | "screenshot" | "session_report";
	originalSize: number;
	storedSize: number;
	mediaType: string;
	redaction: "metadata_only" | "redacted" | "encrypted_forensic";
	transformReceipt: string;
	workspaceId?: WorkspaceId;
}
