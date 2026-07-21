/**
 * Runtime v3 的轻量 schema guard。
 *
 * TODO(runtime-phase-0): 用冻结后的 TypeBox schema 替换本文件的最小运行时
 * 检查，并为 unknown fields、payload 大小和每个事件类型增加 golden fixtures。
 */

import { RuntimeContractError } from "./errors.ts";
import { isKnownRuntimeEventType, type RuntimeEventV3 } from "./events.ts";
import { RUNTIME_SCHEMA_VERSION } from "./events.ts";

export interface SchemaValidationSuccess<T> {
	ok: true;
	value: T;
}

export interface SchemaValidationFailure {
	ok: false;
	code: "invalid_schema" | "unknown_schema_version" | "unknown_event_type";
	message: string;
}

export type SchemaValidationResult<T> = SchemaValidationSuccess<T> | SchemaValidationFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateRuntimeEvent(value: unknown): SchemaValidationResult<RuntimeEventV3> {
	if (!isRecord(value)) {
		return { ok: false, code: "invalid_schema", message: "event must be an object" };
	}
	if (value.schemaVersion !== RUNTIME_SCHEMA_VERSION) {
		return {
			ok: false,
			code: "unknown_schema_version",
			message: `expected schema version ${RUNTIME_SCHEMA_VERSION}`,
		};
	}
	if (!isKnownRuntimeEventType(value.type)) {
		return { ok: false, code: "unknown_event_type", message: "event type is not in the v3 catalog" };
	}
	const stringFields = [
		"authorityId",
		"tenantId",
		"principalId",
		"eventId",
		"sessionId",
		"timestamp",
		"payloadDigest",
		"currentEventHash",
		"traceId",
	];
	if (stringFields.some((field) => typeof value[field] !== "string")) {
		return { ok: false, code: "invalid_schema", message: "event identity fields must be strings" };
	}
	if (value.previousEventHash !== null && typeof value.previousEventHash !== "string") {
		return { ok: false, code: "invalid_schema", message: "previousEventHash must be string or null" };
	}
	if (typeof value.sequence !== "number" || !Number.isSafeInteger(value.sequence) || value.sequence < 0) {
		return { ok: false, code: "invalid_schema", message: "sequence must be a non-negative safe integer" };
	}
	if (!isRecord(value.payload)) {
		return { ok: false, code: "invalid_schema", message: "payload must be an object" };
	}
	return { ok: true, value: value as unknown as RuntimeEventV3 };
}

export function assertRuntimeEvent(value: unknown): RuntimeEventV3 {
	const result = validateRuntimeEvent(value);
	if (!result.ok) {
		throw new RuntimeContractError({
			code:
				result.code === "unknown_schema_version"
					? "unknown_schema_version"
					: result.code === "unknown_event_type"
						? "unknown_event_type"
						: "invariant_violation",
			message: result.message,
			retryable: false,
		});
	}
	return result.value;
}
