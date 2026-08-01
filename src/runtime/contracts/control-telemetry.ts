/** Control plane、composition、policy、cost、telemetry 与 remote 的被动合同。 */

import type { RuntimeContentRef, RuntimeDigest, RuntimeStreamHead } from "../protocol/foundation.ts";
import type {
	AgentId,
	AuthorityId,
	PrincipalId,
	ReceiptId,
	RuntimeId,
	RuntimeInstanceId,
	SessionId,
	TenantId,
	ToolCallId,
	TurnId,
} from "../protocol/ids.ts";

export interface AdapterIdentityRef {
	readonly adapterId: string;
	readonly generation: number;
	readonly configDigest: RuntimeDigest;
	readonly trustRef?: RuntimeContentRef;
	readonly healthRef?: RuntimeContentRef;
}

export interface RuntimeActivity {
	readonly sessionId: SessionId;
	readonly turnId?: TurnId;
	readonly toolCallId?: ToolCallId;
	readonly agentId?: AgentId;
	readonly state: "idle" | "running" | "waiting" | "stopping" | "terminal" | "uncertain";
	readonly sourceHead: RuntimeStreamHead;
	readonly lastDurableProgressAt: string;
	readonly costSummaryRef?: RuntimeContentRef;
	readonly exporterHealthRef?: RuntimeContentRef;
}

export interface ProductionCompositionReceipt {
	readonly receiptId: ReceiptId;
	readonly runtimeId: RuntimeInstanceId;
	readonly generation: number;
	readonly featureRequirementsDigest: RuntimeDigest;
	readonly adapters: readonly AdapterIdentityRef[];
	readonly effectiveFeatures: readonly string[];
	readonly compositionDigest: RuntimeDigest;
	readonly issuedAt: string;
	readonly expiresAt: string;
}

export interface ManagedPolicyRef {
	readonly policyId: ReceiptId;
	readonly sourceDigests: readonly RuntimeDigest[];
	readonly winnerDigest: RuntimeDigest;
	readonly loserDigests: readonly RuntimeDigest[];
	readonly denyUnionDigest: RuntimeDigest;
	readonly normalizationReasonCode: string;
	readonly effectiveDigest: RuntimeDigest;
	readonly receiptRef: RuntimeContentRef;
}

export interface CostRecord {
	readonly receiptId: ReceiptId;
	readonly sessionId: SessionId;
	readonly parentSessionId?: SessionId;
	readonly providerId: string;
	readonly modelId: string;
	readonly operation: "model_call" | "tool_call" | "verification" | "remote_execution";
	readonly inputUnits: number;
	readonly outputUnits: number;
	readonly cacheUnits: number;
	readonly toolUnits: number;
	readonly currency: string;
	readonly estimatedMicrounits: number;
	readonly finalMicrounits?: number;
	readonly reconciliationRef?: RuntimeContentRef;
	readonly recordedAt: string;
}

export interface TelemetryManifest {
	readonly manifestId: ReceiptId;
	readonly allowedFieldsDigest: RuntimeDigest;
	readonly sinksDigest: RuntimeDigest;
	readonly samplingPermille: number;
	readonly redactionPolicyDigest: RuntimeDigest;
	readonly retentionDays: number;
	readonly tenantId: TenantId;
	readonly exporter: AdapterIdentityRef;
	readonly manifestDigest: RuntimeDigest;
}

export interface RemoteInvocationRef {
	readonly receiptId: ReceiptId;
	readonly authorityId: AuthorityId;
	readonly tenantId: TenantId;
	readonly workloadId: string;
	readonly workspaceRef: RuntimeContentRef;
	readonly capabilityRef: RuntimeContentRef;
	readonly credentialGrantRef: RuntimeContentRef;
	readonly requestDigest: RuntimeDigest;
	readonly executorAttestationRef: RuntimeContentRef;
	readonly resultReceiptRef: RuntimeContentRef;
}

export interface LifecycleRef {
	readonly subjectKind: "session" | "handoff" | "deletion" | "retention";
	readonly subjectId: RuntimeId;
	readonly authorityHead: RuntimeStreamHead;
	readonly legalHoldRef?: RuntimeContentRef;
	readonly referenceGraphDigest: RuntimeDigest;
	readonly tombstoneRef?: RuntimeContentRef;
}
