import type { LoopConditionConfig, LoopLimitRuntime } from "./limit.ts";

/** Client 只搬运 Owner 已扣减的预算；新 Owner 保留绝对截止时间。 */
export interface LoopResetHandoff {
	readonly handoffId: string;
	readonly sourceSessionId: string;
	readonly prompt: string;
	readonly action: "reset";
	readonly limit: LoopLimitRuntime;
	readonly iteration: number;
	readonly condition?: LoopConditionConfig;
}

export function isLoopResetHandoff(value: unknown): value is LoopResetHandoff {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	if (typeof v.handoffId !== "string" || !v.handoffId || typeof v.sourceSessionId !== "string" || !v.sourceSessionId || typeof v.prompt !== "string" || !v.prompt.trim() || v.action !== "reset" || !Number.isSafeInteger(v.iteration) || (v.iteration as number) < 1) return false;
	if (typeof v.limit !== "object" || v.limit === null) return false;
	const limit = v.limit as Record<string, unknown>;
	const validLimit = limit.kind === "iterations"
		? Number.isSafeInteger(limit.initial) && Number.isSafeInteger(limit.remaining) && (limit.initial as number) > 0 && (limit.remaining as number) >= 0 && (limit.remaining as number) < (limit.initial as number)
		: limit.kind === "duration" && Number.isSafeInteger(limit.durationMs) && (limit.durationMs as number) > 0 && Number.isSafeInteger(limit.deadlineMs);
	if (!validLimit) return false;
	if (v.condition === undefined) return true;
	if (typeof v.condition !== "object" || v.condition === null) return false;
	const condition = v.condition as Record<string, unknown>;
	return typeof condition.command === "string" && condition.command.trim().length > 0 && typeof condition.until === "boolean";
}
