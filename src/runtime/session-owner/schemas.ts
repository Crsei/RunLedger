/** Session Owner contract 的 exact TypeBox schema 与 runtime guard(R0 冻结)。 */

import { Type } from "typebox";
import { Value } from "typebox/value";
import { RuntimeDigestSchema } from "../protocol/foundation-schemas.ts";
import {
	COMMAND_ATTEMPT_OUTCOMES,
	COMMAND_EFFECT_CLASSES,
	OWNER_RELEASE_REASONS,
	SESSION_CHECKPOINT_BOUNDARIES,
	SESSION_OWNER_ERROR_CODES,
	SESSION_OWNER_STATES,
	type CommandAttemptOutcome,
	type CommandAttemptReceipt,
	type CommandEffectClass,
	type CommandIntent,
	type OwnerClaimResult,
	type OwnerEndpoint,
	type OwnerFence,
	type OwnerHeartbeatResult,
	type OwnerReleaseReason,
	type SessionCheckpointBoundary,
	type SessionCheckpointDescriptor,
	type SessionOwnerErrorCode,
	type SessionOwnerEventPayload,
	type SessionOwnerRecord,
	type SessionOwnerState,
} from "./types.ts";

const scopedIdSchema = (kind: string) =>
	Type.String({ pattern: `^${kind}_[A-Za-z0-9._~-]{1,128}$`, maxLength: kind.length + 1 + 128 });

const SessionIdSchema = scopedIdSchema("session");
const RuntimeIdSchema = scopedIdSchema("runtime");
const EventIdSchema = scopedIdSchema("event");
const ConnectionIdSchema = scopedIdSchema("connection");
const PrincipalIdSchema = scopedIdSchema("principal");
const CommandIdSchema = scopedIdSchema("command");
const ReceiptIdSchema = scopedIdSchema("receipt");
const AttemptIdSchema = scopedIdSchema("attempt");
const SnapshotIdSchema = scopedIdSchema("snapshot");

const PositiveSafeIntSchema = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const NonNegativeSafeIntSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const TimestampMsSchema = NonNegativeSafeIntSchema;

export const SessionOwnerStateSchema = Type.Unsafe<SessionOwnerState>({
	type: "string",
	enum: [...SESSION_OWNER_STATES],
});

export const OwnerEndpointSchema = Type.Object(
	{
		host: Type.Literal("127.0.0.1"),
		port: Type.Integer({ minimum: 1, maximum: 65_535 }),
	},
	{ additionalProperties: false },
);

export const SessionOwnerRecordSchema = Type.Object(
	{
		sessionId: SessionIdSchema,
		runtimeId: RuntimeIdSchema,
		generation: PositiveSafeIntSchema,
		state: SessionOwnerStateSchema,
		endpoint: Type.Optional(OwnerEndpointSchema),
		heartbeatAtMs: Type.Optional(TimestampMsSchema),
		ownerStartedAtMs: TimestampMsSchema,
		updatedAtMs: TimestampMsSchema,
	},
	{ additionalProperties: false },
);

export const OwnerFenceSchema = Type.Object(
	{
		sessionId: SessionIdSchema,
		runtimeId: RuntimeIdSchema,
		generation: PositiveSafeIntSchema,
	},
	{ additionalProperties: false },
);

export const OwnerClaimTargetSchema = Type.Object(
	{
		runtimeId: RuntimeIdSchema,
		generation: PositiveSafeIntSchema,
		heartbeatAtMs: Type.Optional(TimestampMsSchema),
		state: SessionOwnerStateSchema,
	},
	{ additionalProperties: false },
);

export const OwnerClaimAttemptSchema = Type.Union([
	Type.Object(
		{
			mode: Type.Literal("fresh"),
			sessionId: SessionIdSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			mode: Type.Literal("takeover"),
			sessionId: SessionIdSchema,
			expected: OwnerClaimTargetSchema,
		},
		{ additionalProperties: false },
	),
]);

const SessionOwnerErrorCodeSchema = Type.Unsafe<SessionOwnerErrorCode>({
	type: "string",
	enum: [...SESSION_OWNER_ERROR_CODES],
});

export const OwnerClaimResultSchema = Type.Union([
	Type.Object(
		{
			ok: Type.Literal(true),
			outcome: Type.Literal("claimed"),
			fence: OwnerFenceSchema,
			endpoint: OwnerEndpointSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			ok: Type.Literal(true),
			outcome: Type.Literal("attached"),
			record: SessionOwnerRecordSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			ok: Type.Literal(false),
			code: SessionOwnerErrorCodeSchema,
			retryable: Type.Boolean(),
		},
		{ additionalProperties: false },
	),
]);

