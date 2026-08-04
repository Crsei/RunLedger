/** Managed process 的 current-format 公共 DTO。private backend 字段不在这里出现。 */

import type { RuntimeContentRef, RuntimeDigest } from "../protocol/foundation.ts";
import type { OutputCursor } from "./output.ts";
import type {
	AuthorityId,
	AttemptId,
	CommandId,
	ExecutionId,
	SessionId,
	TenantId,
	WorkspaceId,
} from "../protocol/ids.ts";

export const PROCESS_STATES = [
	"queued",
	"starting",
	"running",
	"backgrounded",
	"completed",
	"failed",
	"timed_out",
	"killed",
	"lost",
	"uncertain",
] as const;

export type ProcessState = (typeof PROCESS_STATES)[number];
export type ProcessTerminalState = Extract<
	ProcessState,
	"completed" | "failed" | "timed_out" | "killed" | "lost" | "uncertain"
>;
export type ProcessBackendKind = "pipe" | "pty";
export type ProcessExecutionMode = "foreground" | "background";

export interface ExecutionHandleRef {
	readonly authorityId: AuthorityId;
	readonly tenantId: TenantId;
	readonly workspaceId: WorkspaceId;
	readonly sessionId: SessionId;
	readonly hostGeneration: number;
	readonly sessionGeneration: number;
	readonly executionId: ExecutionId;
	readonly attemptId: AttemptId;
	readonly revision: number;
	readonly requestDigest: RuntimeDigest;
}

export interface ManagedProcessLimits {
	readonly maxOutputBytes?: number;
	readonly maxDurationMs?: number;
	readonly maxInputFrameBytes?: number;
}


export interface ManagedProcessRequest {
	readonly authorityId: AuthorityId;
	readonly tenantId: TenantId;
	readonly workspaceId: WorkspaceId;
	readonly sessionId: SessionId;
	readonly hostGeneration: number;
	readonly sessionGeneration: number;
	readonly requestDigest: RuntimeDigest;
	readonly commandRef: RuntimeContentRef;
	readonly cwdRef: RuntimeContentRef;
	readonly backend: ProcessBackendKind;
	readonly executionMode: ProcessExecutionMode;
	readonly timeoutMs?: number;
	readonly limits?: ManagedProcessLimits;
	readonly correlationId: CommandId;
}

export interface ManagedProcessCapabilities {
	readonly canWrite: boolean;
	readonly canEof: boolean;
	readonly canResize: boolean;
	readonly canStop: boolean;
	readonly canReadOutput: boolean;
}

export interface ManagedProcessTerminal {
	readonly state: ProcessTerminalState;
	readonly exitCode?: number;
	readonly signal?: string;
	readonly durationMs?: number;
	readonly evidenceRef: RuntimeContentRef;
}

export interface ManagedProcessSummary {
	readonly handle: ExecutionHandleRef;
	readonly state: ProcessState;
	readonly outputCursor: OutputCursor;
	readonly outputSize: number;
	readonly capabilities: ManagedProcessCapabilities;
	readonly terminal?: ManagedProcessTerminal;
}

export interface ManagedProcessOutputPage {
	readonly handle: ExecutionHandleRef;
	readonly startCursor: OutputCursor;
	readonly endCursor: OutputCursor;
	readonly text: string;
	readonly nextCursor: OutputCursor;
	readonly truncated: boolean;
	readonly contentRef?: RuntimeContentRef;
}

export interface ManagedProcessWaitRequest {
	readonly handle: ExecutionHandleRef;
	readonly expectedRevision: number;
	readonly timeoutMs: number;
	readonly correlationId: CommandId;
	readonly deliveryKey?: string;
}

export interface ManagedProcessWaitResult {
	readonly outcome: "terminal" | "running" | "timed_out" | "cancelled" | "uncertain";
	readonly summary: ManagedProcessSummary;
	readonly preview?: string;
	readonly nextCursor: OutputCursor;
	readonly terminalEvidenceRef?: RuntimeContentRef;
}

export interface ProcessCompletionEnvelope {
	readonly deliveryKey: string;
	readonly origin: "explicit_wait" | "explicit_stop" | "automatic_follow_up";
	readonly handle: ExecutionHandleRef;
	readonly terminalSequence: number;
	readonly summary: ManagedProcessSummary;
	readonly preview?: string;
	readonly nextCursor: OutputCursor;
	readonly policyDigest: RuntimeDigest;
	readonly budgetDigest: RuntimeDigest;
}

export interface ManagedProcessMutationReceipt {
	readonly operation: "write" | "eof" | "resize" | "detach" | "stop";
	readonly handle: ExecutionHandleRef;
	readonly previousRevision: number;
	readonly currentRevision: number;
	readonly receiptDigest: RuntimeDigest;
}

export interface ManagedTerminalEvidence {
	readonly handle: ExecutionHandleRef;
	readonly exitCode?: number;
	readonly signal?: string;
	readonly containment: "zero_members" | "unknown";
	readonly outputEvidenceRef: RuntimeContentRef;
	readonly settlementReceiptRef: RuntimeContentRef;
}
