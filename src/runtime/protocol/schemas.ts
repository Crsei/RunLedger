/** Runtime exact event schemas、bounds 与纯 contract validation。 */

import { Type } from "typebox";
import { Value } from "typebox/value";
import { canonicalDigest, canonicalJson } from "./canonical-json.ts";
import { RuntimeContractError } from "./errors.ts";
import {
	EVENT_BINDING_REQUIRED_TYPES,
	EVENT_IDEMPOTENCY_ACTIONS,
	EVENT_METADATA_REQUIRED_ACTIONS,
	EVENT_REASON_REQUIRED_ACTIONS,
	EVENT_REF_REQUIRED_ACTIONS,
	EVENT_REF_REQUIRED_TYPES,
	EVENT_TRANSITION_ACTIONS,
	RUNTIME_EVENT_TYPES,
	isKnownRuntimeEventType,
	type AppendEventOutcome,
	type DurableEventReceipt,
	type RuntimeEvent,
	type RuntimeEventRangeRef,
	type RuntimeEventSubjectKind,
	type RuntimeEventType,
} from "./events.ts";
import {
	CanonicalUtcTimestampSchema,
	RuntimeContentRefSchema,
	RuntimeDigestSchema,
	RuntimeErrorShapeSchema,
	RuntimeIdSchema,
	RuntimeStreamHeadSchema,
	isCanonicalUtcTimestamp,
} from "./foundation-schemas.ts";
import { createRuntimeId, isRuntimeId, type RuntimeId } from "./ids.ts";

export const MAX_RUNTIME_EVENT_PAYLOAD_BYTES = 64 * 1024;

export interface SchemaValidationSuccess<T> {
	ok: true;
	value: T;
}

export interface SchemaValidationFailure {
	ok: false;
	code: "invalid_schema" | "unknown_event_type" | "oversized_payload" | "invalid_digest";
	message: string;
}

export type SchemaValidationResult<T> = SchemaValidationSuccess<T> | SchemaValidationFailure;

const RuntimeEventTypeSchema = Type.Unsafe<RuntimeEventType>({
	type: "string",
	enum: [...RUNTIME_EVENT_TYPES],
});

const RuntimeEventSubjectKindSchema = Type.Unsafe<RuntimeEventSubjectKind>({
	type: "string",
	enum: [
		"authority",
		"session",
		"goal",
		"task",
		"turn",
		"toolCall",
		"queueItem",
		"agent",
		"workspace",
		"approval",
		"principal",
		"snapshot",
		"artifact",
		"finding",
		"proposal",
		"resource",
		"command",
	],
});

const RuntimeEventSubjectSchema = Type.Object(
	{
		kind: RuntimeEventSubjectKindSchema,
		id: RuntimeIdSchema,
	},
	{ additionalProperties: false },
);

const RuntimeEventTransitionSchema = Type.Object(
	{
		revision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		previousStatus: Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()]),
		nextStatus: Type.String({ minLength: 1, maxLength: 64 }),
	},
	{ additionalProperties: false },
);

const RuntimeEventBindingSchema = Type.Object(
	{
		role: Type.String({ minLength: 1, maxLength: 64 }),
		subjectId: RuntimeIdSchema,
	},
	{ additionalProperties: false },
);

export type RuntimeEventPayloadRequirement =
	| "transition"
	| "bindings"
	| "refs"
	| "expectedRevision"
	| "idempotencyKey"
	| "reasonCode"
	| "metadataDigest"
	| "title";

const TRANSITION_ACTIONS = new Set<string>(EVENT_TRANSITION_ACTIONS);
const BINDING_TYPES = new Set<RuntimeEventType>(EVENT_BINDING_REQUIRED_TYPES);
const REF_ACTIONS = new Set<string>(EVENT_REF_REQUIRED_ACTIONS);
const REF_TYPES = new Set<RuntimeEventType>(EVENT_REF_REQUIRED_TYPES);
const IDEMPOTENCY_ACTIONS = new Set<string>(EVENT_IDEMPOTENCY_ACTIONS);
const REASON_ACTIONS = new Set<string>(EVENT_REASON_REQUIRED_ACTIONS);
const METADATA_ACTIONS = new Set<string>(EVENT_METADATA_REQUIRED_ACTIONS);

