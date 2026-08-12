/** Managed process public schema 与 frame-size validation。 */

import { Type } from "typebox";
import { Value } from "typebox/value";
import { canonicalJson } from "../protocol/canonical-json.ts";
import {
	RuntimeContentRefSchema,
	RuntimeDigestSchema,
} from "../protocol/foundation-schemas.ts";
import { RUNTIME_HOST_BOUNDS } from "../host/types.ts";
import {
	PROCESS_STATES,
	type ManagedProcessRequest,
	type ProcessState,
} from "./types.ts";

const ExecutionIdSchema = Type.String({ pattern: "^execution_[A-Za-z0-9._~-]{1,128}$", maxLength: 138 });
const AttemptIdSchema = Type.String({ pattern: "^attempt_[A-Za-z0-9._~-]{1,128}$", maxLength: 136 });
const AuthorityIdSchema = Type.String({ pattern: "^authority_[A-Za-z0-9._~-]{1,128}$", maxLength: 138 });
const TenantIdSchema = Type.String({ pattern: "^tenant_[A-Za-z0-9._~-]{1,128}$", maxLength: 134 });
const WorkspaceIdSchema = Type.String({ pattern: "^workspace_[A-Za-z0-9._~-]{1,128}$", maxLength: 137 });
const SessionIdSchema = Type.String({ pattern: "^session_[A-Za-z0-9._~-]{1,128}$", maxLength: 136 });
const CommandIdSchema = Type.String({ pattern: "^command_[A-Za-z0-9._~-]{1,128}$", maxLength: 136 });
const ProcessStateSchema = Type.Union(PROCESS_STATES.map((state) => Type.Literal(state)));
const BackendSchema = Type.Union([Type.Literal("pipe"), Type.Literal("pty")]);
const ExecutionModeSchema = Type.Union([Type.Literal("foreground"), Type.Literal("background")]);
const ProcessRequestProperties = {
	authorityId: AuthorityIdSchema,
	tenantId: TenantIdSchema,
	workspaceId: WorkspaceIdSchema,
	sessionId: SessionIdSchema,
	hostGeneration: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	sessionGeneration: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	requestDigest: RuntimeDigestSchema,
};
const ProcessHandleProperties = {
	authorityId: AuthorityIdSchema,
	tenantId: TenantIdSchema,
	workspaceId: WorkspaceIdSchema,
	sessionId: SessionIdSchema,
	hostGeneration: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	sessionGeneration: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	executionId: ExecutionIdSchema,
	attemptId: AttemptIdSchema,
	revision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	requestDigest: RuntimeDigestSchema,
};

export const ExecutionHandleRefSchema = Type.Object(ProcessHandleProperties, { additionalProperties: false });

const LimitsSchema = Type.Object(
	{
		maxOutputBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: RUNTIME_HOST_BOUNDS.maxOutputRingBytes })),
		maxDurationMs: Type.Optional(Type.Integer({ minimum: 1, maximum: RUNTIME_HOST_BOUNDS.maxWaitMs * 100 })),
		maxInputFrameBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: RUNTIME_HOST_BOUNDS.maxInputFrameBytes })),
	},
	{ additionalProperties: false },
);

export const ManagedProcessRequestSchema = Type.Object(
	{
		...ProcessRequestProperties,
		commandRef: RuntimeContentRefSchema,
		cwdRef: RuntimeContentRefSchema,
		backend: BackendSchema,
		executionMode: ExecutionModeSchema,
		timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: RUNTIME_HOST_BOUNDS.maxWaitMs * 100 })),
		limits: Type.Optional(LimitsSchema),
		correlationId: CommandIdSchema,
	},
	{ additionalProperties: false },
);