export const OwnerHeartbeatResultSchema = Type.Union([
	Type.Object(
		{
			ok: Type.Literal(true),
			heartbeatAtMs: TimestampMsSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			ok: Type.Literal(false),
			code: Type.Literal("owner_fenced"),
		},
		{ additionalProperties: false },
	),
]);

const OwnerClaimedPayloadSchema = Type.Object(
	{
		eventId: EventIdSchema,
		sessionId: SessionIdSchema,
		runtimeId: RuntimeIdSchema,
		generation: PositiveSafeIntSchema,
		port: Type.Integer({ minimum: 1, maximum: 65_535 }),
		ownerStartedAtMs: TimestampMsSchema,
	},
	{ additionalProperties: false },
);

const OwnerTakenOverPayloadSchema = Type.Object(
	{
		eventId: EventIdSchema,
		sessionId: SessionIdSchema,
		runtimeId: RuntimeIdSchema,
		priorGeneration: PositiveSafeIntSchema,
		generation: PositiveSafeIntSchema,
		port: Type.Integer({ minimum: 1, maximum: 65_535 }),
	},
	{ additionalProperties: false },
);

const OwnerReleasedPayloadSchema = Type.Object(
	{
		eventId: EventIdSchema,
		sessionId: SessionIdSchema,
		runtimeId: RuntimeIdSchema,
		generation: PositiveSafeIntSchema,
		reason: Type.Unsafe<OwnerReleaseReason>({ type: "string", enum: [...OWNER_RELEASE_REASONS] }),
	},
	{ additionalProperties: false },
);

const OwnerFencedPayloadSchema = Type.Object(
	{
		eventId: EventIdSchema,
		sessionId: SessionIdSchema,
		runtimeId: RuntimeIdSchema,
		generation: PositiveSafeIntSchema,
	},
	{ additionalProperties: false },
);

const DriverClaimedPayloadSchema = Type.Object(
	{
		eventId: EventIdSchema,
		sessionId: SessionIdSchema,
		runtimeId: RuntimeIdSchema,
		generation: PositiveSafeIntSchema,
		connectionId: ConnectionIdSchema,
		driverRevision: NonNegativeSafeIntSchema,
	},
	{ additionalProperties: false },
);

const DriverReleasedPayloadSchema = Type.Object(
	{
		eventId: EventIdSchema,
		sessionId: SessionIdSchema,
		runtimeId: RuntimeIdSchema,
		generation: PositiveSafeIntSchema,
		connectionId: ConnectionIdSchema,
		driverRevision: NonNegativeSafeIntSchema,
	},
	{ additionalProperties: false },
);

const DriverResetOnTakeoverPayloadSchema = Type.Object(
	{
		eventId: EventIdSchema,
		sessionId: SessionIdSchema,
		runtimeId: RuntimeIdSchema,
		generation: PositiveSafeIntSchema,
		driverRevision: NonNegativeSafeIntSchema,
	},
	{ additionalProperties: false },
);

const RecoveryVerifiedCleanPayloadSchema = Type.Object(
	{
		eventId: EventIdSchema,
		sessionId: SessionIdSchema,
		runtimeId: RuntimeIdSchema,
		generation: PositiveSafeIntSchema,
		evidenceDigest: RuntimeDigestSchema,
	},
	{ additionalProperties: false },
);

const RecoveryVerifyPayloadSchema = Type.Object(
	{
		eventId: EventIdSchema,
		sessionId: SessionIdSchema,
		runtimeId: RuntimeIdSchema,
		generation: PositiveSafeIntSchema,
		attemptId: AttemptIdSchema,
		outcome: Type.Unsafe<"settled" | "verified_clean">({ type: "string", enum: ["settled", "verified_clean"] }),
		settledGeneration: PositiveSafeIntSchema,
		evidenceDigest: Type.Optional(RuntimeDigestSchema),
	},
	{ additionalProperties: false },
);

const RecoveryAbortPayloadSchema = Type.Object(
	{
		eventId: EventIdSchema,
		sessionId: SessionIdSchema,
		runtimeId: RuntimeIdSchema,
		generation: PositiveSafeIntSchema,
		reasonCode: Type.String({ minLength: 1, maxLength: 128 }),
	},
	{ additionalProperties: false },
);