const SessionTitleValueSchema = Type.String({ minLength: 1, maxLength: 160 });
const SessionTitleSourceSchema = Type.Unsafe<"auto" | "user">({ type: "string", enum: ["auto", "user"] });
const SessionTitleTriggerSchema = Type.Unsafe<"first-user-message" | "manual-rename" | "retry">({
	type: "string",
	enum: ["first-user-message", "manual-rename", "retry"],
});
const SessionTitleModelRefSchema = Type.Object(
	{
		providerId: Type.String({ minLength: 1, maxLength: 128 }),
		modelId: Type.String({ minLength: 1, maxLength: 128 }),
	},
	{ additionalProperties: false },
);
const RuntimeModelRequestKindSchema = Type.Unsafe<"interactive" | "idle-recap" | "auto-title">({
	type: "string",
	enum: ["interactive", "idle-recap", "auto-title"],
});

function eventAction(type: RuntimeEventType): string {
	return type.slice(type.indexOf(".") + 1);
}

function payloadRequirements(type: RuntimeEventType): readonly RuntimeEventPayloadRequirement[] {
	const action = eventAction(type);
	const requirements: RuntimeEventPayloadRequirement[] = [];
	if (TRANSITION_ACTIONS.has(action)) requirements.push("transition");
	if (BINDING_TYPES.has(type)) requirements.push("bindings");
	if (REF_ACTIONS.has(action) || REF_TYPES.has(type)) requirements.push("refs");
	if (TRANSITION_ACTIONS.has(action) && !IDEMPOTENCY_ACTIONS.has(action)) requirements.push("expectedRevision");
	if (IDEMPOTENCY_ACTIONS.has(action)) requirements.push("idempotencyKey");
	if (REASON_ACTIONS.has(action)) requirements.push("reasonCode");
	if (METADATA_ACTIONS.has(action)) requirements.push("metadataDigest");
	if (type === "session.title_changed") requirements.push("title");
	return requirements;
}

export const RUNTIME_EVENT_PAYLOAD_REQUIREMENTS = Object.freeze(
	Object.fromEntries(RUNTIME_EVENT_TYPES.map((type) => [type, Object.freeze(payloadRequirements(type))])),
) as Readonly<Record<RuntimeEventType, readonly RuntimeEventPayloadRequirement[]>>;

function createRuntimeEventPayloadSchema(type?: RuntimeEventType) {
	const requirements = new Set(type === undefined ? [] : RUNTIME_EVENT_PAYLOAD_REQUIREMENTS[type]);
	return Type.Object(
		{
			subject: RuntimeEventSubjectSchema,
			correlationId: RuntimeIdSchema,
			effect: Type.Union([Type.Literal("none"), Type.Literal("committed"), Type.Literal("uncertain")]),
			idempotencyKey: requirements.has("idempotencyKey")
				? Type.String({ minLength: 1, maxLength: 128 })
				: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
			expectedRevision: requirements.has("expectedRevision")
				? Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
				: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
			transition: requirements.has("transition")
				? RuntimeEventTransitionSchema
				: Type.Optional(RuntimeEventTransitionSchema),
			reasonCode: requirements.has("reasonCode")
				? Type.String({ minLength: 1, maxLength: 128 })
				: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
			bindings: requirements.has("bindings")
				? Type.Array(RuntimeEventBindingSchema, { minItems: 1, maxItems: 32 })
				: Type.Optional(Type.Array(RuntimeEventBindingSchema, { maxItems: 32 })),
			refs: requirements.has("refs")
				? Type.Array(RuntimeContentRefSchema, { minItems: 1, maxItems: 16 })
				: Type.Optional(Type.Array(RuntimeContentRefSchema, { maxItems: 16 })),
			metadataDigest: requirements.has("metadataDigest")
				? RuntimeDigestSchema
				: Type.Optional(RuntimeDigestSchema),
			title: requirements.has("title")
				? SessionTitleValueSchema
				: Type.Optional(SessionTitleValueSchema),
			source: requirements.has("title")
				? SessionTitleSourceSchema
				: Type.Optional(SessionTitleSourceSchema),
			previousTitle: Type.Optional(SessionTitleValueSchema),
			trigger: Type.Optional(SessionTitleTriggerSchema),
			modelRef: Type.Optional(SessionTitleModelRefSchema),
			...(type === undefined || type === "model.routed" ? { requestKind: Type.Optional(RuntimeModelRequestKindSchema) } : {}),
			// The envelope is validated before the type-specific payload schema. Keep the
			// generic envelope permissive for the title CAS marker; the concrete schema
			// below rejects it for every event type that does not own title fields.
			expectedTitle: Type.Optional(Type.Null()),
		},
		{ additionalProperties: false },
	);
}

