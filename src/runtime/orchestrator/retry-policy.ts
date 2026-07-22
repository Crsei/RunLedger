/** Retry 分类：不确定副作用默认暂停，只有可证明安全的失败才自动重试。 */

import type { ToolRetryEligibility } from "./tool-retry-eligibility.ts";

export const RETRY_FAILURE_CATEGORIES = [
	"network",
	"rate_limit",
	"context_overflow",
	"tool_uncertain_outcome",
	"tool_definite_failure",
	"validation",
	"cancelled",
	"unknown",
] as const;

export type RetryFailureCategory = (typeof RETRY_FAILURE_CATEGORIES)[number];

export interface RetryFailure {
	category: RetryFailureCategory;
	code: string;
	retryAfterMs?: number;
	/** true 只表示外部系统明确确认未产生副作用。 */
	definitelyNotApplied: boolean;
}

export interface RetryContext {
	attempt: number;
	maxAttempts: number;
	operation: "provider" | "tool" | "verification";
	sideEffect: "none" | "read" | "write" | "external" | "privileged";
	hasStableIdempotencyKey: boolean;
	compactionAttempts: number;
	maxCompactionAttempts: number;
	/** Tool 自动重试必须携带独立、已相关联的 reconcile 资格。 */
	toolRetryEligibility?: ToolRetryEligibility;
}

export interface RetryPolicyOptions {
	baseDelayMs: number;
	maxDelayMs: number;
	maxServerDelayMs: number;
}

export type RetryDecision =
	| { action: "retry"; delayMs: number; reason: RetryFailureCategory }
	| { action: "compact_then_retry"; reason: "context_overflow" }
	| { action: "pause_for_reconciliation"; reason: "tool_uncertain_outcome" }
	| { action: "fail" | "do_not_retry"; reason: RetryFailureCategory };

const DEFAULT_RETRY_POLICY: RetryPolicyOptions = {
	baseDelayMs: 500,
	maxDelayMs: 30_000,
	maxServerDelayMs: 60_000,
};

function safeForAutomaticRetry(context: RetryContext, failure: RetryFailure): boolean {
	if (context.operation === "tool") {
		return context.toolRetryEligibility?.allowed === true && failure.definitelyNotApplied;
	}
	if (context.sideEffect === "none" || context.sideEffect === "read") return true;
	return context.hasStableIdempotencyKey && failure.definitelyNotApplied;
}

function retryDelay(context: RetryContext, failure: RetryFailure, options: RetryPolicyOptions): number {
	if (failure.category === "rate_limit" && failure.retryAfterMs !== undefined) {
		return Math.max(0, Math.min(failure.retryAfterMs, options.maxServerDelayMs));
	}
	const exponent = Math.max(0, context.attempt - 1);
	return Math.min(options.baseDelayMs * 2 ** exponent, options.maxDelayMs);
}

export function decideRetry(
	failure: RetryFailure,
	context: RetryContext,
	options: RetryPolicyOptions = DEFAULT_RETRY_POLICY,
): RetryDecision {
	if (failure.category === "tool_uncertain_outcome") {
		return { action: "pause_for_reconciliation", reason: "tool_uncertain_outcome" };
	}
	if (failure.category === "context_overflow") {
		return context.compactionAttempts < context.maxCompactionAttempts
			? { action: "compact_then_retry", reason: "context_overflow" }
			: { action: "fail", reason: "context_overflow" };
	}
	if (failure.category === "validation" || failure.category === "cancelled") {
		return { action: "do_not_retry", reason: failure.category };
	}
	if (failure.category === "unknown") return { action: "fail", reason: "unknown" };
	if (context.attempt >= context.maxAttempts) return { action: "fail", reason: failure.category };
	if (!safeForAutomaticRetry(context, failure)) {
		return failure.category === "tool_definite_failure"
			? { action: "do_not_retry", reason: failure.category }
			: { action: "fail", reason: failure.category };
	}
	return { action: "retry", delayMs: retryDelay(context, failure, options), reason: failure.category };
}

export interface RetryFailureSignal {
	code?: string;
	httpStatus?: number;
	retryAfterMs?: number;
	operation: "provider" | "tool" | "verification";
	outcomeKnown: boolean;
	definitelyNotApplied?: boolean;
}

/** Adapter 先归一化信号；本函数不读取 provider 私有 Error 对象。 */
export function classifyRetryFailure(signal: RetryFailureSignal): RetryFailure {
	const code = (signal.code ?? "unknown").toLowerCase();
	let category: RetryFailureCategory = "unknown";
	if (signal.operation === "tool" && !signal.outcomeKnown) category = "tool_uncertain_outcome";
	else if (signal.operation === "tool") category = "tool_definite_failure";
	else if (signal.httpStatus === 429 || code.includes("rate_limit")) category = "rate_limit";
	else if (code.includes("context") && (code.includes("overflow") || code.includes("length"))) {
		category = "context_overflow";
	} else if (
		signal.httpStatus === 408 ||
		signal.httpStatus === 502 ||
		signal.httpStatus === 503 ||
		signal.httpStatus === 504 ||
		code.includes("network") ||
		code.includes("timeout") ||
		code.includes("connection")
	) {
		category = "network";
	} else if (code.includes("validation") || signal.httpStatus === 400 || signal.httpStatus === 422) {
		category = "validation";
	} else if (code.includes("abort") || code.includes("cancel")) category = "cancelled";
	return {
		category,
		code,
		retryAfterMs: signal.retryAfterMs,
		definitelyNotApplied: signal.definitelyNotApplied ?? false,
	};
}
