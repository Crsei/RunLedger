/** Control Plane 的稳定错误码。错误详情只能携带脱敏标量。 */

import { Type } from "typebox";
import { Check } from "typebox/value";

export const CONTROL_PLANE_ERROR_CODES = [
	"invalid_request",
	"unknown_command",
	"unknown_query",
	"unsupported_protocol",
	"unsupported_schema",
	"unsupported_feature",
	"handshake_required",
	"unauthorized_peer",
	"remote_disabled",
	"expected_revision_conflict",
	"expected_turn_conflict",
	"idempotency_conflict",
	"command_in_flight",
	"adapter_unavailable",
	"adapter_contract_violation",
	"preflight_rejected",
	"durable_enqueue_failed",
	"malformed_frame",
	"frame_too_large",
	"overloaded",
	"slow_consumer",
	"cursor_mismatch",
	"checkpoint_conflict",
	"stale_session_handle",
	"session_replacing",
	"daemon_shutting_down",
	"drain_timeout",
	"recovery_required",
	"internal_error",
] as const;

export type ControlPlaneErrorCode = (typeof CONTROL_PLANE_ERROR_CODES)[number];

export interface ControlPlaneErrorShape {
	code: ControlPlaneErrorCode;
	message: string;
	retryable: boolean;
	details?: Readonly<Record<string, string | number | boolean>>;
}

const ErrorDetailValueSchema = Type.Union([Type.String({ maxLength: 512 }), Type.Number(), Type.Boolean()]);

export const ControlPlaneErrorSchema = Type.Object(
	{
		code: Type.Union(CONTROL_PLANE_ERROR_CODES.map((code) => Type.Literal(code))),
		message: Type.String({ minLength: 1, maxLength: 1024 }),
		retryable: Type.Boolean(),
		details: Type.Optional(Type.Record(Type.String({ minLength: 1, maxLength: 64 }), ErrorDetailValueSchema)),
	},
	{ additionalProperties: false },
);

export function isControlPlaneError(value: unknown): value is ControlPlaneErrorShape {
	return Check(ControlPlaneErrorSchema, value);
}

export type ControlPlaneResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: ControlPlaneErrorShape; effect: "none" | "uncertain" };

export function controlPlaneFailure<T>(
	code: ControlPlaneErrorCode,
	message: string,
	retryable = false,
	details?: Readonly<Record<string, string | number | boolean>>,
	effect: "none" | "uncertain" = "none",
): Extract<ControlPlaneResult<T>, { ok: false }> {
	return {
		ok: false,
		error: { code, message, retryable, ...(details ? { details } : {}) },
		effect,
	};
}

export class ControlPlaneError extends Error implements ControlPlaneErrorShape {
	public readonly code: ControlPlaneErrorCode;
	public readonly retryable: boolean;
	public readonly details?: Readonly<Record<string, string | number | boolean>>;

	public constructor(shape: ControlPlaneErrorShape) {
		super(shape.message);
		this.name = "ControlPlaneError";
		this.code = shape.code;
		this.retryable = shape.retryable;
		this.details = shape.details;
	}
}