export const RuntimeEventPayloadSchema = createRuntimeEventPayloadSchema();

export const RUNTIME_EVENT_PAYLOAD_SCHEMAS = Object.freeze(
	Object.fromEntries(RUNTIME_EVENT_TYPES.map((type) => [type, createRuntimeEventPayloadSchema(type)])),
) as Readonly<Record<RuntimeEventType, typeof RuntimeEventPayloadSchema>>;

const SessionRuntimeStreamRefSchema = Type.Object(
	{
		scope: Type.Literal("session"),
		streamId: RuntimeIdSchema,
		sessionId: RuntimeIdSchema,
	},
	{ additionalProperties: false },
);

const AuthorityTenantRuntimeStreamRefSchema = Type.Object(
	{
		scope: Type.Literal("authority_tenant"),
		streamId: RuntimeIdSchema,
	},
	{ additionalProperties: false },
);

const RuntimeStreamRefSchema = Type.Union([SessionRuntimeStreamRefSchema, AuthorityTenantRuntimeStreamRefSchema]);

export const RuntimeEventEnvelopeSchema = Type.Object(
	{
		authorityId: RuntimeIdSchema,
		tenantId: RuntimeIdSchema,
		principalId: RuntimeIdSchema,
		eventId: RuntimeIdSchema,
		stream: RuntimeStreamRefSchema,
		sequence: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		timestamp: CanonicalUtcTimestampSchema,
		type: RuntimeEventTypeSchema,
		previousEventHash: Type.Union([RuntimeDigestSchema, Type.Null()]),
		payloadDigest: RuntimeDigestSchema,
		currentEventHash: RuntimeDigestSchema,
		traceId: RuntimeIdSchema,
		payload: RuntimeEventPayloadSchema,
	},
	{ additionalProperties: false },
);

export const DurableEventReceiptSchema = Type.Object(
	{
		receiptId: RuntimeIdSchema,
		stream: RuntimeStreamRefSchema,
		cursor: Type.String({ minLength: 1, maxLength: 256 }),
		sequence: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		eventHash: RuntimeDigestSchema,
		writerEpoch: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		durableAt: CanonicalUtcTimestampSchema,
	},
	{ additionalProperties: false },
);

const AcceptedAppendEventOutcomeSchema = Type.Object(
	{
		outcome: Type.Literal("accepted"),
		eventId: RuntimeIdSchema,
		stream: RuntimeStreamRefSchema,
		sequence: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		acceptedAt: CanonicalUtcTimestampSchema,
	},
	{ additionalProperties: false },
);

const DurableAppendEventOutcomeSchema = Type.Object(
	{
		outcome: Type.Literal("durable"),
		receipt: DurableEventReceiptSchema,
	},
	{ additionalProperties: false },
);

const RejectedAppendEventOutcomeSchema = Type.Object(
	{
		outcome: Type.Literal("rejected"),
		error: RuntimeErrorShapeSchema,
	},
	{ additionalProperties: false },
);

const UncertainAppendEventOutcomeSchema = Type.Object(
	{
		outcome: Type.Literal("uncertain"),
		eventId: RuntimeIdSchema,
		stream: RuntimeStreamRefSchema,
		error: RuntimeErrorShapeSchema,
	},
	{ additionalProperties: false },
);

export const AppendEventOutcomeSchema = Type.Union([
	AcceptedAppendEventOutcomeSchema,
	DurableAppendEventOutcomeSchema,
	RejectedAppendEventOutcomeSchema,
	UncertainAppendEventOutcomeSchema,
]);

export const RuntimeEventRangeRefSchema = Type.Object(
	{
		stream: RuntimeStreamRefSchema,
		startSequence: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		endSequence: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		head: RuntimeStreamHeadSchema,
		rangeDigest: RuntimeDigestSchema,
		complete: Type.Boolean(),
	},
	{ additionalProperties: false },
);