const RecoveryResumeDespiteUncertaintyPayloadSchema = Type.Object(
	{
		eventId: EventIdSchema,
		sessionId: SessionIdSchema,
		runtimeId: RuntimeIdSchema,
		generation: PositiveSafeIntSchema,
		principalId: PrincipalIdSchema,
		reasonCode: Type.String({ minLength: 1, maxLength: 128 }),
		originGeneration: PositiveSafeIntSchema,
		settledGeneration: PositiveSafeIntSchema,
		evidenceDigest: RuntimeDigestSchema,
	},
	{ additionalProperties: false },
);

export const SessionOwnerEventPayloadSchema = Type.Union([
	OwnerClaimedPayloadSchema,
	OwnerTakenOverPayloadSchema,
	OwnerReleasedPayloadSchema,
	OwnerFencedPayloadSchema,
	DriverClaimedPayloadSchema,
	DriverReleasedPayloadSchema,
	DriverResetOnTakeoverPayloadSchema,
	RecoveryVerifiedCleanPayloadSchema,
	RecoveryVerifyPayloadSchema,
	RecoveryAbortPayloadSchema,
	RecoveryResumeDespiteUncertaintyPayloadSchema,
]);

const CommandAttemptOutcomeSchema = Type.Unsafe<CommandAttemptOutcome>({
	type: "string",
	enum: [...COMMAND_ATTEMPT_OUTCOMES],
});

const CommandEffectClassSchema = Type.Unsafe<CommandEffectClass>({
	type: "string",
	enum: [...COMMAND_EFFECT_CLASSES],
});

export const CommandIntentSchema = Type.Object(
	{
		sessionId: SessionIdSchema,
		commandId: CommandIdSchema,
		requestDigest: RuntimeDigestSchema,
		originGeneration: PositiveSafeIntSchema,
		createdAtMs: TimestampMsSchema,
	},
	{ additionalProperties: false },
);

export const CommandAttemptReceiptSchema = Type.Object(
	{
		receiptId: ReceiptIdSchema,
		sessionId: SessionIdSchema,
		commandId: CommandIdSchema,
		attemptId: AttemptIdSchema,
		originGeneration: PositiveSafeIntSchema,
		settledGeneration: Type.Optional(PositiveSafeIntSchema),
		effectClass: CommandEffectClassSchema,
		outcome: CommandAttemptOutcomeSchema,
		resultDigest: Type.Optional(RuntimeDigestSchema),
		evidenceDigest: Type.Optional(RuntimeDigestSchema),
		createdAtMs: TimestampMsSchema,
	},
	{ additionalProperties: false },
);

const SessionCheckpointBoundarySchema = Type.Unsafe<SessionCheckpointBoundary>({
	type: "string",
	enum: [...SESSION_CHECKPOINT_BOUNDARIES],
});

export const SessionCheckpointDescriptorSchema = Type.Object(
	{
		checkpointId: SnapshotIdSchema,
		sessionId: SessionIdSchema,
		ownerGeneration: PositiveSafeIntSchema,
		boundary: SessionCheckpointBoundarySchema,
		sourceSequence: NonNegativeSafeIntSchema,
		snapshotDigest: RuntimeDigestSchema,
		createdAtMs: TimestampMsSchema,
	},
	{ additionalProperties: false },
);

export function isSessionOwnerRecord(value: unknown): value is SessionOwnerRecord {
	return Value.Check(SessionOwnerRecordSchema, value);
}

export function isOwnerFence(value: unknown): value is OwnerFence {
	return Value.Check(OwnerFenceSchema, value);
}

export function isOwnerEndpoint(value: unknown): value is OwnerEndpoint {
	return Value.Check(OwnerEndpointSchema, value);
}

export function isOwnerClaimResult(value: unknown): value is OwnerClaimResult {
	return Value.Check(OwnerClaimResultSchema, value);
}

export function isOwnerHeartbeatResult(value: unknown): value is OwnerHeartbeatResult {
	return Value.Check(OwnerHeartbeatResultSchema, value);
}

export function isSessionOwnerEventPayload(value: unknown): value is SessionOwnerEventPayload {
	return Value.Check(SessionOwnerEventPayloadSchema, value);
}

export function isCommandIntent(value: unknown): value is CommandIntent {
	return Value.Check(CommandIntentSchema, value);
}

export function isCommandAttemptReceipt(value: unknown): value is CommandAttemptReceipt {
	if (!Value.Check(CommandAttemptReceiptSchema, value)) return false;
	// §4.3:settled_generation 必须 >= origin_generation;旧 generation 不能收口新 attempt。
	return value.settledGeneration === undefined || value.settledGeneration >= value.originGeneration;
}

export function isSessionCheckpointDescriptor(value: unknown): value is SessionCheckpointDescriptor {
	return Value.Check(SessionCheckpointDescriptorSchema, value);
}