const CapabilitiesSchema = Type.Object(
	{
		canWrite: Type.Boolean(),
		canEof: Type.Boolean(),
		canResize: Type.Boolean(),
		canStop: Type.Boolean(),
		canReadOutput: Type.Boolean(),
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
const CommandDisplaySchema = Type.Union([
	Type.Object({ authority: Type.Literal("unavailable") }, { additionalProperties: false }),
	Type.Object({
		authority: Type.Union([Type.Literal("authorized"), Type.Literal("spawned")]),
		label: Type.String({ minLength: 1, maxLength: 256 }),
		truncated: Type.Boolean(),
		receiptDigest: RuntimeDigestSchema,
	}, { additionalProperties: false }),
]);

const TerminalSchema = Type.Object(
	{
		state: Type.Union([
			Type.Literal("completed"),
			Type.Literal("failed"),
			Type.Literal("timed_out"),
			Type.Literal("killed"),
			Type.Literal("lost"),
			Type.Literal("uncertain"),
		]),
		exitCode: Type.Optional(Type.Integer({ minimum: -255, maximum: 255 })),
		signal: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
		durationMs: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
		evidenceRef: RuntimeContentRefSchema,
	},
	{ additionalProperties: false },
);

export const ManagedProcessSummarySchema = Type.Object(
	{
		handle: ExecutionHandleRefSchema,
		state: ProcessStateSchema,
		outputCursor: OutputCursorSchema,
		outputSize: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		capabilities: CapabilitiesSchema,
		commandDisplay: Type.Optional(CommandDisplaySchema),
		terminal: Type.Optional(TerminalSchema),
	},
	{ additionalProperties: false },
);

export const ManagedProcessOutputPageSchema = Type.Object(
	{
		handle: ExecutionHandleRefSchema,
		startCursor: OutputCursorSchema,
		endCursor: OutputCursorSchema,
		text: Type.String({ maxLength: RUNTIME_HOST_BOUNDS.maxOutputPageBytes }),
		nextCursor: OutputCursorSchema,
		truncated: Type.Boolean(),
		contentRef: Type.Optional(RuntimeContentRefSchema),
	},
	{ additionalProperties: false },
);

export const ManagedProcessWaitRequestSchema = Type.Object(
	{
		handle: ExecutionHandleRefSchema,
		expectedRevision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		timeoutMs: Type.Integer({ minimum: 1, maximum: RUNTIME_HOST_BOUNDS.maxWaitMs }),
		correlationId: CommandIdSchema,
		deliveryKey: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
	},
	{ additionalProperties: false },
);

export const ManagedProcessWaitResultSchema = Type.Object(
	{
		outcome: Type.Union([
			Type.Literal("terminal"),
			Type.Literal("running"),
			Type.Literal("timed_out"),
			Type.Literal("cancelled"),
			Type.Literal("uncertain"),
		]),
		summary: ManagedProcessSummarySchema,
		preview: Type.Optional(Type.String({ maxLength: RUNTIME_HOST_BOUNDS.maxOutputPageBytes })),
		nextCursor: OutputCursorSchema,
		terminalEvidenceRef: Type.Optional(RuntimeContentRefSchema),
	},
	{ additionalProperties: false },
);

export const ProcessCompletionEnvelopeSchema = Type.Object(
	{
		deliveryKey: Type.String({ minLength: 1, maxLength: 256 }),
		origin: Type.Union([Type.Literal("explicit_wait"), Type.Literal("explicit_stop"), Type.Literal("automatic_follow_up")]),
		handle: ExecutionHandleRefSchema,
		terminalSequence: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		summary: ManagedProcessSummarySchema,
		preview: Type.Optional(Type.String({ maxLength: RUNTIME_HOST_BOUNDS.maxOutputPageBytes })),
		nextCursor: OutputCursorSchema,
		policyDigest: RuntimeDigestSchema,
		budgetDigest: RuntimeDigestSchema,
	},
	{ additionalProperties: false },
);

const MAX_PROCESS_REQUEST_BYTES = RUNTIME_HOST_BOUNDS.maxFrameBytes;

export type ProcessSchemaValidation =
	| { readonly ok: true; readonly value: ManagedProcessRequest }
	| { readonly ok: false; readonly code: "invalid_schema" | "oversized_payload"; readonly message: string };

export function validateManagedProcessRequest(value: unknown): ProcessSchemaValidation {
	let encoded: string;
	try {
		encoded = canonicalJson(value);
	} catch {
		return { ok: false, code: "invalid_schema", message: "request is not canonical JSON" };
	}
	if (Buffer.byteLength(encoded, "utf8") > MAX_PROCESS_REQUEST_BYTES) {
		return { ok: false, code: "oversized_payload", message: "managed process request exceeds frame bound" };
	}
	if (!Value.Check(ManagedProcessRequestSchema, value)) {
		return { ok: false, code: "invalid_schema", message: "managed process request has an invalid current-format shape" };
	}
	return { ok: true, value: value as ManagedProcessRequest };
}

export function isProcessState(value: unknown): value is ProcessState {
	return Value.Check(ProcessStateSchema, value);
}

export const ManagedProcessRequestFrameLimit = MAX_PROCESS_REQUEST_BYTES;