type RuntimeStreamCandidate =
	| { scope: "session"; streamId: RuntimeId; sessionId: RuntimeId }
	| { scope: "authority_tenant"; streamId: RuntimeId };

function isValidRuntimeStreamRef(stream: RuntimeStreamCandidate): boolean {
	if (stream.scope === "session") {
		return (
			isRuntimeId(stream.streamId, "session") &&
			isRuntimeId(stream.sessionId, "session") &&
			stream.streamId === stream.sessionId
		);
	}
	return isRuntimeId(stream.streamId);
}

export function isDurableEventReceipt(value: unknown): value is DurableEventReceipt {
	if (!Value.Check(DurableEventReceiptSchema, value)) return false;
	return isRuntimeId(value.receiptId, "receipt") && isValidRuntimeStreamRef(value.stream) && isCanonicalUtcTimestamp(value.durableAt);
}

export function isAppendEventOutcome(value: unknown): value is AppendEventOutcome {
	if (!Value.Check(AppendEventOutcomeSchema, value)) return false;
	switch (value.outcome) {
		case "accepted":
			return isRuntimeId(value.eventId, "event") && isValidRuntimeStreamRef(value.stream) && isCanonicalUtcTimestamp(value.acceptedAt);
		case "durable":
			return isDurableEventReceipt(value.receipt);
		case "rejected":
			return true;
		case "uncertain":
			return isRuntimeId(value.eventId, "event") && isValidRuntimeStreamRef(value.stream);
	}
}

export function isRuntimeEventRangeRef(value: unknown): value is RuntimeEventRangeRef {
	if (!Value.Check(RuntimeEventRangeRefSchema, value)) return false;
	return (
		isValidRuntimeStreamRef(value.stream) &&
		value.startSequence <= value.endSequence &&
		value.endSequence <= value.head.sequence &&
		value.stream.streamId === value.head.streamId
	);
}

function expectedSubjectKind(type: RuntimeEventType): RuntimeEventSubjectKind {
	const family = type.slice(0, type.indexOf("."));
	switch (family) {
		case "session": return "session";
		case "input": return "session";
		case "goal": return "goal";
		case "task": return "task";
		case "turn": return "turn";
		case "model": return "turn";
		case "tool": return "toolCall";
		case "queue": return "queueItem";
		case "agent": return "agent";
		case "workspace": return "workspace";
		case "permission": return "approval";
		case "capability": return "principal";
		case "sandbox": return "toolCall";
		case "lease": return "workspace";
		case "checkpoint": return "snapshot";
		case "artifact": return "artifact";
		case "episode": return "session";
		case "verification": return "session";
		case "finding": return "finding";
		case "change_proposal": return "proposal";
		case "draft_pr": return "proposal";
		case "human_gate": return "approval";
		case "resource": return "resource";
		case "context": return "session";
		case "plan": return "goal";
		case "compaction": return "snapshot";
		case "memory": return "session";
		case "command": return "command";
		case "runtime": return "authority";
		case "policy": return "authority";
		case "cost": return "session";
		case "telemetry": return "authority";
	}
	throw new Error(`unreachable event family: ${family}`);
}

function eventHashInput(event: RuntimeEvent): Record<string, unknown> {
	return {
		authorityId: event.authorityId,
		tenantId: event.tenantId,
		principalId: event.principalId,
		eventId: event.eventId,
		stream: event.stream,
		sequence: event.sequence,
		timestamp: event.timestamp,
		type: event.type,
		previousEventHash: event.previousEventHash,
		payloadDigest: event.payloadDigest,
		traceId: event.traceId,
	};
}

function digestsEqual(left: { algorithm: string; digest: string }, right: { algorithm: string; digest: string }): boolean {
	return left.algorithm === right.algorithm && left.digest === right.digest;
}

