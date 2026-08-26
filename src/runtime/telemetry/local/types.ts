import type {
	AgentId,
	AttemptId,
	CommandId,
	EventId,
	ExecutionId,
	GoalId,
	TaskId,
	ToolCallId,
	TraceId,
	TurnId,
	SessionId,
} from "../../protocol/ids.ts";

export type ObservationUnit = "bytes" | "tokens" | "usd_micros" | "milliseconds" | "count";

export type ObservationAccuracy = "exact" | "sampled" | "estimated" | "upper_bound";

export type ObservationSource =
	| "runtime_meter"
	| "provider_reported"
	| "canonical_serialization"
	| "linux_proc"
	| "derived";

export type ObservationUnavailableReason =
	| "recording_disabled"
	| "transport_not_instrumented"
	| "platform_unsupported"
	| "permission_denied"
	| "correlation_missing"
	| "provider_usage_missing"
	| "sample_failed"
	| "not_applicable";

export type ObservedQuantity<TUnit extends ObservationUnit> =
	| {
			readonly availability: "available";
			readonly unit: TUnit;
			readonly value: number;
			readonly accuracy: ObservationAccuracy;
			readonly source: ObservationSource;
		}
	| {
			readonly availability: "unavailable";
			readonly unit: TUnit;
			readonly reason: ObservationUnavailableReason;
		};

export interface TelemetryCorrelationContext {
	readonly sessionId: SessionId;
	readonly traceId: TraceId;
	readonly ownerGeneration: number;
	readonly agentId?: AgentId;
	readonly turnId?: TurnId;
	readonly toolCallId?: ToolCallId;
	readonly commandId?: CommandId;
	readonly executionId?: ExecutionId;
	readonly goalId?: GoalId;
	readonly planRevision?: number;
	readonly taskId?: TaskId;
	readonly attemptId?: AttemptId;
	readonly verificationCommandId?: CommandId;
}

export interface TelemetryObservationBase {
	readonly format: "runledger.telemetry.observation";
	readonly observationId: EventId;
	readonly observedAt: string;
	readonly monotonicOffsetMs: number;
	readonly correlation: TelemetryCorrelationContext;
}

export interface TrafficObservation extends TelemetryObservationBase {
	readonly kind: "traffic";
	readonly channel: "llm_http" | "llm_sse" | "llm_websocket" | "mcp_http" | "governed_http" | "gateway";
	readonly direction: "tx" | "rx";
	readonly boundary: "request_body" | "response_body" | "message_payload";
	readonly bytes: ObservedQuantity<"bytes">;
	readonly transportAttempt: number;
	readonly terminal: "completed" | "aborted" | "failed";
}

export interface ProcessIoObservation extends TelemetryObservationBase {
	readonly kind: "process_io";
	readonly stream: "stdin" | "stdout" | "stderr" | "pty_output";
	readonly observedBytes: ObservedQuantity<"bytes">;
	readonly retainedBytes: ObservedQuantity<"bytes">;
}

export interface RuntimeMemoryObservation extends TelemetryObservationBase {
	readonly kind: "runtime_memory";
	readonly rssBytes: ObservedQuantity<"bytes">;
	readonly heapTotalBytes: ObservedQuantity<"bytes">;
	readonly heapUsedBytes: ObservedQuantity<"bytes">;
	readonly externalBytes: ObservedQuantity<"bytes">;
	readonly arrayBuffersBytes: ObservedQuantity<"bytes">;
}

export interface LogicalSessionStateObservation extends TelemetryObservationBase {
	readonly kind: "logical_session_state";
	readonly totalBytes: ObservedQuantity<"bytes">;
	readonly messagesBytes: ObservedQuantity<"bytes">;
	readonly toolResultsBytes: ObservedQuantity<"bytes">;
	readonly planTaskBytes: ObservedQuantity<"bytes">;
	readonly checkpointDescriptorBytes: ObservedQuantity<"bytes">;
	readonly contextCurrentTokens: ObservedQuantity<"tokens">;
}

export interface ManagedProcessMemoryObservation extends TelemetryObservationBase {
	readonly kind: "managed_process_memory";
	readonly rssBytes: ObservedQuantity<"bytes">;
	readonly pssBytes: ObservedQuantity<"bytes">;
	readonly ussBytes: ObservedQuantity<"bytes">;
	readonly observedProcessCount: ObservedQuantity<"count">;
}

export type TelemetryObservation =
	| TrafficObservation
	| ProcessIoObservation
	| RuntimeMemoryObservation
	| LogicalSessionStateObservation
	| ManagedProcessMemoryObservation;
