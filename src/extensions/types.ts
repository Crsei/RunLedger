/** Extension domain 的被动 descriptor 与扫描输入合同。 */

import type {
	ResourceActivationState,
	ResourceApprovalReceipt,
	ResourceIdentity,
	ResourceProvenance,
	ResourceTrustState,
} from "../runtime/resources/types.ts";
import type { AuthorityId, PrincipalId, TenantId } from "../runtime/protocol/ids.ts";
import type { ExtensionDiagnostic } from "./diagnostics.ts";

export type ExtensionKind = "plugin" | "skill" | "hook" | "mcp" | "mcp-server" | "mcp-tool";
export type ExtensionSource = "builtin" | "user" | "project" | "plugin" | "session";

export interface ExtensionRuntimeScope {
	readonly authorityId: AuthorityId;
	readonly tenantId: TenantId;
	readonly principalId: PrincipalId;
}

export interface ExtensionIdentity {
	kind: ExtensionKind;
	qualifiedId: string;
	version: string;
	source: ExtensionSource;
	digest: string;
}

export interface ExtensionResourceDescriptor {
	readonly kind?: ExtensionKind;
	readonly identity: ExtensionIdentity;
	readonly resource: ResourceIdentity;
	readonly provenance: ResourceProvenance;
	readonly displayName?: string;
	readonly description?: string;
	readonly sourcePath?: string;
	readonly pluginId?: string;
	readonly runtimeName?: string;
	readonly priority?: number;
	readonly enabled: boolean;
	readonly trusted: boolean;
	readonly ready: boolean;
	readonly trust?: ResourceTrustState;
	readonly activation?: ResourceActivationState;
	readonly approvalReceiptId?: ResourceApprovalReceipt["receiptId"];
	readonly diagnostics?: readonly ExtensionDiagnostic[];
	readonly capabilities?: readonly string[];
}

export interface ExtensionComponentCounts {
	readonly plugins: number;
	readonly skills: number;
	readonly hooks: number;
	readonly mcpServers: number;
	readonly mcpTools: number;
	readonly ready: number;
	readonly blocked: number;
	readonly disabled: number;
	readonly error: number;
}

export interface ExtensionSourceRoot {
	readonly source: ExtensionSource;
	readonly sourceKey: string;
	readonly rootPath: string;
	readonly priority: number;
	readonly pluginId?: string;
	readonly skillsPath?: string;
	readonly layout?: "extension-root" | "plugin-root";
}

export interface ExtensionStateEntry {
	readonly enabled: boolean;
	readonly updatedAt: string;
}

export interface ExtensionStateDocument {
	readonly revision: number;
	readonly resources: Readonly<Record<string, ExtensionStateEntry>>;
}
