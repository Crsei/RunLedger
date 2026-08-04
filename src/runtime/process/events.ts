/** Managed process durable event catalog 与 hash-chain event builder。 */

import { Type } from "typebox";
import { Value } from "typebox/value";
import { runtimeDigest, type RuntimeContentRef, type RuntimeDigest } from "../protocol/foundation.ts";
import { RuntimeContentRefSchema, RuntimeDigestSchema } from "../protocol/foundation-schemas.ts";
import type {
	AttemptId,
	AuthorityId,
	CommandId,
	EventId,
	ExecutionId,
	SessionId,
	TenantId,
	WorkspaceId,
} from "../protocol/ids.ts";
import {
	PROCESS_STATES,
	type ExecutionHandleRef,
	type ProcessBackendKind,
	type ProcessExecutionMode,
	type ProcessState,
	type ProcessTerminalState,
} from "./types.ts";
import type { OutputCursor } from "./output.ts";

export const PROCESS_EVENT_TYPES = [
	"process.execution_requested",
	"process.execution_starting",
	"process.execution_started",
	"process.execution_backgrounded",
	"process.output_checkpointed",
	"process.termination_requested",
	"process.execution_terminal",
	"process.execution_lost",
	"process.execution_uncertain",
	"process.execution_cleaned",
] as const;

export type ProcessEventType = (typeof PROCESS_EVENT_TYPES)[number];

const ProcessEventTypeSchema = Type.Union(PROCESS_EVENT_TYPES.map((type) => Type.Literal(type)));
const ProcessStateSchema = Type.Union(PROCESS_STATES.map((state) => Type.Literal(state)));
const TerminalStateSchema = Type.Union([
	Type.Literal("completed"),
	Type.Literal("failed"),
	Type.Literal("timed_out"),
	Type.Literal("killed"),
	Type.Literal("lost"),
	Type.Literal("uncertain"),
]);
const TerminalPayloadSchema = Type.Object(
	{
		state: TerminalStateSchema,
		exitCode: Type.Optional(Type.Integer({ minimum: -255, maximum: 255 })),
		signal: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
		evidenceRef: RuntimeContentRefSchema,
	},
	{ additionalProperties: false },
);
const OutputCursorSchema = Type.Object(
	{
		sequence: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		byteOffset: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	},
	{ additionalProperties: false },
);

export interface ProcessEvent {
	readonly eventId: EventId;
	readonly authorityId: AuthorityId;
	readonly tenantId: TenantId;
	readonly workspaceId: WorkspaceId;
	readonly sessionId: SessionId;
	readonly hostGeneration: number;
	readonly sessionGeneration: number;
	readonly executionId: ExecutionId;
	readonly attemptId: AttemptId;
	readonly commandId?: CommandId;
	readonly sequence: number;
	readonly revision: number;
	readonly type: ProcessEventType;
	readonly requestDigest: RuntimeDigest;
	readonly managedRequestDigest?: RuntimeDigest;
	readonly backend?: ProcessBackendKind;
	readonly executionMode?: ProcessExecutionMode;
	readonly constraintSnapshotDigest?: RuntimeDigest;
	readonly previousState: ProcessState | null;
	readonly nextState: ProcessState;
	readonly previousEventHash: RuntimeDigest | null;
	readonly outputCursor?: OutputCursor;
	readonly outputSize?: number;
	readonly spawnReceiptDigest?: RuntimeDigest;
	readonly spawnEvidenceRef?: RuntimeContentRef;
	readonly terminal?: {
		readonly state: ProcessTerminalState;
		readonly exitCode?: number;
		readonly signal?: string;
		readonly evidenceRef: RuntimeContentRef;
	};
	readonly eventHash: RuntimeDigest;
}