export function validateRuntimeEvent(value: unknown): SchemaValidationResult<RuntimeEvent> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { ok: false, code: "invalid_schema", message: "event must be an object" };
	}
	const candidate = value as Record<string, unknown>;
	if (!isKnownRuntimeEventType(candidate.type)) {
		return { ok: false, code: "unknown_event_type", message: "event type is not in the current catalog" };
	}
	if (!Value.Check(RuntimeEventEnvelopeSchema, value)) {
		return { ok: false, code: "invalid_schema", message: "event does not match the exact envelope and payload schema" };
	}
	const event = value as unknown as RuntimeEvent;
	if (!Value.Check(RUNTIME_EVENT_PAYLOAD_SCHEMAS[event.type], event.payload)) {
		return { ok: false, code: "invalid_schema", message: "event payload does not match its registered schema" };
	}
	if (event.type === "session.title_changed" && !isValidSessionTitleChangedPayload(event.payload as unknown as Record<string, unknown>)) {
		return { ok: false, code: "invalid_schema", message: "session.title_changed title fields are unsafe or exceed their byte bounds" };
	}
	if (
		!isRuntimeId(event.authorityId, "authority") ||
		!isRuntimeId(event.tenantId, "tenant") ||
		!isRuntimeId(event.principalId, "principal") ||
		!isRuntimeId(event.eventId, "event") ||
		!isRuntimeId(event.traceId, "trace") ||
		!isCanonicalUtcTimestamp(event.timestamp)
	) {
		return { ok: false, code: "invalid_schema", message: "event identity or timestamp is invalid" };
	}
	if (!isValidRuntimeStreamRef(event.stream)) {
		return { ok: false, code: "invalid_schema", message: "session stream identity is invalid" };
	}
	const subjectKind = expectedSubjectKind(event.type);
	if (
		event.payload.subject.kind !== subjectKind ||
		!isRuntimeId(event.payload.subject.id, subjectKind) ||
		!isRuntimeId(event.payload.correlationId, "trace") ||
		event.payload.correlationId !== event.traceId
	) {
		return { ok: false, code: "invalid_schema", message: "event subject or correlation does not match its type" };
	}
	let payloadJson: string;
	try {
		payloadJson = canonicalJson(event.payload);
	} catch {
		return { ok: false, code: "invalid_schema", message: "event payload is not canonical JSON" };
	}
	if (new TextEncoder().encode(payloadJson).byteLength > MAX_RUNTIME_EVENT_PAYLOAD_BYTES) {
		return { ok: false, code: "oversized_payload", message: "event payload exceeds the byte limit" };
	}
	const expectedPayloadDigest = { algorithm: "sha256", digest: canonicalDigest(event.payload) };
	if (!digestsEqual(event.payloadDigest, expectedPayloadDigest)) {
		return { ok: false, code: "invalid_digest", message: "event payload digest does not match its payload" };
	}
	const expectedEventHash = { algorithm: "sha256", digest: canonicalDigest(eventHashInput(event)) };
	if (!digestsEqual(event.currentEventHash, expectedEventHash)) {
		return { ok: false, code: "invalid_digest", message: "event hash does not match the canonical hash input" };
	}
	return { ok: true, value: event };
}

function isValidSessionTitleChangedPayload(payload: Record<string, unknown>): boolean {
	if (payload.source === "auto" && payload.expectedTitle !== null) return false;
	if (payload.expectedTitle !== undefined && payload.expectedTitle !== null) return false;
	for (const key of ["title", "previousTitle"] as const) {
		const value = payload[key];
		if (value === undefined) continue;
		if (typeof value !== "string" || value.length === 0 || new TextEncoder().encode(value).byteLength > 160 || /[\u0000-\u001F\u007F-\u009F]/u.test(value)) {
			return false;
		}
	}
	const modelRef = payload.modelRef;
	if (modelRef !== undefined) {
		if (typeof modelRef !== "object" || modelRef === null || Array.isArray(modelRef)) return false;
		for (const key of ["providerId", "modelId"] as const) {
			const value = (modelRef as Record<string, unknown>)[key];
			if (typeof value !== "string" || value.length === 0 || /[\u0000-\u001F\u007F-\u009F]/u.test(value)) return false;
		}
	}
	return true;
}

export function assertRuntimeEvent(value: unknown): RuntimeEvent {
	const result = validateRuntimeEvent(value);
	if (!result.ok) {
		throw new RuntimeContractError({
			code:
				result.code === "unknown_event_type"
					? "unknown_event_type"
					: result.code === "oversized_payload"
						? "oversized_payload"
						: "invariant_violation",
			message: result.message,
			retryable: false,
			correlationId: createRuntimeId("trace", "contract-validation"),
		});
	}
	return result.value;
}
