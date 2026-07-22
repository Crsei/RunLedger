/** Runtime v3 的稳定错误码与公开错误形状。 */

export const RUNTIME_ERROR_CODES = [
	"invalid_id",
	"invalid_canonical_json",
	"invalid_schema",
	"unknown_field",
	"unknown_schema_version",
	"unknown_event_type",
	"oversized_payload",
	"expected_revision_conflict",
	"invalid_state_transition",
	"invariant_violation",
	"boundary_violation",
	"contract_unavailable",
	"corrupted_event_chain",
	"attestation_unavailable",
	"idempotency_conflict",
	"legacy_read_only",
	"legacy_migration_required",
] as const;

export type RuntimeErrorCode = (typeof RUNTIME_ERROR_CODES)[number];

export interface RuntimeErrorShape {
	readonly code: RuntimeErrorCode;
	readonly message: string;
	readonly retryable: boolean;
	/** 仅允许脱敏标量；secret、credential、完整命令和 payload 不得进入错误详情。 */
	readonly details?: Readonly<Record<string, string | number | boolean>>;
}

const RUNTIME_ERROR_CODE_SET: ReadonlySet<string> = new Set(RUNTIME_ERROR_CODES);

export function isRuntimeErrorCode(value: unknown): value is RuntimeErrorCode {
	return typeof value === "string" && RUNTIME_ERROR_CODE_SET.has(value);
}

export class RuntimeContractError extends Error implements RuntimeErrorShape {
	public readonly code: RuntimeErrorCode;
	public readonly retryable: boolean;
	public readonly details?: Readonly<Record<string, string | number | boolean>>;

	public constructor(shape: RuntimeErrorShape) {
		super(shape.message);
		this.name = "RuntimeContractError";
		this.code = shape.code;
		this.retryable = shape.retryable;
		this.details = shape.details;
	}
}