export const ProcessEventSchema = Type.Object(
	{
		eventId: Type.String({ pattern: "^event_[A-Za-z0-9._~-]{1,128}$", maxLength: 134 }),
		authorityId: Type.String({ pattern: "^authority_[A-Za-z0-9._~-]{1,128}$", maxLength: 138 }),
		tenantId: Type.String({ pattern: "^tenant_[A-Za-z0-9._~-]{1,128}$", maxLength: 134 }),
		workspaceId: Type.String({ pattern: "^workspace_[A-Za-z0-9._~-]{1,128}$", maxLength: 137 }),
		sessionId: Type.String({ pattern: "^session_[A-Za-z0-9._~-]{1,128}$", maxLength: 136 }),
		hostGeneration: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		sessionGeneration: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		executionId: Type.String({ pattern: "^execution_[A-Za-z0-9._~-]{1,128}$", maxLength: 138 }),
		attemptId: Type.String({ pattern: "^attempt_[A-Za-z0-9._~-]{1,128}$", maxLength: 136 }),
		commandId: Type.Optional(Type.String({ pattern: "^command_[A-Za-z0-9._~-]{1,128}$", maxLength: 136 })),
		sequence: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		revision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		type: ProcessEventTypeSchema,
		requestDigest: RuntimeDigestSchema,
		managedRequestDigest: Type.Optional(RuntimeDigestSchema),
		backend: Type.Optional(Type.Union([Type.Literal("pipe"), Type.Literal("pty")])),
		executionMode: Type.Optional(Type.Union([Type.Literal("foreground"), Type.Literal("background")])),
		constraintSnapshotDigest: Type.Optional(RuntimeDigestSchema),
		previousState: Type.Union([ProcessStateSchema, Type.Null()]),
		nextState: ProcessStateSchema,
		previousEventHash: Type.Union([RuntimeDigestSchema, Type.Null()]),
		outputCursor: Type.Optional(OutputCursorSchema),
		outputSize: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
		spawnReceiptDigest: Type.Optional(RuntimeDigestSchema),
		spawnEvidenceRef: Type.Optional(RuntimeContentRefSchema),
		terminal: Type.Optional(TerminalPayloadSchema),
		eventHash: RuntimeDigestSchema,
	},
	{ additionalProperties: false },
);

export function isProcessEvent(value: unknown): value is ProcessEvent {
	return Value.Check(ProcessEventSchema, value);
}

export interface CreateProcessEventInput {
	readonly handle: ExecutionHandleRef;
	readonly sequence: number;
	readonly revision: number;
	readonly type: ProcessEventType;
	readonly previousState: ProcessState | null;
	readonly nextState: ProcessState;
	readonly previousEventHash: RuntimeDigest | null;
	readonly eventId?: EventId;
	readonly commandId?: CommandId;
	readonly managedRequestDigest?: RuntimeDigest;
	readonly backend?: ProcessBackendKind;
	readonly executionMode?: ProcessExecutionMode;
	readonly constraintSnapshotDigest?: RuntimeDigest;
	readonly outputCursor?: OutputCursor;
	readonly outputSize?: number;
	readonly spawnReceiptDigest?: RuntimeDigest;
	readonly spawnEvidenceRef?: RuntimeContentRef;
	readonly terminal?: ProcessEvent["terminal"];
}

export function processEventDigest(event: Omit<ProcessEvent, "eventHash">): RuntimeDigest {
	return runtimeDigest(event);
}

export function createProcessEvent(input: CreateProcessEventInput): ProcessEvent {
	const eventId = input.eventId ?? (`event_process_${input.handle.executionId}_${input.sequence}` as EventId);
	const body: Omit<ProcessEvent, "eventHash"> = {
		eventId,
		authorityId: input.handle.authorityId,
		tenantId: input.handle.tenantId,
		workspaceId: input.handle.workspaceId,
		sessionId: input.handle.sessionId,
		hostGeneration: input.handle.hostGeneration,
		sessionGeneration: input.handle.sessionGeneration,
		executionId: input.handle.executionId,
		attemptId: input.handle.attemptId,
		...(input.commandId === undefined ? {} : { commandId: input.commandId }),
		sequence: input.sequence,
		revision: input.revision,
		type: input.type,
		requestDigest: input.handle.requestDigest,
		...(input.managedRequestDigest === undefined ? {} : { managedRequestDigest: input.managedRequestDigest }),
		...(input.backend === undefined ? {} : { backend: input.backend }),
		...(input.executionMode === undefined ? {} : { executionMode: input.executionMode }),
		...(input.constraintSnapshotDigest === undefined ? {} : { constraintSnapshotDigest: input.constraintSnapshotDigest }),
		previousState: input.previousState,
		nextState: input.nextState,
		previousEventHash: input.previousEventHash,
		...(input.outputCursor === undefined ? {} : { outputCursor: input.outputCursor }),
		...(input.outputSize === undefined ? {} : { outputSize: input.outputSize }),
		...(input.spawnReceiptDigest === undefined ? {} : { spawnReceiptDigest: input.spawnReceiptDigest }),
		...(input.spawnEvidenceRef === undefined ? {} : { spawnEvidenceRef: input.spawnEvidenceRef }),
		...(input.terminal === undefined ? {} : { terminal: input.terminal }),
	};
	return { ...body, eventHash: processEventDigest(body) };
}
