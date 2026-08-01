/** Plugin/MCP/Skill/Hooks 的 Runtime 中立资源合同。 */

import type { CapabilityClaim } from "../protocol/capability.ts";
import type { RuntimeContentRef, RuntimeDigest, RuntimeStreamHead } from "../protocol/foundation.ts";
import type { CommandId, PrincipalId, ReceiptId, ResourceId, SnapshotId, TraceId } from "../protocol/ids.ts";

export type ResourceKind = "plugin" | "skill" | "hook" | "mcp-server" | "mcp-tool";
export type ResourceSource = "builtin" | "user" | "project" | "plugin" | "session";

export interface ResourceIdentity {
	readonly resourceId: ResourceId;
	readonly kind: ResourceKind;
	readonly qualifiedId: string;
	readonly version: string;
	readonly source: ResourceSource;
	readonly digest: RuntimeDigest;
}

export interface ResourceProvenance {
	readonly source: ResourceSource;
	readonly sourceLocatorDigest: RuntimeDigest;
	readonly publisher?: string;
	readonly signatureRef?: RuntimeContentRef;
	readonly parentResourceId?: ResourceId;
}

export type ResourceTrustState = "untrusted" | "trusted" | "stale" | "revoked";
export type ResourceActivationState = "disabled" | "ready" | "blocked" | "failed";
export type ResourceExposure = "direct" | "deferred" | "hidden";

export interface ResourceApprovalReceipt {
	readonly receiptId: ReceiptId;
	readonly identity: ResourceIdentity;
	readonly manifestDigest: RuntimeDigest;
	readonly configDigest: RuntimeDigest;
	readonly commandDigest: RuntimeDigest;
	readonly assetsDigest: RuntimeDigest;
	readonly capabilityDigest: RuntimeDigest;
	readonly principalId: PrincipalId;
	readonly scope: "session" | "project" | "user";
	readonly approvedAt: string;
	readonly expiresAt?: string;
	readonly revocationRevision: number;
}

export interface RuntimeToolDescriptor {
	readonly identity: ResourceIdentity;
	readonly provenance: ResourceProvenance;
	readonly runtimeName: string;
	readonly description: string;
	readonly parametersSchemaRef: RuntimeContentRef;
	readonly claims: readonly CapabilityClaim[];
	readonly exposure: ResourceExposure;
	readonly isReadOnly: boolean;
	readonly isDestructive: boolean;
	readonly isConcurrencySafe: boolean;
	readonly trust: ResourceTrustState;
	readonly activation: ResourceActivationState;
	readonly descriptorDigest: RuntimeDigest;
}

export interface RuntimeToolInvocation {
	readonly requestId: CommandId;
	readonly tool: ResourceIdentity;
	readonly inputDigest: RuntimeDigest;
	readonly inputRef?: RuntimeContentRef;
	readonly requestedClaims: readonly CapabilityClaim[];
	readonly decisionReceiptRef: RuntimeContentRef;
	readonly snapshotId: SnapshotId;
	readonly correlationId: TraceId;
}

export type ResourceContent =
	| { readonly type: "text"; readonly text: string }
	| { readonly type: "content_ref"; readonly ref: RuntimeContentRef };

export interface RuntimeToolResult {
	readonly requestId: CommandId;
	readonly tool: ResourceIdentity;
	readonly content: readonly ResourceContent[];
	readonly outcome: "ok" | "error" | "denied" | "cancelled" | "unsupported";
	readonly originalBytes: number;
	readonly truncated: boolean;
	readonly contentDigest: RuntimeDigest;
}

export interface ResourceDiagnosticSummary {
	readonly code: string;
	readonly severity: "info" | "warning" | "error";
	readonly message: string;
	readonly resourceId?: ResourceId;
}

export interface RuntimeResourceSnapshot {
	readonly snapshotId: SnapshotId;
	readonly generation: number;
	readonly createdAt: string;
	readonly sourceHead: RuntimeStreamHead;
	readonly resources: readonly RuntimeToolDescriptor[];
	readonly diagnostics: readonly ResourceDiagnosticSummary[];
	readonly digest: RuntimeDigest;
	readonly completeness: "complete" | "partial";
}

export interface ResourceLifecycleEvent {
	readonly identity: ResourceIdentity;
	readonly state: "discovered" | "approved" | "revoked" | "activated" | "deactivated" | "failed";
	readonly snapshotId: SnapshotId;
	readonly receiptRef?: RuntimeContentRef;
	readonly reasonCode?: string;
}
