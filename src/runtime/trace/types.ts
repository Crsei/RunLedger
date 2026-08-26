import type { TelemetryObservation } from "../telemetry/local/types.ts";

export type TraceNodeKind =
	| "trace"
	| "agent"
	| "turn"
	| "model"
	| "tool"
	| "tool_attempt"
	| "context"
	| "verification"
	| "observation";

export type TraceEventPhase = "started" | "finished" | "failed" | "interrupted";

export type TraceMetadataValue = string | number | boolean;

export type TraceMetadata = Readonly<Record<string, TraceMetadataValue>>;

export interface TraceDigestRef {
	readonly storage: "digest_only";
	readonly digest: string;
	readonly mediaType: string;
	readonly size: number;
}

export interface TraceArtifactRef {
	readonly storage: "artifact";
	readonly artifactId: string;
	readonly digest: string;
	readonly mediaType: string;
	readonly size: number;
}

export type TraceContentDescriptor = TraceDigestRef | TraceArtifactRef;

export type TraceUsageSource =
	| "provider_reported"
	| "metered"
	| "estimated"
	| "unavailable"
	| "not_applicable";

export interface TraceUsage {
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly cacheReadTokens?: number;
	readonly cacheWriteTokens?: number;
	readonly reasoningTokens?: number;
	readonly source: TraceUsageSource;
}

export type TraceCostSource = "provider" | "pricing_table" | "metered" | "estimated" | "unavailable" | "not_applicable";

export interface TraceCost {
	readonly usdMicros?: number;
	readonly source: TraceCostSource;
	readonly pricingVersion?: string;
	readonly billable: boolean;
}

export interface TraceError {
	readonly code: string;
	readonly message: string;
	readonly outcomeCertain: boolean;
}

export interface TraceEventInput {
	readonly eventId: string;
	readonly traceId: string;
	readonly nodeId: string;
	readonly parentNodeId: string | null;
	readonly kind: TraceNodeKind;
	readonly name: string;
	readonly phase: TraceEventPhase;
	readonly timestamp: string;
	readonly durationMs?: number;
	readonly inputContent?: TraceContentDescriptor;
	readonly outputContent?: TraceContentDescriptor;
	readonly usage?: TraceUsage;
	readonly cost?: TraceCost;
	readonly error?: TraceError;
	readonly metadata?: TraceMetadata;
	readonly observation?: TelemetryObservation;
}

export interface TraceEvent extends TraceEventInput {
	readonly sequence: number;
	readonly previousEventHash: string | null;
	readonly eventHash: string;
}

export interface TraceTreeNode {
	readonly traceId: string;
	readonly nodeId: string;
	readonly parentNodeId: string | null;
	readonly kind: TraceNodeKind;
	readonly name: string;
	readonly phase: TraceEventPhase;
	readonly timestamp: string;
	readonly durationMs?: number;
	readonly inputContent?: TraceContentDescriptor;
	readonly outputContent?: TraceContentDescriptor;
	readonly usage?: TraceUsage;
	readonly cost?: TraceCost;
	readonly error?: TraceError;
	readonly metadata?: TraceMetadata;
	readonly observation?: TelemetryObservation;
	readonly children: readonly TraceTreeNode[];
}
