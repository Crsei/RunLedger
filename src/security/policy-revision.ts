import type { SecurityResult } from "./types.ts";

/** 单次授权持有的版本检查；变更信号只取消授权等待，不取消已执行的操作。 */
export interface SecurityPolicyRevisionPort {
	readonly signal: AbortSignal;
	check(): SecurityResult<void>;
	checkAdmission(): SecurityResult<void>;
	acquireAdmission(): SecurityResult<() => void>;
}

export function policyChanged(): SecurityResult<never> {
	return { ok: false, error: { code: "security_policy_changed", message: "Session permissions changed before execution", retryable: true } };
}

export function isPolicyChanged(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "security_policy_changed";
}

export function throwPolicyFailure(result: SecurityResult<void>): void {
	if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
}

export function authorizationSignal(revision: SecurityPolicyRevisionPort | undefined, signal?: AbortSignal): AbortSignal | undefined {
	return revision === undefined ? signal : signal === undefined ? revision.signal : AbortSignal.any([signal, revision.signal]);
}
