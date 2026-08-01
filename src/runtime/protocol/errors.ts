/**
 * 当前 Runtime 的错误码合同。
 *
 * TODO(runtime-phase-0): 完成错误码注册表、公开/内部字段分层、重试语义和
 * unknown schema/version 的持久化诊断；调用方不得把未知错误降级成成功。
 */

import type { RuntimeContentRef } from "./foundation.ts";
import type { TraceId } from "./ids.ts";

export const RUNTIME_ERROR_CODES = [
	"invalid_id",
	"invalid_canonical_json",
	"unknown_event_type",
	"oversized_payload",
	"expected_revision_conflict",
	"invariant_violation",
	"boundary_violation",
	"contract_unavailable",
] as const;

export type RuntimeErrorCode = (typeof RUNTIME_ERROR_CODES)[number];

export interface RuntimeErrorShape {
	readonly code: RuntimeErrorCode;
	readonly message: string;
	readonly retryable: boolean;
	readonly correlationId: TraceId;
	readonly detailsRef?: RuntimeContentRef;
}

export class RuntimeContractError extends Error implements RuntimeErrorShape {
	public readonly code: RuntimeErrorCode;
	public readonly retryable: boolean;
	public readonly correlationId: TraceId;
	public readonly detailsRef?: RuntimeContentRef;

	public constructor(shape: RuntimeErrorShape) {
		super(shape.message);
		this.name = "RuntimeContractError";
		this.code = shape.code;
		this.retryable = shape.retryable;
		this.correlationId = shape.correlationId;
		this.detailsRef = shape.detailsRef;
	}
}
