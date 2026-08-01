/** Runtime adapter ports 的中立 request/result/cancel 合同。 */

import type { IdentityContext } from "../identity/types.ts";
import type { AdapterIdentityRef } from "../protocol/adapter.ts";
import type { RuntimeErrorShape } from "../protocol/errors.ts";
import type { RuntimeContentRef, RuntimeDigest } from "../protocol/foundation.ts";
import type { CommandId, TraceId } from "../protocol/ids.ts";

export const RUNTIME_ADAPTER_PORT_ACTIONS = {
	runtime_event_store: ["append", "query_head", "query_range"],
	runtime_event_subscription: ["subscribe", "read", "checkpoint", "cancel"],
	workspace_service: ["bind", "validate", "checkpoint", "release"],
	capability_gateway: ["decide"],
	approval_coordinator: ["create", "query", "cancel"],
	sandbox_execution: ["resolve", "execute", "cancel"],
	artifact_store: ["record_intent", "put_metadata", "get_metadata", "commit"],
	resource_catalog: ["resolve", "search"],
	resource_snapshot: ["acquire", "release"],
	resource_invocation: ["invoke", "cancel"],
	model_stream: ["start", "cancel"],
	verification_runner: ["start", "cancel"],
	managed_policy: ["resolve"],
	credential_broker: ["grant", "revoke"],
	forge_provider: ["create_draft"],
	human_gate: ["request", "query", "cancel"],
	remote_executor: ["invoke", "cancel"],
	telemetry_exporter: ["deliver", "checkpoint"],
} as const;

export const RUNTIME_ADAPTER_PORT_NAMES = [
	"runtime_event_store",
	"runtime_event_subscription",
	"workspace_service",
	"capability_gateway",
	"approval_coordinator",
	"sandbox_execution",
	"artifact_store",
	"resource_catalog",
	"resource_snapshot",
	"resource_invocation",
	"model_stream",
	"verification_runner",
	"managed_policy",
	"credential_broker",
	"forge_provider",
	"human_gate",
	"remote_executor",
	"telemetry_exporter",
] as const satisfies readonly (keyof typeof RUNTIME_ADAPTER_PORT_ACTIONS)[];

export type RuntimeAdapterPortName = (typeof RUNTIME_ADAPTER_PORT_NAMES)[number];
export type AdapterPortAction<P extends RuntimeAdapterPortName = RuntimeAdapterPortName> =
	(typeof RUNTIME_ADAPTER_PORT_ACTIONS)[P][number];

export interface AdapterPortRequest<P extends RuntimeAdapterPortName = RuntimeAdapterPortName> {
	readonly port: P;
	readonly action: AdapterPortAction<P>;
	readonly requestId: CommandId;
	readonly identity: IdentityContext;
	readonly traceId: TraceId;
	readonly idempotencyKey: string;
	readonly expectedRevision?: number;
	readonly deadline: string;
	readonly inputDigest: RuntimeDigest;
	readonly inputRef?: RuntimeContentRef;
	readonly cancellationOf?: CommandId;
}

export type AdapterPortOutcome =
	| "ok"
	| "unsupported"
	| "denied"
	| "conflict"
	| "unavailable"
	| "cancelled"
	| "uncertain";
export type AdapterPortEffect = "none" | "accepted" | "terminal" | "uncertain";

export interface AdapterPortResult<P extends RuntimeAdapterPortName = RuntimeAdapterPortName> {
	readonly port: P;
	readonly action: AdapterPortAction<P>;
	readonly requestId: CommandId;
	readonly outcome: AdapterPortOutcome;
	readonly effect: AdapterPortEffect;
	readonly adapter: AdapterIdentityRef;
	readonly outputDigest: RuntimeDigest;
	readonly outputRef?: RuntimeContentRef;
	readonly receiptRef?: RuntimeContentRef;
	readonly error?: RuntimeErrorShape;
	readonly completedAt: string;
}

export interface AdapterProgressAnnotation<P extends RuntimeAdapterPortName = RuntimeAdapterPortName> {
	readonly port: P;
	readonly action: AdapterPortAction<P>;
	readonly requestId: CommandId;
	readonly sequence: number;
	readonly message: string;
	readonly annotationDigest: RuntimeDigest;
	readonly observedAt: string;
}

export interface RuntimeAdapterPort<P extends RuntimeAdapterPortName = RuntimeAdapterPortName> {
	execute(request: AdapterPortRequest<P>): Promise<AdapterPortResult<P>>;
}

export type RuntimeEventStorePort = RuntimeAdapterPort<"runtime_event_store">;
export type RuntimeEventSubscriptionPort = RuntimeAdapterPort<"runtime_event_subscription">;
export type WorkspaceServicePort = RuntimeAdapterPort<"workspace_service">;
export type CapabilityGatewayPort = RuntimeAdapterPort<"capability_gateway">;
export type ApprovalCoordinatorPort = RuntimeAdapterPort<"approval_coordinator">;
export type SandboxExecutionPort = RuntimeAdapterPort<"sandbox_execution">;
export type ArtifactStorePort = RuntimeAdapterPort<"artifact_store">;
export type RuntimeResourceCatalogPort = RuntimeAdapterPort<"resource_catalog">;
export type RuntimeResourceSnapshotPort = RuntimeAdapterPort<"resource_snapshot">;
export type RuntimeResourceInvocationPort = RuntimeAdapterPort<"resource_invocation">;
export type ModelStreamPort = RuntimeAdapterPort<"model_stream">;
export type VerificationRunnerPort = RuntimeAdapterPort<"verification_runner">;
export type ManagedPolicyPort = RuntimeAdapterPort<"managed_policy">;
export type CredentialBrokerPort = RuntimeAdapterPort<"credential_broker">;
export type ForgeProviderPort = RuntimeAdapterPort<"forge_provider">;
export type HumanGatePort = RuntimeAdapterPort<"human_gate">;
export type RemoteExecutorPort = RuntimeAdapterPort<"remote_executor">;
export type TelemetryExporterPort = RuntimeAdapterPort<"telemetry_exporter">;
