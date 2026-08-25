/** Settings-aware retry policy；不包含 provider-specific error classification。 */

import type { SimpleStreamOptions } from "../../types.ts";
import type { StreamFn } from "../types.ts";

export interface RetryPolicy {
	readonly enabled: boolean;
	readonly maxRetries: number;
	readonly baseDelayMs: number;
	readonly maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({
	enabled: true,
	maxRetries: 0,
	baseDelayMs: 250,
	maxDelayMs: 10_000,
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedInteger(value: unknown, minimum: number, maximum: number): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

/** 将持久化的 partial policy 转成 immutable、全范围受限的 Runtime policy。 */
export function resolveRetryPolicy(input: unknown): RetryPolicy {
	if (!isRecord(input)) return DEFAULT_RETRY_POLICY;
	const enabled = input.enabled;
	const maxRetries = input.maxRetries;
	const baseDelayMs = input.baseDelayMs;
	const maxDelayMs = input.maxDelayMs;
	if (enabled !== undefined && typeof enabled !== "boolean") return DEFAULT_RETRY_POLICY;
	if (maxRetries !== undefined && !boundedInteger(maxRetries, 0, 10)) return DEFAULT_RETRY_POLICY;
	if (baseDelayMs !== undefined && !boundedInteger(baseDelayMs, 0, 60_000)) return DEFAULT_RETRY_POLICY;
	if (maxDelayMs !== undefined && !boundedInteger(maxDelayMs, 0, 300_000)) return DEFAULT_RETRY_POLICY;
	const policy: RetryPolicy = {
		enabled: enabled === undefined ? DEFAULT_RETRY_POLICY.enabled : enabled,
		maxRetries: maxRetries === undefined ? DEFAULT_RETRY_POLICY.maxRetries : maxRetries,
		baseDelayMs: baseDelayMs === undefined ? DEFAULT_RETRY_POLICY.baseDelayMs : baseDelayMs,
		maxDelayMs: maxDelayMs === undefined ? DEFAULT_RETRY_POLICY.maxDelayMs : maxDelayMs,
	};
	if (policy.maxDelayMs < policy.baseDelayMs) return DEFAULT_RETRY_POLICY;
	return Object.freeze(policy);
}

/**
 * 计算第 retryIndex 次重试前的等待时间。retryIndex 从 0 开始；provider
 * 提供的 Retry-After 只会增加等待，不得超过 settings 的 maxDelayMs。
 */
export function calculateRetryDelayMs(
	policy: RetryPolicy,
	retryIndex: number,
	retryAfterMs?: number,
): number {
	if (!policy.enabled || policy.maxRetries <= 0 || retryIndex < 0) return 0;
	const exponent = Math.min(30, Math.trunc(retryIndex));
	const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** exponent);
	const requested = typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
		? retryAfterMs
		: 0;
	return Math.min(policy.maxDelayMs, Math.max(exponential, requested));
}

/** Caller 显式传入的 request option 优先；settings 只填空值。 */
export function applyRetryPolicy(
	options: SimpleStreamOptions,
	policy: RetryPolicy,
): SimpleStreamOptions {
	return {
		...options,
		maxRetries: options.maxRetries ?? (policy.enabled ? policy.maxRetries : 0),
		maxRetryDelayMs: options.maxRetryDelayMs ?? policy.maxDelayMs,
		retryBaseDelayMs: options.retryBaseDelayMs ?? policy.baseDelayMs,
	};
}

/** 将 retry policy 接入唯一的 model stream seam；provider adapter 不读 settings。 */
export function createSettingsAwareStreamFn(streamFn: StreamFn, policy: RetryPolicy): StreamFn {
	return (model, context, options) => streamFn(model, context, applyRetryPolicy(options ?? {}, policy));
}
