/** Plugin、Skill、Hook 与 MCP 的声明式扩展领域合同。 */

import type {
	ResourceActivationState,
	ResourceApprovalReceipt,
	ResourceCapabilityDeclaration,
	ResourceExposure,
	ResourceIdentity,
	ResourceManifestDigest,
	ResourceProvenance,
	ResourceRiskProfile,
	ResourceSource,
	ResourceTrustState,
	ResourceContentKind,
	RuntimeExecutionMetadata,
} from "../runtime/resources/types.ts";
import type { AuthorityId, PrincipalId, ResourceId, TenantId } from "../runtime/protocol/v3/ids.ts";
import type { ExtensionDiagnostic } from "./diagnostics.ts";

export const EXTENSION_SCHEMA_VERSION = 1 as const;
export type ExtensionSchemaVersion = typeof EXTENSION_SCHEMA_VERSION;

export const EXTENSION_KINDS = ["plugin", "skill", "hook", "mcp-server", "mcp-tool"] as const;
export type ExtensionKind = (typeof EXTENSION_KINDS)[number];
export type ExtensionSource = ResourceSource;

export interface ExtensionRuntimeScope {
	authorityId: AuthorityId;
	tenantId: TenantId;
	principalId: PrincipalId;
}

/**
 * 快照只保存可序列化 descriptor。handler、MCP client、transport 和进程句柄
 * 必须留在各 manager 的私有表中。
 */
export interface ExtensionResourceDescriptor {
	schemaVersion: ExtensionSchemaVersion;
	kind: ExtensionKind;
	identity: ResourceIdentity;
	provenance: ResourceProvenance;
	manifest: ResourceManifestDigest;
	displayName: string;
	description: string;
	runtimeName?: string;
	sourcePath: string;
	pluginId?: string;
	enabled: boolean;
	trust: ResourceTrustState;
	activation: ResourceActivationState;
	approvalReceiptId?: ResourceApprovalReceipt["receiptId"];
	capabilities: readonly ResourceCapabilityDeclaration[];
	risk: ResourceRiskProfile;
	exposure: ResourceExposure;
	diagnostics: readonly ExtensionDiagnostic[];
	tool?: {
		inputSchemaJson: string;
		maxInputBytes: number;
		resultContentKinds: readonly ResourceContentKind[];
		execution: RuntimeExecutionMetadata;
	};
}

export interface ExtensionComponentCounts {
	plugins: number;
	skills: number;
	hooks: number;
	mcpServers: number;
	mcpTools: number;
	ready: number;
	blocked: number;
	disabled: number;
	error: number;
}

export interface ExtensionSourceRoot {
	source: ExtensionSource;
	sourceKey: string;
	rootPath: string;
	priority: number;
	pluginId?: string;
}

export interface ExtensionStateEntry {
	enabled: boolean;
	updatedAt: string;
}

export interface ExtensionStateDocument {
	schemaVersion: ExtensionSchemaVersion;
	revision: number;
	resources: Readonly<Record<string, ExtensionStateEntry>>;
}

export interface ExtensionLifecycleAudit {
	schemaVersion: ExtensionSchemaVersion;
	kind: string;
	sessionId: string;
	snapshotId: string;
	resourceId?: ResourceId;
	resourceQualifiedId?: string;
	occurredAt: string;
	payload: Readonly<Record<string, unknown>>;
}

export interface ExtensionSpillRef {
	relativePath: string;
	digest: string;
	bytes: number;
}

export interface ExtensionSpillPort {
	write(kind: "hook-input" | "hook-output" | "mcp-result", bytes: Uint8Array): Promise<ExtensionSpillRef>;
}

export interface ExtensionClock {
	now(): Date;
}

export const systemExtensionClock: ExtensionClock = { now: () => new Date() };
