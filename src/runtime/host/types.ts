/** Runtime Host 与 bounded transport 的纯数据合同。 */

import type { RuntimeDigest } from "../protocol/foundation.ts";
import type {
	AuthorityId,
	ConnectionId,
	PrincipalId,
	RepositoryId,
	RuntimeInstanceId,
	SessionId,
	TenantId,
	WorkspaceId,
} from "../protocol/ids.ts";

export const HOST_PROTOCOL_VERSION = 1 as const;
export const HOST_SESSION_STORAGE_CONTRACT_VERSION = 1 as const;

/** 所有 transport、replay、wait 与 process 资源的固定上限。 */
export const RUNTIME_HOST_BOUNDS = Object.freeze({
	maxFrameBytes: 256 * 1024,
	maxConnectionOutbox: 256,
	maxSubscriptionReplay: 2_048,
	maxPreActivationPending: 256,
	maxReverseRequestWaiters: 64,
	maxAckWindow: 256,
	maxSubscriptionsPerPrincipalSession: 8,
	maxOutputPageBytes: 64 * 1024,
	maxOutputRingBytes: 2 * 1024 * 1024,
	maxInputFrameBytes: 64 * 1024,
	maxProcessesPerSession: 32,
	maxProcessesPerHost: 128,
	maxWaitMs: 30_000,
	maxCompletionBatchMembers: 32,
	maxCompletionBatchBytes: 64 * 1024,
	});

export type HostPeerAttestorKind = "linux-so-peercred" | "windows-named-pipe" | "test";

export interface HostPeerAttestorDescriptor {
	readonly kind: HostPeerAttestorKind;
	readonly generation: number;
	readonly configDigest: RuntimeDigest;
}

export interface RuntimeHostScope {
	readonly authorityId: AuthorityId;
	readonly tenantId: TenantId;
	readonly workspaceId: WorkspaceId;
	readonly repositoryId: RepositoryId;
	readonly workspaceStorageKey: string;
	readonly protocolVersion: typeof HOST_PROTOCOL_VERSION;
	readonly hostBuildDigest: RuntimeDigest;
	readonly compositionDigest: RuntimeDigest;
	readonly settingsDigest: RuntimeDigest;
	readonly modelCatalogDigest: RuntimeDigest;
	readonly tracePolicyDigest: RuntimeDigest;
	readonly securityAdapterDigest: RuntimeDigest;
	readonly extensionProfileDigest: RuntimeDigest;
	readonly sessionStorageContractVersion: typeof HOST_SESSION_STORAGE_CONTRACT_VERSION;
	readonly peerAttestor: HostPeerAttestorDescriptor;
}

export interface HostCompatibilityEnvelope extends RuntimeHostScope {
	readonly compatibilityDigest: RuntimeDigest;
}

export interface HostConnectionPrincipal {
	readonly principalId: PrincipalId;
	readonly connectionId: ConnectionId;
	readonly attestationDigest: RuntimeDigest;
}

export interface HostSessionRef {
	readonly sessionId: SessionId;
	readonly hostGeneration: number;
	readonly sessionGeneration: number;
}

export interface RuntimeHostIdentity {
	readonly runtimeId: RuntimeInstanceId;
	readonly generation: number;
	readonly scope: RuntimeHostScope;
}

export type HostFrameKind =
	| "initialize_request"
	| "initialize_response"
	| "command_request"
	| "command_result"
	| "query_request"
	| "query_result"
	| "subscribe_request"
	| "subscription_event"
	| "ack_cursor"
	| "resync_required"
	| "reverse_request"
	| "reverse_response";

export interface HostFrameEnvelope {
	readonly frameId: string;
	readonly kind: HostFrameKind;
	readonly protocolVersion: typeof HOST_PROTOCOL_VERSION;
	readonly body: Record<string, unknown>;
}
