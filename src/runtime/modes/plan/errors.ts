import type { RuntimeDigest } from "../../protocol/foundation.ts";

export type PlanFailureCode =
	| "invalid_state"
	| "invalid_command"
	| "invalid_artifact"
	| "invalid_snapshot"
	| "illegal_transition"
	| "stale_expected_revision"
	| "stale_expected_plan_revision"
	| "stale_expected_digest"
	| "artifact_not_found"
	| "artifact_digest_drift"
	| "approval_mismatch"
	| "scope_mismatch";

export interface PlanFailure {
	readonly code: PlanFailureCode;
	readonly message: string;
	readonly retryable: boolean;
	readonly expectedRevision?: number;
	readonly actualRevision?: number;
	readonly expectedDigest?: RuntimeDigest;
	readonly actualDigest?: RuntimeDigest;
}

export type PlanResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: PlanFailure };

export function planFailure<T>(
	code: PlanFailureCode,
	message: string,
	options: {
		readonly retryable?: boolean;
		readonly expectedRevision?: number;
		readonly actualRevision?: number;
		readonly expectedDigest?: RuntimeDigest;
		readonly actualDigest?: RuntimeDigest;
	} = {},
): PlanResult<T> {
	return {
		ok: false,
		error: {
			code,
			message,
			retryable: options.retryable ?? false,
			...(options.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }),
			...(options.actualRevision === undefined ? {} : { actualRevision: options.actualRevision }),
			...(options.expectedDigest === undefined ? {} : { expectedDigest: options.expectedDigest }),
			...(options.actualDigest === undefined ? {} : { actualDigest: options.actualDigest }),
		},
	};
}
