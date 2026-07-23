/** Runtime v3 exact TypeBox schema、版本栅栏和 payload 上限。 */

import { Type, type TSchema } from "typebox";
import { Check, Errors } from "typebox/value";
import { canonicalJson, CanonicalJsonError } from "./canonical-json.ts";
import {
	isKnownRuntimeEventType,
	isRuntimeEventTypeAllowedInStream,
	RUNTIME_EVENT_TYPES,
	type RuntimeEventType,
} from "./event-catalog.ts";
import { RUNTIME_EVENT_PAYLOAD_SCHEMAS } from "./event-payloads.ts";
import { RuntimeContractError } from "./errors.ts";
import {
	EventCursorSchema,
	ExpectedRevisionSchema,
	RuntimeEventStreamRefSchema,
} from "./event-references.ts";
import { RUNTIME_SCHEMA_VERSION, type EventCursor, type ExpectedRevision, type RuntimeEventV3 } from "./events.ts";

export const MAX_RUNTIME_EVENT_PAYLOAD_BYTES = 64 * 1024;
export const MAX_RUNTIME_EVENT_BYTES = 96 * 1024;

const idPattern = "^[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9][A-Za-z0-9._~-]*$";
const digestPattern = "^[a-f0-9]{64}$";
const timestampPattern = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$";
const runtimeId = (kind: string) => Type.String({ pattern: `^${kind}_[A-Za-z0-9][A-Za-z0-9._~-]*$`, maxLength: 128 });
const digest = Type.String({ pattern: digestPattern, maxLength: 64 });

export function isEventCursor(value: unknown): value is EventCursor {
	return Check(EventCursorSchema, value);
}

export function isExpectedRevision(value: unknown): value is ExpectedRevision {
	return Check(ExpectedRevisionSchema, value);
}

function createEventSchema(type: RuntimeEventType): TSchema {
	return Type.Object(
		{
			schemaVersion: Type.Literal(RUNTIME_SCHEMA_VERSION),
			authorityId: runtimeId("authority"),
			tenantId: runtimeId("tenant"),
				principalId: runtimeId("principal"),
				eventId: runtimeId("event"),
				stream: RuntimeEventStreamRefSchema,
			sequence: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
			timestamp: Type.String({ pattern: timestampPattern, maxLength: 24 }),
			type: Type.Literal(type),
			previousEventHash: Type.Union([digest, Type.Null()]),
			payloadDigest: digest,
			currentEventHash: digest,
			traceId: runtimeId("trace"),
			payload: RUNTIME_EVENT_PAYLOAD_SCHEMAS[type],
		},
		{ additionalProperties: false },
	);
}

export const RUNTIME_EVENT_SCHEMAS = Object.fromEntries(
	RUNTIME_EVENT_TYPES.map((type) => [type, createEventSchema(type)]),
) as Readonly<Record<RuntimeEventType, TSchema>>;

export interface SchemaValidationSuccess<T> {
	ok: true;
	value: T;
}

export interface SchemaValidationFailure {
	ok: false;
	code:
		| "invalid_schema"
		| "unknown_field"
		| "unknown_schema_version"
		| "unknown_event_type"
		| "oversized_payload";
	message: string;
}

export type SchemaValidationResult<T> = SchemaValidationSuccess<T> | SchemaValidationFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalByteLength(value: unknown): number | undefined {
	try {
		return Buffer.byteLength(canonicalJson(value), "utf8");
	} catch (error) {
		if (error instanceof CanonicalJsonError) return undefined;
		throw error;
	}
}

