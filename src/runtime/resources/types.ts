/**
 * Plugin/MCP/Skill/Hooks 的 Runtime 中立资源合同。
 *
 * TODO(runtime-phase-5): 冻结 TypeBox schema、receipt 绑定和各类资源的状态
 * 转换。这里仅保存 descriptor/ref，不保存 loader、client、handler 或进程句柄。
 */

import type { CapabilityClaim, CapabilityDecision } from "../protocol/capability.ts";
import type { ResourceId, SnapshotId } from "../protocol/ids.ts";

export type ResourceKind = "plugin" | "skill" | "hook" | "mcp-server" | "mcp-tool";
export type ResourceSource = "builtin" | "user" | "project" | "plugin" | "session";

export interface ResourceIdentity {
	resourceId: ResourceId;
	kind: ResourceKind;
	qualifiedId: string;
	version: string;
	source: ResourceSource;
	digest: string;
}

export interface ResourceProvenance {
	source: ResourceSource;
	canonicalLocator: string;
	publisher?: string;
	signatureRef?: string;
	parentResourceId?: ResourceId;
}

export type ResourceTrustState = "untrusted" | "trusted" | "stale" | "revoked";
export type ResourceActivationState = "disabled" | "ready" | "blocked" | "failed";
export type ResourceExposure = "direct" | "deferred" | "hidden";

export interface ResourceApprovalReceipt {
	receiptId: string;
	identity: ResourceIdentity;
	manifestDigest: string;
	configDigest: string;
	commandDigest: string;
	assetsDigest: string;
	capabilityDigest: string;
	principalId: string;
	scope: "session" | "project" | "user";
	expiresAt?: string;
	revocationRevision: number;
}

export interface RuntimeToolDescriptor {
	identity: ResourceIdentity;
	provenance: ResourceProvenance;
	runtimeName: string;
	description: string;
	parametersSchema: Readonly<Record<string, unknown>>;
	claims: readonly CapabilityClaim[];
	exposure: ResourceExposure;
	isReadOnly: boolean;
	isDestructive: boolean;
	isConcurrencySafe: boolean;
	trust: ResourceTrustState;
	activation: ResourceActivationState;
}

export interface RuntimeToolInvocation {
	requestId: string;
	tool: ResourceIdentity;
	input: unknown;
	requestedClaims: readonly CapabilityClaim[];
	decision: CapabilityDecision;
	snapshotId: SnapshotId;
	correlationId: string;
}

export interface RuntimeToolResult {
	requestId: string;
	tool: ResourceIdentity;
	content: readonly ResourceContent[];
	isError: boolean;
	originalBytes: number;
	truncated: boolean;
	contentDigest: string;
}

export type ResourceContent =
	| { type: "text"; text: string }
	| { type: "image"; mediaType: string; dataBase64: string }
	| { type: "resource"; uri: string; text?: string }
	| { type: "json"; value: unknown };

export interface ResourceDiagnosticSummary {
	code: string;
	severity: "info" | "warning" | "error";
	message: string;
	resourceId?: ResourceId;
}

export interface RuntimeResourceSnapshot {
	snapshotId: SnapshotId;
	generation: number;
	createdAt: string;
	resources: readonly RuntimeToolDescriptor[];
	diagnostics: readonly ResourceDiagnosticSummary[];
	digest: string;
}

export interface ResourceLifecycleEvent {
	identity: ResourceIdentity;
	state: "discovered" | "approved" | "revoked" | "activated" | "deactivated" | "failed";
	snapshotId: SnapshotId;
	receiptId?: string;
	reason?: string;
}
