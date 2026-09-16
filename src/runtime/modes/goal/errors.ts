/** Goal Mode 的 typed failures，形态与 modes/plan/errors.ts 一致。 */

import type { RuntimeDigest } from "../../protocol/foundation.ts";

export type GoalFailureCode =
	| "invalid_state"
	| "invalid_command"
	| "invalid_snapshot"
	| "invalid_objective"
	| "invalid_budget"
	| "invalid_usage"
	| "illegal_transition"
	| "stale_expected_revision"
	| "completion_not_requested";

export interface GoalFailure {
	readonly code: GoalFailureCode;
	readonly message: string;
	readonly retryable: boolean;
	readonly expectedRevision?: number;
	readonly actualRevision?: number;
	readonly expectedDigest?: RuntimeDigest;
	readonly actualDigest?: RuntimeDigest;
}

export type GoalResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: GoalFailure };

export function goalFailure<T>(
	code: GoalFailureCode,
	message: string,
	options: {
		readonly retryable?: boolean;
		readonly expectedRevision?: number;
		readonly actualRevision?: number;
		readonly expectedDigest?: RuntimeDigest;
		readonly actualDigest?: RuntimeDigest;
	} = {},
): GoalResult<T> {
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