export function validateRuntimeEvent(value: unknown): SchemaValidationResult<RuntimeEventV3> {
	if (!isRecord(value)) return { ok: false, code: "invalid_schema", message: "event must be an object" };
	if (value.schemaVersion !== RUNTIME_SCHEMA_VERSION) {
		return { ok: false, code: "unknown_schema_version", message: `expected schema version ${RUNTIME_SCHEMA_VERSION}` };
	}
	if (!isKnownRuntimeEventType(value.type)) {
		return { ok: false, code: "unknown_event_type", message: "event type is not in the v3 catalog" };
	}
	if (!isRecord(value.payload)) return { ok: false, code: "invalid_schema", message: "event payload must be an object" };

	const payloadBytes = canonicalByteLength(value.payload);
	if (payloadBytes === undefined) return { ok: false, code: "invalid_schema", message: "payload is not canonical JSON" };
	if (payloadBytes > MAX_RUNTIME_EVENT_PAYLOAD_BYTES) {
		return { ok: false, code: "oversized_payload", message: `payload exceeds ${MAX_RUNTIME_EVENT_PAYLOAD_BYTES} bytes` };
	}
	const eventBytes = canonicalByteLength(value);
	if (eventBytes === undefined) return { ok: false, code: "invalid_schema", message: "event is not canonical JSON" };
	if (eventBytes > MAX_RUNTIME_EVENT_BYTES) {
		return { ok: false, code: "oversized_payload", message: `event exceeds ${MAX_RUNTIME_EVENT_BYTES} bytes` };
	}

	const schema = RUNTIME_EVENT_SCHEMAS[value.type];
	if (!Check(schema, value)) {
		const first = Errors(schema, value)[0];
		const unknownField = first?.keyword === "additionalProperties";
		return {
			ok: false,
			code: unknownField ? "unknown_field" : "invalid_schema",
			message: first?.message ?? "event does not match its exact payload schema",
		};
	}
	const event = value as unknown as RuntimeEventV3;
	if (!isRuntimeEventTypeAllowedInStream(event.type, event.stream.scope)) {
		return { ok: false, code: "invalid_schema", message: `${event.type} is not allowed on ${event.stream.scope} stream` };
	}
	return { ok: true, value: event };
}

export function assertRuntimeEvent(value: unknown): RuntimeEventV3 {
	const result = validateRuntimeEvent(value);
	if (!result.ok) {
		throw new RuntimeContractError({
			code: result.code,
			message: result.message,
			retryable: false,
		});
	}
	return result.value;
}

export function isRuntimeEventSchemaCatalogExhaustive(): boolean {
	return (
		Object.keys(RUNTIME_EVENT_SCHEMAS).length === RUNTIME_EVENT_TYPES.length &&
		Object.keys(RUNTIME_EVENT_PAYLOAD_SCHEMAS).length === RUNTIME_EVENT_TYPES.length &&
		RUNTIME_EVENT_TYPES.every((type) => Boolean(RUNTIME_EVENT_SCHEMAS[type] && RUNTIME_EVENT_PAYLOAD_SCHEMAS[type]))
	);
}

export const RUNTIME_ID_SCHEMA_PATTERN = idPattern;

export { EventCursorSchema, ExpectedRevisionSchema, RuntimeEventStreamRefSchema } from "./event-references.ts";

export {
	ApprovalCoordinatorRequestSchema,
	ApprovalCoordinatorResultSchema,
	ApprovalReceiptRefSchema,
	ApprovalTicketSchema,
	AuthorizationContextSchema,
	CapabilityClaimSchema,
	CapabilityDecisionSchema,
	CapabilityAuthChannelSchema,
	CapabilityGatewayRequestBodySchema,
	CapabilityGatewayRequestSchema,
	CapabilityGatewayResultSchema,
	CapabilityRequestAuthenticationSchema,
	CapabilityNameSchema,
	CapabilityRequestRefSchema,
	CredentialGrantRefSchema,
	GatewayRateLimitReceiptSchema,
	GatewayRateLimitRequestSchema,
	RateLimitOperationSchema,
	RateLimitOutcomeSchema,
	SandboxExecutionReceiptRefSchema,
	SandboxExecutorRequestSchema,
	SandboxExecutorResultSchema,
	SandboxProfileRefSchema,
	SecurityPortCancelRequestSchema,
	SecurityPortCancelResultSchema,
	ToolInvocationRequestSchema,
} from "./capability.ts";
export {
	DeclassificationReceiptRefSchema,
	InputSourceKindSchema,
	InputSourceRefSchema,
	InputTrustSchema,
	TaintLabelSchema,
	TaintSinkSchema,
} from "./taint.ts";
export {
	PermissionDecidedPayloadSchema,
	PermissionExpiredPayloadSchema,
	PermissionRequestedPayloadSchema,
	PermissionRequestSummarySchema,
	PermissionRevokedPayloadSchema,
	SandboxExecutionRecordedPayloadSchema,
	SandboxResolvedPayloadSchema,
	ToolAuthorizedPayloadSchema,
} from "./security-events.ts";

export {
	WorkspaceBindingRefSchema,
	WorkspaceCheckpointDescriptorSchema,
	WorkspaceExecutionEnvelopeSchema,
	WorkspaceLeaseRefSchema,
	WorkspaceReleaseReceiptRefSchema,
	WorkspaceServiceRequestSchema,
	WorkspaceServiceResultSchema,
	WorkspaceValidationReceiptRefSchema,
	WorktreeIdSchema,
} from "./workspace.ts";
